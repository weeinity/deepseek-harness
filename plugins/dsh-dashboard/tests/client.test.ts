import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import type { AdoItem, AdoSnapshot, AdoSource, DashboardSettings, PersonalSnapshot, SectionId } from '../src/shared/types.ts'
import { safeSourceUrl } from '../src/shared/urls.ts'
import { DashboardOwner, refreshDelay, type Environment, type Request } from '../src/client/owner.ts'
import { DashboardCache } from '../src/client/cache.ts'
import { adoSchema, boundedDiagnostic, personalSchema, settingsSchema } from '../src/client/validation.ts'
import { emptyFilters, filterItems, pageItems, selectedType, sourceKey, summarize } from '../src/shared/selection.ts'
import { createDashboardStore } from '../src/client/stores.ts'
import { parseSource } from '../src/client/source.ts'
import { en, zh } from '../src/client/locale.ts'
import type { DashboardText } from '../src/client/locale.ts'
import { estimate } from '../src/client/format.ts'
import { SnapshotDownloads } from '../src/client/download.ts'
import { createDashboardRequest } from '../src/client/transport.ts'
import { snapshotForExport } from '../src/client/export-selection.ts'
import { receiptSchema } from '../src/shared/chat.ts'
import { displayedContext, displayedReceipt } from '../src/client/chat-selection.ts'

const instant = '2026-09-11T15:00:00Z'
const settings: DashboardSettings = {
  timeZone: 'America/Los_Angeles', refreshMinutes: 15, refreshMinute: 0, workdayStart: 9, workdayEnd: 17, cacheSeconds: 600, hasReference: true, maxChatQuestionChars: 4000,
}
const source: AdoSource = {
  input: 'Example\\Sprint A', orgName: 'example', project: 'Example', mode: 'iteration',
  path: 'Example\\Sprint A', includeChildren: false,
}
const otherSource: AdoSource = { ...source, input: 'Example\\Sprint B', path: 'Example\\Sprint B' }

function snapshotResponse(value: PersonalSnapshot | AdoSnapshot) {
  return { ok: true, value, receipt: receiptSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    scope: { id: value.kind === 'personal' ? 'personal' : `ado:${'a'.repeat(64)}`, title: 'Synthetic source' },
    expiresAt: '2099-01-01T00:00:00Z',
  }) }
}

function personal(): PersonalSnapshot {
  const ids: SectionId[] = ['urgent', 'prep', 'projects', 'reply', 'actions', 'training', 'oof', 'people', 'chats', 'files']
  return {
    kind: 'personal', generatedAt: instant, timeZone: 'America/Los_Angeles', displayName: 'Example User',
    nextBusinessDay: '2026-09-14', referenceAsOf: '2026-09-10',
    sources: [{ id: 'reference', state: 'reference', updatedAt: instant }],
    metrics: { overdueActions: null, attentionItems: 2, unreadEmails: null, meetingsNextDay: 1, teamsUnread: null, projects: 1, oof: null },
    schedule: [{
      id: 'calendar-1', title: 'Synthetic planning meeting', start: '2026-09-14T16:00:00Z', end: '2026-09-14T16:30:00Z',
      url: 'https://outlook.office.com/calendar/item/example', organizer: 'Example organizer', response: 'accepted',
      online: true, allDay: false, free: false, conflict: true, optionalOverlap: false, preview: 'Synthetic meeting preview',
    }],
    todayRemaining: [], weekLoad: [{ date: '2026-09-14', meetings: 1, minutes: 30 }],
    allocation: [{ category: 'internal', minutes: 30, percent: 100 }],
    sections: ids.map(id => ({
      id, source: 'reference',
      items: [{
        id, title: `Synthetic ${id}`, detail: 'Saved source detail',
        url: 'https://teams.microsoft.com/l/message/example', source: 'reference', sourceDate: '2026-09-10',
      }],
    })),
    warnings: ['Synthetic partial-source warning'],
  }
}

function item(id: number, patch: Partial<AdoItem> = {}): AdoItem {
  return {
    id, title: `Example item ${id}`, type: 'Task', state: 'Active', category: 'InProgress',
    assignee: 'Example Person', assigneeId: 'person-1', areaPath: 'Example\\Area', iterationPath: 'Example\\Sprint A',
    tags: ['example'], url: `https://dev.azure.com/example/Example/_workitems/edit/${id}`, risks: [],
    ...patch,
  }
}

function ado(selectedSource = source): AdoSnapshot {
  return {
    kind: 'ado', generatedAt: instant, source: selectedSource,
    sourceUrl: 'https://dev.azure.com/example/Example/_sprints', complete: false,
    defaultType: 'Task', warnings: ['Synthetic truncated result'],
    items: [
      item(1, { state: 'Done', category: 'Completed', estimate: 3, estimateField: 'Microsoft.VSTS.Scheduling.StoryPoints' }),
      item(2, { risks: ['blocked'], estimate: 4, estimateField: 'Microsoft.VSTS.Scheduling.OriginalEstimate', remainingWork: 2 }),
      item(3, { assignee: '', assigneeId: '', category: 'Unknown', state: 'Custom', estimate: 500, estimateField: 'Microsoft.VSTS.Scheduling.StoryPoints' }),
      item(4, { category: 'Removed', state: 'Removed', risks: ['overdue'] }),
      item(5, { type: 'Feature', estimate: 100, estimateField: 'Microsoft.VSTS.Scheduling.StoryPoints' }),
    ],
  }
}

interface Call {
  endpoint: Parameters<Request>[0]
  payload: unknown
  signal: AbortSignal
  resolve(value: unknown): void
  reject(error: Error): void
}

/** Instance-local clock and RPC barriers avoid timers, globals, ports, and sleeps. */
function harness(cache?: DashboardCache, initialTime = '2026-09-11T17:00:00Z') {
  let now = Date.parse(initialTime)
  let hidden = false
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const visibility = new Set<() => void>()
  const calls: Call[] = []
  const unread: Call[] = []
  const waiters: ((call: Call) => void)[] = []
  const request: Request = (endpoint, payload, signal) => new Promise((resolve, reject) => {
    const call = { endpoint, payload, signal, resolve, reject }
    calls.push(call)
    const waiting = waiters.shift()
    if (waiting) waiting(call)
    else unread.push(call)
  })
  const environment: Environment = {
    now: () => now, hidden: () => hidden,
    onVisibility(callback) { visibility.add(callback); return () => { visibility.delete(callback) } },
    schedule(callback, delay) {
      const id = ++timerId
      timers.set(id, { callback, delay })
      return () => { timers.delete(id) }
    },
  }
  const owner = new DashboardOwner(request, environment, undefined, cache)
  return {
    owner, calls, timers, visibility,
    take: (): Promise<Call> => {
      const call = unread.shift()
      return call ? Promise.resolve(call) : new Promise(resolve => { waiters.push(resolve) })
    },
    hide(value: boolean) { hidden = value; for (const callback of [...visibility]) callback() },
    time(value: string) { now = Date.parse(value) },
    async cleanup() {
      for (const call of calls) call.reject(new Error('Fixture cleanup'))
      await owner.dispose()
    },
  }
}

test('validates wire data, zone configuration, missing counts and enum values', () => {
  assert.equal(boundedDiagnostic(' \n '), null)
  assert.equal(boundedDiagnostic('x'.repeat(512)), 'x'.repeat(512))
  assert.equal(settingsSchema.safeParse(settings).success, true)
  assert.equal(settingsSchema.safeParse({ ...settings, timeZone: 'Invalid/Zone' }).success, false)
  assert.equal(settingsSchema.safeParse({ ...settings, workdayEnd: settings.workdayStart }).success, false)
  assert.equal(settingsSchema.safeParse({ ...settings, refreshMinutes: 0 }).success, false)
  assert.equal(settingsSchema.safeParse({ ...settings, maxChatQuestionChars: 0 }).success, false)
  assert.equal(personalSchema.safeParse(personal()).success, true)
  assert.equal(personalSchema.safeParse({ ...personal(), metrics: {} }).success, false)
  assert.equal(personalSchema.safeParse({ ...personal(), metrics: { ...personal().metrics, projects: -1 } }).success, false)
  assert.equal(adoSchema.safeParse(ado()).success, true)
  assert.equal(adoSchema.safeParse({ ...ado(), items: [{ ...item(1), category: 'Guessed' }] }).success, false)
})

test('transport posts plain JSON to fixed authenticated same-origin routes and forwards cancellation', async () => {
  const calls: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
  const response = { ok: true, value: settings }
  const request = createDashboardRequest(async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const controller = new AbortController()
  assert.deepEqual(await request('settings', {}, controller.signal), response)
  const payload = { view: 'ado', source, force: true }
  await request('snapshot', payload, controller.signal)
  await request('chat-open', { snapshotId: 'synthetic-id' }, controller.signal)
  await request('chat-send', { question: 'Synthetic question' }, controller.signal)
  assert.equal(calls[0]?.input, '/api/dsh-dashboard/settings')
  assert.equal(calls[0]?.init?.body, '{}')
  assert.equal(calls[1]?.input, '/api/dsh-dashboard/snapshot')
  assert.equal(calls[1]?.init?.body, JSON.stringify(payload))
  assert.equal(calls[2]?.input, '/api/dsh-dashboard/chat-open')
  assert.equal(calls[3]?.input, '/api/dsh-dashboard/chat-send')
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST')
    assert.equal(call.init?.credentials, 'same-origin')
    assert.equal(call.init?.redirect, 'error')
    assert.equal(call.init?.cache, 'no-store')
    assert.equal(call.init?.signal, controller.signal)
    assert.deepEqual(call.init?.headers, { 'content-type': 'application/json' })
  }
})

test('transport rejects HTTP failures and malformed JSON rather than presenting a successful snapshot', async () => {
  const controller = new AbortController()
  const failed = createDashboardRequest(async () => new Response(JSON.stringify({ ok: true, value: settings }), { status: 500 }))
  await assert.rejects(failed('settings', {}, controller.signal), /dashboard\/http/)
  const malformed = createDashboardRequest(async () => new Response('<html>not JSON</html>', { status: 200 }))
  await assert.rejects(malformed('settings', {}, controller.signal), SyntaxError)
  const failure = { ok: false, error: { code: 'source/auth', message: 'Sign in to the selected source.', details: {} } }
  const actionable = createDashboardRequest(async () => new Response(JSON.stringify(failure), { status: 403 }))
  assert.deepEqual(await actionable('snapshot', { view: 'ado', source }, controller.signal), failure)
})

test('source form accepts ADO URLs and explicit paths but rejects unsafe, incomplete and query paths', () => {
  assert.deepEqual(parseSource(source), source)
  assert.equal(parseSource({ ...source, orgName: '' }), null)
  assert.equal(parseSource({ ...source, mode: 'query' }), null)
  assert.equal(parseSource({ ...source, input: 'javascript:alert(1)' }), null)
  assert.equal(parseSource({ ...source, input: 'https://outlook.office.com/mail/example' }), null)
  assert.equal(parseSource({ ...source, input: 'https://dev.azure.com.attacker.invalid/' }), null)
  assert.equal(parseSource({ ...source, input: 'https://user:pass@dev.azure.com/example' }), null)
  assert.ok(parseSource({ input: 'https://dev.azure.com/example/Example/_queries/query/example', orgName: '', project: '', mode: 'query' }))
  assert.ok(parseSource({ input: 'https://example.visualstudio.com/Example/_sprints', orgName: '', project: '', mode: 'iteration' }))
  assert.equal(safeSourceUrl('data:text/html,example'), undefined)
  assert.equal(safeSourceUrl('https://teams.microsoft.com/l/message/example'), 'https://teams.microsoft.com/l/message/example')
  assert.equal(sourceKey(source), sourceKey({ includeChildren: false, mode: 'iteration', path: source.path, project: source.project, orgName: source.orgName, input: source.input }))
  assert.notEqual(sourceKey(source), sourceKey({ ...source, includeChildren: true }))
})

test('single-type metrics exclude Unknown and Removed and keep estimate fields separate', () => {
  const snapshot = ado()
  assert.equal(selectedType(snapshot, ''), 'Task')
  assert.equal(selectedType(snapshot, 'Missing'), 'Task')
  const rows = filterItems(snapshot.items, { ...emptyFilters(), type: selectedType(snapshot, '') })
  const metrics = summarize(rows)
  assert.deepEqual([metrics.completed, metrics.remaining, metrics.people, metrics.risks, metrics.unknown, metrics.removed], [1, 1, 1, 1, 1, 1])
  assert.deepEqual(metrics.estimates, [
    { field: 'Microsoft.VSTS.Scheduling.StoryPoints', total: 3, count: 1 },
    { field: 'Microsoft.VSTS.Scheduling.OriginalEstimate', total: 4, count: 1 },
  ])
  assert.equal(metrics.remainingWork, 2)
  assert.equal(summarize([item(10)]).remainingWork, null)
  assert.equal(summarize([item(10, { remainingWork: 0 })]).remainingWork, 0)
})

test('ADO scheduling fields use work units without assuming team-specific hourly units', () => {
  const dictionary: Readonly<Record<string, string>> = en
  const t: DashboardText = (key, parameters = {}) => (dictionary[key] ?? key)
    .replace(/\{(\w+)\}/g, (_match, name: string) => String(parameters[name] ?? ''))
  for (const field of ['OriginalEstimate', 'RemainingWork', 'CompletedWork']) {
    assert.equal(estimate(4, `Microsoft.VSTS.Scheduling.${field}`, t), '4 work units')
  }
  assert.equal(estimate(3, 'Microsoft.VSTS.Scheduling.StoryPoints', t), '3 points')
  assert.match(estimate(2, 'Custom.Estimate', t), /Custom.Estimate \(field units\)/)
})

test('type, person, state, tag, text, risk, and clickable metric filters select exact rows', () => {
  const items = ado().items
  const base = { ...emptyFilters(), type: 'Task' }
  assert.deepEqual(filterItems(items, { ...base, metric: 'completed' }).map(row => row.id), [1])
  assert.deepEqual(filterItems(items, { ...base, metric: 'remaining' }).map(row => row.id), [2])
  assert.deepEqual(filterItems(items, { ...base, metric: 'risks' }).map(row => row.id), [2])
  assert.deepEqual(filterItems(items, { ...base, person: '__unassigned__' }).map(row => row.id), [3])
  assert.deepEqual(filterItems(items, { ...base, state: 'Done', tag: 'example', text: 'EXAMPLE ITEM 1' }).map(row => row.id), [1])
  assert.equal(filterItems(items, { ...base, tag: 'missing' }).length, 0)
  assert.deepEqual(filterItems(items, { ...base, risk: 'blocked' }).map(row => row.id), [2])
  assert.deepEqual(filterItems(items, { ...base, type: 'Feature' }).map(row => row.id), [5])
})

test('table pagination clamps after filtering and missing sort values stay last', () => {
  const items = [item(3), item(2, { priority: 1 }), item(1, { priority: 1 }), item(4, { priority: 2 })]
  assert.deepEqual(pageItems(items, 'priority', 'asc', 0, 10).items.map(row => row.id), [1, 2, 4, 3])
  assert.deepEqual(pageItems(items, 'priority', 'desc', 0, 10).items.map(row => row.id), [4, 1, 2, 3])
  assert.deepEqual(pageItems(items, 'id', 'asc', 9, 2).items.map(row => row.id), [3, 4])
  assert.equal(pageItems([], 'id', 'asc', 9, 20).page, 0)
  assert.deepEqual(pageItems([
    item(1, { changedAt: '2026-09-11T10:00:00-07:00' }),
    item(2, { changedAt: '2026-09-11T16:00:00Z' }),
  ], 'changedAt', 'asc', 0, 20).items.map(row => row.id), [2, 1])
})

test('preference stores are independent and source switches clear old selection and filters', () => {
  const first = createDashboardStore().create()
  const second = createDashboardStore().create()
  first.actions.tab('ado')
  first.actions.filter({ text: 'example', type: 'Task' })
  first.actions.select(1)
  first.actions.page(4)
  first.actions.source(otherSource)
  assert.equal(first.getSnapshot().selection, null)
  assert.equal(first.getSnapshot().page, 0)
  assert.deepEqual(first.getSnapshot().filters, emptyFilters())
  assert.equal(second.getSnapshot().tab, 'personal')
})

test('workday timers use configured zone and skip weekends across daylight saving', () => {
  assert.equal(refreshDelay(settings, Date.parse('2026-09-11T17:00:00Z')), 15 * 60_000)
  const friday = Date.parse('2026-09-12T00:55:00Z')
  assert.equal(friday + refreshDelay(settings, friday), Date.parse('2026-09-14T16:00:00Z'))
  const dst = Date.parse('2026-03-06T23:55:00Z')
  const endingAt16 = { ...settings, workdayEnd: 16 }
  assert.equal(dst + refreshDelay(endingAt16, dst), Date.parse('2026-03-09T16:00:00Z'))
})

test('owner is lazy, deduplicates refreshes, and aborts and ignores an obsolete view', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('personal', null)
  assert.equal(h.calls.length, 0)
  const remove = h.owner.subscribe(() => {})
  const settingsCall = await h.take()
  assert.equal(settingsCall.endpoint, 'settings')
  settingsCall.resolve({ ok: true, value: settings })
  const old = await h.take()
  const oldJob = h.owner.refresh()
  assert.equal(oldJob, h.owner.refresh())
  assert.deepEqual(old.payload, { view: 'personal', force: false })
  h.owner.select('ado', source)
  assert.equal(old.signal.aborted, true)
  const current = await h.take()
  const currentJob = h.owner.refresh()
  current.resolve(snapshotResponse(ado()))
  await currentJob
  old.resolve(snapshotResponse(personal()))
  await oldJob
  assert.equal(h.owner.getSnapshot().personal.data, null)
  assert.equal(h.owner.getSnapshot().ado.status, 'ready')
  assert.equal(h.timers.size, 1)
  remove()
  assert.equal(h.timers.size, 0)
  assert.equal(h.visibility.size, 0)
})

test('fresh dashboard reopens synchronously without snapshot requests until the ten-minute TTL', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.time(instant)
  h.owner.select('personal', null)
  let remove = h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const first = await h.take()
  const loading = h.owner.refresh(false)
  first.resolve(snapshotResponse(personal()))
  await loading
  const data = h.owner.getSnapshot().personal.data
  const requests = h.calls.length
  remove()
  h.time('2026-09-11T15:09:59.999Z')
  remove = h.owner.subscribe(() => {})
  assert.equal(h.calls.length, requests)
  await h.owner.refresh(false)
  assert.equal(h.owner.getSnapshot().personal.data, data)
  assert.equal(h.owner.getSnapshot().personal.status, 'ready')
  assert.equal(h.owner.getSnapshot().personal.stale, false)
  assert.equal(h.timers.size, 1)
  h.hide(true)
  h.hide(false)
  assert.equal(h.calls.length, requests)
  remove()
  h.time('2026-09-11T15:10:00.000Z')
  h.owner.subscribe(() => {})
  assert.equal(h.calls.length, requests + 1)
  assert.equal(h.owner.getSnapshot().personal.data, data)
  assert.equal(h.owner.getSnapshot().personal.status, 'pending')
  const background = h.owner.refresh(false)
  ;(await h.take()).resolve({ ok: false, error: { code: 'offline', message: 'Offline', details: {} } })
  await background
  assert.equal(h.owner.getSnapshot().personal.data, data)
  assert.equal(h.owner.getSnapshot().personal.status, 'error')
})

test('tab reload restores cached content before subscribing and never renews its TTL', async t => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) } }
  const cache = () => new DashboardCache(() => storage, () => assert.fail('Unexpected cache failure'))
  const first = harness(cache(), instant)
  t.after(() => first.cleanup())
  first.owner.select('personal', null)
  first.owner.subscribe(() => {})
  ;(await first.take()).resolve({ ok: true, value: settings })
  const call = await first.take()
  const work = first.owner.refresh(false)
  call.resolve(snapshotResponse(personal()))
  await work
  await first.owner.dispose()
  const reloaded = harness(cache(), '2026-09-11T15:09:59.999Z')
  t.after(() => reloaded.cleanup())
  assert.deepEqual(reloaded.owner.getSnapshot().personal.data, personal())
  reloaded.owner.select('personal', null)
  reloaded.owner.subscribe(() => {})
  assert.equal(reloaded.calls.length, 0)
  assert.equal(reloaded.owner.getSnapshot().personal.status, 'ready')
  const expired = harness(cache(), '2026-09-11T15:10:00.000Z')
  t.after(() => expired.cleanup())
  assert.equal(expired.owner.getSnapshot().personal.stale, true)
  expired.owner.select('personal', null)
  expired.owner.subscribe(() => {})
  assert.equal(expired.calls.length, 1)
  assert.equal(expired.owner.getSnapshot().personal.status, 'pending')
  assert.deepEqual(expired.owner.getSnapshot().personal.data, personal())
  const refreshing = expired.owner.refresh(false)
  ;(await expired.take()).resolve(snapshotResponse({ ...personal(), generatedAt: '2026-09-11T15:10:00Z' }))
  await refreshing
  assert.equal(expired.owner.getSnapshot().personal.stale, false)
})

test('cache storage failures and malformed values preserve successful in-memory reads', async t => {
  let failures = 0
  const malformed = new DashboardCache(() => ({ getItem: () => '{bad', setItem: () => {} }), () => { failures++ })
  assert.deepEqual(malformed.restore(), {})
  assert.equal(failures, 1)
  const unavailable = new DashboardCache(() => { throw new Error('Storage denied') }, () => { failures++ })
  const h = harness(unavailable, instant)
  t.after(() => h.cleanup())
  h.owner.select('personal', null)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const call = await h.take()
  const work = h.owner.refresh(false)
  call.resolve(snapshotResponse(personal()))
  await work
  assert.equal(h.owner.getSnapshot().personal.status, 'ready')
  assert.deepEqual(h.owner.getSnapshot().personal.data, personal())
  assert.ok(failures > 1)
})

test('switching back to a fresh ADO view reuses its data and receipt without a loading state', async t => {
  const h = harness(undefined, instant)
  t.after(() => h.cleanup())
  h.owner.select('ado', source)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const call = await h.take()
  const work = h.owner.refresh(false)
  call.resolve(snapshotResponse(ado()))
  await work
  const resource = h.owner.getSnapshot().ado
  h.owner.select('personal', null)
  const personalCall = await h.take()
  const personalWork = h.owner.refresh(false)
  personalCall.resolve(snapshotResponse(personal()))
  await personalWork
  const count = h.calls.length
  h.owner.select('ado', source)
  assert.equal(h.calls.length, count)
  assert.equal(h.owner.getSnapshot().ado.status, 'ready')
  assert.equal(h.owner.getSnapshot().ado.stale, false)
  assert.equal(h.owner.getSnapshot().ado.data, resource.data)
  assert.equal(h.owner.getSnapshot().ado.receipt, resource.receipt)
})

test('manual refresh bypasses a fresh cache and deduplicates concurrent clicks', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.time(instant)
  h.owner.select('personal', null)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const first = await h.take()
  const loading = h.owner.refresh(false)
  first.resolve(snapshotResponse(personal()))
  await loading
  const data = h.owner.getSnapshot().personal.data
  const manual = h.owner.refresh()
  assert.equal(h.owner.refresh(), manual)
  const next = await h.take()
  assert.deepEqual(next.payload, { view: 'personal', force: true })
  assert.equal(h.owner.getSnapshot().personal.data, data)
  next.resolve(snapshotResponse({ ...personal(), generatedAt: '2026-09-11T15:01:00Z' }))
  await manual
  assert.equal(h.owner.getSnapshot().personal.status, 'ready')
})

test('errors and pending loads retain valid data marked stale and source changes label old results', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('ado', source)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const initial = await h.take()
  const initialJob = h.owner.refresh()
  initial.resolve(snapshotResponse(ado()))
  await initialJob
  const data = h.owner.getSnapshot().ado.data
  const retry = h.owner.refresh()
  assert.equal(h.owner.getSnapshot().ado.data, data)
  assert.equal(h.owner.getSnapshot().ado.stale, true)
  ;(await h.take()).resolve({ ok: false, error: { code: 'offline', message: 'Synthetic failure', details: null } })
  await retry
  assert.equal(h.owner.getSnapshot().ado.status, 'error')
  assert.equal(h.owner.getSnapshot().ado.data, data)
  h.owner.select('ado', otherSource)
  const replacing = await h.take()
  assert.equal(h.owner.getSnapshot().ado.previousSource, true)
  assert.equal(h.owner.getSnapshot().ado.dataKey, sourceKey(source))
  const replacementJob = h.owner.refresh()
  replacing.resolve(snapshotResponse(ado(otherSource)))
  await replacementJob
  assert.equal(h.owner.getSnapshot().ado.previousSource, false)
  assert.equal(h.owner.getSnapshot().ado.dataKey, sourceKey(otherSource))
  const malformedJob = h.owner.refresh()
  ;(await h.take()).resolve({ ok: true, value: { kind: 'ado' } })
  await malformedJob
  assert.equal(h.owner.getSnapshot().ado.error, 'invalid')
  assert.equal(h.owner.getSnapshot().ado.data?.source.input, otherSource.input)
})

test('whole-source errors retain bounded sanitized message text but not response details or raw exceptions', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('ado', source)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const failed = await h.take()
  const failure = h.owner.refresh()
  failed.resolve({ ok: false, error: {
    code: 'source/auth', message: 'Sign in again to read the selected source.',
    details: { debug: 'fixture-detail-must-not-be-displayed' },
  } })
  await failure
  assert.equal(h.owner.getSnapshot().ado.error, 'request')
  assert.equal(h.owner.getSnapshot().ado.errorDetail, 'Sign in again to read the selected source.')
  assert.doesNotMatch(JSON.stringify(h.owner.getSnapshot()), /fixture-detail-must-not-be-displayed/)
  const retry = h.owner.refresh()
  assert.equal(h.owner.getSnapshot().ado.errorDetail, null)
  ;(await h.take()).resolve(snapshotResponse(ado()))
  await retry
  const data = h.owner.getSnapshot().ado.data
  const bounded = h.owner.refresh()
  ;(await h.take()).resolve({ ok: false, error: { code: 'source/failed', message: '😀'.repeat(600), details: {} } })
  await bounded
  assert.equal(Array.from(h.owner.getSnapshot().ado.errorDetail ?? '').length, 512)
  assert.ok(h.owner.getSnapshot().ado.errorDetail?.endsWith('…'))
  assert.equal(h.owner.getSnapshot().ado.data, data)
  assert.equal(h.owner.getSnapshot().ado.stale, true)
  const raw = h.owner.refresh()
  ;(await h.take()).reject(new Error('fixture-exception-must-not-be-displayed'))
  await raw
  assert.equal(h.owner.getSnapshot().ado.errorDetail, null)
})

test('visibility pause and disposal reach quiescence before any late completion can publish', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('personal', null)
  let publications = 0
  h.owner.subscribe(() => { publications++ })
  ;(await h.take()).resolve({ ok: true, value: settings })
  const pending = await h.take()
  const job = h.owner.refresh()
  h.hide(true)
  assert.equal(pending.signal.aborted, true)
  assert.equal(h.timers.size, 0)
  const pausedPublications = publications
  pending.resolve(snapshotResponse(personal()))
  await job
  assert.equal(publications, pausedPublications)
  const callCount = h.calls.length
  await h.owner.refresh()
  assert.equal(h.calls.length, callCount)
  h.hide(false)
  const active = await h.take()
  let disposed = false
  const completion = h.owner.dispose().then(() => { disposed = true })
  assert.equal(active.signal.aborted, true)
  assert.equal(h.visibility.size, 0)
  assert.equal(disposed, false)
  const disposingPublications = publications
  active.resolve(snapshotResponse(personal()))
  await completion
  assert.equal(disposed, true)
  assert.equal(publications, disposingPublications)
  assert.equal(h.owner.getSnapshot().personal.data, null)
})

test('an unconfigured ADO view reads settings but starts no source requests', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('ado', null)
  h.owner.subscribe(() => {})
  const pending = h.owner.refresh()
  ;(await h.take()).resolve({ ok: true, value: settings })
  await pending
  assert.equal(h.calls.length, 1)
  assert.equal(h.owner.getSnapshot().ado.status, 'idle')
  assert.equal(h.timers.size, 0)
})

test('an older ADO source cannot overwrite a later successful source', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('ado', source)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const older = await h.take()
  const olderJob = h.owner.refresh()
  h.owner.select('ado', otherSource)
  const newer = await h.take()
  const newerJob = h.owner.refresh()
  assert.equal(older.signal.aborted, true)
  newer.resolve(snapshotResponse(ado(otherSource)))
  await newerJob
  const published = h.owner.getSnapshot()
  older.resolve(snapshotResponse(ado(source)))
  await olderJob
  assert.equal(h.owner.getSnapshot(), published)
  assert.equal(published.ado.dataKey, sourceKey(otherSource))
})

/** Bundle only synthetic SSR fixtures in memory; no browser, artifact file, or CSS loader hook. */
async function renderFixture(
  kind: 'personal' | 'ado', locale: 'en' | 'zh', fixture: PersonalSnapshot | AdoSnapshot = kind === 'personal' ? personal() : ado(),
  zone = 'UTC',
): Promise<string> {
  const contents = `
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { Personal } from './src/client/Personal.tsx'
    import { Ado } from './src/client/Ado.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    import { en, zh } from './src/client/locale.ts'
    const dict = ${locale === 'zh' ? 'zh' : 'en'}
    const t = (key, params = {}) => (dict[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? ''))
    const store = createDashboardStore().create()
    store.actions.select(2)
    const snapshot = ${JSON.stringify(fixture)}
    const zone = ${JSON.stringify(zone)}
    module.exports = renderToStaticMarkup(
      ${kind === 'personal' ? '<Personal snapshot={snapshot} t={t} attentionFilter={store.getSnapshot().attentionFilter} onAttentionFilter={store.actions.attentionFilter} />'
    : '<Ado snapshot={snapshot} prefs={store.getSnapshot()} actions={store.actions} zone={zone} t={t} />'}
    )
  `
  return renderSource(contents)
}

async function renderSource(contents: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), stdin: { contents, loader: 'tsx', resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, outfile: 'client-render.cjs', logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    // Linked shared primitives use the browser platform's single React identity.
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  })
  const code = result.outputFiles.find(file => file.path.endsWith('.cjs'))?.text
  assert.ok(code)
  const module: { exports: unknown } = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require,
    process, console, setTimeout, clearTimeout, queueMicrotask, TextEncoder, TextDecoder, Buffer, URL,
    fetch, AbortController, crypto, structuredClone,
  })
  const exported: unknown = await module.exports
  assert.equal(typeof exported, 'string')
  return String(exported)
}

test('representative Personal content renders saved freshness, unavailable metrics and every source card', async () => {
  const html = await renderFixture('personal', 'en')
  assert.match(html, /Needs attention now/)
  assert.match(html, /Overdue actions/)
  assert.match(html, /Saved briefing as of/)
  assert.match(html, /not live status/)
  assert.match(html, /Unavailable, not zero/)
  assert.match(html, /Unavailable/)
  assert.match(html, /Synthetic planning meeting/)
  assert.match(html, /Scheduling conflict/)
  assert.match(html, /Week calendar load/)
  assert.match(html, /Calendar time allocation/)
  assert.match(html, /target="_blank" rel="noopener noreferrer"/)
  for (const section of ['urgent', 'prep', 'projects', 'reply', 'actions', 'training', 'oof', 'people', 'chats', 'files']) {
    assert.match(html, new RegExp(`Synthetic ${section}`))
  }
  assert.doesNotMatch(html, /<iframe|<script|onerror=/)
})

test('complete Teams unread evidence renders numeric chat counts, including zero, without an unknown warning', async () => {
  for (const count of [0, 4]) {
    const fixture = personal()
    fixture.metrics.teamsUnread = count
    const html = await renderFixture('personal', 'en', fixture)
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    assert.match(text, new RegExp(`${count} Unread Teams chats`))
    assert.doesNotMatch(html, /Unread count is unknown/)
  }
})

test('weekly bars rank meeting counts rather than durations and distinguish heavy, light, and normal days', async () => {
  const fixture = personal()
  fixture.weekLoad = [
    { date: '2024-06-03', meetings: 7, minutes: 10 },
    { date: '2024-06-04', meetings: 8, minutes: 20 },
    { date: '2024-06-05', meetings: 2, minutes: 300 },
    { date: '2024-06-06', meetings: 4, minutes: 480 },
  ]
  const html = await renderFixture('personal', 'en', fixture)
  const bars = [...html.matchAll(/data-load="(heavy|light|normal)" style="--dashboard-size:([\d.]+)%"/g)]
    .map(match => ({ load: match[1], height: Number(match[2]) }))
  assert.deepEqual(bars, [
    { load: 'heavy', height: 87.5 },
    { load: 'heavy', height: 100 },
    { load: 'light', height: 25 },
    { load: 'normal', height: 50 },
  ])
  assert.match(html, /300 min/)
  assert.match(html, /480 min/)
})

test('representative ADO content renders single-type exclusions, distinct units, filters and accessible details', async () => {
  const html = await renderFixture('ado', 'en')
  assert.match(html, /Counting Task only/)
  assert.match(html, /1 Unknown · 1 Removed/)
  assert.match(html, /3 points/)
  assert.match(html, /4 work units/)
  assert.match(html, /Remaining work · 2 work units/)
  assert.doesNotMatch(html, /4 hours|2 hours/)
  assert.doesNotMatch(html, /103 points|503 points/)
  assert.match(html, /Partial result/)
  assert.match(html, /aria-sort="ascending"/)
  assert.match(html, /Work item 2/)
  assert.match(html, /role="region"/)
  assert.match(html, /Close details/)
  assert.match(html, /Items per page/)
  assert.match(html, /href="https:\/\/dev.azure.com\/example\/Example\/_workitems\/edit\/2" target="_blank" rel="noopener noreferrer"/)
})

test('historical iterations show returned dates with years, including an incomplete date range', async () => {
  const fixture = ado()
  fixture.iteration = { id: 'example-iteration', name: 'Historical sprint', path: source.path!, start: '2024-06-03', finish: '2024-06-14' }
  const html = await renderFixture('ado', 'en', fixture)
  assert.match(html, /Starts Mon, Jun 3, 2024/)
  assert.match(html, /Ends Fri, Jun 14, 2024/)
  delete fixture.iteration.finish
  const partial = await renderFixture('ado', 'en', fixture)
  assert.match(partial, /Starts Mon, Jun 3, 2024/)
})

test('Pacific iteration dates preserve June 1 and June 30 while ChangedDate remains a local timestamp', async () => {
  const fixture = ado()
  fixture.iteration = {
    id: 'synthetic-calendar-iteration', name: 'Calendar-date sprint', path: source.path!,
    start: '2026-06-01T00:00:00Z', finish: '2026-06-30T00:00:00Z',
  }
  fixture.items[1]!.changedAt = '2026-06-01T00:00:00Z'
  const html = await renderFixture('ado', 'en', fixture, 'America/Los_Angeles')
  assert.match(html, /Starts Mon, Jun 1, 2026/)
  assert.match(html, /Ends Tue, Jun 30, 2026/)
  assert.match(html, /Sun, May 31, 2026/)
  assert.doesNotMatch(html, /Starts Sun, May 31|Ends Mon, Jun 29/)
})

test('English and Chinese keys match and localized content renders without English chrome fallback', async () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  const html = await renderFixture('personal', 'zh')
  assert.match(html, /需要关注/)
  assert.match(html, /不可用，并非零/)
  assert.match(html, /保存的简报截至/)
  assert.doesNotMatch(html, /Calendar time allocation|Source freshness|Unavailable/)
})

test('provider source names and tentative/free/unknown overlaps are localized without claiming optional attendance', async () => {
  const fixture = personal()
  fixture.sources = ['profile', 'inbox', 'calendar', 'mail', 'chats', 'files'].map(id => ({
    id, state: 'live', updatedAt: instant,
  }))
  fixture.schedule[0]!.optionalOverlap = true
  const html = await renderFixture('personal', 'zh', fixture)
  assert.match(html, /个人资料/)
  assert.match(html, /收件箱/)
  assert.match(html, /暂定、空闲或忙闲未知日程重叠/)
  assert.match(html, /收件箱未读邮件/)
  assert.doesNotMatch(html, />profile<|>inbox<|可选会议重叠/)
})

test('saved refresh labels remain readable verbatim and OOF counts are labeled as notices', async () => {
  const fixture = personal()
  fixture.referenceAsOf = 'Original Last refreshed wording'
  fixture.sections[0]!.items[0]!.sourceDate = 'Previously recorded date label'
  assert.equal(personalSchema.safeParse(fixture).success, true)
  const html = await renderFixture('personal', 'en', fixture)
  assert.match(html, /Saved briefing as of Original Last refreshed wording/)
  assert.match(html, /Previously recorded date label/)
  assert.match(html, /Out-of-office notices/)
  assert.match(html, /Calendar notice records, not distinct people/)
})

test('source content is escaped and a malformed source URL never becomes an anchor', async () => {
  const fixture = personal()
  fixture.sections[0]!.items[0]!.title = '<img src=x onerror=alert(1)>'
  fixture.sections[0]!.items[0]!.url = 'javascript:alert(1)'
  const html = await renderFixture('personal', 'en', fixture)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /Source link unavailable/)
  assert.doesNotMatch(html, /href="javascript:|<img src=x/)
  const work = ado()
  work.items[0]!.url = 'https://teams.microsoft.com/l/message/not-a-work-item'
  const adoHtml = await renderFixture('ado', 'en', work)
  assert.doesNotMatch(adoHtml, /href="https:\/\/teams.microsoft.com/)
})

test('expired cached data refreshes on return outside work hours and preserves scheduled slots', async t => {
  const h = harness()
  t.after(() => h.cleanup())
  h.owner.select('personal', null)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const snapshot = await h.take()
  const initial = h.owner.refresh()
  snapshot.resolve(snapshotResponse(personal()))
  await initial
  h.owner.select('personal', source)
  assert.equal(h.calls.length, 2)
  h.hide(true)
  h.time('2026-09-12T20:00:00Z')
  h.hide(false)
  assert.equal(h.calls.length, 3)
  assert.ok(h.owner.getSnapshot().personal.data)
  const background = h.owner.refresh(false)
  ;(await h.take()).resolve(snapshotResponse({ ...personal(), generatedAt: '2026-09-12T20:00:00Z' }))
  await background
  assert.equal(h.timers.size, 1)
  const [timerId, timer] = [...h.timers.entries()][0]!
  assert.equal(Date.parse('2026-09-12T20:00:00Z') + timer.delay, Date.parse('2026-09-14T16:00:00Z'))
  h.time('2026-09-14T16:00:00Z')
  h.timers.delete(timerId)
  timer.callback()
  const automatic = await h.take()
  assert.deepEqual(automatic.payload, { view: 'personal', force: false })
  h.hide(true)
  assert.equal(automatic.signal.aborted, true)
})

test('HTML export downloads dashboard.html and defers object URL revocation through teardown', async () => {
  const deferred: (() => void)[] = []
  const downloads: { url: string; filename: string }[] = []
  const revoked: string[] = []
  const html: string[] = []
  const owner = new SnapshotDownloads(() => '<!doctype html><title>Synthetic snapshot</title>', {
    createUrl: value => { html.push(value); return 'blob:synthetic-snapshot' },
    startDownload: (url, filename) => { downloads.push({ url, filename }) },
    revokeUrl: url => { revoked.push(url) },
    afterNavigation: callback => { deferred.push(callback) },
  })
  assert.equal(owner.download(personal()), true)
  assert.deepEqual(downloads, [{ url: 'blob:synthetic-snapshot', filename: 'dashboard.html' }])
  assert.match(html[0]!, /Synthetic snapshot/)
  assert.equal(revoked.length, 0)
  let disposed = false
  const disposal = owner.dispose().then(() => { disposed = true })
  assert.equal(disposed, false)
  assert.equal(owner.download(ado()), false)
  deferred[0]!()
  await disposal
  assert.deepEqual(revoked, ['blob:synthetic-snapshot'])
})

test('HTML download failures return a UI error signal and release any allocated object URL', async () => {
  const revoked: string[] = []
  const owner = new SnapshotDownloads(() => '<html></html>', {
    createUrl: () => 'blob:failed-snapshot',
    startDownload: () => { throw new Error('Synthetic browser failure') },
    revokeUrl: url => { revoked.push(url) },
    afterNavigation: () => { assert.fail('Failed download must not schedule delayed work') },
  })
  assert.equal(owner.download(personal()), false)
  assert.deepEqual(revoked, ['blob:failed-snapshot'])
  await owner.dispose()
})

test('ADO export honors Bug selection and active filters without changing the original Task snapshot', () => {
  const dictionary: Readonly<Record<string, string>> = en
  const t: DashboardText = (key, parameters = {}) => (dictionary[key] ?? key)
    .replace(/\{(\w+)\}/g, (_match, name: string) => String(parameters[name] ?? ''))
  const snapshot = ado()
  const bug = item(10, {
    type: 'Bug', title: 'Verify selected export', assignee: 'Example Reviewer', assigneeId: 'person-2',
    tags: ['triage'], risks: ['blocked'],
  })
  snapshot.items.push(
    bug,
    { ...bug, id: 11, state: 'Done', category: 'Completed' },
    { ...bug, id: 12, assigneeId: 'person-3' },
    { ...bug, id: 13, tags: ['other'] },
    { ...bug, id: 14, type: 'Task' },
  )
  const original = structuredClone(snapshot)
  Object.freeze(snapshot.items)
  Object.freeze(snapshot.warnings)
  Object.freeze(snapshot)
  const store = createDashboardStore().create()
  store.actions.filter({
    type: 'Bug', person: 'person-2', state: 'Active', tag: 'triage',
    text: 'verify', risk: 'blocked', metric: 'risks',
  })
  store.actions.page(3)
  const exported = snapshotForExport(snapshot, store.getSnapshot(), t)
  assert.equal(exported.kind, 'ado')
  if (exported.kind !== 'ado') assert.fail('ADO export must retain its discriminant')
  assert.equal(exported.defaultType, 'Bug')
  assert.deepEqual(exported.items.map(value => value.id), [10])
  const note = exported.warnings.at(-1)
  assert.match(note!, /Matching items across all pages: 1/)
  assert.match(note!, /Item type: Bug/)
  assert.match(note!, /Person: Example Reviewer \(person-2\)/)
  assert.match(note!, /State: Active/)
  assert.match(note!, /Tag: triage/)
  assert.match(note!, /Search items: verify/)
  assert.match(note!, /Blocked/)
  assert.match(note!, /not the entire source/)
  assert.deepEqual(snapshot, original)
  const personalSnapshot = personal()
  assert.equal(snapshotForExport(personalSnapshot, store.getSnapshot(), t), personalSnapshot)
})

test('snapshot success requires a valid matching receipt and retains the previous data/receipt together on failure', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.select('personal', null)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  let pending = h.owner.refresh()
  ;(await h.take()).resolve({ ok: true, value: personal() })
  await pending
  assert.equal(h.owner.getSnapshot().personal.data, null)
  assert.equal(h.owner.getSnapshot().personal.error, 'invalid')
  pending = h.owner.refresh()
  ;(await h.take()).resolve(snapshotResponse(personal()))
  await pending
  const { data, receipt } = h.owner.getSnapshot().personal
  assert.ok(receipt)
  for (const invalid of [undefined, { id: 'bad' }, snapshotResponse(ado()).receipt]) {
    pending = h.owner.refresh()
    assert.equal(h.owner.getSnapshot().personal.receipt, receipt)
    ;(await h.take()).resolve({ ok: true, value: personal(), receipt: invalid })
    await pending
    assert.equal(h.owner.getSnapshot().personal.data, data)
    assert.equal(h.owner.getSnapshot().personal.receipt, receipt)
    assert.equal(h.owner.getSnapshot().personal.stale, true)
    assert.equal(h.owner.getSnapshot().personal.error, 'invalid')
  }
})

test('chat selection matches fallback type, rendered details, clamped page and stale-source rules', async t => {
  const h = harness(); t.after(() => h.cleanup())
  const store = createDashboardStore().create()
  store.actions.tab('ado')
  store.actions.source(source)
  h.owner.select('ado', source)
  h.owner.subscribe(() => {})
  ;(await h.take()).resolve({ ok: true, value: settings })
  const pending = h.owner.refresh()
  ;(await h.take()).resolve(snapshotResponse(ado()))
  await pending
  store.actions.filter({ type: 'Missing type' })
  store.actions.select(5)
  store.actions.page(100)
  const selected = displayedContext(h.owner.getSnapshot(), store.getSnapshot())
  assert.equal(selected?.selection.view, 'ado')
  if (selected?.selection.view !== 'ado') assert.fail()
  assert.equal(selected.selection.filters.type, 'Task')
  assert.equal(selected.selection.selectedItem, null)
  assert.equal(selected.selection.page, 0)
  store.actions.select(2)
  assert.equal((displayedContext(h.owner.getSnapshot(), store.getSnapshot())?.selection as { selectedItem: number }).selectedItem, 2)
  const refreshing = h.owner.refresh()
  assert.equal(displayedContext(h.owner.getSnapshot(), store.getSnapshot()), null)
  assert.ok(displayedReceipt(h.owner.getSnapshot(), store.getSnapshot()))
  ;(await h.take()).reject(new Error('Offline'))
  await refreshing
  assert.equal(displayedContext(h.owner.getSnapshot(), store.getSnapshot())?.selection.stale, true)
  store.actions.source(otherSource)
  assert.equal(displayedReceipt(h.owner.getSnapshot(), store.getSnapshot()), null)
  assert.equal(displayedContext(h.owner.getSnapshot(), store.getSnapshot()), null)
})

test('root viewing state keeps same-source filters and isolates question drafts through acceptance', () => {
  const store = createDashboardStore().create()
  store.actions.source(source)
  store.actions.filter({ type: 'Feature', person: 'person-2' })
  store.actions.source({ ...source })
  assert.equal(store.getSnapshot().filters.type, 'Feature')
  store.actions.question('personal', 'Personal draft')
  store.actions.question('ado:a', 'ADO draft')
  const revision = store.getSnapshot().drafts.personal!.revision
  store.actions.tab('ado')
  store.actions.mobilePane('chat')
  store.actions.accepted('personal', revision)
  assert.equal(store.getSnapshot().drafts.personal!.text, '')
  assert.equal(store.getSnapshot().drafts['ado:a']!.text, 'ADO draft')
  assert.equal(store.getSnapshot().mobilePane, 'chat')
})

test('registration exposes a global page and sidebar destination without selecting or reusing Conversation', async () => {
  const serialized = await renderSource(`
    import { apply } from './src/client/index.ts'
    const entries = []
    const cleanups = []
    const calls = []
    const ctx = {
      effect(factory) { cleanups.push(factory()) },
      locale: {
        register() { return () => calls.push('locale-dispose') },
        bind() { return key => key === 'view.label' ? 'Dashboard' : key },
      },
      sessions: { retain() { throw Error('No history reader is mounted') } },
      uiConversation: { binding() { throw Error('No history reader is mounted') } },
      slots: {
        inject(name, install) {
          const result = install()
          if (typeof result === 'function') cleanups.push(result)
          else for (const dispose of result) cleanups.push(dispose)
        },
        register(spec, Component) {
          const entry = { spec, Component }; entries.push(entry)
          return () => entries.splice(entries.indexOf(entry), 1)
        },
      },
    }
    apply(ctx)
    const registrations = entries.map(({spec}) => ({ name: spec.name, key: spec.key, id: spec.id, store: Boolean(spec.store) }))
    const launcher = entries.find(({spec}) => spec.name === 'sidebar.panellist')
    module.exports = (async () => {
      for (const dispose of cleanups.reverse()) await dispose()
      return JSON.stringify({ registrations, label: launcher.spec.label(), calls, remaining: entries.length })
    })()
  `)
  const result = JSON.parse(serialized) as {
    registrations: { name: string; key?: string; id?: string; store: boolean }[]
    label: string
    calls: string[]
    remaining: number
  }
  assert.deepEqual(result.registrations, [
    { name: 'main', key: 'dashboard', store: true },
    { name: 'sidebar.panellist', id: 'dashboard', store: false },
  ])
  assert.equal(result.label, 'Dashboard')
  assert.deepEqual(result.calls, ['locale-dispose'])
  assert.equal(result.remaining, 0)
})

test('sidebar panel icon uses the shared gauge at the shell-provided size', async () => {
  const render = (size: number, active: boolean) => renderSource(`
    import assert from 'node:assert/strict'
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
    import { DashboardLauncher } from './src/client/DashboardLauncher.tsx'
    const html = renderToStaticMarkup(<DashboardLauncher size={${size}} active={${active}} />)
    assert.equal(html, renderToStaticMarkup(<IconGaugeOutlineRegular size={${size}} />),
      'Dashboard must use the shared gauge at the sidebar icon size')
    module.exports = html
  `)
  assert.match(await render(16, true), /width="16"/)
  assert.match(await render(18, false), /width="18"/)
})

test('standalone page renders both default tabs, separate Q&A, source context and safe native text', async () => {
  for (const locale of ['en', 'zh'] as const) {
    const value = personal()
    const receipt = snapshotResponse(value).receipt
    const html = await renderSource(`
      import React from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { Dashboard } from './src/client/Dashboard.tsx'
      import { createDashboardStore } from './src/client/stores.ts'
      import { en, zh } from './src/client/locale.ts'
      const dict = ${locale}
      const t = (key, params = {}) => (dict[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => String(params[name] ?? ''))
      const store = createDashboardStore().create()
      const empty = { status: 'idle', data: null, dataKey: null, receipt: null, error: null, errorDetail: null, stale: false, previousSource: false }
      const dashboard = {
        settings: ${JSON.stringify(settings)}, ado: empty,
        personal: { ...empty, status: 'ready', data: ${JSON.stringify(value)}, dataKey: 'personal', receipt: ${JSON.stringify(receipt)} },
      }
      const chat = {
        scope: ${JSON.stringify(receipt.scope)}, status: 'ready', sessionId: 'private-dashboard-session',
        running: true, hasMore: true, loadingOlder: false, nativeError: null, error: null, errorDetail: null,
        pendingQuestion: null, retryQuestion: null, retryRevision: null,
        messages: [
          { id: 'u:1', role: 'user', text: '<script>synthetic user question</script>', streaming: false, interrupted: false },
          { id: 'a:2', role: 'assistant', text: 'A **grounded** answer. [unsafe](javascript:alert(1)) <script>unsafe</script>', streaming: true, interrupted: false },
        ],
      }
      module.exports = renderToStaticMarkup(<Dashboard
        t={t} useStore={select => select(store.getSnapshot())} actions={store.actions}
        useDashboard={select => select(dashboard)} useDashboardChat={select => select(chat)}
        select={() => {}} selectChat={() => {}} refresh={async () => {}} exportSnapshot={() => true}
        sendQuestion={async () => false} retryQuestion={async () => false} retryHistory={async () => {}}
        stopQuestion={async () => {}} loadHistory={async () => {}}
      />)
    `)
    assert.match(html, /role="tablist"/)
    assert.match(html, /role="tab"[^>]*aria-selected="true"/)
    assert.match(html, /role="log"/)
    assert.match(html, /aria-live="polite"/)
    assert.match(html, /<textarea[^>]*maxLength="4000"/i)
    assert.match(html, /&lt;script&gt;synthetic user question&lt;\/script&gt;/)
    assert.doesNotMatch(html, /data-conversation-composer-overlay|href="javascript:|<script>/)
    for (const key of ['view.personal', 'view.ado', 'chat.title', 'chat.personalContext', 'chat.stop', 'chat.older', 'chat.disclosure'] as const) {
      assert.ok(html.includes((locale === 'en' ? en : zh)[key].replaceAll('&', '&amp;')), key)
    }
    assert.match(html, /<textarea[^>]*aria-describedby="[^"]*-disclosure"/)
    assert.doesNotMatch(html, /Enable Dashboard|Disable Dashboard/)
  }
})

test('a different displayed source never renders another source’s replies or enables its composer', async () => {
  const visible = snapshotResponse(ado()).receipt
  const html = await renderSource(`
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { DashboardChat } from './src/client/DashboardChat.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    import { en } from './src/client/locale.ts'
    const store = createDashboardStore().create()
    const state = {
      scope: { id: 'personal', title: 'Personal history' }, status: 'ready', running: true,
      messages: [{ id: 'a', role: 'assistant', text: 'Other scope private answer', streaming: true, interrupted: false }],
      error: 'rejected', errorDetail: 'Other source diagnostic', nativeError: null,
      pendingQuestion: 'Other pending question', retryQuestion: null, retryRevision: null,
    }
    module.exports = renderToStaticMarkup(<DashboardChat state={state} context={null} receipt={${JSON.stringify(visible)}}
      prefs={store.getSnapshot()} actions={store.actions} maxChars={4000} t={key => en[key]}
      sendQuestion={async () => false} retryQuestion={async () => false} retryHistory={async () => {}}
      stopQuestion={async () => {}} loadHistory={async () => {}} />)
  `)
  assert.doesNotMatch(html, /Other scope private answer|Other pending question|Personal history|Other source diagnostic/)
  assert.match(html, /Opening source history/)
  assert.match(html, /Wait for the selected source/)
  assert.match(html, /type="submit"[^>]*disabled=""/)
})

test('streaming remains plain text and finalized Markdown cannot load resources or activate links', async () => {
  const content = [
    '![private evidence](https://images.example.invalid/pixel?context=synthetic)',
    '[linked evidence](https://sources.example.invalid/document)',
    '<img src="https://images.example.invalid/pixel">',
    '<video src="https://images.example.invalid/video"><source src="https://images.example.invalid/source"></video>',
    '<iframe src="https://images.example.invalid/frame"></iframe>',
    '<object data="https://images.example.invalid/object"></object>',
    '<link rel="prefetch" href="https://images.example.invalid/prefetch">',
    '<script src="https://images.example.invalid/script"></script>',
  ].join('\n')
  const receipt = snapshotResponse(personal()).receipt
  receipt.scope.title = content
  for (const streaming of [false, true]) {
    const html = await renderSource(`
      import React from 'react'
      import { renderToStaticMarkup } from 'react-dom/server'
      import { DashboardChat } from './src/client/DashboardChat.tsx'
      import { createDashboardStore } from './src/client/stores.ts'
      import { en } from './src/client/locale.ts'
      const store = createDashboardStore().create()
      const receipt = ${JSON.stringify(receipt)}
      const state = {
        scope: receipt.scope, status: 'ready', running: ${streaming}, hasMore: false, loadingOlder: false,
        messages: [{ id: 'a', role: 'assistant', text: ${JSON.stringify(content)}, streaming: ${streaming}, interrupted: false }],
        error: null, errorDetail: null, nativeError: null, pendingQuestion: null, retryQuestion: null, retryRevision: null,
      }
      module.exports = renderToStaticMarkup(<DashboardChat state={state}
        context={{ receipt, selection: { view: 'personal', stale: false } }} receipt={receipt}
        prefs={store.getSnapshot()} actions={store.actions} maxChars={4000} t={key => en[key]}
        sendQuestion={async () => false} retryQuestion={async () => false} retryHistory={async () => {}}
        stopQuestion={async () => {}} loadHistory={async () => {}} />)
    `)
    if (streaming) {
      assert.ok(html.includes('![private evidence](https://images.example.invalid/pixel?context=synthetic)'))
      assert.ok(html.includes('[linked evidence](https://sources.example.invalid/document)'))
      assert.match(html, /&lt;img src=&quot;https:\/\/images\.example\.invalid\/pixel&quot;&gt;/)
    } else {
      assert.match(html, /private evidence/)
      assert.match(html, /linked evidence/)
      assert.doesNotMatch(html, /images\.example\.invalid|sources\.example\.invalid/)
    }
    assert.doesNotMatch(html, /<(?:a|img|picture|source|video|audio|iframe|object|embed|script|link)\b/i)
    assert.doesNotMatch(html, /\b(?:src|srcset|href|data)=["']https?:\/\//i)
    assert.match(html, /role="log"[^>]*aria-live="polite"/)
  }
})

test('source-local Host diagnostics render as actionable escaped text, not resource elements', async () => {
  const receipt = snapshotResponse(personal()).receipt
  const diagnostic = 'Snapshot expired. Refresh this source. <img src="https://images.example.invalid/private">'
  const html = await renderSource(`
    import React from 'react'
    import { renderToStaticMarkup } from 'react-dom/server'
    import { DashboardChat } from './src/client/DashboardChat.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    import { en } from './src/client/locale.ts'
    const store = createDashboardStore().create()
    const receipt = ${JSON.stringify(receipt)}
    const state = {
      scope: receipt.scope, status: 'ready', running: false, hasMore: false, loadingOlder: false, messages: [],
      error: 'rejected', errorDetail: ${JSON.stringify(diagnostic)}, nativeError: null,
      pendingQuestion: null, retryQuestion: null, retryRevision: null,
    }
    module.exports = renderToStaticMarkup(<DashboardChat state={state}
      context={{ receipt, selection: { view: 'personal', stale: false } }} receipt={receipt}
      prefs={store.getSnapshot()} actions={store.actions} maxChars={4000} t={key => en[key]}
      sendQuestion={async () => false} retryQuestion={async () => false} retryHistory={async () => {}}
      stopQuestion={async () => {}} loadHistory={async () => {}} />)
  `)
  assert.match(html, /role="alert"/)
  assert.ok(html.includes(en['chat.error.rejected']))
  assert.match(html, /Snapshot expired\. Refresh this source\./)
  assert.match(html, /&lt;img src=&quot;https:\/\/images\.example\.invalid\/private&quot;&gt;/)
  assert.doesNotMatch(html, /<img\b|\bsrc=["']https:/)
})
