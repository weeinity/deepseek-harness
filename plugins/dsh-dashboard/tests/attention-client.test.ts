import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { load } from 'cheerio'
import { DashboardOwner, type DashboardState, type Environment, type Request } from '../src/client/owner.ts'
import { attentionDeadline } from '../src/client/attention-time.ts'
import { attentionResponseSchema, personalSchema } from '../src/client/validation.ts'
import { createDashboardRequest } from '../src/client/transport.ts'
import { displayedContext } from '../src/client/chat-selection.ts'
import { createDashboardStore } from '../src/client/stores.ts'
import { projectAttention } from '../src/shared/personal-selection.ts'
import {
  attentionActionIdSchema, attentionKeySchema, attentionProposalIdSchema, type AttentionIntent,
  type AttentionItemState, type AttentionMutation, type AttentionProposal, type AttentionWrite,
} from '../src/shared/attention.ts'
import { receiptSchema, questionIdSchema } from '../src/shared/chat.ts'
import type { DashboardSettings, PersonalSnapshot } from '../src/shared/types.ts'

const instant = '2040-01-02T10:00:00.000Z'
const until = '2040-01-02T10:05:00.000Z'
const uuid = (serial: number) => `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`
const key = attentionKeySchema.parse(`attention:${'a'.repeat(64)}`)
const actionId = attentionActionIdSchema.parse(uuid(80))
const settings: DashboardSettings = {
  timeZone: 'UTC', refreshMinutes: 15, refreshMinute: 0, workdayStart: 9, workdayEnd: 17,
  cacheSeconds: 600, hasReference: true, maxChatQuestionChars: 4000,
}
function item(patch: Partial<AttentionItemState> = {}): AttentionItemState {
  return {
    key, title: 'Synthetic attention alpha', url: 'https://outlook.office.com/mail/alpha',
    fingerprint: 'a'.repeat(64), itemId: 'raw-alpha', revision: 0, disposition: { mode: 'visible' },
    effective: { mode: 'visible' }, changed: false, ambiguous: false, undoable: false, ...patch,
  }
}
function personal(patch: Partial<AttentionItemState> = {}, extra: AttentionItemState[] = []): PersonalSnapshot {
  const entries = [item(patch), ...extra]
  return {
    kind: 'personal', generatedAt: instant, timeZone: 'UTC', displayName: 'Synthetic user',
    nextBusinessDay: '2040-01-03', sources: [{ id: 'reference', state: 'reference', updatedAt: instant }],
    metrics: { overdueActions: null, attentionItems: 19, unreadEmails: null, meetingsNextDay: null, teamsUnread: null, projects: 0, oof: null },
    schedule: [], todayRemaining: [], weekLoad: [], allocation: [], warnings: [],
    sections: [{ id: 'urgent', source: 'reference', items: [{
      id: patch.itemId ?? 'raw-alpha', title: 'Synthetic attention alpha', detail: 'Source record unchanged',
      source: 'reference', url: 'https://outlook.office.com/mail/alpha',
    }] }],
    attention: {
      version: 1, revision: patch.revision ?? 0, evaluatedAt: instant, sourceCount: 19, loadedCount: 1,
      visibleCount: entries.filter(entry => entry.itemId !== null && entry.effective.mode === 'visible').length,
      hiddenCount: entries.filter(entry => entry.itemId !== null && entry.effective.mode === 'hidden').length,
      handledCount: entries.filter(entry => entry.itemId !== null && entry.effective.mode === 'handled').length,
      snoozedCount: entries.filter(entry => entry.itemId !== null && entry.effective.mode === 'snoozed').length,
      ...(patch.effective?.mode === 'snoozed' ? { nextExpiry: patch.effective.until } : {}),
      items: entries,
    },
  }
}
function response(value = personal(), serial = 1, proposals: AttentionProposal[] = [], mutation?: AttentionMutation) {
  return {
    ok: true, value, receipt: receiptSchema.parse({
      id: uuid(serial), scope: { id: 'personal', title: 'Personal Work' }, expiresAt: '2099-01-01T00:00:00Z',
    }), proposals, ...(mutation ? { mutation } : {}),
  }
}
function mutation(intent: AttentionIntent, revision = 1): AttentionMutation {
  return {
    id: actionId, itemKey: key, kind: intent.kind, revision, before: { mode: 'visible' },
    after: intent.kind === 'snooze' ? { mode: 'snoozed', until: intent.until }
      : { mode: intent.kind === 'hide' ? 'hidden' : intent.kind === 'handle' ? 'handled' : 'visible' },
    at: instant, undoable: true,
  }
}
function proposal(patch: Partial<AttentionProposal> = {}): AttentionProposal {
  return {
    id: attentionProposalIdSchema.parse(uuid(90)), sessionId: 'personal-session',
    questionId: questionIdSchema.parse(uuid(91)), target: { key, title: item().title, url: item().url, fingerprint: item().fingerprint },
    intent: { kind: 'hide' }, expectedRevision: 0, createdAt: instant, expiresAt: until, status: 'pending', ...patch,
  }
}
interface Call {
  endpoint: Parameters<Request>[0]; payload: unknown; signal: AbortSignal
  resolve(value: unknown): void; reject(error: Error): void
}

/** Request barriers and the instance-owned clock make cancellation and expiry deterministic. */
function harness() {
  let time = Date.parse(instant)
  let hidden = false
  let serial = 0
  let timerId = 0
  const timers = new Map<number, { callback(): void; delay: number }>()
  const visibility = new Set<() => void>()
  const calls: Call[] = []
  const queue: Call[] = []
  const waiting: ((call: Call) => void)[] = []
  const environment: Environment = {
    now: () => time, hidden: () => hidden,
    onVisibility(callback) { visibility.add(callback); return () => { visibility.delete(callback) } },
    schedule(callback, delay) {
      const id = ++timerId
      timers.set(id, { callback, delay })
      return () => { timers.delete(id) }
    },
  }
  const owner = new DashboardOwner((endpoint, payload, signal) => new Promise((resolve, reject) => {
    const call = { endpoint, payload, signal, resolve, reject }
    calls.push(call)
    const next = waiting.shift()
    if (next) next(call); else queue.push(call)
  }), environment, () => uuid(++serial + 100))
  const take = (): Promise<Call> => queue.length > 0 ? Promise.resolve(queue.shift()!)
    : new Promise(resolve => { waiting.push(resolve) })
  return {
    owner, calls, timers, take, visibility,
    hide(value: boolean) { hidden = value; for (const callback of [...visibility]) callback() },
    clock(value: string) { time = Date.parse(value) },
    fire(delay: number) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, `Expected timer ${delay}`)
      timers.delete(entry[0]); entry[1].callback()
    },
    async boot(value = personal()) {
      owner.select('personal', null)
      const unsubscribe = owner.subscribe(() => {})
      ;(await take()).resolve({ ok: true, value: settings })
      const initial = owner.refresh(false)
      const source = await take()
      assert.equal(source.endpoint, 'snapshot')
      source.resolve(response(value))
      if (value.attention) {
        const local = await take()
        assert.equal(local.endpoint, 'attention-read')
        local.resolve(response(value))
      }
      await initial
      return unsubscribe
    },
    async cleanup() {
      const disposal = owner.dispose()
      for (const call of calls) call.reject(new Error('Fixture cleanup'))
      await disposal
    },
  }
}

test('direct Hide, Handle, Snooze and Restore capture exact keys/revisions and atomically adopt durable receipts', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  for (const [index, intent] of ([
    { kind: 'hide' }, { kind: 'handle' }, { kind: 'snooze', until }, { kind: 'restore' },
  ] satisfies AttentionIntent[]).entries()) {
    const before = h.owner.getSnapshot().personal.data!.attention!.items[0]!
    const pending = h.owner.applyAttention(before, intent)
    const call = await h.take()
    const payload = call.payload as AttentionWrite
    assert.deepEqual(payload, {
      kind: 'apply', requestId: uuid(index + 101), snapshotId: uuid(index + 1),
      itemKey: key, expectedRevision: index, intent,
    })
    assert.equal(call.endpoint, 'attention-write')
    assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(index + 1))
    assert.equal(h.owner.getSnapshot().personal.data?.attention?.items[0]?.revision, index)
    assert.equal(h.owner.getSnapshot().attention?.mutation, null)
    await h.owner.applyAttention(before, { kind: 'hide' })
    assert.equal(h.calls.filter(entry => entry.endpoint === 'attention-write').length, index + 1)
    const saved = mutation(intent, index + 1)
    const value = personal({
      revision: index + 1, disposition: saved.after, effective: saved.after, lastActionId: saved.id, undoable: true,
    })
    call.resolve(response(value, index + 2, [], saved))
    await pending
    assert.deepEqual(h.owner.getSnapshot().personal.data, value)
    assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(index + 2))
    assert.equal(h.owner.getSnapshot().attention?.pending, null)
  }
  const undo = h.owner.undoAttention(actionId)
  const call = await h.take()
  assert.deepEqual(call.payload, { kind: 'undo', requestId: uuid(105), snapshotId: uuid(5), actionId })
  call.resolve(response(personal({ revision: 5 }), 6, [], { ...mutation({ kind: 'restore' }, 5), kind: 'undo', undoable: false }))
  await undo
  assert.equal(h.owner.getSnapshot().attention?.mutation?.undoable, false)
  assert.deepEqual(h.calls.filter(call => !['settings', 'snapshot', 'attention-read', 'attention-write'].includes(call.endpoint)), [])
})

test('response loss retains the identical frozen request and blocks new intents until an explicit safe Retry settles', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const before = h.owner.getSnapshot().personal.data!
  const write = h.owner.applyAttention(before.attention!.items[0]!, { kind: 'hide' })
  const call = await h.take()
  call.reject(new Error('Synthetic lost response'))
  await write
  assert.equal(h.owner.getSnapshot().attention?.error, 'uncertain')
  const captured = h.owner.getSnapshot().attention?.pending
  assert.equal(captured, call.payload)
  assert.ok(Object.isFrozen(captured))
  assert.equal(h.owner.getSnapshot().personal.data, before)
  assert.equal(displayedContext(h.owner.getSnapshot(), createDashboardStore().create().getSnapshot()), null)
  const count = h.calls.length
  await h.owner.applyAttention(item(), { kind: 'handle' })
  await h.owner.undoAttention(actionId)
  assert.equal(h.calls.length, count)
  const retry = h.owner.retryAttention()
  const retried = await h.take()
  assert.equal(retried.payload, call.payload)
  const saved = mutation({ kind: 'hide' })
  retried.resolve(response(personal({
    revision: 1, effective: saved.after, disposition: saved.after, lastActionId: saved.id, undoable: true,
  }), 2, [], saved))
  await retry
  assert.equal(h.owner.getSnapshot().attention?.pending, null)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(2))
  assert.equal(displayedContext(h.owner.getSnapshot(), createDashboardStore().create().getSnapshot())?.receipt.id, uuid(2))
})

test('saved item keys, revisions and Undo survive owner recreation, raw-row identity changes and a normal refresh', async t => {
  const saved = mutation({ kind: 'handle' }, 3)
  const value = personal({
    itemId: 'raw-reordered-alpha', revision: 3, disposition: saved.after, effective: saved.after,
    lastActionId: saved.id, undoable: true,
  })
  const first = harness(); t.after(() => first.cleanup())
  await first.boot(value)
  assert.equal(first.owner.getSnapshot().personal.data?.attention?.items[0]?.lastActionId, actionId)
  await first.owner.dispose()
  const h = harness(); t.after(() => h.cleanup())
  await h.boot(value)
  const refresh = h.owner.refresh()
  const raw = await h.take()
  assert.equal(raw.endpoint, 'snapshot')
  raw.resolve(response(personal(), 3))
  const local = await h.take()
  assert.deepEqual(local.payload, { view: 'personal' })
  local.resolve(response(value, 4))
  await refresh
  const retained = h.owner.getSnapshot().personal.data?.attention?.items[0]!
  assert.equal(retained.key, key)
  assert.equal(retained.revision, 3)
  assert.equal(retained.itemId, 'raw-reordered-alpha')
  assert.equal(retained.undoable, true)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(4))
})

test('invalid acknowledgement stays uncertain while a definitive stale rejection is visible without resubmission', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const write = h.owner.applyAttention(item(), { kind: 'hide' })
  ;(await h.take()).resolve(response(personal(), 2))
  await write
  assert.equal(h.owner.getSnapshot().attention?.error, 'uncertain')
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(1))
  const retry = h.owner.retryAttention()
  ;(await h.take()).resolve({ ok: false, error: { code: 'STALE', message: 'Refresh local decisions.', details: 'Not displayable' } })
  await retry
  assert.equal(h.owner.getSnapshot().attention?.error, 'rejected')
  assert.equal(h.owner.getSnapshot().attention?.errorDetail, 'Refresh local decisions.')
  assert.equal(h.owner.getSnapshot().attention?.pending, null)
  assert.equal(h.calls.filter(call => call.endpoint === 'attention-write').length, 2)
})

test('post-commit and pre-reconciliation Host failures preserve the exact pending operation for safe retry', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const write = h.owner.applyAttention(item(), { kind: 'hide' })
  const call = await h.take()
  call.resolve({ ok: false, error: { code: 'dashboard/provider', message: 'The response could not be built.' } })
  await write
  assert.equal(h.owner.getSnapshot().attention?.error, 'uncertain')
  const freshRead = h.owner.readAttention()
  const local = await h.take()
  assert.equal(local.endpoint, 'attention-read')
  local.resolve(response(personal({ revision: 1, disposition: { mode: 'hidden' }, effective: { mode: 'hidden' } }), 2))
  await freshRead
  assert.equal(h.owner.getSnapshot().attention?.pending, call.payload)
  assert.equal(h.owner.getSnapshot().attention?.error, 'uncertain')
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(2))
  for (const code of ['dashboard/cancelled', 'dashboard/invalid-input', 'SNAPSHOT_EXPIRED', 'NOT_READY', 'CORRUPT']) {
    const retry = h.owner.retryAttention()
    const repeated = await h.take()
    assert.equal(repeated.payload, call.payload)
    repeated.resolve({ ok: false, error: { code, message: 'Synthetic unconfirmed result.' } })
    await retry
    assert.equal(h.owner.getSnapshot().attention?.pending, call.payload)
    assert.equal(h.owner.getSnapshot().attention?.error, 'uncertain')
  }
  const retry = h.owner.retryAttention()
  const confirmed = await h.take()
  assert.equal(confirmed.payload, call.payload)
  const saved = mutation({ kind: 'hide' })
  confirmed.resolve(response(personal({ revision: 1, disposition: saved.after, effective: saved.after }), 2, [], saved))
  await retry
  assert.equal(h.owner.getSnapshot().attention?.pending, null)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(2))
})

test('an old source refresh or read cannot overwrite a newer local mutation and receipt', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const sourceRefresh = h.owner.refresh()
  const source = await h.take()
  const write = h.owner.applyAttention(item(), { kind: 'hide' })
  const call = await h.take()
  assert.equal(source.signal.aborted, true)
  const saved = mutation({ kind: 'hide' })
  const current = response(personal({ revision: 1, effective: saved.after, disposition: saved.after }), 2, [], saved)
  call.resolve(current)
  await write
  source.resolve(response(personal(), 99))
  await sourceRefresh
  assert.deepEqual(h.owner.getSnapshot().personal.data, current.value)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(2))
  const read = h.owner.readAttention()
  const old = await h.take()
  const restoring = h.owner.applyAttention(current.value.attention!.items[0]!, { kind: 'restore' })
  const restore = await h.take()
  assert.equal(old.signal.aborted, true)
  restore.resolve(response(personal({ revision: 2 }), 3, [], mutation({ kind: 'restore' }, 2)))
  await restoring
  old.resolve(current)
  await read
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(3))
})

test('local expiry uses no providers; returning after the source TTL refreshes with data retained', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot(personal({ revision: 1, disposition: { mode: 'snoozed', until }, effective: { mode: 'snoozed', until } }))
  assert.equal(h.timers.size, 2)
  const providers = h.calls.filter(call => call.endpoint === 'snapshot').length
  h.clock(until); h.fire(5 * 60_000)
  const call = await h.take()
  assert.equal(call.endpoint, 'attention-read')
  const pending = h.owner.readAttention()
  call.resolve(response(personal({ revision: 1, disposition: { mode: 'snoozed', until } }), 2))
  await pending
  assert.equal(h.owner.getSnapshot().personal.data?.attention?.visibleCount, 1)
  assert.equal(h.calls.filter(call => call.endpoint === 'snapshot').length, providers)
  h.hide(true)
  assert.equal(h.timers.size, 0)
  h.clock('2040-01-02T20:00:00.000Z')
  h.hide(false)
  const resume = await h.take()
  assert.equal(resume.endpoint, 'snapshot')
  assert.ok(h.owner.getSnapshot().personal.data)
  const resumed = h.owner.refresh(false)
  resume.resolve(response(personal({ revision: 2 }), 3))
  const local = await h.take()
  assert.equal(local.endpoint, 'attention-read')
  local.resolve(response(personal({ revision: 2 }), 3))
  await resumed
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(3))
  assert.equal(h.calls.filter(call => call.endpoint === 'snapshot').length, providers + 1)
})

test('failed source refresh still reads local expiry and preserves the independent source error', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot(personal({ revision: 1, disposition: { mode: 'snoozed', until }, effective: { mode: 'snoozed', until } }))
  h.clock(until)
  const refresh = h.owner.refresh()
  const source = await h.take()
  source.resolve({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'Synthetic source unavailable.' } })
  const local = await h.take()
  assert.equal(local.endpoint, 'attention-read')
  local.resolve(response(personal({ revision: 1, disposition: { mode: 'snoozed', until } }), 2))
  await refresh
  assert.equal(h.owner.getSnapshot().personal.data?.attention?.visibleCount, 1)
  assert.equal(h.owner.getSnapshot().personal.status, 'error')
  assert.equal(h.owner.getSnapshot().personal.errorDetail, 'Synthetic source unavailable.')
  assert.equal(h.owner.getSnapshot().personal.stale, true)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(2))
})

test('a source timer firing during a write preserves the next scheduled refresh without overlapping provider work', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const writing = h.owner.applyAttention(item(), { kind: 'hide' })
  const call = await h.take()
  h.clock('2040-01-02T10:15:00.000Z')
  h.fire(15 * 60_000)
  assert.equal(h.calls.filter(entry => entry.endpoint === 'snapshot').length, 1)
  const saved = mutation({ kind: 'hide' })
  call.resolve(response(personal({ revision: 1, disposition: saved.after, effective: saved.after }), 2, [], saved))
  await writing
  assert.equal(h.timers.size, 1)
  assert.equal([...h.timers.values()][0]?.delay, 15 * 60_000)
})

test('settled native read requests coalesce during an in-flight read and never start inference', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const first = h.owner.readAttention()
  const beforeStage = await h.take()
  assert.equal(h.owner.readAttention(true), first)
  assert.equal(h.owner.readAttention(true), first)
  beforeStage.resolve(response(personal()))
  const afterStage = await h.take()
  afterStage.resolve(response(personal(), 2, [proposal()]))
  await first
  assert.equal(h.owner.getSnapshot().attention?.proposals.length, 1)
  assert.equal(h.calls.filter(call => call.endpoint === 'attention-read').length, 3)
  assert.equal(h.calls.filter(call => call.endpoint === 'attention-write' || call.endpoint === 'chat-send').length, 0)
})

test('Cancel and Apply use proposal identities and refresh statuses without inferring actions from text', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const read = h.owner.readAttention()
  ;(await h.take()).resolve(response(personal(), 2, [proposal()]))
  await read
  assert.equal(h.calls.filter(call => call.endpoint === 'attention-write').length, 0)
  const cancel = h.owner.decideAttention(proposal().id, 'cancel')
  const call = await h.take()
  assert.deepEqual(call.payload, { kind: 'cancel', requestId: uuid(101), snapshotId: uuid(2), proposalId: proposal().id })
  call.resolve(response(personal(), 3, [proposal({ status: 'cancelled' })]))
  await cancel
  assert.equal(h.owner.getSnapshot().attention?.proposals[0]?.status, 'cancelled')
  assert.equal(h.owner.getSnapshot().attention?.mutation, null)
  const apply = h.owner.decideAttention(proposal().id, 'confirm')
  const confirmation = await h.take()
  assert.deepEqual(confirmation.payload, { kind: 'confirm', requestId: uuid(102), snapshotId: uuid(3), proposalId: proposal().id })
  confirmation.resolve({ ok: false, error: { code: 'STALE', message: 'This proposal was cancelled.' } })
  await apply
  assert.equal(h.owner.getSnapshot().attention?.error, 'rejected')
})

test('absent saved records accept only Restore and ambiguous items cannot submit controls', async t => {
  const h = harness(); t.after(() => h.cleanup())
  await h.boot()
  const absent = item({ itemId: null, revision: 4, disposition: { mode: 'hidden' } })
  const count = h.calls.length
  await h.owner.applyAttention(absent, { kind: 'hide' })
  await h.owner.applyAttention(absent, { kind: 'handle' })
  await h.owner.applyAttention(absent, { kind: 'snooze', until })
  await h.owner.applyAttention(item({ ambiguous: true }), { kind: 'restore' })
  assert.equal(h.calls.length, count)
  const restore = h.owner.applyAttention(absent, { kind: 'restore' })
  const call = await h.take()
  assert.equal((call.payload as Extract<AttentionWrite, { kind: 'apply' }>).expectedRevision, 4)
  call.resolve(response(personal(), 2, [], mutation({ kind: 'restore' }, 5)))
  await restore
})

test('navigation and awaited disposal suppress late publications and retain uncertain writes for remount', async t => {
  const h = harness(); t.after(() => h.cleanup())
  const unsubscribe = await h.boot()
  let publications = 0
  const remove = h.owner.subscribe(() => { publications++ })
  const read = h.owner.readAttention()
  const call = await h.take()
  h.owner.select('ado', null)
  const observed = publications
  call.resolve(response(personal({ revision: 9 }), 9))
  await read
  assert.equal(publications, observed)
  assert.equal(h.owner.getSnapshot().personal.receipt?.id, uuid(1))
  assert.equal(h.timers.size, 0)
  unsubscribe(); remove()
  await h.owner.readAttention()
  assert.equal(h.calls.filter(entry => entry.endpoint === 'attention-read').length, 2)
  await h.owner.dispose()
  assert.equal(h.visibility.size, 0)

  const other = harness(); t.after(() => other.cleanup())
  await other.boot()
  const write = other.owner.applyAttention(item(), { kind: 'hide' })
  const pending = await other.take()
  let disposed = false
  const disposal = other.owner.dispose().then(() => { disposed = true })
  assert.equal(pending.signal.aborted, true)
  assert.equal(disposed, false)
  pending.resolve(response(personal({ revision: 1 }), 2, [], mutation({ kind: 'hide' })))
  await Promise.all([write, disposal])
  assert.equal(other.owner.getSnapshot().personal.receipt?.id, uuid(1))
  assert.equal(other.owner.getSnapshot().attention?.pending, pending.payload)
})

test('attention metadata and counts validate, older snapshots remain supported, and question captures opt in only with attention', async t => {
  assert.ok(personalSchema.safeParse(personal()).success)
  const wrong = personal()
  wrong.attention!.hiddenCount = 1
  assert.equal(personalSchema.safeParse(wrong).success, false)
  const projected = projectAttention(personal({
    revision: 1, disposition: { mode: 'hidden' }, effective: { mode: 'hidden' },
  }), 'all')
  assert.equal(projected.sections[0]?.items.length, 0)
  assert.equal(projected.attention?.loadedCount, 1)
  assert.equal(personalSchema.safeParse(projected).success, true)
  const missing = personal()
  missing.sections[0]!.items[0]!.id = 'missing-metadata'
  assert.equal(personalSchema.safeParse(missing).success, false)
  assert.equal(attentionResponseSchema.safeParse({ ...response(), proposals: [{ status: 'guessed' }] }).success, false)
  const h = harness(); t.after(() => h.cleanup())
  const old = personal()
  delete old.attention
  await h.boot(old)
  await h.owner.applyAttention(item(), { kind: 'hide' })
  assert.equal(h.calls.length, 2)
  const prefs = createDashboardStore().create().getSnapshot()
  assert.equal(displayedContext(h.owner.getSnapshot(), prefs)?.selection.view, 'personal')
  assert.ok(!('attentionVersion' in displayedContext(h.owner.getSnapshot(), prefs)!.selection))
  const current: DashboardState = {
    ...h.owner.getSnapshot(), personal: { ...h.owner.getSnapshot().personal, data: personal() },
  }
  assert.equal((displayedContext(current, prefs)?.selection as { attentionVersion?: number }).attentionVersion, 1)
})

test('explicit deadlines reject past, malformed, nonexistent and repeated local times without browser-zone fallback', () => {
  const now = Date.parse('2039-01-01T00:00:00Z')
  assert.deepEqual(attentionDeadline('2040-01-02T10:05', 'UTC', now), { ok: true, until })
  assert.deepEqual(attentionDeadline('2040-01-02T10:05', 'America/Los_Angeles', now),
    { ok: true, until: '2040-01-02T18:05:00.000Z' })
  assert.deepEqual(attentionDeadline('2040-03-11T02:30', 'America/Los_Angeles', now), { ok: false, error: 'gap' })
  assert.deepEqual(attentionDeadline('2040-11-04T01:30', 'America/Los_Angeles', now), { ok: false, error: 'ambiguous' })
  assert.deepEqual(attentionDeadline('2040-02-31T10:00', 'UTC', now), { ok: false, error: 'invalid' })
  assert.deepEqual(attentionDeadline('2040-01-02T10:00', 'Invalid/Zone', now), { ok: false, error: 'invalid' })
  assert.deepEqual(attentionDeadline('2040-01-02T10:00', 'UTC', Date.parse(instant)), { ok: false, error: 'past' })
})

test('attention transport uses authenticated fixed POST routes, never an EventSource channel', async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const request = createDashboardRequest(async (input, init) => {
    calls.push({ input, init })
    return new Response(JSON.stringify(response()), { status: 200 })
  })
  const controller = new AbortController()
  await request('attention-read', { view: 'personal' }, controller.signal)
  await request('attention-write', { kind: 'undo', requestId: uuid(2), snapshotId: uuid(1), actionId }, controller.signal)
  assert.deepEqual(calls.map(call => call.input), ['/api/dsh-dashboard/attention-read', '/api/dsh-dashboard/attention-write'])
  for (const call of calls) {
    assert.equal(call.init?.method, 'POST')
    assert.equal(call.init?.credentials, 'same-origin')
    assert.equal(call.init?.signal, controller.signal)
  }
})

async function render(contents: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const directory = fileURLToPath(new URL('..', import.meta.url))
  const result = await build({
    absWorkingDir: directory, stdin: { contents, loader: 'tsx', resolveDir: directory }, bundle: true,
    platform: 'node', format: 'cjs', jsx: 'automatic', write: false, outfile: 'attention-render.cjs', logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  })
  const module: { exports: unknown } = { exports: {} }
  runInNewContext(result.outputFiles.find(file => file.path.endsWith('.cjs'))!.text, {
    module, exports: module.exports, require, process, console, setTimeout, clearTimeout, queueMicrotask,
    TextEncoder, TextDecoder, Buffer, URL, AbortController, crypto, structuredClone,
    fetch: () => { throw new Error('Static UI must not request resources') },
  })
  const html = await module.exports
  assert.equal(typeof html, 'string')
  return String(html)
}
const renderSetup = `
  import { renderToStaticMarkup } from 'react-dom/server'
  import { en } from './src/client/locale.ts'
  const t = (key, values = {}) => en[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name] ?? ''))
  const actions = { apply: fail, undo: fail, decide: fail, retry: fail, read: fail }
  function fail() { throw new Error('Rendering never applies or reads decisions') }
`

test('review keeps hidden, handled, snoozed and absent decisions accessible with local-only labels and durable Undo', async () => {
  const absentKey = attentionKeySchema.parse(`attention:${'b'.repeat(64)}`)
  const value = personal({
    revision: 1, disposition: { mode: 'hidden' }, effective: { mode: 'hidden' }, undoable: true, lastActionId: actionId,
  }, [item({ key: absentKey, itemId: null, title: 'Absent synthetic decision', revision: 1, disposition: { mode: 'handled' } })])
  value.attention!.sourceCount = null
  const $ = load(await render(`${renderSetup}
    import { Personal } from './src/client/Personal.tsx'
    module.exports = renderToStaticMarkup(<Personal snapshot={${JSON.stringify(value)}} t={t}
      attentionFilter="all" onAttentionFilter={() => {}} adjustments={actions} />)
  `))
  assert.equal($('[class*="attentionItems"] > li').length, 0)
  assert.match($('[class*="attentionSummary"]').text(), /0 visible · 1 hidden · 0 handled · 0 snoozed/)
  assert.match($('[class*="attentionSummary"]').text(), /Unchanged source total: —.*Unavailable, not zero/)
  assert.match($('[class*="attentionReview"]').text(), /Hidden locally.*Undo local change/)
  assert.equal($('a button, a input, a form').length, 0)
  const absent = $('li').filter((_index, element) => $(element).text().includes('Absent synthetic decision'))
  assert.deepEqual(absent.find('button').map((_index, element) => $(element).text()).get(), ['Restore attention'])
  assert.match($.text(), /Original source counts and readings/)
  const snoozed = personal({ revision: 1, disposition: { mode: 'snoozed', until }, effective: { mode: 'snoozed', until } })
  const snooze = load(await render(`${renderSetup}
    import { AttentionReview } from './src/client/AttentionControls.tsx'
    module.exports = renderToStaticMarkup(<AttentionReview view={${JSON.stringify(snoozed.attention)}} actions={actions} zone="UTC" t={t} />)
  `))
  assert.equal(snooze('time').attr('datetime'), until)
  assert.match(snooze.text(), /Snoozed locally until.*UTC/)
})

test('proposal cards retain target, deadline and Host status; pending cards never mutate until an explicit click', async () => {
  const proposals = [
    proposal({ intent: { kind: 'snooze', until } }),
    proposal({ id: attentionProposalIdSchema.parse(uuid(92)), status: 'applied', intent: { kind: 'handle' } }),
    proposal({ id: attentionProposalIdSchema.parse(uuid(93)), sessionId: 'another-session', target: { ...proposal().target, title: 'Other source card' } }),
    proposal({ id: attentionProposalIdSchema.parse(uuid(94)), status: 'expired' }),
    proposal({ id: attentionProposalIdSchema.parse(uuid(95)), status: 'cancelled' }),
    proposal({ id: attentionProposalIdSchema.parse(uuid(96)), status: 'stale' }),
  ]
  const $ = load(await render(`${renderSetup}
    import { AttentionProposals } from './src/client/AttentionControls.tsx'
    module.exports = renderToStaticMarkup(<AttentionProposals proposals={${JSON.stringify(proposals)}}
      sessionId="personal-session" actions={actions} zone="UTC" t={t} />)
  `))
  assert.equal($('[data-proposal]').length, 5)
  assert.equal($('[data-status="pending"] button').length, 2)
  assert.match($('[data-status="pending"]').text(), /Awaiting confirmation · not applied/)
  assert.equal($('[data-status="pending"] time').attr('datetime'), until)
  assert.equal($('[data-status="applied"] button, [data-status="expired"] button').length, 0)
  assert.equal($('[data-status="cancelled"] button, [data-status="stale"] button').length, 0)
  assert.match($('[data-status="applied"]').text(), /handled locally, not completed at source/)
  assert.doesNotMatch($.text(), /Other source card/)
  assert.equal($('a button').length, 0)
})

test('uncertain feedback exposes both exact Retry and a fresh local read without claiming a saved mutation', async () => {
  const pending = { kind: 'apply', requestId: uuid(2), snapshotId: uuid(1), itemKey: key, expectedRevision: 0, intent: { kind: 'hide' } }
  const $ = load(await render(`${renderSetup}
    import { AttentionFeedback } from './src/client/AttentionControls.tsx'
    module.exports = renderToStaticMarkup(<AttentionFeedback t={t} actions={{ ...actions, state: {
      status: 'error', error: 'uncertain', errorDetail: null, pending: ${JSON.stringify(pending)}, proposals: [], mutation: null
    } }} />)
  `))
  assert.deepEqual($('button').map((_index, element) => $(element).text()).get(),
    ['Retry captured operation', 'Reload local adjustments'])
  assert.match($.text(), /result is unconfirmed/)
  assert.doesNotMatch($.text(), /Local decision saved/)
})

test('ADO Q&A never exposes Personal proposal cards or local adjustment disclosure', async () => {
  const $ = load(await render(`${renderSetup}
    import { DashboardChat } from './src/client/DashboardChat.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    const store = createDashboardStore().create()
    const receipt = { id: ${JSON.stringify(uuid(1))}, scope: { id: 'ado:${'a'.repeat(64)}', title: 'Synthetic ADO' }, expiresAt: '2099-01-01T00:00:00Z' }
    const state = { scope: receipt.scope, status: 'ready', sessionId: 'personal-session', messages: [], running: false,
      hasMore: false, loadingOlder: false, nativeError: null, error: null, errorDetail: null, pendingQuestion: null,
      retryQuestion: null, retryRevision: null }
    module.exports = renderToStaticMarkup(<DashboardChat t={t} actions={store.actions} prefs={store.getSnapshot()}
      receipt={receipt} context={null} state={state} maxChars={4000} sendQuestion={fail} retryQuestion={fail}
      retryHistory={fail} stopQuestion={fail} loadHistory={fail}
      adjustments={{ ...actions, state: { proposals: ${JSON.stringify([proposal()])} } }} />)
  `))
  assert.equal($('[data-proposal]').length, 0)
  assert.match($.text(), /Answers cannot change source data or run tools/)
  assert.doesNotMatch($.text(), /Local attention confirmations|only Apply saves/)
})

test('ambiguous identity controls are visibly disabled and changed items expose the local review warning', async () => {
  const $ = load(await render(`${renderSetup}
    import { ItemAttentionControls } from './src/client/AttentionControls.tsx'
    module.exports = renderToStaticMarkup(<ItemAttentionControls item={${JSON.stringify(item({ ambiguous: true, changed: true }))}}
      actions={actions} zone="America/Los_Angeles" t={t} />)
  `))
  assert.equal($('button:not([disabled])').length, 0)
  assert.equal($('button').length, 3)
  assert.match($.text(), /Source content changed.*identity matches multiple items/)
  assert.equal($('[role="group"]').attr('aria-label'), `Local attention controls for ${item().title}`)
})
