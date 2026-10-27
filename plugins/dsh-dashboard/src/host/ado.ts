/** Current Azure Boards work items via read-only MCP; no analytics or capacity inference. */
import { z } from 'zod'
import type { AdoOptions, AdoSnapshot, AdoSource, ReadOnlyMcp, StateCategory } from '../shared/types.ts'
import { adoRecord, batchItems, isoDate, iterationIds, normalizeItem, partialOutput, queryIds, requiredField, stateMetadata, type WorkItem } from './ado-data.ts'
import { classificationPath, parseAdoSource, scopeWiql, selectorName, type ParsedAdoSource } from './ado-source.ts'

const iterationSchema = z.object({
  id: z.string().regex(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i), name: z.string().min(1), path: z.string().min(1),
  attributes: z.object({ startDate: z.unknown().optional(), finishDate: z.unknown().optional() }).nullish(),
})

type Reader = (operation: string, args: Record<string, unknown>) => Promise<unknown>

async function resolveSprint(parsed: ParsedAdoSource, read: Reader, warnings: Set<string>): Promise<AdoSnapshot['iteration']> {
  if (!parsed.sprint) return undefined
  const response = await read('work', {
    action: 'list_team_iterations', team: parsed.source.team,
    ...(parsed.sprint.current ? { timeframe: 'current' } : {}),
  })
  const meta = Array.isArray(response) ? undefined : adoRecord(response, 'work/list_team_iterations')
  const values = meta ? meta.value : response
  const iterations = z.array(iterationSchema).safeParse(values)
  if (!iterations.success) throw new Error('Unsupported ADO iteration output: expected an array or { value: [...] } with iteration id, name, path, and optional attributes.')
  if (partialOutput(meta, iterations.data.length)) throw new Error('ADO returned an incomplete team iteration list; provide an explicit full iteration path instead of a sprint URL.')
  const requested = parsed.sprint
  const matches = iterations.data.filter(iteration =>
    (!requested.id || iteration.id.toLowerCase() === requested.id.toLowerCase())
    && (!requested.path || classificationPath(iteration.path, parsed.source.project).toLowerCase() === requested.path.toLowerCase()),
  )
  if (matches.length !== 1) {
    throw new Error(`ADO sprint could not be resolved uniquely (${matches.length} matches). Verify the team and exact iteration path/ID, or provide a full iteration path.`)
  }
  const match = matches[0]!
  const path = classificationPath(match.path, parsed.source.project)
  parsed.source = { ...parsed.source, path }
  const start = isoDate(match.attributes?.startDate, 'Iteration start', warnings)
  const finish = isoDate(match.attributes?.finishDate, 'Iteration finish', warnings)
  return { name: match.name, id: match.id, path, ...(start ? { start } : {}), ...(finish ? { finish } : {}) }
}

async function selectIds(parsed: ParsedAdoSource, iteration: AdoSnapshot['iteration'], options: AdoOptions, read: Reader, warnings: Set<string>): Promise<{ ids: number[]; complete: boolean }> {
  if (iteration) {
    const result = iterationIds(await read('wit_work_item', {
      action: 'list_for_iteration', team: parsed.source.team, iterationId: iteration.id,
    }))
    const capped = result.ids.length >= options.maxItems
    if (capped) warnings.add(`Team iteration work-item cap (${options.maxItems}) reached; results are partial. Increase maxItems to hydrate the remaining membership.`)
    if (result.partial) warnings.add('ADO team iteration membership is truncated; results are partial and list_for_iteration exposes no continuation.')
    if (result.sourceOnly) warnings.add(`${result.sourceOnly} source-only parent references were excluded because links do not establish their team membership; completeness is unverified.`)
    return { ids: result.ids.slice(0, options.maxItems), complete: !capped && !result.partial && result.sourceOnly === 0 }
  }
  if (parsed.queryId) {
    const top = Math.min(1_000, options.maxItems)
    const result = queryIds(await read('wit_query', {
      action: 'get_results', id: parsed.queryId, top, ...(parsed.source.team ? { team: parsed.source.team } : {}),
    }))
    const complete = !result.partial && result.ids.length < top
    if (!complete) warnings.add(`Saved-query results are partial at the ${top}-item read limit or provider truncation. get_results exposes no continuation; narrow the saved query or use an explicit area/iteration path.`)
    return { ids: result.ids.slice(0, top), complete }
  }
  const ids: number[] = []
  let cursor = 0
  while (ids.length < options.maxItems) {
    const top = Math.min(1_000, options.pageSize, options.maxItems - ids.length)
    const result = queryIds(await read('wit_query', {
      action: 'wiql', wiql: scopeWiql(parsed.source, cursor), top,
      ...(parsed.source.team ? { team: parsed.source.team } : {}),
    }))
    if (result.ids.length > top) throw new Error('ADO WIQL response exceeded the requested page size; completeness cannot be established.')
    for (const id of result.ids) {
      if (id <= cursor) throw new Error('ADO WIQL pagination did not return strictly increasing IDs; refusing to skip or repeat work items.')
      cursor = id
      ids.push(id)
    }
    if (result.partial) {
      warnings.add('ADO marked a WIQL page incomplete; the result is partial and no undocumented continuation is attempted.')
      return { ids, complete: false }
    }
    if (ids.length === options.maxItems) {
      warnings.add(`Work-item cap (${options.maxItems}) reached; this is a partial result. Narrow the source or increase maxItems.`)
      return { ids, complete: false }
    }
    if (result.ids.length < top) return { ids, complete: true }
  }
  return { ids, complete: false }
}

async function hydrate(ids: number[], read: Reader, warnings: Set<string>): Promise<{ items: WorkItem[]; complete: boolean }> {
  const found = new Map<number, WorkItem>()
  let complete = true
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    // All fields preserve process-specific estimates; the returned relations are not aggregated.
    const response = batchItems(await read('wit_work_item', { action: 'get_batch', ids: batch, expand: 'Relations' }))
    const requested = new Set(batch)
    for (const item of response.items) {
      if (!requested.has(item.id) || found.has(item.id)) throw new Error('Unsupported ADO batch output: unexpected or duplicate work-item ID.')
      found.set(item.id, item)
    }
    complete &&= !response.partial
  }
  const missing = ids.filter(id => !found.has(id))
  if (missing.length) {
    complete = false
    warnings.add(`${missing.length} requested work items were not returned by hydration (deleted, inaccessible, or omitted); results are partial. Missing IDs: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', …' : ''}.`)
  }
  if (!complete && !missing.length) warnings.add('ADO batch hydration reported truncation; results are partial.')
  return { items: ids.flatMap(id => found.has(id) ? [found.get(id)!] : []), complete }
}

/** Load a bounded current-state snapshot. Tree queries and undocumented JSON envelopes fail explicitly. */
export async function loadAdo(mcp: ReadOnlyMcp, source: AdoSource, options: AdoOptions, signal: AbortSignal): Promise<AdoSnapshot> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || !Number.isSafeInteger(options.pageSize) || options.pageSize < 1
    || !Number.isFinite(options.staleDays) || options.staleDays < 0) {
    throw new Error('Invalid ADO limits: maxItems/pageSize must be positive integers and staleDays must be a nonnegative finite number.')
  }
  const now = options.now()
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid ADO snapshot clock.')
  const parsed = parseAdoSource(source)
  const warnings = new Set<string>()
  const read: Reader = async (operation, args) => {
    signal.throwIfAborted()
    const result = await mcp.call(operation, { orgName: parsed.source.orgName, project: parsed.source.project, ...args }, signal)
    signal.throwIfAborted()
    return result
  }
  const iteration = await resolveSprint(parsed, read, warnings)
  const selected = await selectIds(parsed, iteration, options, read, warnings)
  const hydrated = await hydrate(selected.ids, read, warnings)
  const scopedItems = iteration ? hydrated.items.filter(item =>
    requiredField(item, 'System.IterationPath').toLowerCase() === iteration.path.toLowerCase(),
  ) : hydrated.items
  if (scopedItems.length !== hydrated.items.length) warnings.add(`${hydrated.items.length - scopedItems.length} contextual work items outside the selected iteration were excluded from the team sprint.`)
  const metadata = new Map<string, Map<string, StateCategory>>()
  const items = []
  for (const item of scopedItems) {
    const type = requiredField(item, 'System.WorkItemType')
    const recordedProject = item.fields['System.TeamProject']
    if (recordedProject !== undefined && (typeof recordedProject !== 'string' || !recordedProject.trim())) {
      throw new Error(`Unsupported ADO work item ${item.id}: invalid System.TeamProject.`)
    }
    const project = typeof recordedProject === 'string' ? selectorName(recordedProject, 'work-item project') : parsed.source.project
    const key = `${project.toLowerCase()}\0${type.toLowerCase()}`
    let states = metadata.get(key)
    if (!states) {
      states = stateMetadata(await read('wit_work_item', { action: 'get_type', project, workItemType: type }), type, warnings)
      metadata.set(key, states)
    }
    items.push(normalizeItem(item, states, parsed.source.orgName, project, options, now.getTime(), warnings))
  }
  const types = [...new Set(items.map(item => item.type))].sort()
  const preferred = ['User Story', 'Product Backlog Item', 'Requirement', 'Task', 'Bug']
  const defaultType = preferred.find(type => types.includes(type)) ?? types[0] ?? ''
  if (types.length > 1) warnings.add(`Mixed work-item types are retained, not aggregated. The default view is "${defaultType}"; keep counts and estimate fields type-specific.`)
  if (defaultType && !preferred.includes(defaultType)) warnings.add(`No standard delivery-item type is present; "${defaultType}" is the default view, not an inferred delivery category.`)
  if (items.some(item => item.risks.includes('stale'))) warnings.add(`No update means System.ChangedDate is at least ${options.staleDays} days old; it does not prove that no work occurred.`)
  if (new Set(items.map(item => item.estimateField).filter(Boolean)).size > 1) warnings.add('StoryPoints, Effort, and Size are distinct estimate fields and must not be summed together. RemainingWork is separate, not points.')
  return {
    kind: 'ado', generatedAt: now.toISOString(), source: parsed.source, sourceUrl: parsed.sourceUrl,
    ...(iteration ? { iteration } : {}), items, complete: selected.complete && hydrated.complete, warnings: [...warnings], defaultType,
  }
}
