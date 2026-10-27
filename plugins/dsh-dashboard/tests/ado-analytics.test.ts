import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAdoAnalytics } from '../src/shared/ado-analytics.ts'
import { adoAnalyticsSettingsSchema, adoAnalyticsSnapshotSchema, adoHistorySchema, validateAdoHistory } from '../src/shared/ado-analytics-schema.ts'
import type { AdoHistory } from '../src/shared/ado-analytics-model.ts'
import { chatSelectionSchema, filtersSchema, type AdoChatSelection } from '../src/shared/chat.ts'
import { baseFilters, emptyFilters, filterItems, groupCounts, summarize } from '../src/shared/selection.ts'
import { batchItems, normalizeItem } from '../src/host/ado-data.ts'
import { assertReadOperation } from '../src/host/mcp.ts'
import { asOf, item, snapshot } from './ado-analytics-fixture.ts'

const filters = () => ({ ...emptyFilters(), type: 'Story' })

test('chart denominators exclude refinements, ownership retains all selected-type rows, and raw charts keep their scope', () => {
  const data = snapshot([
    item(1, { category: 'Completed', state: 'Delivered', risks: [] }),
    item(2, { risks: ['blocked', 'stale'], tags: ['release'] }),
    item(3, { assignee: 'Zed', assigneeId: 'zed', areaPath: 'Project\\Other', risks: ['unassigned'] }),
    item(4, { category: 'Unknown' }), item(5, { category: 'Removed' }),
    item(6, { type: 'Task', assignee: 'Task Owner', assigneeId: 'task' }),
  ])
  const selection = { ...filters(), person: 'alice', metric: 'remaining' as const, risk: 'blocked' as const }
  const original = structuredClone({ data, selection })
  const report = buildAdoAnalytics(data, selection)!
  assert.deepEqual(report.typeItemIds, [1, 2, 3, 4, 5])
  assert.deepEqual(report.baseItemIds, [1, 2, 4, 5])
  assert.deepEqual(report.matchingItemIds, [2])
  assert.deepEqual(report.totals, { completed: 1, remaining: 1, eligible: 2, percent: 50, unknown: 1, removed: 1, flagged: 1, unassigned: 0, blocked: 1 })
  assert.deepEqual(report.owners.map(row => [row.key, row.itemIds]), [['alice', [1, 2, 4, 5]], ['zed', [3]]])
  assert.equal(report.areas.length, 1)
  assert.equal(report.delivery.reduce((sum, row) => sum + row.count, 0), 4)
  assert.deepEqual(filterItems(data.items, selection), data.items.filter(row => row.id === 2))
  assert.equal(groupCounts(data.items.filter(row => row.type === 'Story'), 'person')[0]!.count, 4)
  assert.deepEqual({ data, selection }, original)
})

test('only Completed is complete; Unknown and Removed do not create progress or risk denominators', () => {
  const data = snapshot([
    item(1, { category: 'Resolved', state: 'Verified' }),
    item(2, { category: 'Unknown', risks: ['blocked'], estimate: 5, estimateField: 'points' }),
    item(3, { category: 'Removed', risks: ['unassigned'], estimate: 8, estimateField: 'points' }),
  ])
  const report = buildAdoAnalytics(data, filters())!
  assert.equal(report.totals.remaining, 1)
  assert.equal(report.totals.completed, 0)
  assert.equal(report.totals.flagged, 0)
  assert.equal(summarize(data.items).estimates.length, 0)
  const excluded = buildAdoAnalytics(snapshot(data.items.slice(1)), filters())!
  assert.equal(excluded.totals.percent, null)
  assert.equal(excluded.age.reduce((sum, row) => sum + row.count, 0), 0)
  delete data.analytics
  assert.equal(buildAdoAnalytics(data, filters()), null)
})

test('elapsed 24-hour age bands are half-open and missing, invalid, or future dates stay unknown', () => {
  const data = snapshot([
    item(1, { createdAt: '2026-09-06T12:00:00.001Z', stateChangedAt: '2026-09-06T12:00:00.000Z' }),
    item(2, { createdAt: '2026-09-06T12:00:00.000Z', stateChangedAt: undefined }),
    item(3, { createdAt: '2026-08-30T12:00:00.000Z', stateChangedAt: 'invalid' }),
    item(4, { createdAt: '2026-08-14T12:00:00.000Z', stateChangedAt: '2026-09-14T00:00:00Z' }),
    item(5, { createdAt: undefined }), item(6, { createdAt: 'not-a-date' }),
    item(7, { createdAt: '2026-09-13T12:00:00.001Z' }),
    item(8, { category: 'Completed', createdAt: undefined }),
  ])
  const report = buildAdoAnalytics(data, filters())!
  assert.deepEqual(report.age.map(row => [row.key, row.itemIds]), [
    ['lt-7', [1]], ['7-14', [2]], ['14-30', [3]], ['gte-30', [4]], ['unknown', [5, 6, 7]],
  ])
  assert.deepEqual(report.stateAge.find(row => row.key === 'unknown')!.itemIds, [2, 3, 4])
  assert.deepEqual(report.stateAge.find(row => row.key === '7-14')!.itemIds, [1])
})

test('overlapping risk flags form a distinct union while closure partitions remaining rows by priority', () => {
  const data = snapshot([
    item(1, { category: 'Resolved', risks: ['blocked', 'unassigned', 'overdue', 'stale'] }),
    item(2, { risks: ['unassigned', 'overdue', 'stale'] }),
    item(3, { category: 'Resolved', risks: ['overdue', 'stale'] }),
    item(4, { category: 'Resolved', risks: ['stale'] }),
    item(5, { risks: ['stale'] }), item(6), item(7, { category: 'Completed' }),
  ])
  const report = buildAdoAnalytics(data, filters())!
  assert.equal(report.totals.flagged, 5)
  assert.ok(report.risks.reduce((sum, row) => sum + row.count, 0) > report.totals.flagged)
  assert.deepEqual(report.closure.map(row => [row.key, row.itemIds]), [
    ['blocked', [1]], ['unassigned', [2]], ['overdue', [3]], ['resolved', [4]], ['stale', [5]], ['continue', [6]],
  ])
  assert.equal(report.closure.reduce((sum, row) => sum + row.count, 0), report.totals.remaining)
})

test('dependencies resolve only current snapshot IDs across types and distinguish absent knowledge from clear relations', () => {
  const data = snapshot([
    item(1, { predecessors: [20, null, 999] }),
    item(2, { predecessors: [21, 22] }),
    item(3, { predecessors: [21] }), item(4, { predecessors: [] }),
    item(5, { predecessors: undefined }), item(6, { predecessors: [23] }),
    item(7, { category: 'Unknown', predecessors: [20] }),
    item(8, { category: 'Completed', predecessors: [20] }),
    item(20, { type: 'Task', category: 'Resolved' }),
    item(21, { type: 'Task', category: 'Completed' }),
    item(22, { type: 'Task', category: 'Removed' }),
    item(23, { type: 'Task', category: 'Unknown' }),
  ])
  const report = buildAdoAnalytics(data, filters())!
  assert.deepEqual(report.dependencies.groups.map(row => [row.key, row.itemIds]), [
    ['open', [1]], ['unavailable', [2, 5, 6]], ['clear', [3, 4]],
  ])
  assert.deepEqual(report.dependencies.links.filter(link => link.itemId === 1), [
    { itemId: 1, predecessorId: 20, status: 'open' },
    { itemId: 1, predecessorId: null, status: 'unavailable' },
    { itemId: 1, predecessorId: 999, status: 'unavailable' },
  ])
  assert.equal(report.dependencies.links.some(link => link.itemId === 7 || link.itemId === 8), false)
  assert.equal(report.totals.blocked, 0)
})

test('every drill selects exactly its report row, validates keys, and does not narrow sibling chart denominators', () => {
  const data = snapshot([
    item(1), item(2, { areaPath: 'Project\\Other', createdAt: undefined, predecessors: [1], risks: ['blocked'] }),
    item(3, { category: 'Completed', predecessors: undefined }),
  ])
  const report = buildAdoAnalytics(data, filters())!
  const chartRows = {
    category: report.delivery, area: report.areas, age: report.age, stateAge: report.stateAge,
    dependency: report.dependencies.groups, closure: report.closure,
  }
  for (const [chart, rows] of Object.entries(chartRows)) {
    for (const row of rows) {
      const selection = filtersSchema.parse({ ...filters(), drill: { chart, key: row.key } })
      assert.deepEqual(filterItems(data.items, selection, data).map(row => row.id), row.itemIds)
      const drilled = buildAdoAnalytics(data, selection)!
      assert.deepEqual(drilled.matchingItemIds, row.itemIds)
      assert.deepEqual(drilled.baseItemIds, report.baseItemIds)
    }
  }
  const selection = { ...filters(), drill: { chart: 'age' as const, key: 'not-a-band' } }
  assert.throws(() => filterItems(data.items, selection), /snapshot/)
  assert.throws(() => filterItems(data.items, selection, data), /Unrecognized/)
  assert.throws(() => buildAdoAnalytics(data, { ...selection, person: 'nobody' }), /Unrecognized/)
  assert.deepEqual(baseFilters(selection), filters())
  assert.equal(selection.drill.key, 'not-a-band')
})

test('stale area and category selections remain exact empty selections after source refresh', () => {
  const refreshed = snapshot([item(1), item(2, { areaPath: 'Project\\Other', assignee: 'Bob', assigneeId: 'bob' })])
  for (const drill of [
    { chart: 'area', key: 'Project\\Area removed by refresh' },
    { chart: 'category', key: 'Completed' },
  ]) {
    const selection = filtersSchema.parse({ ...filters(), drill })
    assert.deepEqual(filterItems(refreshed.items, selection, refreshed), [])
    const report = buildAdoAnalytics(refreshed, selection)!
    assert.deepEqual(report.matchingItemIds, [])
    assert.deepEqual(report.baseItemIds, [1, 2])
    assert.equal(report.totals.remaining, 2)
  }
  const narrowed = filtersSchema.parse({ ...filters(), person: 'bob', drill: { chart: 'area', key: 'Project\\Area' } })
  assert.deepEqual(filterItems(refreshed.items, narrowed, refreshed), [])
  assert.deepEqual(buildAdoAnalytics(refreshed, narrowed)!.matchingItemIds, [])
  assert.deepEqual(buildAdoAnalytics(refreshed, narrowed)!.baseItemIds, [2])
})

test('self-describing age and state-age selections retain their original bounds after settings changes', () => {
  const data = snapshot([
    item(1, { createdAt: '2026-09-06T12:00:00.000Z', stateChangedAt: '2026-08-30T12:00:00.000Z' }),
    item(2, { createdAt: '2026-08-30T12:00:00.001Z', stateChangedAt: '2026-09-06T12:00:00.000Z' }),
    item(3, { createdAt: '2026-08-30T12:00:00.000Z', stateChangedAt: undefined }),
    item(4, { createdAt: '2026-08-14T12:00:00.000Z' }),
    item(5, { createdAt: '2026-09-12T12:00:00.000Z' }),
    item(6, { createdAt: undefined }),
  ], { ageBands: [3, 21] })
  for (const [chart, key, expected] of [
    ['age', '7-14', [1, 2]],
    ['stateAge', '7-14', [2]],
    ['age', 'lt-7', [5]],
    ['age', 'gte-30', [4]],
    ['age', 'unknown', [6]],
    ['stateAge', 'unknown', [3]],
  ] as const) {
    const selection = filtersSchema.parse({ ...filters(), drill: { chart, key } })
    assert.deepEqual(filterItems(data.items, selection, data).map(item => item.id), expected)
    const report = buildAdoAnalytics(data, selection)!
    assert.deepEqual(report.matchingItemIds, expected)
    assert.deepEqual(report.age.map(row => row.key), ['lt-3', '3-21', 'gte-21', 'unknown'])
  }
})

test('drill wire validation rejects malformed bounds and unknown closed keys without broadening a selection', () => {
  for (const chart of ['age', 'stateAge']) {
    for (const key of ['0-7', '7-7', '14-7', 'lt-0', 'gte-3651', '1-3651', 'lt-07', '7..14', 'unknownx', '', '7-14-extra', 'lt-Infinity']) {
      assert.equal(filtersSchema.safeParse({ ...filters(), drill: { chart, key } }).success, false, `${chart}/${key}`)
    }
  }
  for (const [chart, key] of [['category', 'Done'], ['dependency', 'blocked'], ['closure', 'open']]) {
    assert.equal(filtersSchema.safeParse({ ...filters(), drill: { chart, key } }).success, false)
    assert.throws(() => buildAdoAnalytics(snapshot([item(1)]), {
      ...filters(), drill: { chart: chart as 'category' | 'dependency' | 'closure', key: key! },
    }), /Unrecognized/)
  }
})

test('new wire fields remain omitted for old selection fingerprints and reject unknown discriminants', () => {
  const old = { view: 'ado' as const, filters: filters(), selectedItem: null, sort: 'id', direction: 'asc', page: 0, pageSize: 25, stale: false }
  assert.equal(JSON.stringify(chatSelectionSchema.parse(old)), JSON.stringify(old))
  assert.equal(Object.hasOwn(filtersSchema.parse(filters()), 'drill'), false)
  const next = { ...old, analyticsVersion: 1, filters: { ...filters(), drill: { chart: 'closure', key: 'continue' } } }
  assert.deepEqual(chatSelectionSchema.parse(next), next)
  assert.throws(() => chatSelectionSchema.parse({ ...old, analyticsVersion: 2 }))
  assert.throws(() => filtersSchema.parse({ ...filters(), drill: { chart: 'forecast', key: 'x' } }))
  assert.throws(() => filtersSchema.parse({ ...filters(), drill: { chart: 'age', key: 'x', extra: true } }))
})

test('public chat selections remain assignable to the parsed wire type without narrowing the frozen drill model', () => {
  const selection: AdoChatSelection = {
    view: 'ado', analyticsVersion: 1, filters: { ...filters(), drill: { chart: 'closure', key: 'continue' } },
    selectedItem: null, sort: 'id', direction: 'asc', page: 0, pageSize: 25, stale: false,
  }
  const wire: ReturnType<typeof chatSelectionSchema.parse> = selection
  assert.deepEqual(chatSelectionSchema.parse(wire), selection)
})

test('settings enforce all bounds, ascending bands, and the effective window limit', () => {
  assert.deepEqual(adoAnalyticsSettingsSchema.parse({}), {
    ageBands: [7, 14, 30], historyDays: 30, maxHistoryDays: 120, maxHistoryItems: 200,
    maxRevisionsPerItem: 1000, revisionPageSize: 50, historyConcurrency: 4, historyTimeoutMs: 120000, maxHistoryRequests: 400,
  })
  for (const invalid of [
    { ageBands: [] }, { ageBands: [7, 7] }, { ageBands: [14, 7] }, { ageBands: [0] }, { ageBands: [3651] },
    { ageBands: [1, 2, 3, 4, 5, 6, 7] }, { ageBands: [1.5] }, { historyDays: 0 },
    { historyDays: 121 }, { maxHistoryDays: 367 }, { maxHistoryItems: 1001 }, { maxHistoryItems: 0 },
    { maxRevisionsPerItem: 10001 }, { revisionPageSize: 201 }, { historyConcurrency: 9 },
    { historyTimeoutMs: 999 }, { historyTimeoutMs: 300001 }, { maxHistoryRequests: 5001 }, { extra: true },
  ]) assert.equal(adoAnalyticsSettingsSchema.safeParse(invalid).success, false, JSON.stringify(invalid))
})

test('wire snapshots require all resolved settings while configuration alone supplies defaults', () => {
  const defaults = adoAnalyticsSettingsSchema.parse({})
  const analytics = { version: 1, timeZone: 'UTC', settings: defaults }
  assert.deepEqual(adoAnalyticsSnapshotSchema.parse(analytics), analytics)
  assert.equal(adoAnalyticsSnapshotSchema.safeParse({ ...analytics, settings: {} }).success, false)
  for (const field of Object.keys(defaults)) {
    const partial: Record<string, unknown> = { ...defaults }
    delete partial[field]
    assert.equal(adoAnalyticsSnapshotSchema.safeParse({ ...analytics, settings: partial }).success, false, field)
    assert.equal(adoAnalyticsSnapshotSchema.safeParse({ ...analytics, settings: { ...defaults, [field]: undefined } }).success, false, field)
  }
  assert.deepEqual(adoAnalyticsSettingsSchema.parse({ ageBands: undefined }), defaults)
})

test('history wire validation rejects impossible partitions, dates, categories, ranges, and snapshot cohorts', () => {
  const data = snapshot([item(1), item(2)], { historyDays: 2 })
  const history: AdoHistory = {
    basis: 'current-cohort', type: 'Story', status: 'partial', fetchedAt: asOf,
    range: { start: '2026-09-12', finish: '2026-09-13', timeZone: 'UTC', source: 'recent', clipped: false },
    requestedItemIds: [1, 2], items: [{ id: 1, changes: [{ at: '2026-09-12T00:00:00.000Z', category: 'InProgress' }] }],
    omitted: [{ id: 2, reason: 'Unavailable' }], warnings: [],
  }
  assert.deepEqual(validateAdoHistory(history, data), history)
  const invalids = [
    { ...history, requestedItemIds: [1, 1] }, { ...history, omitted: [] },
    { ...history, omitted: [{ id: 1, reason: 'Unavailable' }] },
    { ...history, status: 'complete' }, { ...history, range: null },
    { ...history, range: { ...history.range, start: '2026-09-31' } },
    { ...history, range: { ...history.range, finish: '2026-09-01' } },
    { ...history, items: [{ id: 1, changes: [] }] },
    { ...history, items: [{ id: 1, changes: [{ at: asOf, category: 'Done' }] }] },
    { ...history, items: [{ id: 1, changes: [...history.items[0]!.changes, ...history.items[0]!.changes] }] },
  ]
  for (const invalid of invalids) assert.equal(adoHistorySchema.safeParse(invalid).success, false)
  assert.throws(() => validateAdoHistory({ ...history, type: 'Task' }, data), /type/)
  assert.throws(() => validateAdoHistory({ ...history, requestedItemIds: [1, 3], omitted: [{ id: 3, reason: 'Unavailable' }] }, data), /cohort/)
  assert.throws(() => validateAdoHistory({ ...history, range: { ...history.range, finish: '2026-09-14' } }, data), /snapshot date/)
  assert.throws(() => validateAdoHistory({ ...history, items: [{ id: 1, changes: [{ at: '2026-09-14T00:00:00Z', category: 'InProgress' }] }] }, data), /snapshot timestamp/)
  assert.throws(() => validateAdoHistory({ ...history, range: { ...history.range, start: '2026-09-11' } }, data), /snapshot settings/)
  assert.throws(() => validateAdoHistory(history, { ...data, items: [item(1, { revision: undefined }), item(2)] }), /revision fence/)
  assert.throws(() => validateAdoHistory({
    ...history, items: [{ id: 1, changes: [...history.items[0]!.changes, { at: asOf, category: 'Completed' }] }],
  }, data), /revision fence/)
  assert.throws(() => validateAdoHistory(history, { ...data, analytics: { ...data.analytics!, settings: { ...data.analytics!.settings, maxHistoryItems: 1 } } }), /cohort limit/)
  assert.equal(adoAnalyticsSnapshotSchema.safeParse({ ...data.analytics, history: { ...history, range: { ...history.range, timeZone: 'America/Los_Angeles' } } }).success, false)
  assert.equal(adoAnalyticsSnapshotSchema.safeParse({ ...data.analytics, timeZone: 'not/a-zone' }).success, false)
})

test('batch normalization retains valid fences and dates, and never mistakes unresolved links for no predecessors', () => {
  const raw = {
    id: 1, rev: 7,
    fields: {
      'System.Title': 'Synthetic', 'System.WorkItemType': 'Story', 'System.State': 'Doing',
      'System.AreaPath': 'Project\\Area', 'System.IterationPath': 'Project\\Sprint',
      'System.CreatedDate': '2026-09-01', 'System.ChangedDate': asOf,
      'Microsoft.VSTS.Common.StateChangeDate': 'bad-date',
    },
    relations: [
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/example-org/Project/_apis/wit/workitems/20' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://example-org.visualstudio.com/DefaultCollection/_apis/wit/workItems/21' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/other-org/Project/_apis/wit/workitems/22' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://example.invalid/_apis/wit/workitems/23' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/example-org/_apis/wit/workitems/24?token=fixture' },
      { rel: 'System.LinkTypes.Dependency-Forward', url: 'https://dev.azure.com/example-org/_apis/wit/workitems/25' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/example-org/Project/_workitems/edit/26' },
      { rel: 'System.LinkTypes.Dependency-Reverse', url: 'https://dev.azure.com/example-org/_apis%2Fwit%2Fworkitems%2F27' },
    ],
  }
  const warnings = new Set<string>()
  const options = { maxItems: 10, pageSize: 10, staleDays: 7, blockedTags: [], now: () => new Date(asOf) }
  const normalized = normalizeItem(batchItems([raw]).items[0]!, new Map([['doing', 'InProgress']]), 'example-org', 'Project', options, Date.parse(asOf), warnings)
  assert.equal(normalized.revision, 7)
  assert.equal(normalized.project, 'Project')
  assert.equal(normalized.createdAt, '2026-09-01T00:00:00.000Z')
  assert.equal(normalized.stateChangedAt, undefined)
  assert.deepEqual(normalized.predecessors, [20, 21, null, null, null, 26, null])
  assert.ok([...warnings].some(message => message.includes('predecessor')))
  assert.equal([...warnings].some(message => message.includes('token=fixture')), false)
  const oldRaw = { ...raw, rev: undefined, relations: undefined }
  const old = normalizeItem(batchItems([oldRaw]).items[0]!, new Map([['doing', 'InProgress']]), 'example-org', 'Project', options, Date.parse(asOf), new Set())
  assert.equal(old.revision, undefined)
  assert.deepEqual(old.predecessors, [])
  for (const rev of [null, '7', 0, -1, 1.5, NaN, Infinity]) assert.throws(() => batchItems([{ ...raw, rev }]))
  for (const relations of [null, {}, [{ rel: 'System.LinkTypes.Dependency-Reverse' }], [{ rel: 1, url: 'x' }]]) {
    assert.throws(() => batchItems([{ ...raw, relations }]))
  }
  assert.doesNotThrow(() => assertReadOperation('ado', 'wit_work_item', { orgName: 'example-org', project: 'Project', action: 'list_revisions' }))
  assert.throws(() => assertReadOperation('ado', 'wit_work_item_write', { orgName: 'example-org', project: 'Project', action: 'list_revisions' }))
})
