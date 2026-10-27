/** Bounded revision reads stop at captured fences and retain only category observations. */
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { AdoHistory, AdoItemHistory } from '../shared/ado-analytics-model.ts'
import { adoAnalyticsSnapshotSchema, validateAdoHistory } from '../shared/ado-analytics-schema.ts'
import { adoHistoryRange, currentCohortWarning, currentMetadataWarning, partialSourceWarning } from '../shared/ado-history.ts'
import type { AdoItem, AdoSnapshot, ReadOnlyMcp, StateCategory } from '../shared/types.ts'
import { adoRecord, stateMetadata } from './ado-data.ts'

/** Instance-local clock and deadline hooks; cancellation still waits for every provider promise. */
export interface AdoHistoryRuntime {
  now?: () => Date
  scheduleTimeout?: (milliseconds: number, expire: () => void) => () => void
}

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const revisionSchema = z.object({
  id: idSchema,
  rev: idSchema,
  fields: z.object({
    'System.WorkItemType': z.string().min(1),
    'System.State': z.string().min(1),
    'System.ChangedDate': z.iso.datetime({ offset: true }),
    'System.TeamProject': z.string().min(1).optional(),
  }),
})

class HistoryFailure extends Error {}

function revisionPage(value: unknown, id: number, skip: number, top: number): z.infer<typeof revisionSchema>[] {
  let values: unknown[]
  if (Array.isArray(value)) values = value
  else {
    let meta: Record<string, unknown>
    try {
      meta = adoRecord(value, 'wit_work_item/list_revisions')
    } catch {
      throw new HistoryFailure('Revision data was not a supported decoded collection.')
    }
    const keys = ['value', 'items'].filter(key => meta[key] !== undefined)
    if (keys.length !== 1 || !Array.isArray(meta[keys[0]!])) throw new HistoryFailure('Revision data was not a supported decoded collection.')
    values = meta[keys[0]!] as unknown[]
    for (const key of ['count', 'total', 'totalCount']) {
      const count = meta[key]
      if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < values.length)) {
        throw new HistoryFailure('Revision collection metadata was invalid.')
      }
    }
    for (const key of ['truncated', 'isTruncated', 'hasMore', 'complete']) {
      if (meta[key] !== undefined && typeof meta[key] !== 'boolean') throw new HistoryFailure('Revision collection metadata was invalid.')
    }
    if (meta.truncated === true || meta.isTruncated === true) throw new HistoryFailure('The provider truncated a revision page.')
  }
  if (values.length !== top) throw new HistoryFailure('Revision page length did not match the captured revision fence.')
  // The field whitelist discards descriptions, identities, and other unrelated revision data.
  const parsed = z.array(revisionSchema).safeParse(values)
  if (!parsed.success) throw new HistoryFailure('Revision fields were missing or malformed.')
  if (parsed.data.some((revision, index) => revision.id !== id || revision.rev !== skip + index + 1)) {
    throw new HistoryFailure('Revision IDs or sequence numbers were unexpected, duplicated, reordered, or missing.')
  }
  return parsed.data
}

function scheduleTimeout(milliseconds: number, expire: () => void): () => void {
  const timer = setTimeout(expire, milliseconds)
  return () => clearTimeout(timer)
}

/**
 * Read all current items of one existing type, never a sampled or historical membership cohort.
 * @param mcp Read-only connector; requests must settle after their abort signal fires.
 * @param snapshot Snapshot supplying settings, current membership, and revision fences.
 * @param type Exact existing selected type.
 * @param signal Caller cancellation rejects only after in-flight reads settle.
 * @param runtime Optional instance-local clock and deadline scheduler.
 * @returns Complete, partial, or unavailable evidence; provider errors are explicit omissions.
 */
export async function loadAdoHistory(
  mcp: ReadOnlyMcp, snapshot: AdoSnapshot, type: string, signal: AbortSignal, runtime: AdoHistoryRuntime = {},
): Promise<AdoHistory> {
  signal.throwIfAborted()
  if (!snapshot.analytics) throw new Error('ADO history requires analytics metadata')
  const analytics = adoAnalyticsSnapshotSchema.parse(snapshot.analytics)
  const cohort = snapshot.items.filter(item => item.type === type)
  if (!cohort.length) throw new Error('ADO history requires an exact existing selected type')
  const { settings } = analytics
  const { range, warnings: rangeWarnings, reason } = adoHistoryRange(snapshot)
  const warnings = new Set([currentCohortWarning, currentMetadataWarning, ...rangeWarnings])
  if (!snapshot.complete) warnings.add(partialSourceWarning)
  const requestedItemIds = cohort.map(item => item.id)
  const available = new Map<number, AdoItemHistory>()
  const omitted = new Map<number, string>()
  const finish = (): AdoHistory => {
    const now = (runtime.now ?? (() => new Date()))()
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid ADO history clock')
    const items = cohort.flatMap(item => available.has(item.id) ? [available.get(item.id)!] : [])
    const history: AdoHistory = {
      basis: 'current-cohort', type,
      status: !items.length ? 'unavailable' : omitted.size ? 'partial' : 'complete',
      fetchedAt: now.toISOString(), range, requestedItemIds, items,
      omitted: cohort.flatMap(item => omitted.has(item.id) ? [{ id: item.id, reason: omitted.get(item.id)! }] : []),
      warnings: [...warnings].sort(),
    }
    return validateAdoHistory(history, snapshot)
  }
  if (!range || cohort.length > settings.maxHistoryItems) {
    const message = !range ? reason! : `The current type exceeds the ${settings.maxHistoryItems}-item history limit; narrow the source or select a smaller type.`
    warnings.add(message)
    for (const item of cohort) omitted.set(item.id, message)
    return finish()
  }
  const timeout = new AbortController()
  const failure = new AbortController()
  const combined = AbortSignal.any([signal, timeout.signal, failure.signal])
  const clearTimeout = (runtime.scheduleTimeout ?? scheduleTimeout)(settings.historyTimeoutMs, () => {
    timeout.abort(new Error('ADO history deadline reached'))
  })
  let requests = 0
  const read = async (project: string, args: Record<string, unknown>): Promise<unknown> => {
    combined.throwIfAborted()
    if (requests >= settings.maxHistoryRequests) throw new HistoryFailure('The shared history request budget was exhausted.')
    requests++
    let value: unknown
    try {
      value = await mcp.call('wit_work_item', { orgName: snapshot.source.orgName, project, ...args }, combined)
    } catch {
      combined.throwIfAborted()
      throw new HistoryFailure('The ADO provider could not read revision evidence or current state metadata.')
    }
    combined.throwIfAborted()
    return value
  }
  const metadata = new Map<string, Promise<Map<string, StateCategory>>>()
  const statesFor = (project: string) => {
    const key = project.toLowerCase()
    let promise = metadata.get(key)
    if (!promise) {
      promise = (async () => {
        const value = await read(project, { action: 'get_type', workItemType: type })
        const metadataWarnings = new Set<string>()
        let states: Map<string, StateCategory>
        try {
          states = stateMetadata(value, type, metadataWarnings)
        } catch {
          throw new HistoryFailure('Current work-item type state metadata was malformed or unavailable.')
        }
        if (metadataWarnings.size) warnings.add('Current type metadata has unavailable state categories; historical completion is not inferred for them.')
        return states
      })()
      metadata.set(key, promise)
    }
    return promise
  }
  const start = DateTime.fromISO(range.start, { zone: range.timeZone }).toMillis()
  const asOf = Date.parse(snapshot.generatedAt)
  const end = Math.min(DateTime.fromISO(range.finish, { zone: range.timeZone }).endOf('day').toMillis(), asOf)
  const loadItem = async (item: AdoItem): Promise<AdoItemHistory> => {
    const fence = item.revision
    if (fence === undefined) throw new HistoryFailure('The current snapshot has no captured revision fence for this item.')
    if (fence > settings.maxRevisionsPerItem) throw new HistoryFailure('The item exceeds the configured revision limit; its history was not sampled.')
    const project = item.project ?? snapshot.source.project
    const states = await statesFor(project)
    const changes: AdoItemHistory['changes'] = []
    let lastAt = -Infinity
    let lastCategory: StateCategory | undefined
    for (let skip = 0; skip < fence; skip += settings.revisionPageSize) {
      const top = Math.min(settings.revisionPageSize, fence - skip)
      const page = revisionPage(await read(project, {
        action: 'list_revisions', workItemId: item.id, skip, top, expand: 'Fields',
      }), item.id, skip, top)
      for (const revision of page) {
        const fields = revision.fields
        if (fields['System.WorkItemType'].toLowerCase() !== type.toLowerCase()
          || (fields['System.TeamProject'] !== undefined && fields['System.TeamProject'].toLowerCase() !== project.toLowerCase())) {
          throw new HistoryFailure('The item has historical type or project changes; current type metadata cannot map that history.')
        }
        const date = DateTime.fromISO(fields['System.ChangedDate'])
        const at = date.toMillis()
        if (!date.isValid || at <= lastAt || at > asOf) {
          throw new HistoryFailure('Revision dates were invalid, non-increasing, or later than the snapshot timestamp.')
        }
        lastAt = at
        const category = states.get(fields['System.State'].toLowerCase()) ?? 'Unknown'
        if (category === 'Unknown') warnings.add('Some historical states have no current category mapping and remain Unknown.')
        if (category !== lastCategory) changes.push({ at: date.toUTC().toISO()!, category })
        lastCategory = category
      }
    }
    let before = -1
    for (let index = 0; index < changes.length; index++) if (Date.parse(changes[index]!.at) < start) before = index
    // The initial observation preserves known nonexistence before creation, even for a late-created item.
    return {
      id: item.id,
      changes: changes.filter((change, index) => index === 0 || index === before
        || (Date.parse(change.at) >= start && Date.parse(change.at) <= end)),
    }
  }
  let next = 0
  const worker = async () => {
    while (next < cohort.length && !combined.aborted) {
      const item = cohort[next++]!
      try {
        available.set(item.id, await loadItem(item))
      } catch (error) {
        signal.throwIfAborted()
        failure.signal.throwIfAborted()
        if (timeout.signal.aborted) {
          omitted.set(item.id, 'The history deadline was reached before this item could be verified.')
          return
        }
        if (!(error instanceof HistoryFailure)) throw error
        omitted.set(item.id, error.message)
        warnings.add(error.message)
      }
    }
  }
  try {
    const tasks = Array.from({ length: Math.min(settings.historyConcurrency, cohort.length) }, () =>
      worker().catch(error => { failure.abort(error); throw error }))
    const outcomes = await Promise.allSettled(tasks)
    signal.throwIfAborted()
    const rejected = outcomes.find(outcome => outcome.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    if (timeout.signal.aborted) {
      const message = 'The history deadline was reached; coverage includes only fully verified items.'
      warnings.add(message)
      for (const item of cohort) if (!available.has(item.id) && !omitted.has(item.id)) omitted.set(item.id, message)
    }
    return finish()
  } finally {
    clearTimeout()
  }
}
