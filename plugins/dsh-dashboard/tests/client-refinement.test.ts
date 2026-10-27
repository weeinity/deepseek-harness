import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { load } from 'cheerio'
import { createDashboardStore } from '../src/client/stores.ts'
import { snapshotForExport } from '../src/client/export-selection.ts'
import { displayedContext } from '../src/client/chat-selection.ts'
import type { DashboardState } from '../src/client/owner.ts'
import { receiptSchema } from '../src/shared/chat.ts'
import { compactSourceDate, date, number, refreshPolicy } from '../src/client/format.ts'
import { en, zh, type DashboardText } from '../src/client/locale.ts'
import { selectAttention } from '../src/shared/personal-selection.ts'
import type { AttentionFilter, EvidenceText, PersonalInsights } from '../src/shared/insights.ts'
import type { DashboardSettings, PersonalSnapshot, SectionId } from '../src/shared/types.ts'

const dictionary: Readonly<Record<string, string>> = en
const t: DashboardText = (key, values = {}) => (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''))
const ids: SectionId[] = ['urgent', 'prep', 'reply', 'chats', 'people', 'actions', 'training', 'oof', 'files', 'projects']
const instant = '2040-04-02T17:00:00Z'
const saved = '2040-03-30'

function evidence(text: string, source: EvidenceText['source'] = 'reference'): EvidenceText {
  return { text, source, ...(source === 'reference' ? { sourceDate: saved } : {}), evidenceIds: ['synthetic-evidence'] }
}

function snapshot(): PersonalSnapshot {
  const value: PersonalSnapshot = {
    kind: 'personal', generatedAt: instant, timeZone: 'UTC', displayName: 'Synthetic user',
    nextBusinessDay: '2040-04-03', referenceAsOf: saved,
    sources: [
      { id: 'calendar', state: 'live', updatedAt: instant },
      { id: 'mail', state: 'partial', updatedAt: instant },
      { id: 'reference', state: 'reference', updatedAt: instant },
    ],
    metrics: { overdueActions: null, attentionItems: 19, unreadEmails: null, meetingsNextDay: 1, teamsUnread: null, projects: 2, oof: 0 },
    schedule: [{
      id: 'synthetic-meeting', title: 'Next meeting fixture', start: '2040-04-03T09:00:00Z', end: '2040-04-03T09:30:00Z',
      url: 'https://outlook.office.com/calendar/item/synthetic', organizer: 'Synthetic organizer', response: 'accepted',
      online: true, allDay: false, free: false, conflict: true, optionalOverlap: true, preview: 'Calendar preview fixture',
    }],
    todayRemaining: [{
      id: 'today-meeting', title: 'Remaining meeting fixture', start: instant, end: '2040-04-02T17:30:00Z',
      url: 'https://outlook.office.com/calendar/item/today', organizer: 'Synthetic organizer', response: 'none',
      online: false, allDay: false, free: true, conflict: false, optionalOverlap: false, preview: 'Today preview fixture',
    }],
    weekLoad: [{ date: '2040-04-03', meetings: 1, minutes: 30 }, { date: '2040-04-04', meetings: 0, minutes: 0 }],
    allocation: [
      { category: 'customer', minutes: 3, percent: 10 }, { category: 'training', minutes: 6, percent: 20 },
      { category: 'internal', minutes: 9, percent: 30 }, { category: 'focus', minutes: 6, percent: 20 },
      { category: 'admin', minutes: 6, percent: 20 },
    ],
    sections: ids.map(id => ({
      id, source: 'reference', note: `Source note ${id}`, items: [{
        id, title: `Section fixture ${id}`, detail: `Detail fixture ${id}`, url: 'https://teams.microsoft.com/l/message/synthetic',
        source: 'reference', sourceDate: saved,
      }],
    })),
    warnings: ['Synthetic bounded-source caveat.', 'Synthetic missing-evidence caveat.'],
  }
  value.sections[0]!.items = ['alpha', 'beta', 'gamma', 'unclassified'].map(id => ({
    id, title: `Attention ${id}`, detail: `Attention detail ${id}`, url: `https://outlook.office.com/mail/${id}`,
    source: 'reference', sourceDate: saved,
  }))
  value.insights = {
    warningsSummary: evidence('Synthetic caveat summary.', 'partial'),
    stats: {
      overdueActions: evidence('Synthetic overdue qualifier.'),
      unreadEmails: evidence('Synthetic inbox qualifier.', 'unavailable'),
      meetingsNextDay: evidence('Synthetic meeting qualifier.', 'live'),
      teamsUnread: evidence('Synthetic chat qualifier.', 'partial'),
      projects: evidence('Synthetic project qualifier.'),
      oof: evidence('Synthetic absence qualifier.', 'live'),
    },
    attention: [
      { itemId: 'beta', category: 'pastDue', consequence: evidence('Synthetic past-due evidence.'), thisWeekend: true, rank: 0, tone: 'critical' },
      { itemId: 'alpha', category: 'waiting', consequence: evidence('Synthetic waiting evidence.'), thisWeekend: false, rank: 2, tone: 'accent' },
      { itemId: 'gamma', category: 'dueSoon', consequence: evidence('Synthetic due-soon evidence.'), thisWeekend: true, rank: 1, tone: 'warning' },
      { itemId: 'unclassified', category: 'unclassified', consequence: evidence('Synthetic severity evidence without a deadline.'), thisWeekend: false, rank: 3, tone: 'critical' },
    ],
    attentionCounts: { pastDue: 1, dueSoon: 1, waiting: 1, standing: 0, unclassified: 1 },
    reads: Object.fromEntries([
      'attention', 'weekLoad', 'allocation', 'agenda', 'prep', 'reply', 'chats', 'people', 'projects', 'actions', 'training', 'oof', 'files',
    ].map(key => [key, evidence(`Synthetic read ${key}.`)])) as PersonalInsights['reads'],
    protectedTime: evidence('Synthetic protected-time evidence.', 'live'),
    agendaAdvice: [{ eventId: 'synthetic-meeting', recommendation: 'keep', reason: evidence('Synthetic recommendation evidence.', 'partial') }],
    oofImpact: evidence('Synthetic calendar-impact evidence.', 'partial'),
  }
  return value
}

/** The existing SSR harness bundles in memory; each VM owns its React and module state. */
async function renderSource(contents: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const directory = fileURLToPath(new URL('..', import.meta.url))
  const result = await build({
    absWorkingDir: directory, stdin: { contents, loader: 'tsx', resolveDir: directory },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, outfile: 'refinement-render.cjs', logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  })
  const code = result.outputFiles.find(file => file.path.endsWith('.cjs'))?.text
  assert.ok(code)
  const module: { exports: unknown } = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require, process, console, setTimeout, clearTimeout, queueMicrotask,
    TextEncoder, TextDecoder, Buffer, URL, fetch: () => { throw new Error('Rendering must not request a remote resource') },
    AbortController, crypto, structuredClone,
  })
  const output = await module.exports
  assert.equal(typeof output, 'string')
  return String(output)
}

async function renderPersonal(value = snapshot(), filter: AttentionFilter = 'all') {
  return renderSource(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { Personal } from './src/client/Personal.tsx'
    import { en } from './src/client/locale.ts'
    const t = (key, values = {}) => en[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name] ?? ''))
    module.exports = renderToStaticMarkup(<Personal snapshot={${JSON.stringify(value)}} t={t}
      attentionFilter=${JSON.stringify(filter)} onAttentionFilter={() => {}} />)
  `)
}

test('six authoritative metrics retain unknown qualifiers and evidence dates without borrowing the attention total', async () => {
  const value = snapshot()
  const $ = load(await renderPersonal(value))
  const metrics = $('[class*="kpis"] > div')
  assert.equal(metrics.length, 6)
  assert.equal(metrics.eq(0).find('[class*="metricValue"]').attr('title'), 'Unavailable, not zero')
  assert.match(metrics.eq(0).text(), /—Unavailable, not zeroOverdue actions/)
  assert.doesNotMatch(metrics.eq(0).text(), /19/)
  assert.match(metrics.eq(3).text(), /—Unavailable, not zeroUnread Teams chats/)
  assert.match(metrics.eq(5).text(), /^0Out-of-office notices/)
  for (const entry of Object.values(value.insights!.stats)) assert.ok(metrics.text().includes(entry.text))
  assert.match(metrics.eq(0).find('[data-source="reference"]').text(), /reference · 2040-03-30/)
  assert.equal(metrics.eq(0).find('[data-source="reference"]').attr('aria-label'), 'Saved briefing · 2040-03-30')
  assert.equal(metrics.eq(0).find('[class*="metricNote"] > [class*="evidence"]').length, 1)
  assert.doesNotMatch(metrics.eq(0).find('[class*="metricNote"]').text(), /Unavailable, not zero/)
  assert.equal(number(null, t), '—')
  assert.equal(number(0, t), '0')
})

test('all source sections, today’s remaining schedule and source-owned interpretations remain reachable', async () => {
  const value = snapshot()
  const html = await renderPersonal(value)
  const $ = load(html)
  for (const id of ids.filter(id => id !== 'urgent')) assert.ok($(`[data-section="${id}"]`).text().includes(`Section fixture ${id}`), id)
  assert.ok($('details').filter((_index, element) => $(element).text().includes('Remaining meeting fixture')).length > 0)
  for (const entry of Object.values(value.insights!.reads)) assert.ok($.text().includes(entry.text))
  for (const phrase of ['Synthetic protected-time evidence.', 'Synthetic calendar-impact evidence.', 'Synthetic recommendation evidence.']) {
    assert.ok($.text().includes(phrase), phrase)
  }
  assert.match($.text(), /Tentative \/ free \/ unknown-status overlap/)
  assert.match($.text(), /Absence notices are calendar records/)
  assert.match($.text(), /Saved briefing as of.*2040.*not live status/)
  assert.equal($('a[target="_blank"]').length, $('a[rel="noopener noreferrer"]').length)
  assert.equal($('[class*="allocationBar"] > span').length, value.allocation.length)
})

test('warning disclosure uses the actual count and preserves every warning verbatim', async () => {
  const value = snapshot()
  value.warnings.push('<img src="https://example.invalid/beacon"> Synthetic raw diagnostic.')
  const $ = load(await renderPersonal(value))
  const details = $('details[aria-label="Source warnings"]')
  assert.equal(details.length, 1)
  assert.equal(details.attr('open'), undefined)
  assert.match(details.find('summary').text(), /3 source warnings/)
  assert.match(details.find('summary').text(), /Synthetic caveat summary/)
  assert.deepEqual(details.find('li').map((_index, element) => $(element).text()).get(), value.warnings)
  assert.equal($('img, script').length, 0)
})

test('attention filters use shared selection, preserve unclassified rows in All and never recalculate global metrics', async () => {
  const value = snapshot()
  for (const filter of ['all', 'pastDue', 'thisWeekend'] as const) {
    const $ = load(await renderPersonal(value, filter))
    const rows = $('[class*="attentionItems"] > li')
    assert.deepEqual(rows.map((_index, element) => $(element).find('[class*="itemHeading"] > strong').text()).get(),
      selectAttention(value, filter).map(item => item.title))
    assert.match($('[class*="kpis"]').text(), /—Unavailable, not zeroOverdue actions/)
    assert.equal($('[aria-label="Filter attention items"] button[aria-pressed="true"]').text().trim(),
      `${t(`attention.filter.${filter}`)} ${selectAttention(value, filter).length}`)
    assert.match($('[class*="consequenceBars"]').text(), /Unclassified1/)
    assert.doesNotMatch($.text(), /Waiting on you/)
    assert.match($('[class*="consequenceBars"]').text(), /Waiting1/)
  }
})

test('older snapshots disclose absent interpretations and disable unsupported classified filters', async () => {
  const value = snapshot()
  delete value.insights
  const all = load(await renderPersonal(value))
  assert.equal(all('[class*="attentionItems"] > li').length, value.sections[0]!.items.length)
  assert.equal(all('[aria-label="Filter attention items"] button[disabled]').length, 2)
  assert.match(all.text(), /Interpretation unavailable/)
  assert.match(all.text(), /Attention classifications are unavailable\. Only All is available/)
  assert.equal(all('[class*="consequenceBars"]').length, 0)
  assert.match(all('[class*="graphRow"]').text(), /Attention by consequence— itemsUnavailable/)
  const filtered = load(await renderPersonal(value, 'pastDue'))
  assert.match(filtered('[role="status"]').text(), /Only All is available/)
  assert.equal(filtered('[class*="attentionItems"] > li').length, value.sections[0]!.items.length)
  assert.equal(filtered('[aria-label="Filter attention items"] button[aria-pressed="true"]').text(), 'All 4')
})

test('UI, export and captured question selections agree without redefining other sections or source-wide metrics', async () => {
  const value = snapshot()
  const store = createDashboardStore().create()
  const receipt = receiptSchema.parse({
    id: '00000000-0000-4000-8000-000000000007', scope: { id: 'personal', title: 'Synthetic personal source' },
    expiresAt: '2099-01-01T00:00:00Z',
  })
  const empty = {
    status: 'idle' as const, data: null, stale: false, previousSource: false,
    error: null, errorDetail: null, dataKey: null, receipt: null,
  }
  const state: DashboardState = {
    settings: null, ado: empty, personal: { ...empty, status: 'ready', data: value, dataKey: 'personal', receipt },
  }
  for (const filter of ['pastDue', 'thisWeekend'] as const) {
    store.actions.attentionFilter(filter)
    const selected = selectAttention(value, filter)
    const context = displayedContext(state, store.getSnapshot())
    assert.equal(context?.receipt, receipt)
    assert.deepEqual(context?.selection, { view: 'personal', stale: false, attentionFilter: filter })
    const $ = load(await renderPersonal(value, filter))
    assert.deepEqual($('[class*="attentionItems"] > li').map((_index, element) =>
      $(element).find('[class*="itemHeading"] > strong').text()).get(), selected.map(item => item.title))
    const exported = snapshotForExport(value, store.getSnapshot(), t)
    assert.equal(exported.kind, 'personal')
    if (exported.kind !== 'personal') return
    assert.deepEqual(exported.sections.find(section => section.id === 'urgent')?.items, selected)
    assert.deepEqual(exported.metrics, value.metrics)
    assert.deepEqual(exported.insights?.attentionCounts, value.insights?.attentionCounts)
    const projected = load(await renderPersonal(exported))
    assert.match(projected('[class*="consequenceBars"]').text(), /Past due1Due soon1Waiting1Standing sweep0Unclassified1/)
    assert.match(projected('[class*="graphRow"] > section').first().find('[class*="cardMeta"]').text(), /4 items/)
    assert.deepEqual(exported.sections.filter(section => section.id !== 'urgent'), value.sections.filter(section => section.id !== 'urgent'))
    assert.equal(exported.warnings.at(-1),
      `Only attention rows are filtered: ${t(`attention.filter.${filter}`)} · ${selected.length} matching rows. Other sections and source-wide metrics remain unchanged.`)
  }
  for (const unavailable of ['counts', 'insights'] as const) {
    const current = snapshot()
    if (unavailable === 'counts') current.insights!.attentionCounts = null
    else delete current.insights
    state.personal = { ...state.personal, data: current, stale: true, error: 'request', errorDetail: 'Synthetic refresh failure.' }
    const selected = selectAttention(current, 'all')
    for (const filter of ['pastDue', 'thisWeekend'] as const) {
      store.actions.attentionFilter(filter)
      assert.throws(() => selectAttention(current, filter), /no attention classifications/)
      const context = displayedContext(state, store.getSnapshot())
      assert.equal(context?.receipt, receipt)
      assert.deepEqual(context?.selection, { view: 'personal', stale: true, attentionFilter: 'all' })
      const $ = load(await renderPersonal(current, filter))
      assert.deepEqual($('[class*="attentionItems"] > li').map((_index, element) =>
        $(element).find('[class*="itemHeading"] > strong').text()).get(), selected.map(item => item.title))
      assert.equal($('[aria-label="Filter attention items"] button[aria-pressed="true"]').text(), `All ${selected.length}`)
      assert.equal($('[aria-label="Filter attention items"] button[disabled]').length, 2)
      assert.match($('[role="status"]').text(), /Attention classifications are unavailable\. Only All is available/)
      const exported = snapshotForExport(current, store.getSnapshot(), t)
      assert.ok(exported.kind === 'personal')
      assert.deepEqual(exported.sections.find(section => section.id === 'urgent')?.items, selected)
      assert.deepEqual(exported.sections.filter(section => section.id !== 'urgent'), current.sections.filter(section => section.id !== 'urgent'))
      assert.deepEqual(exported.metrics, current.metrics)
      assert.deepEqual(exported.warnings, current.warnings)
      assert.deepEqual(exported.insights?.attentionCounts, current.insights?.attentionCounts)
      assert.equal(store.getSnapshot().attentionFilter, filter)
    }
  }
})

test('attention graph uses source-wide counts and a null count object remains unavailable', async () => {
  const value = snapshot()
  value.insights!.attentionCounts = { pastDue: 8, dueSoon: 2, waiting: 3, standing: 4, unclassified: 1 }
  const $ = load(await renderPersonal(value, 'pastDue'))
  assert.match($('[class*="consequenceBars"]').text(), /Past due8Due soon2Waiting3Standing sweep4Unclassified1/)
  assert.equal($('[class*="attentionItems"] > li').length, 1)
  value.insights!.attentionCounts = null
  const unavailable = load(await renderPersonal(value, 'thisWeekend'))
  assert.equal(unavailable('[class*="consequenceBars"]').length, 0)
  assert.match(unavailable('[class*="graphRow"]').text(), /Attention by consequence— itemsUnavailable/)
  assert.equal(unavailable('[class*="attentionItems"] > li').length, 4)
  assert.equal(unavailable('[aria-label="Filter attention items"] button[disabled]').length, 2)
  assert.equal(unavailable('[aria-label="Filter attention items"] button[aria-pressed="true"]').text(), 'All 4')
})

test('compact source details keep source states visible and exact dates accessible without repeating live timestamps', async () => {
  const readings = [
    evidence('Reference qualifier fixture.'),
    { ...evidence('Raw reference qualifier fixture.'), sourceDate: 'Original human-written refresh label fixture' },
    { ...evidence('Live qualifier fixture.', 'live'), sourceDate: instant },
    { ...evidence('Partial qualifier fixture.', 'partial'), sourceDate: instant },
  ]
  const html = await renderSource(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { Evidence } from './src/client/presentation.tsx'
    import { en } from './src/client/locale.ts'
    const readings = ${JSON.stringify(readings)}
    module.exports = renderToStaticMarkup(<div>{readings.map(value =>
      <Evidence key={value.text} value={value} zone="UTC" t={key => en[key]} />)}</div>)
  `)
  const $ = load(html)
  const attributions = $('[role="note"][data-source]')
  assert.equal(attributions.eq(0).text(), 'reference · 2040-03-30')
  assert.equal(attributions.eq(1).text(), 'reference')
  assert.equal(attributions.eq(1).attr('title'), 'Saved briefing · Original human-written refresh label fixture')
  assert.equal(attributions.eq(1).attr('aria-label'), attributions.eq(1).attr('title'))
  assert.equal(attributions.eq(2).text(), 'live')
  assert.equal(attributions.eq(3).text(), 'partial')
  assert.match(attributions.eq(2).attr('aria-label') ?? '', /2040-04-02T17:00:00Z/)
  for (const reading of readings) assert.ok($.text().includes(reading.text))
  assert.equal(compactSourceDate('Human date fixture', 'UTC'), null)
  assert.equal(compactSourceDate('2040-04-03', 'America/Los_Angeles'), '2040-04-03')
  assert.equal(compactSourceDate('2040-04-03T01:00:00Z', 'America/Los_Angeles'), '2040-04-02')
})

test('unavailable calendar and sections never display empty-source charts as observed zeroes', async () => {
  const value = snapshot()
  delete value.insights
  value.weekLoad = []
  value.allocation = []
  value.schedule = []
  value.todayRemaining = []
  value.sections = []
  value.sources = [{ id: 'calendar', state: 'unavailable', updatedAt: instant }]
  const $ = load(await renderPersonal(value))
  assert.doesNotMatch($('[class*="graphRow"]').text(), /0 booked|0 hours|0 items/)
  assert.equal($('[class*="consequenceBars"]').length, 0)
  assert.match($('[class*="todayDisclosure"] > summary').text(), /— items/)
  assert.match($('[aria-label="Filter attention items"]').text(), /All —/)
})

test('attention preferences and suggestion draft writes preserve source histories, other drafts and ADO filters', async () => {
  const first = createDashboardStore().create()
  const second = createDashboardStore().create()
  first.actions.question('personal', 'Personal draft fixture')
  first.actions.question('ado:synthetic', 'Other draft fixture')
  first.actions.filter({ text: 'ADO fixture' })
  const before = first.getSnapshot()
  first.actions.attentionFilter('thisWeekend')
  assert.equal(first.getSnapshot().attentionFilter, 'thisWeekend')
  assert.equal(second.getSnapshot().attentionFilter, 'all')
  assert.deepEqual(first.getSnapshot().drafts, before.drafts)
  assert.deepEqual(first.getSnapshot().filters, before.filters)
  const output = await renderSource(`
    import { QuestionSuggestions } from './src/client/chat-presentation.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    import { en } from './src/client/locale.ts'
    const store = createDashboardStore().create()
    store.actions.question('ado:fixture', 'Other draft fixture')
    const questions = ['Generic question fixture']
    const element = QuestionSuggestions({ questions, enabled: true, maxChars: 4000, t: key => en[key],
      fill: text => store.actions.question('personal', text) })
    const button = element.props.children[0]
    if (button.props.type !== 'button') throw new Error('A suggestion must not submit the form')
    button.props.onClick()
    const disabled = QuestionSuggestions({ questions, enabled: false, maxChars: 4000, t: key => en[key], fill: () => {} })
    if (!disabled.props.children[0].props.disabled) throw new Error('An unavailable source must disable suggestions')
    module.exports = JSON.stringify(store.getSnapshot().drafts)
  `)
  assert.deepEqual(JSON.parse(output), {
    personal: { text: 'Generic question fixture', revision: 1 },
    'ado:fixture': { text: 'Other draft fixture', revision: 1 },
  })
})

test('final answer Markdown preserves basic formatting while refusing links, images, HTML and executable resources', async () => {
  const markdown = [
    '# Heading fixture', '**Strong fixture** and *emphasis fixture* with `identifier_fixture`.',
    '- List fixture', '> Quote fixture', '```text\n<literal-code-fixture>\n```',
    '[Link text fixture](https://example.invalid/private)',
    '[Executable link fixture](javascript:alert(1))',
    '![Image alt fixture](https://example.invalid/beacon)',
    '<script>throw new Error("must not execute")</script>',
    '<iframe src="https://example.invalid/frame"></iframe>',
    '<img src="https://example.invalid/raw" onerror="alert(1)">',
    '<audio src="https://example.invalid/audio"></audio>',
    '<object data="https://example.invalid/object"></object>',
    '<svg><use href="https://example.invalid/glyph"></use></svg>',
    '<link rel="prefetch" href="https://example.invalid/prefetch">',
  ].join('\n\n')
  const html = await renderSource(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { FinalAnswer } from './src/client/chat-presentation.tsx'
    module.exports = renderToStaticMarkup(<FinalAnswer text={${JSON.stringify(markdown)}} />)
  `)
  const $ = load(html)
  assert.equal($('strong').text(), 'Strong fixture')
  assert.equal($('em').text(), 'emphasis fixture')
  assert.match($('code').text(), /identifier_fixture.*<literal-code-fixture>/s)
  assert.equal($('h1').text(), 'Heading fixture')
  assert.equal($('li').text(), 'List fixture')
  assert.match($.text(), /Link text fixture/)
  assert.match($.text(), /Executable link fixture/)
  assert.match($.text(), /Image alt fixture/)
  assert.equal($('a,img,video,audio,iframe,object,embed,script,link,svg,style').length, 0)
  assert.equal($('[href],[src],[srcset],[onerror],[onclick]').length, 0)
  assert.doesNotMatch(html, /example\.invalid|javascript:|must not execute/)
})

test('schedule copy follows configured slots and offsets rather than hardcoded hourly defaults', () => {
  const settings: DashboardSettings = {
    timeZone: 'UTC', refreshMinutes: 60, refreshMinute: 55, workdayStart: 6, workdayEnd: 18,
    cacheSeconds: 600, hasReference: false, maxChatQuestionChars: 4000,
  }
  assert.match(refreshPolicy(settings, t), /hourly at :55, 6:55 AM–5:55 PM UTC/)
  assert.match(refreshPolicy({ ...settings, refreshMinute: 7, refreshMinutes: 45 }, t), /every 45 min, 6:07 AM–5:22 PM UTC/)
  assert.doesNotMatch(refreshPolicy({ ...settings, refreshMinute: 7, refreshMinutes: 45 }, t), /:55|hourly/)
  assert.match(date('2040-04-03', 'America/Los_Angeles', t), /Apr 3, 2040/)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})

test('Dashboard keeps three fixed header rows above both panes with live, partial, reference and retained-error feedback', async () => {
  const value = snapshot()
  const html = await renderSource(`
    import { renderToStaticMarkup } from 'react-dom/server'
    import { Dashboard } from './src/client/Dashboard.tsx'
    import { createDashboardStore } from './src/client/stores.ts'
    import { en } from './src/client/locale.ts'
    const store = createDashboardStore().create()
    const receipt = { id: '00000000-0000-4000-8000-000000000009', scope: { id: 'personal', title: 'Synthetic history' }, expiresAt: '2099-01-01T00:00:00Z' }
    const empty = { status: 'idle', data: null, dataKey: null, receipt: null, error: null, errorDetail: null, stale: false, previousSource: false }
    const data = {
      settings: { timeZone: 'UTC', refreshMinutes: 45, refreshMinute: 7, workdayStart: 6, workdayEnd: 18, maxChatQuestionChars: 4000, cacheSeconds: 600, hasReference: true },
      personal: { ...empty, status: 'pending', data: ${JSON.stringify(value)}, dataKey: 'personal', receipt,
        stale: true, error: 'request', errorDetail: 'Retained source diagnostic fixture.' },
      ado: empty,
    }
    const chat = { scope: receipt.scope, status: 'ready', sessionId: 'fixture', messages: [], running: false,
      hasMore: false, loadingOlder: false, nativeError: null, error: null, errorDetail: null,
      pendingQuestion: null, retryQuestion: null, retryRevision: null }
    const t = (key, values = {}) => en[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name] ?? ''))
    module.exports = renderToStaticMarkup(<Dashboard t={t} useStore={select => select(store.getSnapshot())}
      actions={store.actions} useDashboard={select => select(data)} useDashboardChat={select => select(chat)}
      select={() => {}} refresh={async () => {}} exportSnapshot={() => true} selectChat={() => {}}
      sendQuestion={async () => { throw new Error('Rendering must not submit a question') }}
      retryQuestion={async () => false} retryHistory={async () => {}} stopQuestion={async () => {}} loadHistory={async () => {}}
    />)
  `)
  const $ = load(html)
  const root = $('[class*="dashboard"][data-pane]')
  const children = root.children()
  assert.equal(children.eq(0).prop('tagName'), 'HEADER')
  assert.equal(children.eq(1).find('[role="tablist"]').length, 1)
  assert.match(children.eq(2).text(), /READ-ONLY.*Saved briefing as of.*not live status/)
  assert.match(children.eq(2).text(), /Calendar\s+live.*Mail\s+partial.*Saved briefing\s+reference/)
  const workspace = children.eq(3)
  assert.equal(workspace.find('[role="tabpanel"]').length, 1)
  assert.equal(workspace.children('aside').length, 1)
  assert.match(children.eq(0).text(), /every 45 min, 6:07 AM–5:22 PM UTC/)
  assert.match(workspace.text(), /Stale snapshot — not current/)
  assert.match(workspace.find('[role="alert"]').text(), /Retained source diagnostic fixture/)
  assert.equal(workspace.find('[role="tabpanel"]').attr('aria-busy'), 'true')
  assert.equal(workspace.find('button[type="submit"]').prop('disabled'), true)
  const refresh = children.eq(0).find('button').first()
  assert.equal(refresh.prop('disabled'), true)
  assert.equal(refresh.attr('aria-label'), 'Refresh now')
  assert.equal(refresh.attr('aria-busy'), 'true')
  assert.equal(refresh.text(), '')
  assert.match(workspace.find('[role="status"]').text(), /Refreshing in background · showing cached data/)
  assert.match(workspace.text(), /Section fixture files/)
})

function assertStyleIsolation(css: string) {
  assert.equal(css.indexOf('.dashboard {'), 0)
  assert.doesNotMatch(css, /:root|@import|https?:|:global\((?!body\[data-ds-dark-theme\]\))/)
  const globalRules = css.match(/:global\([^)]*\)[^{]*\{/g) ?? []
  assert.deepEqual(globalRules, [':global(body[data-ds-dark-theme]) .dashboard {'])
  assert.match(css, /\.panel > \*, \.content > \* \{ flex-shrink: 0; \}/)
  assert.match(css, /font-family: dsh-dashboard-inter,Inter,system-ui,sans-serif;/)
  assert.match(css, /outline: 2px solid var\(--acc\); outline-offset: 2px;/)
}

test('theme tokens stay on Dashboard and main cards cannot flex-shrink', async () => {
  const css = (await readFile(new URL('../src/client/dsh-dashboard.module.css', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
  assertStyleIsolation(css)
  assert.throws(() => { assertStyleIsolation(`${css}\n:global(body) { color: red; }`) })
  assert.throws(() => { assertStyleIsolation(css.replace('.panel > *, .content > * { flex-shrink: 0; }',
    '.panel > *, .content > * { flex-shrink: 1; }')) })
  const light = css.slice(css.indexOf('.dashboard {'), css.indexOf(':global(body'))
  const dark = css.slice(css.indexOf(':global(body'), css.indexOf('.dashboard *,'))
  const tokens = {
    surf: ['#ffffff', '#232532'], surf2: ['#f7f8fa', '#191b27'], ink: ['#16181d', '#e9e9ed'],
    ink2: ['#4d5260', '#b2b6ca'], ink3: ['#5f6672', '#9397ab'], line: ['#e2e4ea', '#3f424d'],
    acc: ['#0f6cbd', '#5d5294'], accInk: ['#0b5394', '#d2cefd'], accSoft: ['#eef4fb', '#2b2741'],
    accBorder: ['#a8cbeb', '#5d5294'], ok: ['#107c41', '#b2b6ca'], warn: ['#c78300', '#968ae0'],
    warnInk: ['#8a5a00', '#b5abfc'], warnSoft: ['#fdf4e3', '#2b2741'], warnBorder: ['#f0d9a8', '#423a6a'],
    crit: ['#c4314b', '#d2cefd'], track: ['#e8eaee', '#292b31'],
    s1: ['#0b4f8f', '#d2cefd'], s2: ['#0f6cbd', '#b5abfc'], s3: ['#3f8fd4', '#968ae0'],
    s4: ['#6fadde', '#796cbf'], s5: ['#a0c9e9', '#5d5294'], s6: ['#cfe1f2', '#423a6a'],
  }
  for (const [token, [a, b]] of Object.entries(tokens)) {
    assert.ok(light.includes(`--${token}: ${a};`), `light ${token}`)
    assert.ok(dark.includes(`--${token}: ${b};`), `dark ${token}`)
  }
})
