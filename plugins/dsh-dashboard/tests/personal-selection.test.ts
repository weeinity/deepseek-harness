import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from 'cheerio'
import { personalSchema } from '../src/client/validation.ts'
import { renderDashboardHtml } from '../src/export/html.ts'
import { SnapshotContexts } from '../src/host/snapshot-context.ts'
import { personalInsightsSchema, type AttentionFilter, type PersonalInsights } from '../src/shared/insights.ts'
import { projectAttention, selectAttention } from '../src/shared/personal-selection.ts'
import type { DashboardItem, PersonalSnapshot } from '../src/shared/types.ts'

const instant = '2026-09-14T16:00:00.000Z'
function fixture(): PersonalSnapshot & { insights: PersonalInsights } {
  const note = {
    text: 'Synthetic source-wide evidence <script>not executable</script>',
    source: 'reference', sourceDate: '2026-09-11', evidenceIds: ['reference'],
  }
  const notes = (keys: string[]) => Object.fromEntries(keys.map(key => [key, note]))
  const rows: DashboardItem[] = ['unknown', 'weekend', 'past', 'waiting'].map(id => ({
    id, title: `Synthetic ${id}`, detail: `Detail for ${id}`,
    url: `https://outlook.office.com/mail/inbox?searchquery=${id}`,
    source: 'reference', sourceDate: '2026-09-11',
  }))
  const event = {
    id: 'meeting', title: 'Synthetic meeting', start: instant, end: '2026-09-14T17:00:00Z',
    url: 'https://outlook.office.com/calendar/item/synthetic', organizer: 'Example',
    response: 'accepted', online: true, allDay: false, free: false,
    conflict: false, optionalOverlap: false, preview: '',
  }
  const insights = personalInsightsSchema.parse({
    warningsSummary: note,
    stats: notes(Object.keys(personalInsightsSchema.shape.stats.shape)),
    reads: notes(Object.keys(personalInsightsSchema.shape.reads.shape)),
    attention: [
      { itemId: 'unknown', category: 'unclassified', rank: 4, thisWeekend: false, tone: 'neutral', consequence: note },
      { itemId: 'weekend', category: 'dueSoon', rank: 2, thisWeekend: true, tone: 'warning', consequence: note },
      { itemId: 'past', category: 'pastDue', rank: 0, thisWeekend: false, tone: 'critical', consequence: note },
      { itemId: 'waiting', category: 'waiting', rank: 2, thisWeekend: false, tone: 'accent', consequence: note },
    ],
    attentionCounts: { pastDue: 1, dueSoon: 1, waiting: 1, standing: 0, unclassified: 1 },
    agendaAdvice: [{ eventId: event.id, recommendation: 'optional', reason: note }],
    protectedTime: note, oofImpact: note,
  })
  return {
    kind: 'personal', generatedAt: instant, timeZone: 'UTC', displayName: 'Example',
    nextBusinessDay: '2026-09-15', sources: [], referenceAsOf: '2026-09-11',
    metrics: { overdueActions: null, attentionItems: 4, unreadEmails: 17, meetingsNextDay: 1, teamsUnread: null, projects: 0, oof: 0 },
    schedule: [event], todayRemaining: [{ ...event, id: 'today', title: 'Synthetic remaining event' }],
    weekLoad: [{ date: '2026-09-14', meetings: 1, minutes: 60 }],
    allocation: [{ category: 'internal', minutes: 60, percent: 100 }],
    sections: [
      { id: 'urgent', source: 'reference', items: rows },
      { id: 'projects', source: 'reference', items: [] },
      { id: 'oof', source: 'live', items: [] },
    ],
    warnings: ['Original warning \u{1F642}'], insights,
  }
}
function contexts(maxContextBytes = 128_000) {
  return new SnapshotContexts({ maxEntries: 2, maxContextBytes, retentionMilliseconds: 60_000, now: () => Date.parse(instant) })
}
function compile(snapshot: PersonalSnapshot, maxContextBytes?: number, attentionFilter: AttentionFilter = 'pastDue') {
  const store = contexts(maxContextBytes)
  const receipt = store.retain(snapshot)
  return store.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: false, attentionFilter })
}
function evidence(text: string): unknown {
  return JSON.parse(text.slice(text.indexOf('\n\n{') + 2))
}

test('attention ranking is stable and All keeps unclassified rows', () => {
  const snapshot = fixture()
  const before = structuredClone(snapshot)
  assert.deepEqual(selectAttention(snapshot, 'all').map(item => item.id), ['past', 'weekend', 'waiting', 'unknown'])
  assert.deepEqual(selectAttention(snapshot, 'pastDue').map(item => item.id), ['past'])
  assert.deepEqual(selectAttention(snapshot, 'thisWeekend').map(item => item.id), ['weekend'])
  assert.deepEqual(snapshot, before)
})

test('older snapshots support All but do not imply classifications for other segments', () => {
  const { insights: _insights, ...snapshot } = fixture()
  assert.equal(projectAttention(snapshot, 'all'), snapshot)
  assert.deepEqual(selectAttention(snapshot, 'all').map(item => item.id), ['unknown', 'weekend', 'past', 'waiting'])
  assert.throws(() => selectAttention(snapshot, 'pastDue'), /no attention classifications/)
  assert.throws(() => projectAttention(snapshot, 'thisWeekend'), /no attention classifications/)
})

test('attention projection preserves source-wide metrics and unrelated sections without mutation', () => {
  const snapshot = fixture()
  const before = structuredClone(snapshot)
  const projected = projectAttention(snapshot, 'pastDue')
  assert.equal(projected.metrics, snapshot.metrics)
  assert.equal(projected.sections[1], snapshot.sections[1])
  assert.equal(projected.schedule, snapshot.schedule)
  assert.equal(projected.insights?.reads, snapshot.insights.reads)
  assert.equal(projected.insights?.attentionCounts, snapshot.insights.attentionCounts)
  assert.deepEqual(projected.insights?.attention.map(item => item.itemId), ['past'])
  assert.equal(personalSchema.safeParse(projected).success, true)
  assert.deepEqual(snapshot, before)
})

test('captured model evidence distinguishes full graph counts from the selected attention rows', () => {
  const snapshot = fixture()
  const store = contexts()
  const receipt = store.retain(snapshot)
  const text = store.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: true, attentionFilter: 'pastDue' })
  snapshot.sections[0]!.items[2]!.title = 'Changed after capture'
  assert.match(text, /source-wide snapshot/)
  assert.partialDeepStrictEqual(evidence(text), {
    displayedAsStale: true,
    evidence: {
      metrics: { attentionItems: 4, overdueActions: null, teamsUnread: null },
      sections: [{ id: 'urgent', items: [{ id: 'past', title: 'Synthetic past' }] }],
      insights: { attention: [{ itemId: 'past', consequence: { source: 'reference', sourceDate: '2026-09-11' } }] },
      attentionSelection: {
        filter: 'pastDue', sourceItemCount: 4, matchingItemCount: 1, matchingItemIds: ['past'],
        graph: [
          { category: 'pastDue', count: 1 }, { category: 'dueSoon', count: 1 },
          { category: 'waiting', count: 1 }, { category: 'standing', count: 0 },
          { category: 'unclassified', count: 1 },
        ],
        otherSectionsFiltered: false,
      },
    },
  })
  assert.equal(store.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: true, attentionFilter: 'pastDue' }), text)
})

test('new enriched evidence requires an explicit browser attention selection', () => {
  const store = contexts()
  const receipt = store.retain(fixture())
  assert.throws(() => store.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: false }), /Reload Dashboard/)
  assert.doesNotThrow(() => store.compile(receipt.id, receipt.scope.id, { view: 'personal', stale: false, attentionFilter: 'all' }))
})

test('unavailable attention remains unavailable in model graph evidence', () => {
  const snapshot = fixture()
  snapshot.sections[0] = { id: 'urgent', source: 'unavailable', items: [] }
  snapshot.metrics.attentionItems = 0
  snapshot.insights.attention = []
  snapshot.insights.attentionCounts = null
  assert.partialDeepStrictEqual(evidence(compile(snapshot, undefined, 'all')), {
    evidence: { attentionSelection: { graph: null } },
  })
})

test('enriched evidence accepts exactly its UTF-8 limit and never truncates at one byte less', () => {
  const snapshot = fixture()
  const size = Buffer.byteLength(compile(snapshot), 'utf8')
  assert.equal(Buffer.byteLength(compile(snapshot, size), 'utf8'), size)
  assert.throws(() => compile(snapshot, size - 1), /exceeds the configured.*byte limit/)
})

test('snapshot validation rejects missing, duplicate and foreign attention associations', () => {
  const snapshot = fixture()
  assert.equal(personalSchema.safeParse(snapshot).success, true)
  for (const attention of [
    snapshot.insights.attention.slice(1),
    [...snapshot.insights.attention, snapshot.insights.attention[0]],
    snapshot.insights.attention.map((item, index) => index === 0 ? { ...item, itemId: 'foreign' } : item),
    snapshot.insights.attention.map((item, index) => index === 0 ? { ...item, rank: -1 } : item),
    snapshot.insights.attention.map((item, index) => index === 0 ? { ...item, category: 'invented' } : item),
  ]) {
    assert.equal(personalSchema.safeParse({ ...snapshot, insights: { ...snapshot.insights, attention } }).success, false)
  }
  const duplicateRows = fixture()
  duplicateRows.sections[0]!.items.push(duplicateRows.sections[0]!.items[0]!)
  assert.equal(personalSchema.safeParse(duplicateRows).success, false)
})

test('snapshot validation rejects duplicate or foreign advice but permits no advice', () => {
  const snapshot = fixture()
  const advice = snapshot.insights.agendaAdvice[0]!
  for (const agendaAdvice of [[advice, advice], [{ ...advice, eventId: 'foreign' }]]) {
    assert.equal(personalSchema.safeParse({ ...snapshot, insights: { ...snapshot.insights, agendaAdvice } }).success, false)
  }
  assert.equal(personalSchema.safeParse({ ...snapshot, insights: { ...snapshot.insights, agendaAdvice: [] } }).success, true)
})

test('source-wide attention counts reject unavailable zeros, wrong totals and contradictory categories', () => {
  const snapshot = fixture()
  for (const attentionCounts of [
    null,
    { ...snapshot.insights.attentionCounts, pastDue: 7 },
    { pastDue: 0, dueSoon: 2, waiting: 1, standing: 0, unclassified: 1 },
  ]) {
    assert.equal(personalSchema.safeParse({ ...snapshot, insights: { ...snapshot.insights, attentionCounts } }).success, false)
  }
  snapshot.sections[0] = { id: 'urgent', source: 'unavailable', items: [] }
  snapshot.insights.attention = []
  snapshot.metrics.attentionItems = 0
  snapshot.insights.attentionCounts = { pastDue: 0, dueSoon: 0, waiting: 0, standing: 0, unclassified: 0 }
  assert.equal(personalSchema.safeParse(snapshot).success, false)
  snapshot.insights.attentionCounts = null
  assert.equal(personalSchema.safeParse(snapshot).success, true)
})

test('portable exports keep selection, remaining calendar, source details and literal annotations offline', () => {
  const projected = projectAttention(fixture(), 'pastDue')
  const $ = load(renderDashboardHtml(projected))
  assert.equal($('#urgent .row').length, 1)
  assert.deepEqual($('.attention-count strong').map((_, element) => $(element).text()).get(), ['1', '1', '1', '0', '1'])
  assert.match($('.attention-counts').parent().text(), /4 source-wide attention items/)
  assert.match($('#urgent .row').text(), /Synthetic past/)
  assert.doesNotMatch($('#urgent .row').text(), /Synthetic weekend/)
  assert.match($('body').text(), /Synthetic remaining event/)
  assert.match($('.reading').text(), /<script>not executable<\/script>/)
  assert.match($('.reading').text(), /reference.*2026-09-11/s)
  assert.equal($('.reading script').length, 0)
  assert.equal($('script[src],link[href],img[src],iframe,canvas').length, 0)
  assert.equal($('.kpi-value').first().text(), '\u2014')
  $('script').remove()
  assert.match($('body').text(), /Original warning/)
  assert.match($('body').text(), /Suggestion: optional; no calendar changes made/)
})

test('unavailable exported attention has no numeric category bars', () => {
  const snapshot = fixture()
  snapshot.sections[0] = { id: 'urgent', source: 'unavailable', items: [] }
  snapshot.insights.attention = []
  snapshot.metrics.attentionItems = 0
  snapshot.insights.attentionCounts = null
  assert.equal(personalSchema.safeParse(snapshot).success, true)
  const $ = load(renderDashboardHtml(snapshot))
  assert.equal($('.attention-count').length, 0)
  assert.match($('body').text(), /Attention classifications unavailable/)
})
