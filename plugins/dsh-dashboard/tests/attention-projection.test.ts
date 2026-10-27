import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { renderDashboardHtml } from '../src/export/html.ts'
import { AttentionWriteRejection, DashboardAttentionViews } from '../src/host/attention-views.ts'
import { AttentionError } from '../src/host/attention-store.ts'
import { SnapshotContexts } from '../src/host/snapshot-context.ts'
import {
  attentionActionIdSchema, attentionKeySchema, attentionReadSchema,
  type AttentionDisposition, type AttentionMutation, type AttentionView, type AttentionWrite,
} from '../src/shared/attention.ts'
import { projectAttention, selectAttention } from '../src/shared/personal-selection.ts'
import type { PersonalSnapshot } from '../src/shared/types.ts'

const instant = '2040-04-03T17:00:00.000Z'
const stamp = Date.parse(instant)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const key = (value: string) => attentionKeySchema.parse(`attention:${digest(value)}`)
const actionId = attentionActionIdSchema.parse('12345678-1234-4123-8123-123456789abc')
const signal = () => new AbortController().signal
const selection = { view: 'personal', stale: false, attentionFilter: 'all', attentionVersion: 1 } as const

function source(): PersonalSnapshot {
  return {
    kind: 'personal', generatedAt: instant, timeZone: 'UTC', displayName: 'Synthetic reader',
    nextBusinessDay: '2040-04-04', sources: [],
    metrics: { overdueActions: null, attentionItems: 4, unreadEmails: 17, meetingsNextDay: null, teamsUnread: null, projects: 0, oof: null },
    schedule: [], todayRemaining: [], weekLoad: [], allocation: [], warnings: [],
    sections: [{
      id: 'urgent', source: 'reference',
      items: ['visible', 'hidden', 'handled', 'snoozed'].map(id => ({
        id, title: `Synthetic ${id} item`, detail: `Source detail ${id}`,
        url: `https://example.invalid/items/${id}`, source: 'reference', sourceDate: '2040-04-01',
      })),
    }, { id: 'projects', source: 'reference', items: [] }],
  }
}

function decisions(raw: PersonalSnapshot, excluded = true, revision = 1): AttentionView {
  const rows = raw.sections.find(section => section.id === 'urgent')!.items
  const states: Record<string, AttentionDisposition> = {
    visible: { mode: 'visible' }, hidden: { mode: 'hidden' }, handled: { mode: 'handled' },
    snoozed: { mode: 'snoozed', until: '2040-04-04T17:00:00.000Z' },
  }
  return {
    version: 1, revision, evaluatedAt: instant,
    sourceCount: 4, loadedCount: 4, visibleCount: excluded ? 1 : 4,
    hiddenCount: excluded ? 1 : 0, handledCount: excluded ? 1 : 0, snoozedCount: excluded ? 1 : 0,
    items: rows.map(item => ({
      key: key(item.id), title: item.title, url: item.url, fingerprint: digest(item.detail),
      itemId: item.id, revision, disposition: excluded ? states[item.id]! : { mode: 'visible' },
      effective: excluded ? states[item.id]! : { mode: 'visible' },
      changed: false, ambiguous: false, undoable: false,
    })),
  }
}

function contexts(now = () => stamp, maxEntries = 16) {
  return new SnapshotContexts({ now, maxEntries, retentionMilliseconds: 60_000, maxContextBytes: 128_000 })
}

function evidence(text: string) {
  return JSON.parse(text.slice(text.indexOf('\n\n{') + 2))
}

test('display, export and subsequent question use the same effective rows without changing source totals', () => {
  const raw = source()
  const original = structuredClone(raw)
  const snapshot = { ...raw, attention: decisions(raw) }
  assert.deepEqual(selectAttention(snapshot, 'all').map(item => item.id), ['visible'])
  const projected = projectAttention(snapshot, 'all')
  assert.equal(projected.metrics, raw.metrics)
  assert.equal(projected.sections[1], raw.sections[1])
  const html = renderDashboardHtml(snapshot)
  const $ = load(html)
  assert.equal($('#urgent .row').length, 1)
  assert.match($('#urgent').text(), /1 displayed in this selection/)
  assert.match($('#urgent').text(), /4 in source/)
  assert.match($('#urgent').text(), /1 handled locally/)
  for (const name of ['hidden', 'handled', 'snoozed']) {
    assert.ok(!html.includes(`Synthetic ${name} item`), `Excluded ${name} row is absent from exported HTML`)
    assert.ok(!html.includes(`Source detail ${name}`))
  }
  const retained = contexts()
  const receipt = retained.retain(snapshot)
  const compiled = evidence(retained.compile(receipt.id, receipt.scope.id, selection))
  assert.deepEqual(compiled.evidence.sections[0].items.map((item: { id: string }) => item.id), ['visible'])
  assert.equal(compiled.evidence.attentionSelection.sourceItemCount, 4)
  assert.equal(compiled.evidence.attentionSelection.matchingItemCount, 1)
  assert.equal(compiled.evidence.metrics.teamsUnread, null)
  assert.equal(compiled.evidence.metrics.unreadEmails, 17)
  assert.match(compiled.evidence.localAttentionNote, /not current attention or verified source completion/)
  assert.deepEqual(raw, original)
})

test('proposal grants retain only explicitly captured identities and cannot mutate old evidence', () => {
  const raw = source()
  const snapshot = { ...raw, attention: decisions(raw) }
  snapshot.attention.items.push({
    key: key('absent'), title: 'Absent saved decision', url: 'https://example.invalid/absent',
    fingerprint: digest('absent'), itemId: null, revision: 1,
    disposition: { mode: 'hidden' }, effective: { mode: 'hidden' },
    changed: false, ambiguous: false, undoable: false,
  })
  const retained = contexts()
  const receipt = retained.retain(snapshot)
  const original = retained.compile(receipt.id, receipt.scope.id, selection)
  const grant = retained.attentionGrant(receipt.id, receipt.scope.id, selection)!
  assert.deepEqual(grant.items.map(item => item.key), ['visible', 'hidden', 'handled', 'snoozed'].map(key))
  assert.equal(grant.snapshotId, receipt.id)
  grant.items[0]!.title = 'Changed returned copy'
  snapshot.attention.items[1]!.effective = { mode: 'visible' }
  assert.equal(retained.compile(receipt.id, receipt.scope.id, selection), original)
  const compiled = evidence(original)
  assert.deepEqual(grant.items.map(item => item.key), compiled.evidence.attention.items.map((item: { key: string }) => item.key))
  assert.ok(!original.includes('Absent saved decision'))
  assert.throws(() => retained.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: false }), /Reload Dashboard/)
})

test('unpersonalized snapshots retain their original behavior and have no proposal grant', () => {
  const raw = source()
  assert.equal(projectAttention(raw, 'all'), raw)
  const retained = contexts()
  const receipt = retained.retain(raw)
  assert.equal(retained.attentionGrant(receipt.id, receipt.scope.id, { view: 'personal', stale: false }), undefined)
})

test('cache hits evaluate fresh local state even after older receipts are evicted', () => {
  let excluded = false
  let revision = 0
  let evaluations = 0
  const retained = contexts(() => stamp, 1)
  const views = new DashboardAttentionViews({
    decorate: raw => { evaluations++; return { ...raw, attention: decisions(raw, excluded, revision) } },
    proposals: () => [], reconcile: async () => undefined, write: async () => undefined,
  }, retained)
  const first = views.publish(source(), 1)
  assert.equal(selectAttention(first.value, 'all').length, 4)
  excluded = true
  revision = 1
  const second = views.read()
  assert.equal(selectAttention(second.value, 'all').length, 1)
  assert.equal(retained.has(first.receipt.id), false)
  assert.equal(selectAttention(views.read().value, 'all').length, 1)
  assert.equal(evaluations, 3)
  assert.equal(first.value.attention!.visibleCount, 4)
})

test('a slower earlier source read cannot regress the latest completed source', () => {
  const views = new DashboardAttentionViews({
    decorate: raw => ({ ...raw, attention: decisions(raw) }),
    proposals: () => [], reconcile: async () => undefined, write: async () => undefined,
  }, contexts())
  const newer = { ...source(), generatedAt: '2040-04-03T17:05:00.000Z', displayName: 'Newer source' }
  const latest = views.publish(newer, 2)
  const late = views.publish(source(), 1)
  assert.equal(late.value.displayName, 'Newer source')
  assert.equal(late.value.generatedAt, latest.value.generatedAt)
  assert.equal(views.source().displayName, 'Newer source')
})

test('a durable retry is reconciled before its expired display receipt is consulted', async () => {
  let now = stamp
  let writes = 0
  const retained = contexts(() => now)
  const mutation: AttentionMutation = {
    id: actionId, itemKey: key('visible'), kind: 'hide', revision: 1,
    before: { mode: 'visible' }, after: { mode: 'hidden' }, at: instant, undoable: true,
  }
  const views = new DashboardAttentionViews({
    decorate: raw => ({ ...raw, attention: decisions(raw) }),
    proposals: () => [], reconcile: async () => ({ mutation }),
    write: async () => { writes++; return mutation },
  }, retained)
  const first = views.publish(source(), 1)
  now += 60_001
  assert.equal(retained.has(first.receipt.id), false)
  const request: AttentionWrite = {
    kind: 'apply', requestId: actionId, snapshotId: first.receipt.id,
    itemKey: key('visible'), expectedRevision: 0, intent: { kind: 'hide' },
  }
  const result = await views.write(request, signal())
  assert.deepEqual(result.mutation, mutation)
  assert.equal(writes, 0)
  assert.equal(retained.has(result.receipt.id), true)
})

test('concurrent identical requests share the complete receipt lookup and publication', async () => {
  let writes = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const admission = new Promise<void>(resolve => { entered = resolve })
  const mutation: AttentionMutation = {
    id: actionId, itemKey: key('visible'), kind: 'hide', revision: 1,
    before: { mode: 'visible' }, after: { mode: 'hidden' }, at: instant, undoable: true,
  }
  const views = new DashboardAttentionViews({
    decorate: raw => ({ ...raw, attention: decisions(raw) }), proposals: () => [],
    reconcile: async () => undefined,
    write: async () => { writes++; entered(); await barrier; return mutation },
  }, contexts())
  const initial = views.publish(source(), 1)
  const request: AttentionWrite = {
    kind: 'apply', requestId: actionId, snapshotId: initial.receipt.id,
    itemKey: key('visible'), expectedRevision: 0, intent: { kind: 'hide' },
  }
  const first = views.write(request, signal())
  const second = views.write(request, signal())
  await admission
  release()
  const results = await Promise.all([first, second])
  assert.equal(writes, 1)
  assert.equal(results[0].receipt.id, results[1].receipt.id)
})

test('a new request with an expired receipt is a proven rejection after durable lookup', async () => {
  let now = stamp
  let writes = 0
  const retained = contexts(() => now)
  const views = new DashboardAttentionViews({
    decorate: raw => ({ ...raw, attention: decisions(raw) }), proposals: () => [],
    reconcile: async () => undefined, write: async () => { writes++; return undefined },
  }, retained)
  const first = views.publish(source(), 1)
  now += 60_001
  await assert.rejects(views.write({
    kind: 'apply', requestId: actionId, snapshotId: first.receipt.id,
    itemKey: key('visible'), expectedRevision: 0, intent: { kind: 'hide' },
  }, signal()), error => error instanceof AttentionWriteRejection && error.code === 'EXPIRED')
  assert.equal(writes, 0)
})

test('post-commit publication errors cannot be classified as a command rejection', async () => {
  let committed = false
  const views = new DashboardAttentionViews({
    decorate: raw => {
      if (committed) throw new AttentionError('SCOPE', 'Synthetic publication failure')
      return { ...raw, attention: decisions(raw) }
    },
    proposals: () => [], reconcile: async () => undefined,
    write: async () => { committed = true; return undefined },
  }, contexts())
  const first = views.publish(source(), 1)
  await assert.rejects(views.write({
    kind: 'apply', requestId: actionId, snapshotId: first.receipt.id,
    itemKey: key('visible'), expectedRevision: 0, intent: { kind: 'hide' },
  }, signal()), error => error instanceof AttentionError && !(error instanceof AttentionWriteRejection))
  assert.equal(committed, true)
})

test('local snooze expiry can refresh cached Personal evidence after display receipts expire', () => {
  let now = stamp
  const deadline = stamp + 8 * 60 * 60 * 1000
  const retained = contexts(() => now)
  const views = new DashboardAttentionViews({
    decorate: raw => {
      const attention = decisions(raw, false, 1)
      const snoozed: AttentionDisposition = { mode: 'snoozed', until: new Date(deadline).toISOString() }
      attention.items[0]!.disposition = snoozed
      attention.items[0]!.effective = now < deadline ? snoozed : { mode: 'visible' }
      attention.visibleCount = now < deadline ? 3 : 4
      attention.snoozedCount = now < deadline ? 1 : 0
      return { ...raw, attention }
    },
    proposals: () => [], reconcile: async () => undefined, write: async () => undefined,
  }, retained)
  const before = views.publish(source(), 1)
  now = deadline
  assert.equal(retained.has(before.receipt.id), false)
  const after = views.read()
  assert.equal(selectAttention(after.value, 'all').length, 4)
  assert.equal(after.value.generatedAt, before.value.generatedAt)
  assert.equal(before.value.attention!.visibleCount, 3)
  assert.throws(() => retained.compile(before.receipt.id, before.receipt.scope.id, selection), /expired/)
  assert.equal(attentionReadSchema.safeParse({ view: 'personal' }).success, true)
  assert.equal(attentionReadSchema.safeParse({ view: 'ado' }).success, false)
  assert.equal(attentionReadSchema.safeParse({ snapshotId: before.receipt.id }).success, false)
})
