/** Validate decoded ADO JSON. Unknown envelopes fail instead of becoming empty lists. */
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { AdoItem, AdoOptions, StateCategory } from '../shared/types.ts'

const recordSchema = z.record(z.string(), z.unknown())
const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const referenceSchema = z.object({ id: idSchema })
const workItemSchema = z.object({
  id: idSchema, rev: idSchema.optional(), fields: recordSchema,
  relations: z.array(z.object({ rel: z.string().min(1), url: z.string().min(1) })).optional(),
})
const categories = new Set<StateCategory>(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed'])
const estimateFields = ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size']
const dueFields = ['Microsoft.VSTS.Scheduling.DueDate', 'Custom.DueDate']
const blockedFields = ['Microsoft.VSTS.CMMI.Blocked', 'Microsoft.VSTS.Common.Blocked', 'Custom.Blocked']

export type WorkItem = z.infer<typeof workItemSchema>

/** Require a JSON object rather than accepting MCP text/error wrappers. */
export function adoRecord(value: unknown, operation: string): Record<string, unknown> {
  const result = recordSchema.safeParse(value)
  if (!result.success || result.data.isError === true || result.data.error !== undefined) {
    throw new Error(`Unsupported ADO output from ${operation}: expected a decoded JSON data object, not text or an error envelope.`)
  }
  return result.data
}

function collection(value: unknown, operation: string, keys: string[]): { values: unknown[]; meta?: Record<string, unknown> } {
  if (Array.isArray(value)) return { values: value }
  const meta = adoRecord(value, operation)
  const present = keys.filter(key => meta[key] !== undefined)
  if (present.length !== 1 || !Array.isArray(meta[present[0]!])) {
    throw new Error(`Unsupported ADO output from ${operation}: expected an array or exactly one array named ${keys.join('/')}.`)
  }
  return { values: meta[present[0]!] as unknown[], meta }
}

/** Detect explicit provider truncation; counts are never substituted for returned records. */
export function partialOutput(meta: Record<string, unknown> | undefined, length: number): boolean {
  if (!meta) return false
  let partial = false
  for (const key of ['count', 'totalCount', 'total']) {
    if (meta[key] === undefined) continue
    const count = meta[key]
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < length) throw new Error(`Unsupported ADO output: ${key} must be an integer at least as large as the returned collection.`)
    partial ||= count > length
  }
  for (const key of ['isTruncated', 'truncated', 'hasMore']) {
    if (meta[key] === undefined) continue
    if (typeof meta[key] !== 'boolean') throw new Error(`Unsupported ADO output: ${key} must be boolean.`)
    partial ||= meta[key] === true
  }
  if (meta.complete !== undefined) {
    if (typeof meta.complete !== 'boolean') throw new Error('Unsupported ADO output: complete must be boolean.')
    partial ||= !meta.complete
  }
  for (const key of ['continuationToken', 'nextLink', '@odata.nextLink']) {
    if (meta[key] === undefined || meta[key] === null || meta[key] === '') continue
    if (typeof meta[key] !== 'string') throw new Error(`Unsupported ADO output: ${key} must be a string.`)
    partial = true
  }
  return partial
}

/** Only flat results can be counted without silently combining link parents and targets. */
export function queryIds(value: unknown): { ids: number[]; partial: boolean } {
  const object = Array.isArray(value) ? undefined : adoRecord(value, 'wit_query')
  if (object && (object.workItemRelations !== undefined || (object.queryType !== undefined && !['flat', 'Flat', 1].includes(object.queryType as string | number)))) {
    throw new Error('Unsupported ADO saved-query result: use a flat work-item query, not a tree or link query.')
  }
  const { values, meta } = collection(value, 'wit_query', ['workItems', 'value', 'items'])
  const parsed = z.array(referenceSchema).safeParse(values)
  if (!parsed.success) throw new Error('Unsupported ADO query output: each work-item reference must contain a positive integer id.')
  const ids = parsed.data.map(item => item.id)
  if (new Set(ids).size !== ids.length) throw new Error('Unsupported ADO query output: duplicate work-item IDs.')
  return { ids, partial: partialOutput(meta, ids.length) }
}

/** Team iteration targets are candidates; source-only references are parent context, not proven team members. */
export function iterationIds(value: unknown): { ids: number[]; sourceOnly: number; partial: boolean } {
  const { values, meta } = collection(value, 'wit_work_item/list_for_iteration', ['workItemRelations'])
  const parsed = z.array(z.object({
    rel: z.string().nullish(), source: referenceSchema.nullish(), target: referenceSchema,
  })).safeParse(values)
  if (!parsed.success) throw new Error('Unsupported ADO team iteration output: expected workItemRelations with positive target IDs and optional source IDs.')
  const targets = new Set<number>()
  const sources = new Set<number>()
  for (const relation of parsed.data) {
    if (relation.source ? relation.rel !== 'System.LinkTypes.Hierarchy-Forward' : relation.rel != null) {
      throw new Error('Unsupported ADO team iteration relation: expected root entries or forward parent/child links.')
    }
    targets.add(relation.target.id)
    if (relation.source) sources.add(relation.source.id)
  }
  return {
    ids: [...targets].sort((left, right) => left - right),
    sourceOnly: [...sources].filter(id => !targets.has(id)).length,
    partial: partialOutput(meta, values.length),
  }
}

/** Batch responses may be SDK arrays or REST value/items envelopes; all records need fields. */
export function batchItems(value: unknown): { items: WorkItem[]; partial: boolean } {
  const { values, meta } = collection(value, 'wit_work_item/get_batch', ['value', 'items', 'workItems'])
  const parsed = z.array(workItemSchema).safeParse(values)
  if (!parsed.success) throw new Error('Unsupported ADO batch output: expected positive work-item IDs with fields objects.')
  return { items: parsed.data, partial: partialOutput(meta, values.length) }
}

/** Read process-defined categories; absent and unfamiliar categories remain Unknown. */
export function stateMetadata(value: unknown, type: string, warnings: Set<string>): Map<string, StateCategory> {
  const data = adoRecord(value, `wit_work_item/get_type (${type})`)
  if (typeof data.name !== 'string' || data.name.toLowerCase() !== type.toLowerCase()) {
    throw new Error(`Unsupported ADO state metadata for "${type}": expected matching work item type name.`)
  }
  if (data.states === undefined || data.states === null) {
    warnings.add(`State categories are unavailable for "${type}"; its states remain Unknown.`)
    return new Map()
  }
  const parsed = z.array(z.object({ name: z.string().min(1), category: z.string().nullish() })).safeParse(data.states)
  if (!parsed.success) throw new Error(`Unsupported ADO state metadata for "${type}": expected states[].name and optional states[].category strings.`)
  const result = new Map<string, StateCategory>()
  for (const state of parsed.data) {
    const key = state.name.toLowerCase()
    if (result.has(key)) throw new Error(`Ambiguous ADO state metadata for "${type}": duplicate state "${state.name}".`)
    const category = categories.has(state.category as StateCategory) ? state.category as StateCategory : 'Unknown'
    if (category === 'Unknown') warnings.add(`Unknown state category for "${type}" / "${state.name}"; completion and risks are not inferred.`)
    result.set(key, category)
  }
  return result
}

/** Require core fields supplied by hydrated work items. */
export function requiredField(item: WorkItem, name: string): string {
  const value = item.fields[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Unsupported ADO work item ${item.id}: missing or invalid ${name}.`)
  return value
}

function numericField(item: WorkItem, name: string, warnings: Set<string>): number | undefined {
  const value = item.fields[name]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  warnings.add(`Work item ${item.id}: invalid ${name} was omitted, not treated as zero.`)
  return undefined
}

/** Parse ISO dates in UTC, never the host machine's local time zone. */
export function isoDate(value: unknown, label: string, warnings: Set<string>): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) {
    const date = DateTime.fromISO(value, { zone: 'utc' })
    if (date.isValid) return date.toUTC().toISO()!
  }
  warnings.add(`${label}: invalid ISO date was omitted.`)
  return undefined
}

function assignment(value: unknown, id: number): { assignee: string; assigneeId: string } {
  if (value === undefined || value === null || value === '') return { assignee: '', assigneeId: '' }
  if (typeof value === 'string') return { assignee: value.trim(), assigneeId: value.trim() }
  const parsed = z.object({
    displayName: z.string().optional(), uniqueName: z.string().optional(),
    id: z.string().optional(), descriptor: z.string().optional(),
  }).safeParse(value)
  if (!parsed.success) throw new Error(`Unsupported ADO assignment for work item ${id}.`)
  const data = parsed.data
  const assigneeId = data.id?.trim() || data.uniqueName?.trim() || data.descriptor?.trim() || data.displayName?.trim()
  if (!assigneeId) throw new Error(`Unsupported ADO assignment for work item ${id}: identity fields are absent.`)
  return { assignee: data.displayName?.trim() || data.uniqueName?.trim() || assigneeId, assigneeId }
}

function predecessorId(value: string, orgName: string): number | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
  if (parts.some(part => /[/\\]/.test(part))) return null
  if (url.hostname.toLowerCase() === 'dev.azure.com') {
    if (parts.shift()?.toLowerCase() !== orgName.toLowerCase()) return null
  } else if (url.hostname.toLowerCase() === `${orgName.toLowerCase()}.visualstudio.com`) {
    if (parts[0]?.toLowerCase() === 'defaultcollection') parts.shift()
  } else return null
  const path = parts.join('/')
  const match = /^(?:[^/]+\/)?(?:_apis\/wit\/workitems|_workitems\/edit)\/([1-9]\d*)$/i.exec(path)
  if (!match) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/** Normalize estimates without combining units, and risks only for known unfinished categories. */
export function normalizeItem(
  item: WorkItem, states: Map<string, StateCategory>, orgName: string, project: string,
  options: AdoOptions, now: number, warnings: Set<string>,
): AdoItem {
  const type = requiredField(item, 'System.WorkItemType')
  const state = requiredField(item, 'System.State')
  const category = states.get(state.toLowerCase()) ?? 'Unknown'
  if (category === 'Unknown') warnings.add(`Unknown state mapping for "${type}" / "${state}"; completion and risks are not inferred.`)
  const rawTags = item.fields['System.Tags']
  if (rawTags !== undefined && rawTags !== null && typeof rawTags !== 'string') throw new Error(`Unsupported ADO tags for work item ${item.id}: expected a semicolon-separated string.`)
  const tags = typeof rawTags === 'string' ? rawTags.split(';').map(tag => tag.trim()).filter(Boolean) : []
  const preferred = type === 'Product Backlog Item' ? estimateFields[1]! : type === 'Requirement' ? estimateFields[2]! : estimateFields[0]!
  const estimates = [preferred, ...estimateFields.filter(field => field !== preferred)]
    .map(field => ({ field, value: numericField(item, field, warnings) })).filter(entry => entry.value !== undefined)
  const estimate = estimates[0]
  if (estimates.length > 1) warnings.add(`Work item ${item.id} has multiple estimate fields; using ${estimate!.field} without adding them.`)
  const changedAt = isoDate(item.fields['System.ChangedDate'], `Work item ${item.id} ChangedDate`, warnings)
  const createdAt = isoDate(item.fields['System.CreatedDate'], `Work item ${item.id} CreatedDate`, warnings)
  const stateChangedAt = isoDate(item.fields['Microsoft.VSTS.Common.StateChangeDate'], `Work item ${item.id} StateChangeDate`, warnings)
  const predecessors = (item.relations ?? [])
    .filter(relation => relation.rel === 'System.LinkTypes.Dependency-Reverse')
    .map(relation => predecessorId(relation.url, orgName))
  if (predecessors.includes(null)) warnings.add(`Work item ${item.id}: an unrecognized or cross-organization predecessor is unavailable; no external item was fetched.`)
  const dues = dueFields.map(field => ({ raw: item.fields[field], date: isoDate(item.fields[field], `Work item ${item.id} ${field}`, warnings) })).filter(entry => entry.date)
  if (dues.length > 1) warnings.add(`Work item ${item.id} has multiple due-date fields; using ${dueFields[0]}.`)
  const due = dues[0]
  const assigned = assignment(item.fields['System.AssignedTo'], item.id)
  const risks: AdoItem['risks'] = []
  if (category === 'Proposed' || category === 'InProgress' || category === 'Resolved') {
    if (!assigned.assigneeId) risks.push('unassigned')
    const blockedTags = new Set(options.blockedTags.map(tag => tag.trim().toLowerCase()).filter(Boolean))
    const blocked = blockedFields.some(field => {
      const value = item.fields[field]
      return value === true || value === 1 || (typeof value === 'string' && ['yes', 'true'].includes(value.trim().toLowerCase()))
    })
    if (blocked || tags.some(tag => blockedTags.has(tag.toLowerCase()))) risks.push('blocked')
    if (changedAt && now - Date.parse(changedAt) >= options.staleDays * 86_400_000) risks.push('stale')
    if (due) {
      const deadline = typeof due.raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due.raw)
        ? DateTime.fromISO(due.raw, { zone: 'utc' }).endOf('day').toMillis() : Date.parse(due.date!)
      if (deadline < now) risks.push('overdue')
    }
  }
  const remainingWork = numericField(item, 'Microsoft.VSTS.Scheduling.RemainingWork', warnings)
  const priority = numericField(item, 'Microsoft.VSTS.Common.Priority', warnings)
  return {
    id: item.id, ...(item.rev !== undefined ? { revision: item.rev } : {}), project,
    title: requiredField(item, 'System.Title'), type, state, category, ...assigned,
    areaPath: requiredField(item, 'System.AreaPath'), iterationPath: requiredField(item, 'System.IterationPath'), tags,
    url: `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`,
    ...(changedAt ? { changedAt } : {}), ...(due ? { dueDate: due.date! } : {}),
    ...(createdAt ? { createdAt } : {}), ...(stateChangedAt ? { stateChangedAt } : {}), predecessors,
    ...(estimate ? { estimate: estimate.value!, estimateField: estimate.field } : {}),
    ...(remainingWork !== undefined ? { remainingWork } : {}), ...(priority !== undefined ? { priority } : {}), risks,
  }
}
