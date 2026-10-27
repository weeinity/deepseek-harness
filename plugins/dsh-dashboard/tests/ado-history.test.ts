import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAdoHistory, type AdoHistoryRuntime } from '../src/host/ado-history.ts'
import { adoHistoryRange, projectAdoHistory } from '../src/shared/ado-history.ts'
import { buildAdoAnalytics } from '../src/shared/ado-analytics.ts'
import { emptyFilters } from '../src/shared/selection.ts'
import type { AdoSnapshot, ReadOnlyMcp } from '../src/shared/types.ts'
import { asOf, counts, deferred, item, metadata, revision, snapshot } from './ado-analytics-fixture.ts'

const signal = () => new AbortController().signal
const clock: AdoHistoryRuntime = { now: () => new Date('2026-09-13T13:00:00.000Z') }
type Call = { operation: string; args: Record<string, unknown>; signal: AbortSignal }

function provider(rows: Map<number, unknown[]>, override?: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = []
  const mcp: ReadOnlyMcp = {
    async call(operation, args, signal) {
      const call = { operation, args, signal }
      calls.push(call)
      assert.equal(operation, 'wit_work_item')
      assert.equal(args.orgName, 'example-org')
      assert.equal(typeof args.project, 'string')
      if (override) return override(call)
      if (args.action === 'get_type') return metadata
      assert.equal(args.action, 'list_revisions')
      assert.equal(args.expand, 'Fields')
      assert.ok(Number.isInteger(args.skip) && Number(args.skip) >= 0)
      assert.ok(Number.isInteger(args.top) && Number(args.top) >= 1 && Number(args.top) <= 200)
      return rows.get(Number(args.workItemId))!.slice(Number(args.skip), Number(args.skip) + Number(args.top))
    },
  }
  return { mcp, calls }
}

async function history(data: AdoSnapshot, rows: Map<number, unknown[]>) {
  const fixture = provider(rows)
  const result = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
  data.analytics!.history = result
  return { ...fixture, result }
}

test('revision reads use bounded exact pages, stop at captured fences, and discard unrelated fields', async () => {
  const rows = [
    revision(1, 1, '2026-08-01T00:00:00Z', 'New', { 'System.Description': '<large>' + 'x'.repeat(100000) }),
    revision(1, 2, '2026-08-02T00:00:00Z', 'Doing'),
    revision(1, 3, '2026-09-11T01:00:00Z', 'Doing', { 'System.AssignedTo': { uniqueName: 'private@example.invalid' } }),
    revision(1, 4, '2026-09-12T01:00:00Z', 'Delivered'),
    revision(1, 5, '2026-09-13T13:00:00Z', 'Doing'),
  ]
  const data = snapshot([item(1, { revision: 4, category: 'Completed' })], { historyDays: 3, revisionPageSize: 2 })
  const { result, calls } = await history(data, new Map([[1, rows]]))
  assert.equal(result.status, 'complete')
  assert.equal(result.fetchedAt, '2026-09-13T13:00:00.000Z')
  assert.deepEqual(calls.map(call => [call.args.action, call.args.skip, call.args.top]), [
    ['get_type', undefined, undefined], ['list_revisions', 0, 2], ['list_revisions', 2, 2],
  ])
  assert.deepEqual(result.items, [{
    id: 1, changes: [
      { at: '2026-08-01T00:00:00.000Z', category: 'Proposed' },
      { at: '2026-08-02T00:00:00.000Z', category: 'InProgress' },
      { at: '2026-09-12T01:00:00.000Z', category: 'Completed' },
    ],
  }])
  assert.equal(JSON.stringify(result).includes('<large>'), false)
  assert.equal(JSON.stringify(result).includes('private@example.invalid'), false)
  assert.match(result.warnings.join('\n'), /current cohort/)
})

test('standard paginated total metadata describes all revisions without making each complete page partial', async () => {
  const data = snapshot([item(1, { revision: 2 })], { revisionPageSize: 1 })
  const rows = [revision(1, 1, '2026-09-10T00:00:00Z', 'New'), revision(1, 2, '2026-09-11T00:00:00Z', 'Doing')]
  for (const key of ['value', 'items']) {
    const fixture = provider(new Map(), ({ args }) => args.action === 'get_type' ? metadata
      : { [key]: rows.slice(Number(args.skip), Number(args.skip) + Number(args.top)), totalCount: 12, hasMore: true })
    assert.equal((await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)).status, 'complete')
  }
})

test('daily occupancy distinguishes not-created and Unknown, and completion/reopening IDs are distinct within each day', async () => {
  const data = snapshot([
    item(1, { revision: 6, category: 'Completed' }),
    item(2, { revision: 2 }), item(3, { revision: undefined }),
  ], { historyDays: 4 })
  const { result } = await history(data, new Map([
    [1, [
      revision(1, 1, '2026-09-10T00:00:00Z', 'New'),
      revision(1, 2, '2026-09-11T01:00:00Z', 'Delivered'),
      revision(1, 3, '2026-09-11T02:00:00Z', 'Doing'),
      revision(1, 4, '2026-09-11T03:00:00Z', 'Delivered'),
      revision(1, 5, '2026-09-12T01:00:00Z', 'Verified'),
      revision(1, 6, '2026-09-13T01:00:00Z', 'Delivered'),
    ]],
    [2, [revision(2, 1, '2026-09-12T02:00:00Z', 'Historical custom state'), revision(2, 2, '2026-09-13T02:00:00Z', 'Doing')]],
  ]))
  assert.equal(result.status, 'partial')
  const report = projectAdoHistory(data, 'Story', [1, 2, 3])!
  assert.equal(report.availableCount, 2)
  assert.equal(report.requestedCount, 3)
  assert.deepEqual(report.omittedItemIds, [3])
  assert.deepEqual(report.points.map(point => point.date), ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'])
  assert.deepEqual(report.points.map(point => point.notCreated), [1, 1, 0, 0])
  assert.deepEqual(report.points.map(point => point.counts.Completed), [0, 1, 0, 1])
  assert.deepEqual(report.points.map(point => point.completedItemIds), [[], [1], [], [1]])
  assert.deepEqual(report.points.map(point => point.reopenedItemIds), [[], [1], [1], []])
  assert.equal(report.points[2]!.counts.Unknown, 1)
  for (const point of report.points) assert.equal(Object.values(point.counts).reduce((sum, count) => sum + count, point.notCreated), report.availableCount)
  assert.ok(result.warnings.some(warning => warning.includes('Unknown')))
  assert.equal(projectAdoHistory(data, 'Task', [1]), null)
  assert.deepEqual(projectAdoHistory(data, 'Story', [3])!.points, [])
  assert.equal(projectAdoHistory(data, 'Story', [3])!.status, 'unavailable')
})

test('history uses base IDs rather than metric/risk/drill rows and discloses partial source coverage', async () => {
  const data = snapshot([item(1, { risks: ['blocked'] }), item(2), item(3, { assigneeId: 'zed', assignee: 'Zed' })], { historyDays: 1 })
  data.complete = false
  await history(data, new Map(data.items.map(row => [row.id, [revision(row.id, 1, '2026-09-12T00:00:00Z', 'Doing')]])))
  const report = buildAdoAnalytics(data, {
    ...emptyFilters(), type: 'Story', person: 'alice', risk: 'blocked',
    drill: { chart: 'closure', key: 'blocked' },
  })!
  assert.deepEqual(report.matchingItemIds, [1])
  assert.deepEqual(report.baseItemIds, [1, 2])
  assert.equal(report.history!.availableCount, 2)
  assert.deepEqual(report.history!.points[0]!.counts, counts('InProgress', 2))
  assert.ok(report.history!.warnings.some(warning => warning.includes('source coverage is partial')))
})

test('calendar ranges include iteration finish days, use DST calendar arithmetic, and clip disclosed oversized windows', () => {
  const data = snapshot([item(1)], { historyDays: 3, maxHistoryDays: 3 })
  data.analytics!.timeZone = 'America/Los_Angeles'
  data.generatedAt = '2026-03-09T18:00:00.000Z'
  assert.deepEqual(adoHistoryRange(data).range, {
    start: '2026-03-07', finish: '2026-03-09', timeZone: 'America/Los_Angeles', source: 'recent', clipped: false,
  })
  data.iteration = { name: 'Sprint', path: 'Project\\Sprint', id: 'synthetic', start: '2026-03-01T00:00:00.000Z', finish: '2026-03-08T00:00:00.000Z' }
  const clipped = adoHistoryRange(data)
  assert.equal(clipped.range!.start, '2026-03-06')
  assert.equal(clipped.range!.finish, '2026-03-08')
  assert.equal(clipped.range!.clipped, true)
  assert.match(clipped.warnings[0]!, /clipped/)
  data.iteration.start = '2026-03-10T00:00:00.000Z'
  data.iteration.finish = '2026-03-15T00:00:00.000Z'
  assert.equal(adoHistoryRange(data).range, null)
  assert.match(adoHistoryRange(data).reason!, /not started/)
  data.iteration.start = undefined
  assert.match(adoHistoryRange(data).reason!, /valid start/)
  data.iteration.start = '2026-03-01garbage'
  assert.match(adoHistoryRange(data).reason!, /valid start/)
})

test('daily endpoints honor short and long DST days and cap the current day at snapshot time', async () => {
  for (const [generatedAt, firstDate, observations, expected] of [
    ['2026-03-09T18:00:00.000Z', '2026-03-07', [
      ['2026-03-08T07:59:00Z', 'New'], ['2026-03-09T06:59:00Z', 'Delivered'], ['2026-03-09T07:01:00Z', 'Doing'],
    ], ['Proposed', 'Completed', 'InProgress']],
    ['2026-11-02T18:00:00.000Z', '2026-10-31', [
      ['2026-11-01T06:59:00Z', 'New'], ['2026-11-02T07:59:00Z', 'Delivered'], ['2026-11-02T08:01:00Z', 'Doing'],
    ], ['Proposed', 'Completed', 'InProgress']],
  ] as const) {
    const data = snapshot([item(1, { revision: 3 })], { historyDays: 3 })
    data.generatedAt = generatedAt
    data.analytics!.timeZone = 'America/Los_Angeles'
    await history(data, new Map([[1, observations.map(([at, state], index) => revision(1, index + 1, at, state))]]))
    const report = projectAdoHistory(data, 'Story', [1])!
    assert.equal(report.points[0]!.date, firstDate)
    assert.deepEqual(report.points.map(point => Object.entries(point.counts).find(([, value]) => value === 1)![0]), expected)
  }
  const data = snapshot([item(1, { revision: 2 })], { historyDays: 1 })
  const { result } = await history(data, new Map([[1, [
    revision(1, 1, '2026-09-13T11:00:00Z', 'New'), revision(1, 2, '2026-09-13T13:00:00Z', 'Delivered'),
  ]]]))
  assert.equal(result.status, 'unavailable')
  assert.match(result.omitted[0]!.reason, /later than the snapshot/)
})

test('initial observations survive compression and items created after a finished iteration are not invented earlier', async () => {
  const data = snapshot([item(1, { revision: 5 }), item(2)], { maxHistoryDays: 30 })
  data.iteration = { name: 'Sprint', path: 'Project\\Sprint', id: 'synthetic', start: '2026-09-10', finish: '2026-09-11' }
  const { result } = await history(data, new Map([
    [1, [
      revision(1, 1, '2026-08-01T00:00:00Z', 'New'),
      revision(1, 2, '2026-08-02T00:00:00Z', 'Doing'),
      revision(1, 3, '2026-08-03T00:00:00Z', 'Delivered'),
      revision(1, 4, '2026-08-04T00:00:00Z', 'Doing'),
      revision(1, 5, '2026-09-12T00:00:00Z', 'Delivered'),
    ]],
    [2, [revision(2, 1, '2026-09-12T00:00:00Z', 'New')]],
  ]))
  assert.deepEqual(result.items[0]!.changes.map(change => change.at), ['2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z'])
  const report = projectAdoHistory(data, 'Story', [1, 2])!
  assert.deepEqual(report.points.map(point => point.notCreated), [1, 1])
  assert.deepEqual(report.points.map(point => point.counts.InProgress), [1, 1])
})

test('cohort cap and unavailable ranges perform no provider reads, rather than returning a sampled history', async () => {
  const fixture = provider(new Map(), () => { throw new Error('No request permitted') })
  const data = snapshot([item(1), item(2)], { maxHistoryItems: 1 })
  const capped = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
  assert.equal(capped.status, 'unavailable')
  assert.deepEqual(capped.requestedItemIds, [1, 2])
  assert.deepEqual(capped.omitted.map(row => row.id), [1, 2])
  assert.match(capped.warnings.join('\n'), /narrow the source/)
  data.analytics!.settings.maxHistoryItems = 2
  data.iteration = { name: 'Future', path: 'Project\\Future', id: 'synthetic', start: '2026-10-01', finish: '2026-10-14' }
  const future = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
  assert.equal(future.range, null)
  assert.match(future.omitted[0]!.reason, /not started/)
  assert.equal(fixture.calls.length, 0)
  await assert.rejects(loadAdoHistory(fixture.mcp, data, 'Task', signal(), clock), /exact existing/)
  delete data.analytics
  await assert.rejects(loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock), /metadata/)
})

test('missing fences and revision caps are explicit omissions without even a metadata request', async () => {
  const data = snapshot([item(1, { revision: undefined }), item(2, { revision: 4 })], { maxRevisionsPerItem: 3 })
  const fixture = provider(new Map(), () => { throw new Error('No request permitted') })
  const result = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
  assert.equal(fixture.calls.length, 0)
  assert.equal(result.status, 'unavailable')
  assert.match(result.omitted[0]!.reason, /fence/)
  assert.match(result.omitted[1]!.reason, /not sampled/)
})

test('malformed, extra, short, duplicate, reordered, wrong-item, and gapped revision pages omit the entire item', async t => {
  const first = revision(1, 1, '2026-09-11T00:00:00Z', 'New')
  const second = revision(1, 2, '2026-09-12T00:00:00Z', 'Doing')
  const cases: Record<string, unknown> = {
    empty: [], short: [first], extra: [first, second, revision(1, 3, '2026-09-13T00:00:00Z', 'Doing')],
    duplicate: [first, first], reordered: [second, first], gap: [first, { ...second, rev: 3 }],
    wrongItem: [first, { ...second, id: 2 }], missingField: [first, { ...second, fields: {} }],
    sameDate: [first, revision(1, 2, '2026-09-11T00:00:00Z', 'Doing')],
    backwardsDate: [first, revision(1, 2, '2026-09-10T00:00:00Z', 'Doing')],
    malformedDate: [first, revision(1, 2, 'not-a-date', 'Doing')],
    unknownEnvelope: { revisions: [first, second] },
    ambiguousEnvelope: { value: [first, second], items: [first, second] },
    invalidCount: { value: [first, second], totalCount: 1 },
    invalidFlag: { value: [first, second], truncated: 'yes' },
    truncated: { value: [first, second], isTruncated: true },
    errorEnvelope: { value: [first, second], error: 'private-provider-diagnostic' },
  }
  for (const [name, output] of Object.entries(cases)) await t.test(name, async () => {
    const data = snapshot([item(1, { revision: 2 })])
    const fixture = provider(new Map(), ({ args }) => args.action === 'get_type' ? metadata : output)
    const result = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
    assert.equal(result.status, 'unavailable')
    assert.deepEqual(result.items, [])
    assert.deepEqual(result.omitted.map(row => row.id), [1])
    assert.equal(JSON.stringify(result).includes('private-provider-diagnostic'), false)
  })
})

test('current metadata never guesses Completed from a historical state name or maps historical type/project changes', async () => {
  const rows = new Map([[1, [revision(1, 1, '2026-09-12T00:00:00Z', 'Completed')]]])
  const { result } = await history(snapshot([item(1)]), rows)
  assert.equal(result.items[0]!.changes[0]!.category, 'Unknown')
  for (const fields of [{ 'System.WorkItemType': 'Task' }, { 'System.TeamProject': 'Other project' }]) {
    const { result } = await history(snapshot([item(1)]), new Map([[1, [revision(1, 1, '2026-09-12T00:00:00Z', 'Doing', fields)]]]))
    assert.equal(result.status, 'unavailable')
    assert.match(result.omitted[0]!.reason, /historical type or project/)
  }
})

test('provider errors and malformed metadata become sanitized omissions, never zero observations', async () => {
  for (const action of ['get_type', 'list_revisions']) {
    const fixture = provider(new Map(), ({ args }) => {
      if (args.action === action) throw new Error('token=do-not-persist private diagnostic and https://example.invalid')
      return metadata
    })
    const result = await loadAdoHistory(fixture.mcp, snapshot([item(1)]), 'Story', signal(), clock)
    assert.equal(result.status, 'unavailable')
    assert.match(result.omitted[0]!.reason, /provider/)
    assert.doesNotMatch(JSON.stringify(result), /do-not-persist|private diagnostic|example.invalid/)
  }
  const fixture = provider(new Map(), () => ({ name: 'Wrong type', states: [] }))
  const result = await loadAdoHistory(fixture.mcp, snapshot([item(1)]), 'Story', signal(), clock)
  assert.match(result.omitted[0]!.reason, /metadata/)
})

test('the shared request budget includes current-type metadata and never launches requests beyond the cap', async () => {
  const data = snapshot([item(1, { revision: 2 }), item(2, { revision: 2 })], {
    revisionPageSize: 1, maxHistoryRequests: 3, historyConcurrency: 1,
  })
  const rows = new Map(data.items.map(row => [row.id, [
    revision(row.id, 1, '2026-09-11T00:00:00Z', 'New'), revision(row.id, 2, '2026-09-12T00:00:00Z', 'Doing'),
  ]]))
  const { result, calls } = await history(data, rows)
  assert.equal(calls.length, 3)
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.items.map(row => row.id), [1])
  assert.deepEqual(result.omitted.map(row => row.id), [2])
  assert.match(result.omitted[0]!.reason, /budget/)
  const concurrent = snapshot([1, 2, 3, 4, 5].map(id => item(id)), { maxHistoryRequests: 3, historyConcurrency: 4 })
  const concurrentResult = await history(concurrent, new Map(concurrent.items.map(row => [
    row.id, [revision(row.id, 1, '2026-09-12T00:00:00Z', 'Doing')],
  ])))
  assert.equal(concurrentResult.calls.length, 3)
  assert.equal(concurrentResult.result.items.length, 2)
  assert.equal(concurrentResult.result.omitted.length, 3)
})

test('workers overlap only up to configured concurrency and share metadata per current project', { timeout: 10000 }, async t => {
  const firstTwoStarted = deferred()
  const release = deferred()
  let active = 0
  let maximum = 0
  let started = 0
  const data = snapshot([1, 2, 3, 4, 5].map(id => item(id, { project: id < 3 ? 'Project' : 'Other' })), { historyConcurrency: 2 })
  const fixture = provider(new Map(), async ({ args }) => {
    if (args.action === 'get_type') return metadata
    active++
    maximum = Math.max(maximum, active)
    const ordinal = ++started
    if (started === 2) firstTwoStarted.resolve()
    try {
      if (ordinal <= 2) await release.promise
      return [revision(Number(args.workItemId), 1, '2026-09-12T00:00:00Z', 'Doing')]
    } finally {
      active--
    }
  })
  const pending = loadAdoHistory(fixture.mcp, data, 'Story', t.signal, clock)
  t.after(async () => {
    release.resolve()
    await Promise.allSettled([pending])
  })
  try {
    await firstTwoStarted.promise
    assert.equal(started, 2)
    assert.equal(active, 2)
  } finally {
    release.resolve()
  }
  const result = await pending
  assert.equal(result.status, 'complete')
  assert.equal(maximum, 2)
  assert.equal(active, 0)
  assert.equal(started, 5)
  assert.deepEqual(fixture.calls.filter(call => call.args.action === 'get_type').map(call => call.args.project).sort(), ['Other', 'Project'])
})

test('caller abort rejects only after all overlapping provider calls settle and never starts queued items', { timeout: 10000 }, async t => {
  const controller = new AbortController()
  const started = deferred()
  const aborted = [deferred(), deferred()]
  const release = [deferred(), deferred()]
  const settledReads = [deferred(), deferred()]
  let count = 0
  let settled = false
  const fixture = provider(new Map(), async ({ args, signal }) => {
    if (args.action === 'get_type') return metadata
    const index = count++
    signal.addEventListener('abort', () => aborted[index]!.resolve(), { once: true })
    if (count === 2) started.resolve()
    try {
      await release[index]!.promise
      signal.throwIfAborted()
      return []
    } finally {
      settledReads[index]!.resolve()
    }
  })
  const reason = new Error('Synthetic caller cancellation')
  const pending = loadAdoHistory(fixture.mcp, snapshot([item(1), item(2), item(3)], { historyConcurrency: 2 }), 'Story', controller.signal, clock)
  t.after(async () => {
    controller.abort(reason)
    for (const gate of release) gate.resolve()
    await Promise.allSettled([pending])
  })
  void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await started.promise
    controller.abort(reason)
    await Promise.all(aborted.map(event => event.promise))
    assert.equal(settled, false)
    release[0]!.resolve()
    await settledReads[0]!.promise
    assert.equal(settled, false)
    assert.equal(count, 2)
  } finally {
    for (const gate of release) gate.resolve()
  }
  await assert.rejects(pending, error => error === reason)
  await Promise.all(settledReads.map(event => event.promise))
  assert.equal(settled, true)
  assert.equal(count, 2)
})

test('own deadline returns explicit partial coverage after quiescence and clears its instance-local timer', { timeout: 10000 }, async t => {
  const secondStarted = deferred()
  const abortObserved = deferred()
  const release = deferred()
  let expire!: () => void
  let cleared = false
  let reads = 0
  let settled = false
  const fixture = provider(new Map(), async ({ args, signal }) => {
    if (args.action === 'get_type') return metadata
    reads++
    if (reads === 1) return [revision(Number(args.workItemId), 1, '2026-09-12T00:00:00Z', 'Doing')]
    signal.addEventListener('abort', () => abortObserved.resolve(), { once: true })
    secondStarted.resolve()
    await release.promise
    signal.throwIfAborted()
    return []
  })
  const pending = loadAdoHistory(fixture.mcp, snapshot([item(1), item(2), item(3)], { historyConcurrency: 1 }), 'Story', t.signal, {
    ...clock,
    scheduleTimeout(milliseconds, callback) {
      assert.equal(milliseconds, 120000)
      expire = callback
      return () => { cleared = true }
    },
  })
  t.after(async () => {
    release.resolve()
    await Promise.allSettled([pending])
  })
  void pending.then(() => { settled = true }, () => { settled = true })
  try {
    await secondStarted.promise
    expire()
    await abortObserved.promise
    assert.equal(settled, false)
    assert.equal(cleared, false)
  } finally {
    release.resolve()
  }
  const result = await pending
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.items.map(row => row.id), [1])
  assert.deepEqual(result.omitted.map(row => row.id), [2, 3])
  assert.equal(reads, 2)
  assert.equal(cleared, true)
  assert.ok(result.warnings.some(warning => warning.includes('deadline')))
})

test('an already-aborted caller performs no work and unavailable history produces no zero-filled timeline', async () => {
  const controller = new AbortController()
  const reason = new Error('Cancelled before admission')
  controller.abort(reason)
  const fixture = provider(new Map(), () => { throw new Error('No call permitted') })
  const data = snapshot([item(1, { revision: undefined })])
  await assert.rejects(loadAdoHistory(fixture.mcp, data, 'Story', controller.signal, clock), error => error === reason)
  data.analytics!.history = await loadAdoHistory(fixture.mcp, data, 'Story', signal(), clock)
  const report = projectAdoHistory(data, 'Story', [1])!
  assert.equal(report.status, 'unavailable')
  assert.equal(report.availableCount, 0)
  assert.deepEqual(report.omittedItemIds, [1])
  assert.deepEqual(report.points, [])
  assert.equal(fixture.calls.length, 0)
  assert.equal(projectAdoHistory(snapshot([item(1)]), 'Story', [1]), null)
})
