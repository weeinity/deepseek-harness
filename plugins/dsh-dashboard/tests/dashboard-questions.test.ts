import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DashboardChatError, type DashboardChatSessions } from '../src/host/chat/index.ts'
import { DashboardQuestions } from '../src/host/questions.ts'
import { chatSendSchema } from '../src/shared/chat.ts'
import type { SnapshotContexts } from '../src/host/snapshot-context.ts'
import type { AttentionGrant } from '../src/host/attention-contract.ts'
import { attentionKeySchema } from '../src/shared/attention.ts'

const wire = () => chatSendSchema.parse({
  requestId: 'a1234567-1234-4234-a234-123456789012',
  snapshotId: 'b1234567-1234-4234-a234-123456789012',
  scopeId: 'personal', question: 'What needs attention?',
  selection: { view: 'personal', stale: false },
})
const sessionId = SessionId('synthetic-dashboard-session')
type Receipt = Awaited<ReturnType<DashboardChatSessions['submit']>>
type Submission = Parameters<DashboardChatSessions['submit']>[0]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}
function fixture() {
  const records = new Map<string, { fingerprint: string; receipt: Receipt }>()
  const calls: string[] = []
  const submissions: Submission[] = []
  const chats: Pick<DashboardChatSessions, 'reconcile' | 'open' | 'submit'> = {
    async reconcile(input) {
      calls.push('reconcile')
      const record = records.get(input.requestId)
      if (record && record.fingerprint !== input.requestFingerprint) {
        throw new DashboardChatError('REQUEST_CONFLICT', 'Conflicting original request')
      }
      return record?.receipt
    },
    async open() { calls.push('open'); return { sessionId } },
    async submit(input) {
      calls.push('submit')
      submissions.push(input)
      const receipt = { sessionId, requestId: input.requestId }
      records.set(input.requestId, { fingerprint: input.requestFingerprint, receipt })
      return receipt
    },
  }
  const contexts: Pick<SnapshotContexts, 'scope' | 'compile'> & Partial<Pick<SnapshotContexts, 'attentionGrant'>> = {
    scope() { calls.push('scope'); return { id: wire().scopeId, title: 'Personal Work' } },
    compile() { calls.push('compile'); return 'Synthetic evidence' },
  }
  const archive = async () => { calls.push('archive') }
  return { chats, contexts, records, calls, submissions, archive }
}

test('the whole HTTP transaction is single-flight, including open and archive', async t => {
  const f = fixture()
  const entered = deferred()
  const release = deferred()
  f.chats.open = async () => { f.calls.push('open'); entered.resolve(); await release.promise; return { sessionId } }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  const request = wire()
  const first = questions.submit(request, new AbortController().signal)
  t.after(async () => { release.resolve(); await Promise.allSettled([first]) })
  await entered.promise
  const repeated = questions.submit(structuredClone(request), new AbortController().signal)
  assert.equal(repeated, first)
  await assert.rejects(questions.submit({ ...request, question: 'A different question' }, new AbortController().signal),
    { code: 'REQUEST_CONFLICT' })
  release.resolve()
  assert.deepEqual(await first, { sessionId, requestId: request.requestId })
  assert.deepEqual(f.calls, ['reconcile', 'scope', 'compile', 'open', 'archive', 'submit'])
  assert.equal(f.submissions.length, 1)
  assert.match(f.submissions[0]!.requestFingerprint, /^[a-f0-9]{64}$/)
})

test('a durable retry precedes expired evidence and a reduced question limit', async () => {
  const f = fixture()
  const request = wire()
  const first = await new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
    .submit(request, new AbortController().signal)
  f.calls.length = 0
  f.contexts.scope = () => { throw new Error('Expired snapshot must not be consulted') }
  f.contexts.compile = () => { throw new Error('Context must not be reconstructed') }
  const replay = await new DashboardQuestions(f.chats, f.contexts, 1, f.archive)
    .submit(request, new AbortController().signal)
  assert.deepEqual(replay, first)
  assert.deepEqual(f.calls, ['reconcile'])
  assert.equal(f.submissions.length, 1)
})

test('changed selection conflicts after completion without preparing new evidence', async () => {
  const f = fixture()
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  const request = wire()
  await questions.submit(request, new AbortController().signal)
  f.calls.length = 0
  await assert.rejects(questions.submit({
    ...request, selection: { view: 'personal', stale: true },
  }, new AbortController().signal), { code: 'REQUEST_CONFLICT' })
  assert.deepEqual(f.calls, ['reconcile'])
})

test('expired evidence after an absent receipt is authoritative non-admission', async () => {
  const f = fixture()
  f.contexts.scope = () => { throw new Error('Refresh the expired snapshot') }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  await assert.rejects(questions.submit(wire(), new AbortController().signal),
    { code: 'REQUEST_NOT_ADMITTED', message: 'Refresh the expired snapshot' })
  assert.deepEqual(f.calls, ['reconcile'])
  assert.equal(f.submissions.length, 0)
})

test('cancellation during preparation never submits a native question', async t => {
  const f = fixture()
  const entered = deferred()
  const release = deferred()
  const controller = new AbortController()
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, async () => {
    entered.resolve()
    await release.promise
  })
  const pending = questions.submit(wire(), controller.signal)
  t.after(async () => { release.resolve(); await Promise.allSettled([pending]) })
  await entered.promise
  controller.abort()
  release.resolve()
  await assert.rejects(pending, { code: 'REQUEST_NOT_ADMITTED' })
  assert.equal(f.submissions.length, 0)
})

test('uncertain durable claims never consult snapshots or enqueue work', async () => {
  const f = fixture()
  f.chats.reconcile = async () => { throw new DashboardChatError('REQUEST_UNCERTAIN', 'Interrupted claim') }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  await assert.rejects(questions.submit(wire(), new AbortController().signal), { code: 'REQUEST_UNCERTAIN' })
  assert.equal(f.calls.length, 0)
  assert.equal(f.submissions.length, 0)
})

test('post-queue failure remains ambiguous and can reconcile without another submission', async () => {
  const f = fixture()
  const submit = f.chats.submit
  f.chats.submit = async input => {
    await submit(input)
    throw new DashboardChatError('ADMISSION_FAILED', 'Queue acknowledgement interrupted')
  }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  await assert.rejects(questions.submit(wire(), new AbortController().signal), { code: 'ADMISSION_FAILED' })
  f.contexts.scope = () => { throw new Error('Snapshot expired') }
  assert.deepEqual(await questions.submit(wire(), new AbortController().signal), {
    sessionId, requestId: wire().requestId,
  })
  assert.equal(f.submissions.length, 1)
})

test('native pre-claim framing failures cannot leave an ambiguous retry blocked', async () => {
  const f = fixture()
  f.chats.submit = async () => { throw new DashboardChatError('INVALID_CONTEXT', 'Wrapped context is too large') }
  await assert.rejects(new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
    .submit(wire(), new AbortController().signal), { code: 'REQUEST_NOT_ADMITTED' })
})

test('an accepted pre-filter request keeps its wire fingerprint and reconciles before new client requirements', async () => {
  const f = fixture()
  const request = wire()
  assert.equal(Object.hasOwn(request.selection, 'attentionFilter'), false)
  const receipt = { sessionId, requestId: request.requestId }
  const oldJson = '{"snapshotId":"b1234567-1234-4234-a234-123456789012","scopeId":"personal","requestId":"a1234567-1234-4234-a234-123456789012","question":"What needs attention?","selection":{"view":"personal","stale":false}}'
  assert.equal(JSON.stringify(request), oldJson)
  f.records.set(request.requestId, { fingerprint: createHash('sha256').update(oldJson).digest('hex'), receipt })
  f.contexts.compile = () => { throw new Error('Reload Dashboard before asking about enriched evidence') }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  assert.deepEqual(await questions.submit(request, new AbortController().signal), receipt)
  assert.deepEqual(f.calls, ['reconcile'])
  await assert.rejects(questions.submit({
    ...request, selection: { view: 'personal', stale: false, attentionFilter: 'all' },
  }, new AbortController().signal), { code: 'REQUEST_CONFLICT' })
  assert.equal(f.submissions.length, 0)
})

test('Personal evidence and attention grant freeze together before open or archive can refresh the retained view', async t => {
  const f = fixture()
  const entered = deferred()
  const release = deferred()
  const request = wire()
  request.selection = { view: 'personal', stale: false, attentionVersion: 1 }
  const grant: AttentionGrant = {
    snapshotId: request.snapshotId, expiresAt: '2099-01-01T00:00:00.000Z',
    items: [{
      key: attentionKeySchema.parse(`attention:${'a'.repeat(64)}`),
      title: 'Synthetic item', url: 'https://example.test/item', fingerprint: 'b'.repeat(64),
      itemId: 'item-1', revision: 4, disposition: { mode: 'hidden' }, effective: { mode: 'hidden' },
      changed: false, ambiguous: false, undoable: true,
    }],
  }
  const original = structuredClone(grant)
  f.contexts.compile = () => { f.calls.push('compile'); return JSON.stringify(grant.items) }
  f.contexts.attentionGrant = (snapshotId, scopeId, selection) => {
    f.calls.push('grant')
    assert.equal(snapshotId, request.snapshotId)
    assert.equal(scopeId, request.scopeId)
    assert.deepEqual(selection, request.selection)
    return grant
  }
  f.chats.open = async () => {
    f.calls.push('open')
    entered.resolve()
    await release.promise
    return { sessionId }
  }
  const questions = new DashboardQuestions(f.chats, f.contexts, 4000, f.archive)
  const pending = questions.submit(request, new AbortController().signal)
  t.after(async () => { release.resolve(); await Promise.allSettled([pending]) })
  await entered.promise
  grant.items[0]!.revision = 5
  grant.items[0]!.effective.mode = 'visible'
  grant.expiresAt = '2000-01-01T00:00:00.000Z'
  release.resolve()
  const receipt = await pending
  assert.deepEqual(f.calls, ['reconcile', 'scope', 'compile', 'grant', 'open', 'archive', 'submit'])
  assert.deepEqual(f.submissions[0]!.attentionGrant, original)
  assert.equal(f.submissions[0]!.contextText, JSON.stringify(original.items))
  assert(Object.isFrozen(f.submissions[0]!.attentionGrant!.items[0]!.effective))
  f.calls.length = 0
  f.contexts.scope = () => { throw new Error('Expired evidence must not be reloaded') }
  f.contexts.attentionGrant = () => { throw new Error('Accepted authority must not be reacquired') }
  assert.deepEqual(await new DashboardQuestions(f.chats, f.contexts, 1, f.archive)
    .submit(request, new AbortController().signal), receipt)
  assert.deepEqual(f.calls, ['reconcile'])
  assert.equal(f.submissions.length, 1)
})
