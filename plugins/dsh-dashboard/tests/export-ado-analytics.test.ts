import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { load } from 'cheerio'
import { snapshotForExport } from '../src/client/export-selection.ts'
import { en, type DashboardText } from '../src/client/locale.ts'
import type { Preferences } from '../src/client/stores.ts'
import { renderDashboardHtml } from '../src/export/html.ts'
import { buildAdoAnalytics } from '../src/shared/ado-analytics.ts'
import { adoAnalyticsSettingsSchema } from '../src/shared/ado-analytics-schema.ts'
import type { AdoHistory } from '../src/shared/ado-analytics-model.ts'
import { emptyFilters, type Filters } from '../src/shared/selection.ts'
import type { AdoItem, AdoSnapshot, PersonalSnapshot } from '../src/shared/types.ts'

const dictionary: Readonly<Record<string, string>> = en
const t: DashboardText = (key, values = {}) => dictionary[key]!.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''))
const generatedAt = '2040-04-03T17:00:00Z'

function item(id: number, category: AdoItem['category'], extra: Partial<AdoItem> = {}): AdoItem {
  return {
    id, title: `Delivery ${id}`, type: 'Task', state: category, category,
    assignee: 'Beta', assigneeId: 'beta', areaPath: 'Synthetic\\Delivery', iterationPath: 'Synthetic\\Sprint',
    tags: ['scope'], url: `https://dev.azure.com/example/Synthetic/_workitems/edit/${id}`,
    createdAt: '2040-03-01T00:00:00Z', stateChangedAt: '2040-04-01T00:00:00Z',
    predecessors: [], risks: [], ...extra,
  }
}

function snapshot(): AdoSnapshot {
  return {
    kind: 'ado', generatedAt, defaultType: 'Task', complete: false, warnings: ['Synthetic source coverage warning.'],
    source: { input: 'Synthetic\\Sprint', path: 'Synthetic\\Sprint', orgName: 'example', project: 'Synthetic', mode: 'iteration' },
    sourceUrl: 'https://dev.azure.com/example/Synthetic',
    analytics: { version: 1, timeZone: 'America/Los_Angeles', settings: adoAnalyticsSettingsSchema.parse({}) },
    items: [
      item(1, 'Completed', { assignee: 'Alpha', assigneeId: 'alpha', estimate: 3, estimateField: 'Story Points' }),
      item(2, 'Resolved', { risks: ['blocked', 'stale'], estimate: 8, estimateField: 'Story Points', predecessors: [3] }),
      item(3, 'InProgress', { risks: ['overdue', 'stale'], estimate: 5, estimateField: 'Effort', predecessors: [1000] }),
      item(4, 'Unknown', { assignee: 'Unknown owner', assigneeId: 'unknown', estimate: 900, estimateField: 'Story Points', risks: ['blocked'] }),
      item(5, 'Removed', { assignee: 'Removed owner', assigneeId: 'removed', estimate: 800, estimateField: 'Story Points' }),
      item(6, 'Proposed', { assignee: '', assigneeId: '', risks: ['unassigned'], createdAt: undefined, stateChangedAt: undefined }),
      item(7, 'InProgress', { estimate: 2, estimateField: 'Effort', stateChangedAt: '2041-01-01T00:00:00Z' }),
      item(8, 'Completed', { type: 'Feature', assignee: 'Feature owner', assigneeId: 'feature', estimate: 100, estimateField: 'Story Points' }),
    ],
  }
}

function preferences(filters: Partial<Filters> = {}): Preferences {
  return {
    tab: 'ado', source: null, filters: { ...emptyFilters(), type: 'Task', ...filters },
    sort: 'id', direction: 'asc', page: 2, pageSize: 1, selection: null, drafts: {},
    mobilePane: 'data', attentionFilter: 'all',
  }
}

test('ADO export captures the full report before narrowing rows and retains each chart scope', () => {
  const source = snapshot()
  const original = structuredClone(source)
  const prefs = preferences({ person: 'beta', tag: 'scope', text: 'Delivery', metric: 'remaining', risk: 'blocked', drill: { chart: 'category', key: 'Resolved' } })
  const projected = snapshotForExport(source, prefs, t)
  assert.equal(projected.kind, 'ado')
  if (projected.kind !== 'ado') return
  assert.deepEqual(source, original)
  assert.deepEqual(projected.adoReport, buildAdoAnalytics(source, prefs.filters))
  assert.deepEqual(projected.items.map(row => row.id), [2])
  assert.deepEqual(projected.adoReport?.baseItemIds, [2, 3, 7])
  assert.deepEqual(projected.adoReport?.typeItemIds, [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(projected.adoExportSelection?.summary.estimates, [
    { field: 'Story Points', total: 8, count: 1 }, { field: 'Effort', total: 7, count: 2 },
  ])
  const $ = load(renderDashboardHtml(projected))
  assert.deepEqual($('.kpi-value').map((_, node) => $(node).text()).get(), ['0', '3', '1', '2', '0', '0'])
  assert.equal($('#work tbody tr').length, 1)
  assert.match($('#work tbody').text(), /Delivery 2/)
  assert.match($('#states-table').text(), /Unknown/)
  assert.match($('#owners-table').text(), /Alpha/)
  assert.match($('#owners-table').text(), /Unknown owner/)
  assert.match($('#estimates-table').text(), /Effort7/)
  assert.match($('.ado-scope').text(), /Selected type: 7 loaded items; base chart scope: 3; matching rows across all pages: 1/)
  assert.match($('#risks').text(), /Groups overlap.*Distinct union: 2/)
  assert.match($('body').text(), /Synthetic source coverage warning/)
  assert.match($('body').text(), /Chart filter: category · Resolved/)
  assert.doesNotMatch($('body').text(), /Totals describe this selection, not the entire source/)
})

test('ADO export matching rows span all pages and unknown/removed are explicit', () => {
  const source = snapshot()
  const projected = snapshotForExport(source, preferences(), t)
  const $ = load(renderDashboardHtml(projected))
  assert.equal($('#work tbody tr').length, 7)
  assert.match($('#delivery-table').text(), /Unknown \(excluded\)1/)
  assert.match($('#delivery-table').text(), /Removed \(excluded\)1/)
  assert.match($('#state-age-table').text(), /Unknown age2/)
  assert.match($('#age-table').text(), /Unknown age1/)
  assert.match($('#dependencies-table').text(), /Predecessor evidence unavailable1/)
  assert.equal($('#closure-table tbody tr').length, 6)
  assert.deepEqual($('#closure-table tbody tr').map((_, node) => Number($(node).find('td').eq(1).text())).get(), [1, 1, 1, 0, 0, 1])
  assert.match($('body').text(), /history was not loaded/i)
  assert.equal($('[aria-describedby="history-completion-table"]').length, 0)
})

test('a refreshed-away area selection exports empty matching rows without erasing chart scopes', () => {
  const projected = snapshotForExport(snapshot(), preferences({ drill: { chart: 'area', key: 'Synthetic\\Former area' } }), t)
  const $ = load(renderDashboardHtml(projected))
  assert.equal($('#work tbody tr').length, 0)
  assert.deepEqual($('.kpi-value').slice(0, 2).map((_, node) => $(node).text()).get(), ['1', '4'])
  assert.match($('#owners-table').text(), /Alpha/)
  assert.match($('.ado-scope').text(), /Selected type: 7 loaded items; base chart scope: 7; matching rows across all pages: 0/)
  assert.match($('body').text(), /Chart filter: area · Synthetic\\Former area/)
})

test('retained age intervals filter exports exactly while charts retain current configured bands', () => {
  for (const [chart, key, expected] of [['age', '30-60', [2, 3, 7]], ['stateAge', '2-6', [2, 3]]] as const) {
    const projected = snapshotForExport(snapshot(), preferences({ drill: { chart, key } }), t)
    assert.equal(projected.kind, 'ado')
    if (projected.kind !== 'ado') continue
    assert.deepEqual(projected.items.map(row => row.id), expected)
    assert.equal(projected.adoReport?.[chart].some(row => row.key === key), false)
    const $ = load(renderDashboardHtml(projected))
    assert.equal($('#work tbody tr').length, expected.length)
    assert.match($('#owners-table').text(), /Alpha/)
    assert.match($('body').text(), new RegExp(`Chart filter: ${chart} · ${key}`))
  }
})

test('ADO static graphs and all rows survive long owner/area datasets without truncation', () => {
  const source = snapshot()
  source.items = Array.from({ length: 34 }, (_, index) => item(index + 1, index % 2 ? 'Completed' : 'Proposed', {
    assignee: `Owner ${String(index).padStart(2, '0')}`, assigneeId: `owner-${index}`, areaPath: `Area ${index}`,
  }))
  const $ = load(renderDashboardHtml(source))
  assert.equal($('#owners-table tbody tr').length, 34)
  assert.equal($('#areas-table tbody tr').length, 34)
  assert.equal($('#people-table').length, 0)
  assert.equal($('#work tbody tr').length, 34)
  assert.ok($('svg').length >= 9)
  $('svg').each((_, node) => {
    const id = $(node).attr('aria-describedby')
    assert.ok(id)
    assert.equal($(`table[id="${id}"]`).length, 1)
    assert.ok($(node).find('title').text().length)
  })
})

function history(): AdoHistory {
  return {
    basis: 'current-cohort', type: 'Task', status: 'partial', fetchedAt: '2040-04-03T17:05:00Z',
    range: { start: '2040-04-01', finish: '2040-04-03', timeZone: 'America/Los_Angeles', source: 'recent', clipped: true },
    requestedItemIds: [1, 2, 3, 4, 5, 6, 7], omitted: [3, 4, 5, 6, 7].map(id => ({ id, reason: 'Synthetic omitted history.' })),
    items: [
      { id: 1, changes: [
        { at: '2040-03-01T10:00:00Z', category: 'Proposed' },
        { at: '2040-04-01T12:00:00Z', category: 'Completed' },
        { at: '2040-04-01T13:00:00Z', category: 'InProgress' },
        { at: '2040-04-01T14:00:00Z', category: 'Completed' },
        { at: '2040-04-02T12:00:00Z', category: 'InProgress' },
        { at: '2040-04-03T12:00:00Z', category: 'Completed' },
      ] },
      { id: 2, changes: [{ at: '2040-04-02T12:00:00Z', category: 'Unknown' }, { at: '2040-04-03T12:00:00Z', category: 'Resolved' }] },
    ], warnings: ['Synthetic revision coverage warning.'],
  }
}

test('explicitly loaded history exports exact current-cohort points and distinct daily events', () => {
  const source = snapshot()
  source.analytics!.history = history()
  const projected = snapshotForExport(source, preferences({ metric: 'completed' }), t)
  const $ = load(renderDashboardHtml(projected))
  assert.equal($('#work tbody tr').length, 1)
  assert.equal($('#history-completion-table tbody tr').length, 3)
  assert.deepEqual($('#history-completion-table tbody tr').map((_, node) => $(node).find('td').eq(1).text()).get(), ['1', '0', '1'])
  assert.deepEqual($('#history-events-table tbody tr').first().find('td').map((_, node) => $(node).text()).get(), ['2040-04-01', '1', '1', '1', '1'])
  assert.match($('#history-state-table').text(), /Not yet created/)
  assert.match($('#history-state-table').text(), /Unknown \(excluded\)/)
  assert.ok($('path.history-line').attr('d'))
  assert.match($('body').text(), /Omitted current-cohort IDs: 3, 4, 5, 6, 7/)
  assert.match($('body').text(), /Synthetic revision coverage warning/)
  for (const id of ['history-completion', 'history-state', 'history-events']) {
    const card = $(`#${id}-table`).closest('section').text()
    assert.match(card, /2040-04-01–2040-04-03; timezone America\/Los_Angeles/)
    assert.match(card, /available 2\/7 current-cohort items/)
    assert.match(card, /revisions fetched 2040-04-03T17:05:00Z/)
    assert.match(card, /date source: recent calendar days; range clipped/)
  }
})

test('unavailable history remains unavailable without a line or zero-filled historical table', () => {
  const source = snapshot()
  source.analytics!.history = { ...history(), status: 'unavailable', items: [], omitted: [1, 2, 3, 4, 5, 6, 7].map(id => ({ id, reason: 'Synthetic unavailable history.' })) }
  const $ = load(renderDashboardHtml(source))
  assert.equal($('#history-completion-table,#history-state-table,#history-events-table').length, 0)
  assert.equal($('path.history-line').length, 0)
  assert.match($('body').text(), /available 0\/7 current-cohort items/)
  assert.match($('body').text(), /History unavailable. No lines or zero-filled dates/)
})

test('a single historical observation stays visible without extending its date range', () => {
  const source = snapshot()
  source.analytics!.history = history()
  source.analytics!.history!.range!.start = '2040-04-03'
  const $ = load(renderDashboardHtml(source))
  assert.equal($('#history-completion-table tbody tr').length, 1)
  assert.equal($('circle.history-point').length, 1)
  $('svg[aria-describedby="history-state-table"] path').each((_, node) => {
    assert.match($(node).attr('style')!, /stroke-width:8/)
  })
  assert.deepEqual($('#history-state-table tbody td').first().text(), '2040-04-03')
  $('svg[aria-describedby="history-events-table"] rect').each((_, node) => {
    const x = Number($(node).attr('x'))
    assert.ok(x >= 40 && x + Number($(node).attr('width')) <= 624)
  })
})

test('missing optional export summaries do not fabricate source-wide zeros from matching rows', () => {
  const projected = snapshotForExport(snapshot(), preferences({ risk: 'blocked' }), t)
  delete projected.adoExportSelection
  const $ = load(renderDashboardHtml(projected))
  assert.equal($('.kpi-value').eq(2).text(), '—')
  assert.match($('body').text(), /Full-type state data was not captured/)
  assert.match($('body').text(), /Base-scope estimate totals were not captured/)
  assert.match($('#owners-table').text(), /Alpha/)
})

test('ADO output escapes source text and URLs and contains no active or external resources', () => {
  const source = snapshot()
  source.source.project = '<script>project</script>'
  source.sourceUrl = 'javascript:alert(1)'
  source.items[0] = item(1, 'Completed', {
    title: '<img src=x onerror="alert(1)">', assignee: '<svg onload="alert(1)">',
    areaPath: '"></text><script>area</script>', url: 'javascript:alert(2)',
  })
  source.analytics!.history = { ...history(), warnings: ['</li><script>history</script>'] }
  const html = renderDashboardHtml(source)
  const $ = load(html)
  assert.equal($('script,iframe,object,embed,img,link[href],svg use,svg image,meta[http-equiv="refresh"]').length, 0)
  assert.equal($('[onload],[onerror],[onclick],[src]').length, 0)
  assert.match($('meta[http-equiv="Content-Security-Policy"]').attr('content')!, /script-src 'none'/)
  assert.match($('#work').text(), /<img src=x onerror="alert\(1\)">/)
  assert.match(html, /#theme-toggle:checked~main/)
  $('a[href]').each((_, node) => assert.match($(node).attr('href')!, /^(?:https:\/\/|#)/))
  assert.doesNotMatch(html, /NaN|Infinity|@import|url\(/)
})

test('Personal Work export bytes remain unchanged', () => {
  const personal: PersonalSnapshot = {
    kind: 'personal', generatedAt: '2040-04-02T17:00:00Z', timeZone: 'UTC', displayName: 'Synthetic user',
    nextBusinessDay: '2040-04-03', sources: [],
    metrics: { overdueActions: null, attentionItems: 0, unreadEmails: null, meetingsNextDay: 0, teamsUnread: null, projects: 0, oof: null },
    schedule: [], todayRemaining: [], weekLoad: [], allocation: [], sections: [], warnings: [],
  }
  assert.equal(createHash('sha256').update(renderDashboardHtml(personal)).digest('hex'), '17dbc5a8f14216b1407d28b41a7c4de64ef0babcb09c5cf621c3fcb932457227')
})
