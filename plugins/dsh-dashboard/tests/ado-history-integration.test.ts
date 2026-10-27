import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DashboardHistoryReads } from '../src/host/history-context.ts'
import { SnapshotContexts } from '../src/host/snapshot-context.ts'
import { adoAnalyticsSettingsSchema } from '../src/shared/ado-analytics-schema.ts'
import type { AdoHistory } from '../src/shared/ado-analytics-model.ts'
import { adoHistoryRequestSchema } from '../src/shared/requests.ts'
import { chatSendSchema, receiptSchema, type AdoChatSelection } from '../src/shared/chat.ts'
import { emptyFilters, sourceKey } from '../src/shared/selection.ts'
import type { AdoSnapshot, AdoSource, DashboardSettings } from '../src/shared/types.ts'
import { DashboardOwner, type Request } from '../src/client/owner.ts'
import { adoSchema } from '../src/client/validation.ts'
import { displayedContext } from '../src/client/chat-selection.ts'
import { createDashboardStore } from '../src/client/stores.ts'
import { createDashboardRequest } from '../src/client/transport.ts'

const now = '2026-06-10T12:00:00.000Z'
const source: AdoSource = { input: 'Example\\Sprint A', path: 'Example\\Sprint A', orgName: 'example', project: 'Example', mode: 'iteration' }
const settings: DashboardSettings = {
  timeZone: 'UTC', refreshMinutes: 60, refreshMinute: 55, workdayStart: 6, workdayEnd: 18,
  cacheSeconds: 600, hasReference: false, maxChatQuestionChars: 4000,
}
function snapshot(selectedSource = source): AdoSnapshot {
  return {
    kind: 'ado', generatedAt: now, source: selectedSource, sourceUrl: 'https://dev.azure.com/example/Example/_sprints',
    defaultType: 'Task', complete: true, warnings: [],
    iteration: {
      id: 'a1234567-1234-4234-a234-123456789012', name: 'Synthetic sprint', path: selectedSource.path!,
      start: '2026-06-01T00:00:00Z', finish: '2026-06-10T00:00:00Z',
    },
    analytics: { version: 1, timeZone: 'UTC', settings: adoAnalyticsSettingsSchema.parse({}) },
    items: [1, 2].map(id => ({
      id, revision: 2, project: 'Example', title: `Synthetic task ${id}`, type: 'Task',
      state: id === 1 ? 'Closed' : 'Active', category: id === 1 ? 'Completed' : 'InProgress',
      assignee: 'Example owner', assigneeId: 'owner', areaPath: 'Example', iterationPath: selectedSource.path!,
      tags: [], risks: [], predecessors: [], createdAt: '2026-06-01T09:00:00.000Z',
      stateChangedAt: '2026-06-05T09:00:00.000Z', changedAt: '2026-06-05T09:00:00.000Z',
      url: `https://dev.azure.com/example/Example/_workitems/edit/${id}`,
    })),
  }
}
function history(): AdoHistory {
  return {
    basis: 'current-cohort', type: 'Task', status: 'complete', fetchedAt: now,
    range: { start: '2026-06-01', finish: '2026-06-10', timeZone: 'UTC', source: 'iteration', clipped: false },
    requestedItemIds: [1, 2], omitted: [], warnings: ['Current cohort only.'],
    items: [1, 2].map(id => ({
      id, changes: [
        { at: '2026-06-01T09:00:00.000Z', category: 'Proposed' },
        { at: '2026-06-05T09:00:00.000Z', category: id === 1 ? 'Completed' : 'InProgress' },
      ],
    })),
  }
}
function contexts() {
  return new SnapshotContexts({ maxEntries: 16, retentionMilliseconds: 240_000, maxContextBytes: 128_000, now: () => Date.parse(now) })
}
function selection(): AdoChatSelection {
  return {
    view: 'ado', analyticsVersion: 1, filters: { ...emptyFilters(), type: 'Task' },
    selectedItem: null, sort: 'id', direction: 'asc', page: 0, pageSize: 10, stale: false,
  }
}
function response(value: AdoSnapshot, id = '00000000-0000-4000-8000-000000000001') {
  return { ok: true, value, receipt: receiptSchema.parse({
    id, scope: { id: `ado:${'a'.repeat(64)}`, title: 'Synthetic source' }, expiresAt: '2099-01-01T00:00:00Z',
  }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('history admissions accept only retained receipt and exact type, not arbitrary source IDs', () => {
  const input = { snapshotId: response(snapshot()).receipt.id, type: 'Task' }
  assert.equal(adoHistoryRequestSchema.safeParse(input).success, true)
  assert.equal(adoHistoryRequestSchema.safeParse({ ...input, ids: [1] }).success, false)
  assert.equal(adoHistoryRequestSchema.safeParse({ ...input, source }).success, false)
  assert.equal(adoHistoryRequestSchema.safeParse({ ...input, type: '' }).success, false)
})

test('history enrichment issues immutable evidence without splitting the source history', async () => {
  const store = contexts()
  const original = store.retain(snapshot())
  const before = store.compile(original.id, original.scope.id, selection())
  const copy = store.adoSnapshot(original.id)
  copy.snapshot.items[0]!.title = 'Mutated copy'
  let reads = 0
  const loader = new DashboardHistoryReads(store, async () => { reads++; return history() }, 2)
  const first = await loader.read({ snapshotId: original.id, type: 'Task' }, new AbortController().signal)
  assert.notEqual(first.receipt.id, original.id)
  assert.equal(first.receipt.scope.id, original.scope.id)
  assert.equal(first.value.items[0]!.title, 'Synthetic task 1')
  assert.equal(store.compile(original.id, original.scope.id, selection()), before)
  assert.match(store.compile(first.receipt.id, first.receipt.scope.id, selection()), /"availableCount":2/)
  assert.equal(store.adoSnapshot(first.receipt.id).baseId, original.id)
  const cached = await loader.read({ snapshotId: first.receipt.id, type: 'Task' }, new AbortController().signal)
  assert.equal(reads, 1)
  assert.equal(cached.receipt.scope.id, original.scope.id)
  await loader.read({ snapshotId: cached.receipt.id, type: 'Task', force: true }, new AbortController().signal)
  assert.equal(reads, 2)
})

test('history loading rejects unknown types before provider work and recovers after refusal', async () => {
  const store = contexts()
  const original = store.retain(snapshot())
  let calls = 0
  const loader = new DashboardHistoryReads(store, async () => {
    if (++calls === 1) throw new Error('Synthetic provider unavailable')
    return history()
  }, 2)
  await assert.rejects(loader.read({ snapshotId: original.id, type: 'Unknown type' }, new AbortController().signal), /type is absent/)
  assert.equal(calls, 0)
  await assert.rejects(loader.read({ snapshotId: original.id, type: 'Task' }, new AbortController().signal), /provider unavailable/)
  await loader.read({ snapshotId: original.id, type: 'Task' }, new AbortController().signal)
  assert.equal(calls, 2)
})

test('one history workload owns its cancellation and publishes nothing after abort', async () => {
  const store = contexts()
  const original = store.retain(snapshot())
  const barrier = deferred<AdoHistory>()
  let calls = 0
  const loader = new DashboardHistoryReads(store, async () => { calls++; return barrier.promise }, 2)
  const controller = new AbortController()
  const pending = loader.read({ snapshotId: original.id, type: 'Task' }, controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(loader.read({ snapshotId: original.id, type: 'Task' }, new AbortController().signal), /in progress/)
  controller.abort()
  assert.equal(calls, 1)
  barrier.resolve(history())
  await rejected
  assert.equal(store.adoSnapshot(original.id).snapshot.analytics?.history, undefined)
})

test('legacy wire payloads retain omitted analytics fields while new report questions require capture', () => {
  const store = contexts()
  const receipt = store.retain(snapshot())
  const current = selection()
  const { analyticsVersion: _version, ...legacy } = current
  const payload = {
    snapshotId: receipt.id, scopeId: receipt.scope.id, requestId: '00000000-0000-4000-8000-000000000099',
    question: 'What remains?', selection: legacy,
  }
  assert.deepEqual(chatSendSchema.parse(payload), payload)
  assert.equal(Object.hasOwn(chatSendSchema.parse(payload).selection, 'analyticsVersion'), false)
  assert.equal(Object.hasOwn(legacy.filters, 'drill'), false)
  assert.throws(() => store.compile(receipt.id, receipt.scope.id, legacy), /did not capture/)
  assert.match(store.compile(receipt.id, receipt.scope.id, current), /"eligible":2/)
})

test('history wire rejects wrong cohort, duplicate IDs and changed timezone', () => {
  const base = snapshot()
  const valid = { ...base, analytics: { ...base.analytics!, history: history() } }
  assert.equal(adoSchema.safeParse(valid).success, true)
  for (const changed of [
    { ...history(), requestedItemIds: [1, 3] },
    { ...history(), requestedItemIds: [1, 1] },
    { ...history(), range: { ...history().range!, timeZone: 'America/Los_Angeles' } },
  ]) assert.equal(adoSchema.safeParse({ ...base, analytics: { ...base.analytics!, history: changed } }).success, false)
  assert.equal(adoSchema.safeParse({ ...base, items: [base.items[0], base.items[0]] }).success, false)
})

function ownerHarness() {
  const queue: { endpoint: Parameters<Request>[0]; payload: unknown; signal: AbortSignal; result: ReturnType<typeof deferred<unknown>> }[] = []
  const visibility = new Set<() => void>()
  let hidden = false
  const request: Request = async (endpoint, payload, signal) => {
    if (endpoint === 'settings') return { ok: true, value: settings }
    if (endpoint === 'snapshot') {
      const selected = payload as { source: AdoSource }
      return response(snapshot(selected.source))
    }
    const result = deferred<unknown>()
    queue.push({ endpoint, payload, signal, result })
    return result.promise
  }
  const owner = new DashboardOwner(request, {
    now: () => Date.parse(now), hidden: () => hidden,
    onVisibility(callback) { visibility.add(callback); return () => { visibility.delete(callback) } },
    schedule: () => () => {},
  })
  return {
    owner, queue,
    hide() { hidden = true; for (const callback of visibility) callback() },
    async ready() {
      const unsubscribe = owner.subscribe(() => {})
      owner.select('ado', source)
      await owner.refresh(false)
      return unsubscribe
    },
    async close() {
      for (const call of queue) call.result.resolve({ ok: false, error: { code: 'cancelled', message: 'Fixture cleanup' } })
      await owner.dispose()
    },
  }
}

test('current charts remain usable while optional history loads; evidence receipt updates atomically', async t => {
  const h = ownerHarness()
  t.after(() => h.close())
  const unsubscribe = await h.ready()
  t.after(unsubscribe)
  assert.equal(h.queue.length, 0)
  const store = createDashboardStore().create()
  store.actions.source(source)
  store.actions.tab('ado')
  const before = displayedContext(h.owner.getSnapshot(), store.getSnapshot())
  assert.equal(before?.selection.view, 'ado')
  const loading = h.owner.loadAdoHistory('Task')
  assert.equal(h.owner.loadAdoHistory('Task'), loading)
  assert.equal(h.queue.length, 1)
  assert.equal(h.owner.getSnapshot().ado.status, 'ready')
  assert.equal(h.owner.getSnapshot().adoHistory?.status, 'pending')
  assert.equal(displayedContext(h.owner.getSnapshot(), store.getSnapshot())?.receipt.id, before?.receipt.id)
  const enriched = snapshot()
  enriched.analytics!.history = history()
  h.queue[0]!.result.resolve(response(enriched, '00000000-0000-4000-8000-000000000002'))
  await loading
  assert.equal(h.owner.getSnapshot().adoHistory?.status, 'ready')
  assert.notEqual(h.owner.getSnapshot().ado.receipt?.id, before?.receipt.id)
  assert.equal(h.owner.getSnapshot().ado.receipt?.scope.id, before?.receipt.scope.id)
  assert.equal(h.owner.getSnapshot().ado.data?.analytics?.history?.items.length, 2)
})

test('hidden/source-switched history completions cannot overwrite the current source', async t => {
  const h = ownerHarness()
  t.after(() => h.close())
  const unsubscribe = await h.ready()
  t.after(unsubscribe)
  const loading = h.owner.loadAdoHistory('Task')
  const other = { ...source, input: 'Example\\Sprint B', path: 'Example\\Sprint B' }
  h.owner.select('ado', other)
  assert.equal(h.queue[0]!.signal.aborted, true)
  await h.owner.refresh(false)
  const enriched = snapshot()
  enriched.analytics!.history = history()
  h.queue[0]!.result.resolve(response(enriched, '00000000-0000-4000-8000-000000000002'))
  await loading
  assert.equal(h.owner.getSnapshot().ado.dataKey, sourceKey(other))
  assert.equal(h.owner.getSnapshot().ado.data?.analytics?.history, undefined)
  const hiddenLoad = h.owner.loadAdoHistory('Task')
  h.hide()
  assert.equal(h.queue[1]!.signal.aborted, true)
  h.queue[1]!.result.resolve(response(enriched))
  await hiddenLoad
  assert.notEqual(h.owner.getSnapshot().adoHistory?.status, 'pending')
})

test('history failures preserve current data and mismatched source responses are refused', async t => {
  const h = ownerHarness()
  t.after(() => h.close())
  const unsubscribe = await h.ready()
  t.after(unsubscribe)
  const before = h.owner.getSnapshot().ado
  const first = h.owner.loadAdoHistory('Task')
  h.queue[0]!.result.resolve({ ok: false, error: { code: 'provider', message: 'Sign in and retry history.' } })
  await first
  assert.equal(h.owner.getSnapshot().ado.data, before.data)
  assert.equal(h.owner.getSnapshot().ado.receipt, before.receipt)
  assert.equal(h.owner.getSnapshot().adoHistory?.errorDetail, 'Sign in and retry history.')
  const second = h.owner.loadAdoHistory('Task', true)
  const changed = snapshot()
  changed.analytics!.history = history()
  changed.items[0]!.title = 'Unexpected current-field change'
  h.queue[1]!.result.resolve(response(changed, '00000000-0000-4000-8000-000000000002'))
  await second
  assert.equal(h.owner.getSnapshot().ado.data, before.data)
  assert.equal(h.owner.getSnapshot().adoHistory?.status, 'error')
  assert.match(h.owner.getSnapshot().adoHistory?.errorDetail ?? '', /does not match/)
})

test('disposing waits for the final cancelled history continuation', async t => {
  const h = ownerHarness()
  t.after(() => h.close())
  await h.ready()
  const loading = h.owner.loadAdoHistory('Task')
  const disposal = h.owner.dispose()
  assert.equal(h.queue[0]!.signal.aborted, true)
  let finished = false
  void disposal.then(() => { finished = true })
  await Promise.resolve()
  assert.equal(finished, false)
  h.queue[0]!.result.resolve({ ok: false, error: { code: 'cancelled', message: 'Cancelled fixture' } })
  await Promise.all([loading, disposal])
  assert.equal(finished, true)
})

test('history transport uses the fixed authenticated route', async () => {
  let actual: RequestInfo | URL | undefined
  const request = createDashboardRequest(async input => {
    actual = input
    return Response.json({ ok: true, value: {} })
  })
  await request('ado-history', { snapshotId: response(snapshot()).receipt.id, type: 'Task' }, new AbortController().signal)
  assert.equal(actual, '/api/dsh-dashboard/ado-history')
})
