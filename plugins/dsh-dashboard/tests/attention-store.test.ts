import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey, type KvUnit } from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { AttentionStore } from '../src/host/attention-store.ts'
import { dashboardAttentionDomain } from '../src/host/attention-domain.ts'
import { DashboardAttentionViews } from '../src/host/attention-views.ts'
import { SnapshotContexts } from '../src/host/snapshot-context.ts'
import type { AttentionProposalRequest } from '../src/host/attention-contract.ts'
import {
  attentionActionIdSchema, attentionViewSchema, attentionMutationSchema, attentionProposalSchema,
  type AttentionIntent, type AttentionWrite,
} from '../src/shared/attention.ts'
import { questionIdSchema, snapshotIdSchema } from '../src/shared/chat.ts'
import type { DashboardItem, PersonalSnapshot } from '../src/shared/types.ts'

const snapshotId = snapshotIdSchema.parse('00000000-0000-4000-8000-000000000001')
const time = Date.parse('2026-09-14T12:00:00.000Z')
const signal = () => new AbortController().signal
const requestId = () => attentionActionIdSchema.parse(randomUUID())
const iso = (offset: number) => new Date(time + offset).toISOString()

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

function source(items: DashboardItem[] = [item()]): PersonalSnapshot {
  return {
    kind: 'personal', generatedAt: iso(0), timeZone: 'UTC', displayName: 'Synthetic',
    nextBusinessDay: '2026-09-15', sources: [{ id: 'reference', state: 'reference', updatedAt: iso(0) }],
    metrics: { attentionItems: 71, overdueActions: null, unreadEmails: null, meetingsNextDay: null, teamsUnread: null, projects: 8, oof: null },
    schedule: [], todayRemaining: [], weekLoad: [], allocation: [],
    sections: [
      { id: 'urgent', source: 'reference', items },
      { id: 'projects', source: 'reference', items: [item('project', 'Synthetic project')] },
    ],
    referenceAsOf: 'Last refreshed September 1, 2026', warnings: ['Synthetic incomplete source'],
  }
}

function item(id = 'reference-urgent-0', title = 'Synthetic follow-up', detail = 'Review the synthetic draft.'): DashboardItem {
  return {
    id, title, detail, url: 'https://dev.azure.com/example/project/_workitems/edit/1',
    source: 'reference', severity: 'hot', sourceDate: 'Last refreshed September 1, 2026',
  }
}

function apply(captured: PersonalSnapshot, intent: AttentionIntent, index = 0): AttentionWrite {
  const target = captured.attention!.items[index]!
  return { kind: 'apply', requestId: requestId(), snapshotId, itemKey: target.key, expectedRevision: target.revision, intent }
}

function proposal(captured: PersonalSnapshot, intent: AttentionIntent = { kind: 'hide' }, index = 0): AttentionProposalRequest {
  return {
    sessionId: 'synthetic-session', questionId: questionIdSchema.parse(randomUUID()), callId: 'synthetic-call',
    evidenceDigest: 'synthetic-evidence',
    grant: { snapshotId, expiresAt: iso(60_000), items: captured.attention!.items },
    input: { itemKey: captured.attention!.items[index]!.key, intent },
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.attention-test-'))
  const ctx = new Context()
  const owners: AttentionStore[] = []
  const release: (() => void)[] = []
  const hooks = {
    now: time,
    checks: 0,
    beforeOwnership: async () => {},
    beforePut: async (_table: string, _key: string, _value: unknown) => {},
  }
  t.after(async () => {
    for (const done of release) done()
    hooks.beforeOwnership = async () => {}
    hooks.beforePut = async () => {}
    try {
      await Promise.all(owners.map(owner => owner.dispose()))
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      }
    }
  })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  const backend = ctx.storage.backend.get('json')
  const instrumented = {
    kv: {
      open: async (descriptor: Parameters<NonNullable<typeof backend.kv>['open']>[0]): Promise<KvUnit> => {
        const unit = await backend.kv!.open(descriptor)
        return {
          loadAll: () => unit.loadAll(),
          putRecord: async (table, key, value) => { await hooks.beforePut(table, key, value); await unit.putRecord(table, key, value) },
          deleteRecord: (table, key) => unit.deleteRecord(table, key),
          deleteRecords: (table, keys) => unit.deleteRecords(table, keys),
          setGlobal: value => unit.setGlobal(value),
          close: () => unit.close(),
        }
      },
    },
    close: async () => {},
  }
  ctx.effect(() => ctx.storage.backend.register('attention-test', instrumented), 'attentionTest.backend()')
  ctx.provide(storageBackendServiceKey('attention-test'), instrumented)
  await ctx.plugin(StorageDomain, { backend: 'attention-test' })
  const start = async () => {
    const owner = new AttentionStore(ctx, {
      now: () => hooks.now,
      checkOwnership: async () => { hooks.checks += 1; await hooks.beforeOwnership() },
    })
    owners.push(owner)
    await owner.ready
    return owner
  }
  return {
    root, ctx, hooks, start, owner: await start(),
    barrier: () => { const barrier = deferred(); release.push(barrier.resolve); return barrier },
  }
}

test('hide, handle, snooze, Restore, and Undo preserve source data and previous decisions', async t => {
  const f = await fixture(t)
  const raw = source()
  const original = structuredClone(raw)
  let captured = f.owner.decorate(raw)
  const hidden = await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  assert(hidden)
  attentionMutationSchema.parse(hidden)
  captured = f.owner.decorate(raw)
  assert.equal(captured.attention!.hiddenCount, 1)
  const handled = await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  assert(handled)
  captured = f.owner.decorate(raw)
  assert.equal(captured.attention!.handledCount, 1)
  const undone = await f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: handled.id }, captured, () => raw, signal())
  assert.equal(undone?.after.mode, 'hidden')
  assert.equal(undone?.undoable, false)
  captured = f.owner.decorate(raw)
  const snoozed = await f.owner.write(apply(captured, { kind: 'snooze', until: iso(2_000) }), captured, () => raw, signal())
  assert(snoozed)
  captured = f.owner.decorate(raw)
  assert.equal(captured.attention!.snoozedCount, 1)
  assert.equal(captured.attention!.nextExpiry, iso(2_000))
  const restored = await f.owner.write(apply(captured, { kind: 'restore' }), captured, () => raw, signal())
  assert(restored)
  captured = f.owner.decorate(raw)
  assert.equal(captured.attention!.visibleCount, 1)
  const restoreUndo = await f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: restored.id }, captured, () => raw, signal())
  assert.deepEqual(restoreUndo?.after, { mode: 'snoozed', until: iso(2_000) })
  assert.deepEqual(raw, original)
  const decorated = f.owner.decorate(raw)
  attentionViewSchema.parse(decorated.attention)
  const { attention: _, ...unchanged } = decorated
  assert.deepEqual(unchanged, raw)
  assert.equal(decorated.attention!.sourceCount, 71)
  assert.equal(decorated.attention!.loadedCount, 1)
})

test('exact snooze expiry is evaluated without a write and missing rows do not affect counts', async t => {
  const f = await fixture(t)
  const raw = source([item(), item('reference-urgent-1', 'Another synthetic item')])
  let captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'snooze', until: iso(2_000) }), captured, () => raw, signal())
  captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'snooze', until: iso(4_000) }, 1), captured, () => raw, signal())
  f.hooks.now = time + 1_999
  assert.equal(f.owner.decorate(raw).attention!.snoozedCount, 2)
  f.hooks.now = time + 2_000
  const expired = f.owner.decorate(raw).attention!
  assert.equal(expired.revision, 2)
  assert.equal(expired.visibleCount, 1)
  assert.equal(expired.snoozedCount, 1)
  assert.equal(expired.nextExpiry, iso(4_000))
  assert.equal(expired.items[0]!.disposition.mode, 'snoozed')
  const absent = f.owner.decorate(source([])).attention!
  assert.equal(absent.items.length, 2)
  assert.equal(absent.loadedCount, 0)
  assert.equal(absent.visibleCount, 0)
  assert.equal(absent.snoozedCount, 0)
  assert.equal(absent.nextExpiry, undefined)
  f.hooks.now = time + 4_000
  assert.equal(f.owner.decorate(raw).attention!.nextExpiry, undefined)
})

test('unavailable or missing urgent sources retain unknown source count', async t => {
  const f = await fixture(t)
  const missing = source([])
  missing.sections = []
  missing.metrics.attentionItems = 0
  assert.equal(f.owner.decorate(missing).attention!.sourceCount, null)
  const unavailable = source([])
  unavailable.sections[0]!.source = 'unavailable'
  unavailable.metrics.attentionItems = 0
  assert.equal(f.owner.decorate(unavailable).attention!.sourceCount, null)
  const available = source([])
  available.metrics.attentionItems = 0
  assert.equal(f.owner.decorate(available).attention!.sourceCount, 0)
  assert.deepEqual(f.owner.decorate(unavailable).metrics, unavailable.metrics)
})

test('reordered positional IDs never transfer a saved choice to another row', async t => {
  const f = await fixture(t)
  const raw = source([item(), item('reference-urgent-1', 'Another synthetic item')])
  const captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  const reordered = source([item('reference-urgent-0', 'Another synthetic item'), item('reference-urgent-1')])
  const view = f.owner.decorate(reordered).attention!
  assert.equal(view.items[0]!.effective.mode, 'visible')
  assert.equal(view.items[1]!.effective.mode, 'hidden')
  assert.equal(view.items[1]!.itemId, 'reference-urgent-1')
})

test('same briefing with changed fetch/as-of dates preserves decisions while content changes resurface', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  const refreshed = structuredClone(raw)
  refreshed.generatedAt = iso(10_000)
  refreshed.referenceAsOf = 'Last refreshed September 14, 2026'
  refreshed.sources[0]!.updatedAt = iso(10_000)
  refreshed.sections[0]!.items[0]!.sourceDate = refreshed.referenceAsOf
  assert.equal(f.owner.decorate(refreshed).attention!.items[0]!.effective.mode, 'handled')
  refreshed.sections[0]!.items[0]!.detail = 'Synthetic draft reopened.'
  const changed = f.owner.decorate(refreshed).attention!.items[0]!
  assert.equal(changed.effective.mode, 'visible')
  assert.equal(changed.disposition.mode, 'handled')
  assert.equal(changed.changed, true)
  assert.equal(changed.revision, 1)
})

test('title/link changes retain old missing decisions without fuzzy suppression', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  for (const changedRow of [
    item('reference-urgent-0', 'Synthetic follow-up reopened'),
    { ...item(), url: `${item().url}0` },
  ]) {
    const view = f.owner.decorate(source([changedRow])).attention!
    assert.equal(view.items.length, 2)
    assert.equal(view.items[0]!.effective.mode, 'visible')
    assert.equal(view.items[1]!.itemId, null)
    assert.equal(view.hiddenCount, 0)
    assert.equal(view.visibleCount, 1)
  }
})

test('all duplicate identities remain visible and non-actionable, including with an existing choice', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  const duplicate = source([item(), item('reference-urgent-1', item().title, 'Other synthetic detail.')])
  const view = f.owner.decorate(duplicate)
  assert.equal(view.attention!.visibleCount, 2)
  assert(view.attention!.items.every(row => row.ambiguous && !row.undoable && row.effective.mode === 'visible'))
  await assert.rejects(f.owner.write(apply(view, { kind: 'handle' }), view, () => duplicate, signal()), { code: 'AMBIGUOUS' })
  await assert.rejects(f.owner.propose(proposal(view), signal()), { code: 'AMBIGUOUS' })
})

test('only Restore can change a missing saved item', async t => {
  const f = await fixture(t)
  const raw = source()
  let captured = f.owner.decorate(raw)
  const hidden = await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  const missing = source([])
  captured = f.owner.decorate(missing)
  assert.equal(captured.attention!.items[0]!.undoable, false)
  for (const intent of [{ kind: 'hide' }, { kind: 'handle' }, { kind: 'snooze', until: iso(2_000) }] as AttentionIntent[]) {
    await assert.rejects(f.owner.write(apply(captured, intent), captured, () => missing, signal()), { code: 'INVALID_INTENT' })
  }
  await assert.rejects(f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: hidden!.id }, captured, () => missing, signal()), { code: 'INVALID_INTENT' })
  const restored = await f.owner.write(apply(captured, { kind: 'restore' }), captured, () => missing, signal())
  assert.equal(restored!.after.mode, 'visible')
  assert.equal(f.owner.decorate(missing).attention!.items.length, 0)
})

test('old source and revision proofs reject and fresh proof remains usable', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const changed = source([item('reference-urgent-0', item().title, 'Reopened synthetic detail')])
  await assert.rejects(f.owner.write(apply(captured, { kind: 'hide' }), captured, () => changed, signal()), { code: 'STALE' })
  const hidden = await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  await assert.rejects(f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal()), { code: 'STALE' })
  const fresh = f.owner.decorate(raw)
  const handled = await f.owner.write(apply(fresh, { kind: 'handle' }), fresh, () => raw, signal())
  await assert.rejects(f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: hidden!.id }, fresh, () => raw, signal()), { code: 'STALE' })
  await assert.rejects(f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: handled!.id }, fresh, () => raw, signal()), { code: 'STALE' })
})

test('Undo restores the previous source fingerprint rather than suppressing reopened content', async t => {
  const f = await fixture(t)
  const raw = source()
  let captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  const reopened = source([item('reference-urgent-0', item().title, 'Reopened synthetic detail')])
  captured = f.owner.decorate(reopened)
  const handled = await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => reopened, signal())
  captured = f.owner.decorate(reopened)
  const undone = await f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: handled!.id }, captured, () => reopened, signal())
  assert.equal(undone!.after.mode, 'hidden')
  assert.equal(f.owner.decorate(reopened).attention!.items[0]!.changed, true)
  assert.equal(f.owner.decorate(reopened).attention!.items[0]!.effective.mode, 'visible')
  assert.equal(f.owner.decorate(raw).attention!.items[0]!.effective.mode, 'hidden')
  const latest = f.owner.decorate(reopened)
  await assert.rejects(f.owner.write({ kind: 'undo', requestId: requestId(), snapshotId, actionId: undone!.id }, latest, () => reopened, signal()), { code: 'STALE' })
  await f.owner.dispose()
  const restarted = await f.start()
  assert.equal(restarted.decorate(reopened).attention!.items[0]!.changed, true)
  assert.equal(restarted.decorate(raw).attention!.items[0]!.effective.mode, 'hidden')
})

test('explicit future timestamps reject exact/past expiry and malformed request JSON', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  for (const until of [iso(-1), iso(0)]) {
    await assert.rejects(f.owner.write(apply(captured, { kind: 'snooze', until }), captured, () => raw, signal()), { code: 'INVALID_INTENT' })
  }
  const valid = apply(captured, { kind: 'hide' })
  await assert.rejects(f.owner.write(JSON.parse(JSON.stringify({ ...valid, sourceScope: 'ado' })) as AttentionWrite, captured, () => raw, signal()))
  await assert.rejects(f.owner.write(JSON.parse(JSON.stringify({ ...valid, intent: { kind: 'snooze', until: 'tomorrow' } })) as AttentionWrite, captured, () => raw, signal()))
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
})

test('request receipts survive JSON restart and conflicting reuse never changes a decision', async t => {
  const f = await fixture(t)
  const raw = source()
  let captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  const first = await f.owner.write(request, captured, () => raw, signal())
  captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  assert.deepEqual(await f.owner.write(request, source([]), () => source([]), signal()), first)
  assert.equal(f.owner.decorate(raw).attention!.revision, 2)
  await f.owner.dispose()
  const document = JSON.parse(await readFile(join(f.root, 'dashboard_attention.json'), 'utf8'))
  assert.equal(document.tables.actions[request.requestId].outcome.result.after.mode, 'hidden')
  const owner = await f.start()
  assert.equal(owner.decorate(raw).attention!.handledCount, 1)
  assert.deepEqual(await owner.write(request, source([]), () => source([]), signal()), first)
  await assert.rejects(owner.write({ ...request, intent: { kind: 'restore' } } as AttentionWrite, captured, () => raw, signal()), { code: 'CONFLICT' })
  assert.equal(owner.decorate(raw).attention!.revision, 2)
})

test('native proposals persist and dedupe exact evidence/intent without applying', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = proposal(captured)
  const unbound = f.owner.propose
  const first = await unbound(request, signal())
  attentionProposalSchema.parse(first)
  assert.equal(first.status, 'pending')
  assert.equal(first.expiresAt, request.grant.expiresAt)
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
  assert.equal(f.owner.decorate(raw).attention!.visibleCount, 1)
  assert.deepEqual(await f.owner.propose(request, signal()), first)
  await f.owner.dispose()
  const owner = await f.start()
  assert.deepEqual(await owner.propose(request, signal()), first)
  assert.deepEqual(owner.proposals(raw), [first])
  for (const changed of [
    { ...request, evidenceDigest: 'different-synthetic-evidence' },
    { ...request, input: { ...request.input, intent: { kind: 'handle' as const } } },
    { ...request, grant: { ...request.grant, expiresAt: iso(90_000) } },
  ]) await assert.rejects(owner.propose(changed, signal()), { code: 'CONFLICT' })
})

test('proposal scope, expiry, and revision checks cannot widen captured evidence', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = proposal(captured)
  await assert.rejects(f.owner.propose({ ...request, grant: { ...request.grant, items: [] } }, signal()), { code: 'SCOPE' })
  await assert.rejects(f.owner.propose({ ...request, grant: { ...request.grant, expiresAt: iso(0) } }, signal()), { code: 'EXPIRED' })
  const saved = await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
  assert(saved)
  await assert.rejects(f.owner.propose(request, signal()), { code: 'STALE' })
  assert.deepEqual(f.owner.proposals(raw), [])
})

test('confirm commits the exact proposal and repeated confirmations never apply twice', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = proposal(captured, { kind: 'handle' })
  const staged = await f.owner.propose(request, signal())
  const confirm: AttentionWrite = { kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id }
  const applied = await f.owner.write(confirm, captured, () => raw, signal())
  assert.equal(applied!.after.mode, 'handled')
  assert.equal(f.owner.proposals(raw)[0]!.status, 'applied')
  assert.deepEqual(await f.owner.write(confirm, source([]), () => source([]), signal()), applied)
  const again: AttentionWrite = { ...confirm, requestId: requestId() }
  assert.deepEqual(await f.owner.write(again, source([]), () => source([]), signal()), applied)
  assert.equal(f.owner.decorate(raw).attention!.items[0]!.revision, 1)
  const fresh = f.owner.decorate(raw)
  await f.owner.write(apply(fresh, { kind: 'restore' }), fresh, () => raw, signal())
  await f.owner.dispose()
  const owner = await f.start()
  assert.equal(owner.proposals(raw)[0]!.status, 'applied')
  assert.equal(owner.decorate(raw).attention!.visibleCount, 1)
  assert.deepEqual(await owner.write(again, source([]), () => source([]), signal()), applied)
  assert.equal((await owner.propose(request, signal())).status, 'applied')
})

test('cancel is durable, idempotent, and cannot adjust an item or cancel an applied proposal', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  const cancel: AttentionWrite = { kind: 'cancel', requestId: requestId(), snapshotId, proposalId: staged.id }
  assert.equal(await f.owner.write(cancel, captured, () => raw, signal()), undefined)
  assert.equal(await f.owner.write(cancel, captured, () => raw, signal()), undefined)
  assert.equal(await f.owner.write({ ...cancel, requestId: requestId() }, captured, () => raw, signal()), undefined)
  assert.equal(f.owner.proposals(raw)[0]!.status, 'cancelled')
  assert.equal(f.owner.decorate(raw).attention!.items[0]!.revision, 0)
  await assert.rejects(f.owner.write({ ...cancel, kind: 'confirm' }, captured, () => raw, signal()), { code: 'CONFLICT' })
  await assert.rejects(f.owner.write({ ...cancel, kind: 'confirm', requestId: requestId() }, captured, () => raw, signal()), { code: 'STALE' })
  await f.owner.dispose()
  const owner = await f.start()
  assert.equal(owner.proposals(raw)[0]!.status, 'cancelled')
  assert.equal(await owner.write(cancel, captured, () => raw, signal()), undefined)
  const other = await owner.propose(proposal(captured), signal())
  await owner.write({ kind: 'confirm', requestId: requestId(), snapshotId, proposalId: other.id }, captured, () => raw, signal())
  await assert.rejects(owner.write({ kind: 'cancel', requestId: requestId(), snapshotId, proposalId: other.id }, captured, () => raw, signal()), { code: 'CONFLICT' })
})

test('proposal status and confirmation reject changed source, stale state, duplicate identities, and exact expiry', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  const confirm = (): AttentionWrite => ({ kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id })
  for (const current of [
    source([item('reference-urgent-0', item().title, 'Reopened synthetic detail')]),
    source([item(), item('reference-urgent-1')]),
    source([]),
  ]) {
    assert.equal(f.owner.proposals(current)[0]!.status, 'stale')
    await assert.rejects(f.owner.write(confirm(), captured, () => current, signal()), { code: 'STALE' })
  }
  f.hooks.now = time + 59_999
  assert.equal(f.owner.proposals(raw)[0]!.status, 'pending')
  f.hooks.now = time + 60_000
  assert.equal(f.owner.proposals(raw)[0]!.status, 'expired')
  await assert.rejects(f.owner.write(confirm(), captured, () => raw, signal()), { code: 'EXPIRED' })
  f.hooks.now = time
  await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  assert.equal(f.owner.proposals(raw)[0]!.status, 'stale')
  await assert.rejects(f.owner.write(confirm(), captured, () => raw, signal()), { code: 'STALE' })
})

test('failed native durability leaves item state, receipts, and proposal resolution unchanged', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  const request: AttentionWrite = { kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id }
  f.hooks.beforePut = async () => { throw new Error('Synthetic write failure') }
  await assert.rejects(f.owner.write(request, captured, () => raw, signal()), /Synthetic write failure/)
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
  assert.equal(f.owner.decorate(raw).attention!.visibleCount, 1)
  assert.equal(f.owner.proposals(raw)[0]!.status, 'pending')
  await f.owner.dispose()
  const owner = await f.start()
  assert.equal(owner.decorate(raw).attention!.revision, 0)
  assert.equal(owner.proposals(raw)[0]!.status, 'pending')
  f.hooks.beforePut = async () => {}
  const result = await owner.write(request, captured, () => raw, signal())
  assert.equal(result!.after.mode, 'hidden')
})

test('failed proposal staging does not reserve its native execution identity', async t => {
  const f = await fixture(t)
  const raw = source()
  const request = proposal(f.owner.decorate(raw))
  f.hooks.beforePut = async () => { throw new Error('Synthetic proposal write failure') }
  await assert.rejects(f.owner.propose(request, signal()), /Synthetic proposal write failure/)
  assert.equal(f.owner.proposals(raw).length, 0)
  f.hooks.beforePut = async () => {}
  assert.equal((await f.owner.propose(request, signal())).status, 'pending')
})

test('serialized concurrency publishes only durable state and disposal drains admitted work', async t => {
  const f = await fixture(t)
  const entered = f.barrier()
  const release = f.barrier()
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  let writes = 0
  f.hooks.beforePut = async () => {
    writes += 1
    if (writes === 1) { entered.resolve(); await release.promise }
  }
  const first = f.owner.write(request, captured, () => raw, signal())
  await entered.promise
  assert.equal(f.owner.decorate(raw).attention!.visibleCount, 1)
  const duplicate = f.owner.write(request, captured, () => raw, signal())
  const stale = assert.rejects(f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal()), { code: 'STALE' })
  let closed = false
  const disposal = f.owner.dispose().then(() => { closed = true })
  assert.equal(closed, false)
  await assert.rejects(f.owner.write(request, captured, () => raw, signal()), { code: 'CLOSED' })
  await assert.rejects(f.owner.propose(proposal(captured), signal()), { code: 'CLOSED' })
  release.resolve()
  assert.deepEqual(await duplicate, await first)
  await stale
  await disposal
  assert.equal(writes, 1)
  const restarted = await f.start()
  assert.equal(restarted.decorate(raw).attention!.hiddenCount, 1)
})

test('latest source is checked after ownership waits and cancellation before commit prevents a write', async t => {
  const f = await fixture(t)
  const entered = f.barrier()
  const release = f.barrier()
  const raw = source()
  const captured = f.owner.decorate(raw)
  let current = raw
  f.hooks.beforeOwnership = async () => { entered.resolve(); await release.promise }
  const writing = f.owner.write(apply(captured, { kind: 'hide' }), captured, () => current, signal())
  await entered.promise
  current = source([item('reference-urgent-0', item().title, 'Reopened synthetic detail')])
  release.resolve()
  await assert.rejects(writing, { code: 'STALE' })
  f.hooks.beforeOwnership = async () => {}
  const cancelled = new AbortController()
  cancelled.abort(new Error('Synthetic cancellation'))
  await assert.rejects(f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, cancelled.signal), /Synthetic cancellation/)
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
  assert(f.hooks.checks >= 2)
})

test('cancellation after durable admission still returns the committed receipt', async t => {
  const f = await fixture(t)
  const entered = f.barrier()
  const release = f.barrier()
  const raw = source()
  const captured = f.owner.decorate(raw)
  const controller = new AbortController()
  f.hooks.beforePut = async () => { entered.resolve(); await release.promise }
  const writing = f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, controller.signal)
  await entered.promise
  controller.abort(new Error('Synthetic late cancellation'))
  release.resolve()
  assert.equal((await writing)!.after.mode, 'hidden')
  assert.equal(f.owner.decorate(raw).attention!.hiddenCount, 1)
})

test('ownership loss rejects durable work without publishing local decisions', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  f.hooks.beforeOwnership = async () => { throw new Error('Synthetic ownership loss') }
  await assert.rejects(f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal()), /Synthetic ownership loss/)
  await assert.rejects(f.owner.propose(proposal(captured), signal()), /Synthetic ownership loss/)
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
  f.hooks.beforeOwnership = async () => {}
})

test('authoritative replay rejects schema, sequence, transition, and proposal corruption', async t => {
  for (const change of ['schema', 'gap', 'duplicate-sequence', 'before', 'result', 'request', 'proposal'] as const) {
    await t.test(change, async child => {
      const f = await fixture(child)
      const raw = source()
      let captured = f.owner.decorate(raw)
      const first = apply(captured, { kind: 'hide' })
      await f.owner.write(first, captured, () => raw, signal())
      captured = f.owner.decorate(raw)
      const staged = await f.owner.propose(proposal(captured), signal())
      const second = apply(captured, { kind: 'handle' })
      await f.owner.write(second, captured, () => raw, signal())
      await f.owner.dispose()
      const domain = await f.ctx.storageDomain.open(dashboardAttentionDomain)
      const firstRow = structuredClone(domain.table('actions').get(first.requestId)!)
      const secondRow = structuredClone(domain.table('actions').get(second.requestId)!)
      if (change === 'schema') {
        await domain.close()
        const path = join(f.root, 'dashboard_attention.json')
        const document = JSON.parse(await readFile(path, 'utf8'))
        document.tables.actions[first.requestId].sequence = 'invalid'
        await writeFile(path, JSON.stringify(document))
      } else {
        if (change === 'gap') await domain.table('actions').delete(first.requestId)
        if (change === 'duplicate-sequence') {
          secondRow.sequence = 1
          await domain.table('actions').put(second.requestId, secondRow)
        }
        if (change === 'before') {
          assert.equal(secondRow.outcome.kind, 'mutation')
          if (secondRow.outcome.kind === 'mutation') secondRow.outcome.before = null
          await domain.table('actions').put(second.requestId, secondRow)
        }
        if (change === 'result') {
          assert.equal(firstRow.outcome.kind, 'mutation')
          if (firstRow.outcome.kind === 'mutation') firstRow.outcome.result.revision = 2
          await domain.table('actions').put(first.requestId, firstRow)
        }
        if (change === 'request') {
          firstRow.fingerprint = '0'.repeat(64)
          await domain.table('actions').put(first.requestId, firstRow)
        }
        if (change === 'proposal') {
          const [key, record] = [...domain.table('proposals').entries()][0]!
          assert.equal(record.proposal.id, staged.id)
          await domain.table('proposals').put(key, { ...record, createdSequence: 10 })
        }
        await domain.close()
      }
      await assert.rejects(f.start(), change === 'schema' ? { code: 'invalid-record' } : { code: 'CORRUPT' })
    })
  }
})

test('returned proposals and decisions cannot mutate the authoritative in-memory journal', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  const result = await f.owner.write(request, captured, () => raw, signal())
  result!.after.mode = 'handled'
  const decorated = f.owner.decorate(raw)
  decorated.attention!.items[0]!.disposition.mode = 'handled'
  assert.equal(f.owner.decorate(raw).attention!.hiddenCount, 1)
  assert.equal((await f.owner.write(request, captured, () => raw, signal()))!.after.mode, 'hidden')
  const staged = await f.owner.propose(proposal(f.owner.decorate(raw)), signal())
  staged.intent.kind = 'handle'
  assert.equal(f.owner.proposals(raw)[0]!.intent.kind, 'hide')
})

test('every stored disposition survives restart with its exact item revision', async t => {
  const f = await fixture(t)
  const raw = source()
  let owner = f.owner
  let revision = 0
  for (const intent of [
    { kind: 'hide' }, { kind: 'handle' }, { kind: 'snooze', until: iso(2_000) }, { kind: 'restore' },
  ] as AttentionIntent[]) {
    const captured = owner.decorate(raw)
    const applied = await owner.write(apply(captured, intent), captured, () => raw, signal())
    await owner.dispose()
    owner = await f.start()
    revision += 1
    const stored = owner.decorate(raw).attention!.items[0]!
    assert.deepEqual(stored.disposition, applied!.after)
    assert.equal(stored.revision, revision)
    assert.equal(stored.lastActionId, applied!.id)
  }
})

test('unrelated item writes and proposal cancellations do not invalidate an item revision', async t => {
  const f = await fixture(t)
  const raw = source([item(), item('reference-urgent-1', 'Another synthetic item')])
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  await f.owner.write(apply(captured, { kind: 'hide' }, 1), captured, () => raw, signal())
  await f.owner.write({ kind: 'cancel', requestId: requestId(), snapshotId, proposalId: staged.id }, captured, () => raw, signal())
  const applied = await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  assert.equal(applied!.revision, 1)
  const view = f.owner.decorate(raw).attention!
  assert.equal(view.revision, 3)
  assert.deepEqual(view.items.map(row => row.revision), [1, 1])
  await f.owner.dispose()
  const owner = await f.start()
  assert.deepEqual(owner.decorate(raw).attention!.items.map(row => row.revision), [1, 1])
})

test('a captured missing decision can propose and confirm Restore without widening its grant', async t => {
  const f = await fixture(t)
  const raw = source()
  let captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  const missing = source([])
  captured = f.owner.decorate(missing)
  await assert.rejects(f.owner.propose(proposal(captured, { kind: 'hide' }), signal()), { code: 'INVALID_INTENT' })
  const staged = await f.owner.propose(proposal(captured, { kind: 'restore' }), signal())
  const applied = await f.owner.write({ kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id }, captured, () => missing, signal())
  assert.equal(applied!.after.mode, 'visible')
  assert.equal(f.owner.decorate(missing).attention!.items.length, 0)
  await f.owner.dispose()
  const owner = await f.start()
  assert.equal(owner.proposals(missing)[0]!.status, 'applied')
  assert.equal(owner.decorate(missing).attention!.items.length, 0)
})

test('concurrent matching native calls stage one durable proposal', async t => {
  const f = await fixture(t)
  const raw = source()
  const request = proposal(f.owner.decorate(raw))
  const entered = f.barrier()
  const release = f.barrier()
  let writes = 0
  f.hooks.beforePut = async () => { writes += 1; entered.resolve(); await release.promise }
  const first = f.owner.propose(request, signal())
  await entered.promise
  assert.equal(f.owner.proposals(raw).length, 0)
  const second = f.owner.propose(request, signal())
  release.resolve()
  assert.deepEqual(await first, await second)
  assert.equal(writes, 1)
  assert.equal(f.owner.decorate(raw).attention!.visibleCount, 1)
})

test('proposal replay uses journal ordering rather than assuming a monotonic wall clock', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  f.hooks.now = time - 1_000
  await f.owner.write({ kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id }, captured, () => raw, signal())
  await f.owner.dispose()
  const owner = await f.start()
  assert.equal(owner.proposals(raw)[0]!.status, 'applied')
  assert.equal(owner.decorate(raw).attention!.hiddenCount, 1)
})

test('snooze proposals become stale at their target time before evidence expiry', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured, { kind: 'snooze', until: iso(2_000) }), signal())
  f.hooks.now = time + 2_000
  assert.equal(f.owner.proposals(raw)[0]!.status, 'stale')
  await assert.rejects(f.owner.write({ kind: 'confirm', requestId: requestId(), snapshotId, proposalId: staged.id }, captured, () => raw, signal()), { code: 'STALE' })
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
})

test('disposal drains initialization and closes its domain before another owner opens', async t => {
  const f = await fixture(t)
  await f.owner.dispose()
  const entered = f.barrier()
  const release = f.barrier()
  let checks = 0
  const owner = new AttentionStore(f.ctx, {
    now: () => time,
    checkOwnership: async () => {
      checks += 1
      if (checks === 1) { entered.resolve(); await release.promise }
    },
  })
  t.after(() => owner.dispose())
  await entered.promise
  assert.throws(() => owner.decorate(source()), { code: 'NOT_READY' })
  const disposal = owner.dispose()
  release.resolve()
  await disposal
  assert.equal(checks, 2)
  assert.throws(() => owner.decorate(source()), { code: 'CLOSED' })
  const restarted = await f.start()
  assert.equal(restarted.decorate(source()).attention!.revision, 0)
})

test('reconcile returns original durable mutations after restart and evidence expiry without writing', async t => {
  const f = await fixture(t)
  const raw = source()
  let captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  assert.equal(await f.owner.reconcile(request, signal()), undefined)
  const original = await f.owner.write(request, captured, () => raw, signal())
  captured = f.owner.decorate(raw)
  await f.owner.write(apply(captured, { kind: 'handle' }), captured, () => raw, signal())
  await f.owner.dispose()
  f.hooks.now = time + 86_400_000
  const owner = await f.start()
  f.hooks.beforePut = async () => { throw new Error('Reconciliation must not write') }
  assert.deepEqual(await owner.reconcile(request, signal()), { mutation: original })
  const copy = await owner.reconcile(request, signal())
  copy!.mutation!.after.mode = 'handled'
  assert.deepEqual(await owner.reconcile(request, signal()), { mutation: original })
  await assert.rejects(owner.reconcile({
    ...request, snapshotId: snapshotIdSchema.parse(randomUUID()),
  }, signal()), { code: 'CONFLICT' })
  assert.equal(owner.decorate(raw).attention!.revision, 2)
  assert.equal(owner.decorate(raw).attention!.handledCount, 1)
})

test('reconcile distinguishes committed cancellation, confirmation replay, and unknown request IDs', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const staged = await f.owner.propose(proposal(captured), signal())
  const cancel: AttentionWrite = { kind: 'cancel', requestId: requestId(), snapshotId, proposalId: staged.id }
  await f.owner.write(cancel, captured, () => raw, signal())
  const other = await f.owner.propose(proposal(captured), signal())
  const confirm: AttentionWrite = { kind: 'confirm', requestId: requestId(), snapshotId, proposalId: other.id }
  const mutation = await f.owner.write(confirm, captured, () => raw, signal())
  const again: AttentionWrite = { ...confirm, requestId: requestId() }
  await f.owner.write(again, captured, () => raw, signal())
  await f.owner.dispose()
  const owner = await f.start()
  f.hooks.beforePut = async () => { throw new Error('Reconciliation must not write') }
  assert.deepEqual(await owner.reconcile(cancel, signal()), {})
  assert.deepEqual(await owner.reconcile(confirm, signal()), { mutation })
  assert.deepEqual(await owner.reconcile(again, signal()), { mutation })
  assert.equal(await owner.reconcile({ ...cancel, requestId: requestId() }, signal()), undefined)
  await assert.rejects(owner.reconcile({ ...cancel, kind: 'confirm' }, signal()), { code: 'CONFLICT' })
})

test('reconcile waits for durable admission and participates in the disposal drain', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  const entered = f.barrier()
  const release = f.barrier()
  f.hooks.beforePut = async () => { entered.resolve(); await release.promise }
  const writing = f.owner.write(request, captured, () => raw, signal())
  await entered.promise
  const reconciled = f.owner.reconcile(request, signal())
  const closing = f.owner.dispose()
  await assert.rejects(f.owner.reconcile(request, signal()), { code: 'CLOSED' })
  release.resolve()
  assert.deepEqual(await reconciled, { mutation: await writing })
  await closing
})

test('reconcile checks ownership, cancellation, and request JSON without reserving failed writes', async t => {
  const f = await fixture(t)
  const raw = source()
  const captured = f.owner.decorate(raw)
  const request = apply(captured, { kind: 'hide' })
  f.hooks.beforePut = async () => { throw new Error('Synthetic failed admission') }
  await assert.rejects(f.owner.write(request, captured, () => raw, signal()), /Synthetic failed admission/)
  assert.equal(await f.owner.reconcile(request, signal()), undefined)
  f.hooks.beforeOwnership = async () => { throw new Error('Synthetic ownership loss') }
  await assert.rejects(f.owner.reconcile(request, signal()), /Synthetic ownership loss/)
  f.hooks.beforeOwnership = async () => {}
  const controller = new AbortController()
  controller.abort(new Error('Synthetic cancellation'))
  await assert.rejects(f.owner.reconcile(request, controller.signal), /Synthetic cancellation/)
  const invalid: unknown = { ...request, sourceScope: 'ado' }
  await assert.rejects(f.owner.reconcile(invalid as AttentionWrite, signal()))
  assert.equal(f.owner.decorate(raw).attention!.revision, 0)
})

test('native single-document storage rejects malformed JSON, envelopes, tables, and unsupported versions', async t => {
  for (const kind of ['json', 'envelope', 'foreign-domain', 'table', 'future-version', 'older-version'] as const) {
    await t.test(kind, async child => {
      const f = await fixture(child)
      const raw = source()
      const captured = f.owner.decorate(raw)
      await f.owner.write(apply(captured, { kind: 'hide' }), captured, () => raw, signal())
      await f.owner.dispose()
      const path = join(f.root, 'dashboard_attention.json')
      const document = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(document.unit.version, 1)
      if (kind === 'envelope') delete document.unit
      if (kind === 'foreign-domain') document.unit.name = 'another_synthetic_domain'
      if (kind === 'table') document.tables.actions = []
      if (kind === 'future-version') document.unit.version = 2
      if (kind === 'older-version') document.unit.version = 0
      const corruptBytes = kind === 'json' ? '{' : JSON.stringify(document)
      await writeFile(path, corruptBytes)
      await assert.rejects(f.start(), {
        code: kind === 'future-version' || kind === 'older-version' ? 'version-mismatch' : 'malformed-medium',
      })
      assert.equal(await readFile(path, 'utf8'), corruptBytes)
    })
  }
})

test('native durable retries recover a failed post-commit acknowledgement for every write kind', async t => {
  for (const kind of ['apply', 'undo', 'confirm', 'cancel'] as const) {
    await t.test(kind, async child => {
      const f = await fixture(child)
      const raw = source()
      const contextOptions = { maxEntries: 8, retentionMilliseconds: 1_000, maxContextBytes: 32_000, now: () => f.hooks.now }
      const contexts = new SnapshotContexts(contextOptions)
      const publicationFailure = new Error('Synthetic post-commit publication failure')
      let failPublication = false
      const views = new DashboardAttentionViews({
        decorate: snapshot => {
          if (failPublication) throw publicationFailure
          return f.owner.decorate(snapshot)
        },
        proposals: snapshot => f.owner.proposals(snapshot),
        reconcile: (request, requestSignal) => f.owner.reconcile(request, requestSignal),
        write: (request, captured, current, requestSignal) => f.owner.write(request, captured, current, requestSignal),
      }, contexts)
      let display = views.publish(raw, 0)
      let request: AttentionWrite
      if (kind === 'apply') {
        request = { ...apply(display.value, { kind: 'hide' }), snapshotId: display.receipt.id }
      } else if (kind === 'undo') {
        const first = await f.owner.write(apply(display.value, { kind: 'hide' }), display.value, () => raw, signal())
        display = views.publish(raw, 1)
        request = { kind, requestId: requestId(), snapshotId: display.receipt.id, actionId: first!.id }
      } else {
        const staged = await f.owner.propose(proposal(display.value), signal())
        request = { kind, requestId: requestId(), snapshotId: display.receipt.id, proposalId: staged.id }
      }
      failPublication = true
      const failedAcknowledgement = await views.write(request, signal()).then(
        () => assert.fail('Publication must fail after durable commit'),
        error => {
          assert.equal(error, publicationFailure)
          return { ok: false, error: { code: 'dashboard/provider', message: error.message, details: {} } }
        },
      )
      assert.equal(failedAcknowledgement.ok, false)
      const committed = await f.owner.reconcile(request, signal())
      assert.notEqual(committed, undefined)
      assert.equal(committed!.mutation === undefined, kind === 'cancel')
      const committedRevision = f.owner.decorate(raw).attention!.revision
      await f.owner.dispose()
      f.hooks.now = time + 2_000
      assert.throws(() => contexts.personalSnapshot(request.snapshotId))
      const owner = await f.start()
      const restartedViews = new DashboardAttentionViews(owner, new SnapshotContexts(contextOptions))
      const latest = source([item(), item('reference-urgent-1', 'Another synthetic item')])
      latest.generatedAt = iso(2_000)
      restartedViews.publish(latest, 0)
      const retried = await restartedViews.write(request, signal())
      assert.deepEqual(retried.mutation, committed!.mutation)
      assert.equal(retried.value.generatedAt, latest.generatedAt)
      assert.equal(retried.value.attention!.loadedCount, 2)
      assert.equal(retried.value.attention!.revision, committedRevision)
      assert.notEqual(retried.receipt.id, request.snapshotId)
    })
  }
})
