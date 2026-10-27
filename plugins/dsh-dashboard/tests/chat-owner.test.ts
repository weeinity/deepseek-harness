import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { receiptSchema, type DashboardChatSend, type SnapshotReceipt } from '../src/shared/chat.ts'
import { emptyFilters } from '../src/shared/selection.ts'
import { DashboardChatOwner, textMessages, type ChatHistory, type ChatState } from '../src/client/chat-owner.ts'
import type { ChatContext } from '../src/client/chat-selection.ts'
import type { Request } from '../src/client/owner.ts'
import { createDashboardStore } from '../src/client/stores.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function observable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const source: ObservableSnapshot<T> = {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return { source, listeners, update(next: T) { value = next; for (const listener of [...listeners]) listener() } }
}

function receipt(source = 'personal', serial = 1): SnapshotReceipt {
  return receiptSchema.parse({
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    scope: { id: source === 'personal' ? source : `ado:${source.repeat(64)}`, title: `Source ${source}` },
    expiresAt: '2099-01-01T00:00:00Z',
  })
}
function context(value: SnapshotReceipt): ChatContext {
  return {
    receipt: value,
    selection: value.scope.id === 'personal' ? { view: 'personal', stale: false } : {
      view: 'ado', filters: { ...emptyFilters(), type: 'Task' }, selectedItem: 2,
      sort: 'id', direction: 'asc', page: 0, pageSize: 20, stale: false,
    },
  }
}
function projection(text: string): Pick<ChatSnapshot, 'legacy'> {
  return { legacy: {
    nodes: [{ kind: 'assistant', seq: 2, time: 0, turn: 1, step: 1, blocks: [{ kind: 'text', text }] }],
    partial: null, runningCalls: [], turnTimings: new Map(), turnEnds: new Map(),
  } }
}

/** Model-owned observables are the only fake boundary; races use explicit admission/lease barriers. */
function native(sessionId: string, text = sessionId) {
  const lifecycle = observable<SessionSnapshot>({
    sessionId: sessionId as SessionId, pendingSubmissions: [], running: false, subagent: null,
    removed: false, openState: 'open', openError: null, hasMore: true, loadingOlder: false,
    promptError: null, blank: false, lastAgentError: null, promptAttempted: false, awaitingFirstTurn: false,
  })
  const chat = observable<Pick<ChatSnapshot, 'legacy'> | undefined>(projection(text))
  let stops = 0
  let pages = 0
  let releases = 0
  let stopping: Promise<{ ok: true; value: { accepted: true } }> | null = null
  const history: ChatHistory = {
    session: {
      ...lifecycle.source,
      cancel: () => { stops++; return stopping ?? Promise.resolve({ ok: true, value: { accepted: true } }) },
      loadOlder: async () => { pages++ },
    },
    chat: chat.source,
    dispose: async () => { releases++ },
  }
  return {
    history, lifecycle, chat, get stops() { return stops }, get pages() { return pages }, get releases() { return releases },
    stopWith(promise: NonNullable<typeof stopping>) { stopping = promise },
  }
}
interface Call extends ReturnType<typeof deferred<unknown>> {
  endpoint: Parameters<Request>[0]
  payload: unknown
  signal: AbortSignal
}
interface Retention extends ReturnType<typeof deferred<ChatHistory>> { id: string; signal: AbortSignal }

function queue<T>() {
  const values: T[] = []
  const waiting: ((value: T) => void)[] = []
  return {
    push(value: T) { const accept = waiting.shift(); if (accept) accept(value); else values.push(value) },
    next(): Promise<T> { const value = values.shift(); return value === undefined ? new Promise(resolve => { waiting.push(resolve) }) : Promise.resolve(value) },
  }
}
function harness(personalSettled: (afterTurn: boolean) => void = () => {}) {
  const requests = queue<Call>()
  const retentions = queue<Retention>()
  const calls: Call[] = []
  const leases: Retention[] = []
  let uuid = 0
  const owner = new DashboardChatOwner(
    (endpoint, payload, signal) => {
      const call = { ...deferred<unknown>(), endpoint, payload, signal }
      calls.push(call); requests.push(call)
      return call.promise
    },
    (id, signal) => {
      const call = { ...deferred<ChatHistory>(), id, signal }
      leases.push(call); retentions.push(call)
      return call.promise
    },
    () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    personalSettled,
  )
  function until(predicate: (state: ChatState) => boolean): Promise<void> {
    if (predicate(owner.getSnapshot())) return Promise.resolve()
    return new Promise(resolve => {
      const remove = owner.subscribe(() => {
        if (predicate(owner.getSnapshot())) { remove(); resolve() }
      })
    })
  }

  return {
    owner, calls, leases, requests, retentions, until,
    async open(value: SnapshotReceipt, id: string, history = native(id)) {
      owner.select(value)
      const call = await requests.next()
      assert.equal(call.endpoint, 'chat-open')
      assert.deepEqual(call.payload, { snapshotId: value.id })
      call.resolve({ ok: true, value: { sessionId: id, scope: value.scope } })
      const retain = await retentions.next()
      assert.equal(retain.id, id)
      const ready = until(state => state.status === 'ready' && state.sessionId === id)
      retain.resolve(history.history)
      await ready
      return history
    },
    async cleanup() {
      for (const call of calls) call.reject(new Error('Fixture cleanup'))
      for (const lease of leases) lease.reject(new Error('Fixture cleanup'))
      await owner.dispose()
    },
  }
}
function accepted(call: Call, id: string) {
  const payload = call.payload as DashboardChatSend
  call.resolve({ ok: true, value: { sessionId: id, requestId: payload.requestId } })
}

test('Personal opening and native settled transitions request local proposal reads, not streaming chunks or ADO', async t => {
  let reads = 0
  const turns: boolean[] = []
  const h = harness(afterTurn => { reads++; turns.push(afterTurn) }); t.after(() => h.cleanup())
  const unsubscribe = h.owner.subscribe(() => {})
  const personal = await h.open(receipt(), 'personal-native')
  assert.equal(reads, 1)
  personal.chat.update(projection('One text chunk'))
  personal.chat.update(projection('Another text chunk'))
  assert.equal(reads, 1)
  personal.lifecycle.update({ ...personal.lifecycle.source.getSnapshot(), running: true })
  personal.chat.update(projection('Running text'))
  assert.equal(reads, 1)
  personal.lifecycle.update({ ...personal.lifecycle.source.getSnapshot(), running: false })
  assert.equal(reads, 2)
  assert.deepEqual(turns, [false, true])
  personal.lifecycle.update({ ...personal.lifecycle.source.getSnapshot(), loadingOlder: true })
  assert.equal(reads, 2)
  const ado = await h.open(receipt('a'), 'ado-native')
  ado.lifecycle.update({ ...ado.lifecycle.source.getSnapshot(), running: true })
  ado.lifecycle.update({ ...ado.lifecycle.source.getSnapshot(), running: false })
  assert.equal(reads, 2)
  unsubscribe()
  personal.lifecycle.update({ ...personal.lifecycle.source.getSnapshot(), running: false })
  assert.equal(reads, 2)
  assert.ok(h.calls.every(call => call.endpoint === 'chat-open'))
})

test('text projection uses native user/steering, finalized text and accumulated streaming blocks only', () => {
  const base = projection('Final answer')
  type Steering = Extract<ChatSnapshot['legacy']['nodes'][number], { kind: 'steering' }>
  const snapshot: Pick<ChatSnapshot, 'legacy'> = { legacy: { ...base.legacy, nodes: [
    { kind: 'user', seq: 0, time: 0, source: null, content: [{ type: 'text', text: 'Question' }] },
    { kind: 'steering', messageId: 'message' as Steering['messageId'], seq: 1, time: 0, source: null, content: [{ type: 'text', text: 'Follow up' }] },
    ...base.legacy.nodes,
  ], partial: { turn: 2, step: 1, blocks: [{ kind: 'reasoning', text: 'Not public answer text' }, { kind: 'text', text: 'Already accumulated' }] } } }
  assert.deepEqual(textMessages(snapshot).map(message => [message.role, message.text, message.streaming]), [
    ['user', 'Question', false], ['user', 'Follow up', false], ['assistant', 'Final answer', false],
    ['assistant', 'Already accumulated', true],
  ])
  assert.deepEqual(textMessages(snapshot), textMessages(snapshot))
})

test('source switches release native reads without cancelling Agents or mixing histories', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = await h.open(receipt('a'), 'session-a')
  const b = await h.open(receipt('b'), 'session-b')
  assert.equal(a.releases, 1)
  assert.equal(a.stops, 0)
  assert.equal(a.chat.listeners.size, 0)
  assert.equal(a.lifecycle.listeners.size, 0)
  a.chat.update(projection('Late answer A'))
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'session-b')
  const reopened = await h.open(receipt('a', 3), 'session-a', a)
  assert.equal(reopened, a)
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'Late answer A')
  assert.equal(b.releases, 1)
  assert.equal(b.stops, 0)
})

test('late open responses cannot acquire a superseded source history', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  h.owner.select(receipt('a'))
  const old = await h.requests.next()
  await h.open(receipt('b'), 'session-b')
  assert.equal(old.signal.aborted, true)
  old.resolve({ ok: true, value: { sessionId: 'session-a', scope: receipt('a').scope } })
  await old.promise
  assert.deepEqual(h.leases.map(lease => lease.id), ['session-b'])
  assert.equal(h.owner.getSnapshot().sessionId, 'session-b')
})

test('late retain readiness releases its lease instead of publishing over another source', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  h.owner.select(receipt('a'))
  const opening = await h.requests.next()
  opening.resolve({ ok: true, value: { sessionId: 'session-a', scope: receipt('a').scope } })
  const late = await h.retentions.next()
  await h.open(receipt('b'), 'session-b')
  const a = native('session-a')
  late.resolve(a.history)
  await late.promise
  assert.equal(late.signal.aborted, true)
  assert.equal(a.releases, 1)
  assert.equal(a.chat.listeners.size, 0)
  assert.equal(h.owner.getSnapshot().sessionId, 'session-b')
})

test('same-source receipt and filter changes keep native history and freeze each send selection', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt('a')
  await h.open(source, 'session-a')
  const initial = context(source)
  const sending = h.owner.send(initial, '  Which item?  ', 4)
  const call = await h.requests.next()
  if (initial.selection.view !== 'ado') assert.fail()
  initial.selection.filters.type = 'Feature'
  initial.selection.selectedItem = 99
  h.owner.select(receipt('a', 2))
  const payload = call.payload as DashboardChatSend
  assert.equal(payload.question, 'Which item?')
  assert.equal(payload.snapshotId, source.id)
  assert.ok(Object.isFrozen(payload))
  assert.ok(Object.isFrozen(payload.selection))
  assert.equal(payload.selection.view, 'ado')
  if (payload.selection.view !== 'ado') assert.fail()
  assert.equal(payload.selection.filters.type, 'Task')
  assert.equal(payload.selection.selectedItem, 2)
  accepted(call, 'session-a')
  assert.equal(await sending, true)
  assert.equal(h.calls.filter(value => value.endpoint === 'chat-open').length, 1)
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'session-a')
})

test('late send acceptance clears only its captured draft revision, not another source or an edited draft', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt('a'), b = receipt('b')
  const store = createDashboardStore().create()
  await h.open(a, 'session-a')
  store.actions.question(a.scope.id, 'Question A')
  const draft = store.getSnapshot().drafts[a.scope.id]!
  const sending = h.owner.send(context(a), draft.text, draft.revision).then(ok => {
    if (ok) store.actions.accepted(a.scope.id, draft.revision)
  })
  const call = await h.requests.next()
  await h.open(b, 'session-b')
  store.actions.question(b.scope.id, 'Question B')
  store.actions.question(a.scope.id, 'New draft A')
  accepted(call, 'session-a')
  await sending
  assert.equal(store.getSnapshot().drafts[a.scope.id]?.text, 'New draft A')
  assert.equal(store.getSnapshot().drafts[b.scope.id]?.text, 'Question B')
  assert.equal(h.owner.getSnapshot().pendingQuestion, null)
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'session-b')
})

test('ambiguous admission retries preserve the exact captured payload and block unrelated questions', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt('a')
  await h.open(a, 'session-a')
  const first = h.owner.send(context(a), 'Original question', 7)
  const lost = await h.requests.next()
  lost.reject(new Error('Connection ended after admission'))
  assert.equal(await first, false)
  assert.equal(h.owner.getSnapshot().error, 'uncertain')
  assert.equal(h.owner.getSnapshot().retryRevision, 7)
  assert.equal(await h.owner.send(context(a), 'Different question', 8), false)
  h.owner.select(receipt('a', 4))
  const retry = h.owner.retrySend(a.scope.id)
  const repeated = await h.requests.next()
  assert.equal(repeated.payload, lost.payload)
  assert.equal(h.owner.getSnapshot().error, null)
  accepted(repeated, 'session-a')
  assert.equal(await retry, true)
  assert.equal(h.owner.getSnapshot().retryQuestion, null)
})

test('a definite busy rejection retries the same unchanged capture and request identity', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  await h.open(a, 'personal-session')
  const first = h.owner.send(context(a), 'Question', 1)
  const rejected = await h.requests.next()
  rejected.resolve({ ok: false, error: { code: 'BUSY', message: 'Busy' } })
  assert.equal(await first, false)
  assert.equal(h.owner.getSnapshot().error, 'rejected')
  const retry = h.owner.send(context(a), 'Question', 1)
  const call = await h.requests.next()
  assert.equal(call.payload, rejected.payload)
  accepted(call, 'personal-session')
  assert.equal(await retry, true)
})

test('an invalid acceptance echo is ambiguous and never clears the captured question', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  await h.open(a, 'personal-session')
  const sending = h.owner.send(context(a), 'Question', 1)
  const call = await h.requests.next()
  accepted(call, 'unrelated-session')
  assert.equal(await sending, false)
  assert.equal(h.owner.getSnapshot().retryQuestion, 'Question')
})

test('HTTP acceptance does not complete an answer; native lifecycle and errors remain authoritative', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  const history = await h.open(a, 'personal-session')
  const sending = h.owner.send(context(a), 'Question', 1)
  const call = await h.requests.next()
  history.lifecycle.update({ ...history.lifecycle.source.getSnapshot(), running: true })
  history.chat.update({ ...projection('Previous answer'), legacy: {
    ...projection('Previous answer').legacy, partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'Streaming answer' }] },
  } })
  accepted(call, 'personal-session')
  assert.equal(await sending, true)
  assert.equal(h.owner.getSnapshot().running, true)
  assert.equal(h.owner.getSnapshot().messages.at(-1)?.streaming, true)
  history.lifecycle.update({ ...history.lifecycle.source.getSnapshot(), running: false, lastAgentError: 'Synthetic model error' })
  assert.equal(h.owner.getSnapshot().nativeError, 'Synthetic model error')
  assert.equal(h.owner.getSnapshot().running, false)
})

test('stop and earlier-history commands capture the exact native Session before switching tabs', async t => {
  const stop = deferred<{ ok: true; value: { accepted: true } }>()
  const h = harness()
  t.after(async () => { stop.resolve({ ok: true, value: { accepted: true } }); await h.cleanup() })
  h.owner.subscribe(() => {})
  const a = receipt(), b = receipt('b')
  const history = await h.open(a, 'personal-session')
  await h.owner.loadOlder(a.scope.id)
  assert.equal(history.pages, 1)
  history.stopWith(stop.promise)
  const stopping = h.owner.stop(a.scope.id)
  const other = await h.open(b, 'session-b')
  stop.resolve({ ok: true, value: { accepted: true } })
  await stopping
  assert.equal(history.stops, 1)
  assert.equal(other.stops, 0)
  assert.equal(h.owner.getSnapshot().error, null)
  await h.owner.stop(a.scope.id)
  assert.equal(history.stops, 1)
})

test('page unmount releases reads but lets in-flight admission settle and remount resumes the same source', async t => {
  const h = harness(); t.after(() => h.cleanup())
  const unmount = h.owner.subscribe(() => {})
  const a = receipt('a')
  const history = await h.open(a, 'session-a')
  const sending = h.owner.send(context(a), 'Question', 1)
  const call = await h.requests.next()
  unmount()
  assert.equal(history.releases, 1)
  assert.equal(history.stops, 0)
  assert.equal(h.leases[0]?.signal.aborted, true)
  assert.equal(call.signal.aborted, false)
  accepted(call, 'session-a')
  assert.equal(await sending, true)
  h.owner.subscribe(() => {})
  await h.open(a, 'session-a', history)
  assert.equal(h.owner.getSnapshot().sessionId, 'session-a')
  assert.equal(h.owner.getSnapshot().pendingQuestion, null)
})

test('retention failure is visible and requires explicit retry without selection-driven loops', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  h.owner.select(a)
  ;(await h.requests.next()).resolve({ ok: true, value: { sessionId: 'personal-session', scope: a.scope } })
  const retention = await h.retentions.next()
  const failed = h.until(state => state.status === 'error')
  retention.reject(new Error('History unavailable'))
  await failed
  assert.equal(h.owner.getSnapshot().error, 'open')
  h.owner.select(receipt('personal', 5))
  assert.equal(h.calls.length, 1)
  const retry = h.owner.retryOpen()
  await h.open(receipt('personal', 5), 'personal-session')
  await retry
})

test('dispose waits for late retain cleanup and prevents post-disposal publication', async t => {
  const h = harness(); t.after(() => h.cleanup())
  let published = 0
  h.owner.subscribe(() => { published++ })
  const a = receipt()
  h.owner.select(a)
  ;(await h.requests.next()).resolve({ ok: true, value: { sessionId: 'personal-session', scope: a.scope } })
  const retention = await h.retentions.next()
  let done = false
  const disposal = h.owner.dispose().then(() => { done = true })
  const count = published
  assert.equal(retention.signal.aborted, true)
  assert.equal(done, false)
  const history = native('personal-session')
  retention.resolve(history.history)
  await disposal
  assert.equal(history.releases, 1)
  assert.equal(history.stops, 0)
  assert.equal(published, count)
})

test('interrupted Host admission cannot be retried under a new identity', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  await h.open(a, 'personal-session')
  const sending = h.owner.send(context(a), 'Question', 1)
  const call = await h.requests.next()
  call.resolve({ ok: false, error: { code: 'REQUEST_UNCERTAIN', message: 'Inspect history' } })
  assert.equal(await sending, false)
  const retrying = h.owner.retrySend(a.scope.id)
  const retry = await h.requests.next()
  assert.equal(retry.payload, call.payload)
  retry.resolve({ ok: false, error: { code: 'ADMISSION_FAILED', message: 'Not replayable' } })
  assert.equal(await retrying, false)
  assert.equal(h.owner.getSnapshot().error, 'uncertain')
})

test('concurrent local submissions never accept a newer draft through an older promise', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt()
  await h.open(a, 'personal-session')
  const first = h.owner.send(context(a), 'First question', 1)
  const call = await h.requests.next()
  assert.equal(await h.owner.send(context(a), 'Second question', 2), false)
  accepted(call, 'personal-session')
  assert.equal(await first, true)
  assert.equal(h.calls.filter(value => value.endpoint === 'chat-send').length, 1)
})

test('opening and observing Dashboard history does not submit a model question', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  const history = await h.open(source, 'personal-session')
  history.chat.update(projection('Previously recorded synthetic answer'))
  h.owner.select(receipt('personal', 2))
  assert.deepEqual(h.calls.map(call => call.endpoint), ['chat-open'])
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'Previously recorded synthetic answer')
  assert.equal(h.owner.getSnapshot().pendingQuestion, null)
})

test('later native follow errors retain displayed history but block new questions until recovery', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  const history = await h.open(source, 'personal-session')
  history.lifecycle.update({
    ...history.lifecycle.source.getSnapshot(),
    openError: {
      isDSHRemoteError: true, name: 'RemoteError', code: 'gateway/internal',
      message: 'Synthetic follow failure', details: {},
    },
  })
  assert.equal(h.owner.getSnapshot().status, 'error')
  assert.equal(h.owner.getSnapshot().error, 'history')
  assert.equal(h.owner.getSnapshot().errorDetail, 'Synthetic follow failure')
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'personal-session')
  assert.equal(await h.owner.send(context(source), 'Question', 1), false)
  history.lifecycle.update({ ...history.lifecycle.source.getSnapshot(), openError: null })
  assert.equal(h.owner.getSnapshot().status, 'ready')
  assert.equal(h.owner.getSnapshot().error, null)
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  assert.deepEqual(h.calls.map(call => call.endpoint), ['chat-open'])
})

test('native history readiness waits for Chat target materialization without reporting a false failure', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  const history = await h.open(source, 'personal-session')
  history.chat.update(undefined)
  assert.equal(h.owner.getSnapshot().status, 'opening')
  assert.equal(h.owner.getSnapshot().error, null)
  assert.equal(await h.owner.send(context(source), 'Question', 1), false)
  history.chat.update(projection('Materialized answer'))
  assert.equal(h.owner.getSnapshot().status, 'ready')
  assert.equal(h.owner.getSnapshot().messages[0]?.text, 'Materialized answer')
  assert.deepEqual(h.calls.map(call => call.endpoint), ['chat-open'])
})

test('validation and expired receipts cannot resolve an earlier ambiguous admission', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  await h.open(source, 'personal-session')
  const initial = h.owner.send(context(source), 'Original question', 1)
  const first = await h.requests.next()
  first.reject(new Error('Response lost after native admission'))
  assert.equal(await initial, false)
  for (const code of ['INVALID_CONTEXT', 'INVALID_QUESTION', 'dashboard/invalid-input', 'dashboard/receipt-expired']) {
    const retrying = h.owner.retrySend(source.scope.id)
    const retry = await h.requests.next()
    assert.equal(retry.payload, first.payload)
    retry.resolve({ ok: false, error: { code, message: 'Cannot validate this receipt' } })
    assert.equal(await retrying, false)
    assert.equal(h.owner.getSnapshot().error, 'uncertain')
    assert.equal(h.owner.getSnapshot().retryQuestion, 'Original question')
    assert.equal(await h.owner.send(context(source), 'Different question', 2), false)
  }
})

test('after a definite rejection an intentionally changed selection gets a fresh capture', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt('a')
  await h.open(source, 'ado-session')
  const initial = h.owner.send(context(source), 'Question', 1)
  const rejected = await h.requests.next()
  rejected.resolve({ ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'No model route' } })
  assert.equal(await initial, false)
  const selected = context(source)
  if (selected.selection.view !== 'ado') assert.fail()
  selected.selection.filters.type = 'Bug'
  const next = h.owner.send(selected, 'Question', 1)
  const current = await h.requests.next()
  assert.notEqual((current.payload as DashboardChatSend).requestId, (rejected.payload as DashboardChatSend).requestId)
  assert.deepEqual((current.payload as DashboardChatSend).selection, selected.selection)
  accepted(current, 'ado-session')
  assert.equal(await next, true)
})

test('a conflicting request identity is not reused for a new question', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  await h.open(source, 'personal-session')
  const initial = h.owner.send(context(source), 'Question', 1)
  const conflicting = await h.requests.next()
  conflicting.resolve({ ok: false, error: { code: 'REQUEST_CONFLICT', message: 'Different recorded content' } })
  assert.equal(await initial, false)
  assert.equal(h.owner.getSnapshot().error, 'rejected')
  const next = h.owner.send(context(source), 'New question', 2)
  const current = await h.requests.next()
  assert.notEqual((current.payload as DashboardChatSend).requestId, (conflicting.payload as DashboardChatSend).requestId)
  accepted(current, 'personal-session')
  assert.equal(await next, true)
})

test('REQUEST_NOT_ADMITTED resolves prior ambiguity and permits a corrected capture', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  await h.open(source, 'personal-session')
  const initial = h.owner.send(context(source), 'Original question', 1)
  const first = await h.requests.next()
  first.reject(new Error('Lost acknowledgement'))
  assert.equal(await initial, false)
  const reconciling = h.owner.retrySend(source.scope.id)
  const retry = await h.requests.next()
  assert.equal(retry.payload, first.payload)
  retry.resolve({ ok: false, error: {
    code: 'REQUEST_NOT_ADMITTED', message: 'Snapshot expired. Refresh the selected source.', details: {},
  } })
  assert.equal(await reconciling, false)
  assert.equal(h.owner.getSnapshot().error, 'rejected')
  assert.equal(h.owner.getSnapshot().retryQuestion, null)
  assert.equal(h.owner.getSnapshot().errorDetail, 'Snapshot expired. Refresh the selected source.')
  const refreshed = receipt('personal', 2)
  h.owner.select(refreshed)
  const corrected = h.owner.send(context(refreshed), 'Corrected question', 2)
  const current = await h.requests.next()
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  assert.notEqual((current.payload as DashboardChatSend).requestId, (first.payload as DashboardChatSend).requestId)
  assert.equal((current.payload as DashboardChatSend).snapshotId, refreshed.id)
  accepted(current, 'personal-session')
  assert.equal(await corrected, true)
})

test('REQUEST_NOT_ADMITTED can retry an unchanged capture under the same request identity', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  await h.open(source, 'personal-session')
  const initial = h.owner.send(context(source), 'Question', 1)
  const first = await h.requests.next()
  first.resolve({ ok: false, error: {
    code: 'REQUEST_NOT_ADMITTED', message: 'Configure the Dashboard model before sending.',
  } })
  assert.equal(await initial, false)
  const retrying = h.owner.send(context(source), 'Question', 1)
  const retry = await h.requests.next()
  assert.equal(retry.payload, first.payload)
  accepted(retry, 'personal-session')
  assert.equal(await retrying, true)
})

test('chat-open shows validated diagnostics but never raw exceptions, Zod input, or response details', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  h.owner.select(receipt())
  const opening = await h.requests.next()
  const failed = h.until(state => state.status === 'error')
  opening.resolve({ ok: false, error: {
    code: 'PRESET_UNAVAILABLE', message: '  Configure the Dashboard analysis preset.  ',
    details: { debug: 'open-details-must-not-render' },
  } })
  await failed
  assert.equal(h.owner.getSnapshot().errorDetail, 'Configure the Dashboard analysis preset.')
  assert.doesNotMatch(JSON.stringify(h.owner.getSnapshot()), /open-details-must-not-render/)
  let retrying = h.owner.retryOpen()
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  ;(await h.requests.next()).reject(new Error('raw-open-exception-must-not-render'))
  await retrying
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  retrying = h.owner.retryOpen()
  ;(await h.requests.next()).resolve({ ok: false, error: {
    code: 'PRESET_UNAVAILABLE', message: { debug: 'raw-zod-input-must-not-render' },
  } })
  await retrying
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  assert.doesNotMatch(JSON.stringify(h.owner.getSnapshot()), /raw-open-exception|raw-zod-input/)
  retrying = h.owner.retryOpen()
  ;(await h.requests.next()).resolve({ ok: false, error: { code: 'PRESET_UNAVAILABLE', message: '😀'.repeat(600) } })
  await retrying
  assert.equal(Array.from(h.owner.getSnapshot().errorDetail ?? '').length, 512)
  assert.ok(h.owner.getSnapshot().errorDetail?.endsWith('…'))
})

test('chat-send diagnostics are bounded and clear before retries without exposing raw failures', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const source = receipt()
  await h.open(source, 'personal-session')
  let sending = h.owner.send(context(source), 'Question', 1)
  ;(await h.requests.next()).resolve({ ok: false, error: {
    code: 'BUSY', message: '😀'.repeat(600), details: { debug: 'send-details-must-not-render' },
  } })
  assert.equal(await sending, false)
  assert.equal(Array.from(h.owner.getSnapshot().errorDetail ?? '').length, 512)
  assert.ok(h.owner.getSnapshot().errorDetail?.endsWith('…'))
  assert.doesNotMatch(JSON.stringify(h.owner.getSnapshot()), /send-details-must-not-render/)
  sending = h.owner.send(context(source), 'Question', 1)
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  ;(await h.requests.next()).reject(new Error('raw-send-exception-must-not-render'))
  assert.equal(await sending, false)
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  sending = h.owner.retrySend(source.scope.id)
  ;(await h.requests.next()).resolve({ ok: false, error: { code: 'BUSY', message: { debug: 'raw-send-zod-input' } } })
  assert.equal(await sending, false)
  assert.equal(h.owner.getSnapshot().error, 'uncertain')
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  assert.doesNotMatch(JSON.stringify(h.owner.getSnapshot()), /raw-send-exception|raw-send-zod-input/)
})

test('late chat-open and chat-send diagnostics never appear in another source', async t => {
  const h = harness(); t.after(() => h.cleanup())
  h.owner.subscribe(() => {})
  const a = receipt('a'), b = receipt('b')
  h.owner.select(a)
  const lateOpen = await h.requests.next()
  await h.open(b, 'session-b')
  lateOpen.resolve({ ok: false, error: { code: 'PRESET_UNAVAILABLE', message: 'Source A opening diagnostic' } })
  await lateOpen.promise
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  const sending = h.owner.send(context(b), 'Question B', 1)
  const lateSend = await h.requests.next()
  await h.open(a, 'session-a')
  lateSend.resolve({ ok: false, error: { code: 'REQUEST_NOT_ADMITTED', message: 'Source B submission diagnostic' } })
  assert.equal(await sending, false)
  assert.equal(h.owner.getSnapshot().scope?.id, a.scope.id)
  assert.equal(h.owner.getSnapshot().errorDetail, null)
  await h.open(b, 'session-b')
  assert.equal(h.owner.getSnapshot().error, 'rejected')
  assert.equal(h.owner.getSnapshot().errorDetail, 'Source B submission diagnostic')
})
