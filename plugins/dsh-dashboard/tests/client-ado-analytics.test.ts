import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { load } from 'cheerio'
import { buildAdoAnalytics } from '../src/shared/ado-analytics.ts'
import { historyGeometry } from '../src/shared/chart-geometry.ts'
import { categories, emptyFilters, filterItems, type Filters } from '../src/shared/selection.ts'
import type { AdoAnalyticsReport, AdoDrill, HistoryPoint } from '../src/shared/ado-analytics-model.ts'
import type { AdoItem, AdoSnapshot } from '../src/shared/types.ts'
import type { AdoHistoryState } from '../src/client/AdoHistory.tsx'
import { en, zh } from '../src/client/locale.ts'

const instant = '2040-04-04T17:00:00Z'

function item(id: number, patch: Partial<AdoItem> = {}): AdoItem {
  return {
    id, type: 'Task', title: `Synthetic task ${id}`, state: 'Active', category: 'InProgress',
    assignee: 'Alice fixture', assigneeId: 'owner-a', areaPath: 'Fixture\\Area A', iterationPath: 'Fixture\\Sprint',
    tags: ['synthetic'], url: `https://dev.azure.com/fixture/Fixture/_workitems/edit/${id}`,
    createdAt: '2040-04-01T08:00:00Z', stateChangedAt: '2040-04-03T08:00:00Z',
    changedAt: instant, risks: [], predecessors: [], ...patch,
  }
}

function snapshot(withHistory = false): AdoSnapshot {
  const value: AdoSnapshot = {
    kind: 'ado', generatedAt: instant,
    source: { input: 'Fixture\\Sprint', orgName: 'fixture', project: 'Fixture', path: 'Fixture\\Sprint', mode: 'iteration' },
    sourceUrl: 'https://dev.azure.com/fixture/Fixture/_sprints', complete: true, defaultType: 'Task', warnings: [],
    items: [
      item(1, { state: 'Done', category: 'Completed', estimate: 3, estimateField: 'Microsoft.VSTS.Scheduling.StoryPoints' }),
      item(2, { assignee: 'Bob fixture', assigneeId: 'owner-b', state: 'Resolved', category: 'Resolved', risks: ['stale'],
        estimate: 5, estimateField: 'Microsoft.VSTS.Scheduling.OriginalEstimate', remainingWork: 2 }),
      item(3, { risks: ['blocked', 'overdue', 'stale'], predecessors: [2, 900], createdAt: '2040-03-01T08:00:00Z' }),
      item(4, { state: 'New', category: 'Proposed', assignee: '', assigneeId: '', risks: ['unassigned'], predecessors: [900] }),
      item(5, { assignee: 'Carl fixture', assigneeId: 'owner-c', risks: ['overdue'], createdAt: '2040-04-03T08:00:00Z' }),
      item(6, { assignee: 'Dave fixture', assigneeId: 'owner-d', risks: ['stale'], stateChangedAt: undefined }),
      item(7, { assignee: 'Eve fixture', assigneeId: 'owner-e', createdAt: '2040-05-01T08:00:00Z' }),
      item(8, { state: 'Custom', category: 'Unknown', assignee: 'Ghost fixture', assigneeId: 'owner-g' }),
      item(9, { state: 'Removed', category: 'Removed', assignee: 'Ghost fixture', assigneeId: 'owner-g', risks: ['blocked'] }),
      item(10, { type: 'Feature', assignee: 'Zulu fixture', assigneeId: 'owner-z' }),
    ],
    analytics: {
      version: 1, timeZone: 'UTC',
      settings: {
        ageBands: [3, 9, 20], historyDays: 30, maxHistoryDays: 90, maxHistoryItems: 100,
        maxRevisionsPerItem: 500, revisionPageSize: 100, historyConcurrency: 4,
        historyTimeoutMs: 60_000, maxHistoryRequests: 100,
      },
    },
  }
  if (withHistory) {
    value.items[0] = item(1)
    value.items[6] = item(7, { state: 'Done', category: 'Completed', assignee: 'Eve fixture', assigneeId: 'owner-e' })
    value.analytics!.history = {
      basis: 'current-cohort', type: 'Task', status: 'partial', fetchedAt: instant,
      range: { start: '2040-04-01', finish: '2040-04-04', timeZone: 'UTC', source: 'recent', clipped: true },
      requestedItemIds: value.items.filter(entry => entry.type === 'Task').map(entry => entry.id),
      items: value.items.filter(entry => entry.type === 'Task' && entry.id !== 9).map(entry => ({
        id: entry.id,
        changes: entry.id === 1 ? [
          { at: '2040-04-01T08:00:00Z', category: 'Proposed' },
          { at: '2040-04-02T08:00:00Z', category: 'Completed' },
          { at: '2040-04-03T08:00:00Z', category: 'InProgress' },
          { at: '2040-04-03T12:00:00Z', category: 'Completed' },
          { at: '2040-04-04T08:00:00Z', category: 'InProgress' },
        ] : [{ at: entry.id === 4 ? '2040-04-03T08:00:00Z' : '2040-04-01T08:00:00Z', category: entry.category }],
      })),
      omitted: [{ id: 9, reason: 'Synthetic revision failure.' }],
      warnings: ['<img src="https://example.invalid/beacon"> Synthetic warning.'],
    }
  }
  return value
}

interface Renderer {
  render(value: AdoSnapshot, filters?: Partial<Filters>, request?: AdoHistoryState, locale?: 'en' | 'zh', loader?: boolean): string
  history(report: AdoAnalyticsReport): string
  toggle(filters: Filters, drill: AdoDrill): Pick<Filters, 'drill'>
  deliveryActions(report: AdoAnalyticsReport, filters: Filters): Partial<Filters>[]
}

/** In-memory builds and VM-local SSR avoid DOM globals, network, listeners and filesystem fixtures. */
async function buildRenderer(): Promise<Renderer> {
  const require = createRequire(import.meta.url)
  const directory = fileURLToPath(new URL('..', import.meta.url))
  const result = await build({
    absWorkingDir: directory,
    stdin: { resolveDir: directory, loader: 'tsx', contents: `
      import { renderToStaticMarkup } from 'react-dom/server'
      import { Ado } from './src/client/Ado.tsx'
      import { AdoDelivery, adoDrillFilter } from './src/client/AdoCharts.tsx'
      import { AdoHistory } from './src/client/AdoHistory.tsx'
      import { createDashboardStore } from './src/client/stores.ts'
      import { en, zh } from './src/client/locale.ts'
      const translator = dictionary => (key, values = {}) => {
        if (!(key in dictionary)) throw new Error('Missing locale key: ' + key)
        return dictionary[key].replace(/\\{(\\w+)\\}/g, (_, name) => String(values[name] ?? ''))
      }
      module.exports = {
        render(value, filters = {}, request, locale = 'en', loader = true) {
          const store = createDashboardStore().create()
          store.actions.filter(filters)
          return renderToStaticMarkup(<Ado snapshot={value} prefs={store.getSnapshot()} actions={store.actions}
            zone="UTC" t={translator(locale === 'zh' ? zh : en)} history={request} loadHistory={loader ? () => {} : undefined} />)
        },
        history(report) {
          return renderToStaticMarkup(<AdoHistory report={report} t={translator(en)} loadHistory={() => {}} />)
        },
        toggle: adoDrillFilter,
        deliveryActions(report, filters) {
          const changes = []
          const root = AdoDelivery({ report, filters, onFilter: patch => changes.push(patch), t: translator(en) })
          const walk = element => {
            if (!element || typeof element !== 'object') return
            if (Array.isArray(element)) { element.forEach(walk); return }
            if (element.type === 'button') element.props.onClick()
            walk(element.props?.children)
          }
          walk(root)
          return changes
        },
      }
    ` },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, outfile: 'ado-render.cjs', logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  })
  const code = result.outputFiles.find(file => file.path.endsWith('.cjs'))?.text
  assert.ok(code)
  const module: { exports: unknown } = { exports: {} }
  runInNewContext(code, {
    module, exports: module.exports, require, process, console, setTimeout, clearTimeout, queueMicrotask,
    TextEncoder, TextDecoder, Buffer, URL, AbortController, crypto, structuredClone,
    fetch() { throw new Error('Client rendering must not request resources') },
  })
  return module.exports as Renderer
}

const renderer = buildRenderer()

test('ADO current charts present outcomes, exclusive interventions and neutral ownership with complete tables', async () => {
  const $ = load((await renderer).render(snapshot()))
  assert.deepEqual($('[data-ado-chart]').map((_index, element) => $(element).attr('data-ado-chart')).get(),
    ['delivery', 'closure', 'risk', 'age', 'dependency', 'history', 'area', 'owner'])
  assert.match($('[data-ado-chart="delivery"]').text(), /1 of 7 completed/)
  assert.match($('[data-ado-chart="delivery"]').text(), /6 remaining/)
  assert.match($('[data-ado-chart="delivery"]').text(), /Resolved is unfinished/)
  assert.match($('[data-ado-chart="delivery"]').text(), /1 Unknown · 1 Removed/)
  const closure = $('[data-ado-chart="closure"]')
  assert.deepEqual(closure.find('ol button [class*="adoCountLabel"]').map((_index, element) => $(element).text()).get(),
    ['Investigate blockers1', 'Assign owners1', 'Review overdue work1', 'Confirm closure1', 'Confirm status1', 'Continue remaining work1'])
  assert.equal(closure.find('table tbody tr').length, 6)
  assert.match($('[data-ado-chart="risk"]').text(), /5 distinct items/)
  assert.match($('[data-ado-chart="risk"]').text(), /Bars overlap; do not add them/)
  assert.match($('[data-ado-chart="dependency"]').text(), /signal, not proof of blocking/)
  assert.equal($('[data-ado-chart="dependency"] a[href$="/2"]').length, 1)
  assert.equal($('[data-ado-chart="dependency"] button[aria-label="View details for item 2"]').length, 1)
  assert.match($('[data-ado-chart="age"]').text(), /Under 3 days/)
  assert.match($('[data-ado-chart="age"]').text(), /3 to <9 days/)
  assert.match($('[data-ado-chart="age"]').text(), /20\+ days/)
  assert.equal($('[data-ado-chart="age"] table').length, 2)
  assert.match($('[data-ado-chart="owner"]').text(), /not authorship, effort, capacity or a productivity ranking/)
  const owners = $('[data-ado-chart="owner"] [class*="adoOwnedHeading"] > strong').map((_index, element) => $(element).text()).get()
  assert.deepEqual(owners, ['Unassigned', 'Alice fixture', 'Bob fixture', 'Carl fixture', 'Dave fixture', 'Eve fixture', 'Ghost fixture'])
  for (const chart of ['delivery', 'closure', 'risk', 'age', 'dependency', 'area', 'owner']) {
    assert.ok($(`[data-ado-chart="${chart}"] table caption`).length, chart)
    assert.ok($(`[data-ado-chart="${chart}"] button[type="button"][aria-pressed]`).length, chart)
  }
  assert.equal($('[role="button"]').length, 0)
  assert.equal($('img, script, iframe').length, 0)
})

test('chart clicks use shared drill sets, toggle off, and do not silently alter native filters', async () => {
  const api = await renderer
  const value = snapshot()
  const filters: Filters = { ...emptyFilters(), type: 'Task', person: 'owner-a', text: 'synthetic' }
  const report = buildAdoAnalytics(value, filters)!
  const changes = api.deliveryActions(report, filters)
  assert.equal(changes.length, categories.length)
  for (let index = 0; index < categories.length; index++) {
    const patch = changes[index]!
    const category = categories[index]!
    assert.equal(patch.drill?.chart, 'category')
    assert.equal(patch.drill?.key, category)
    assert.deepEqual(filterItems(value.items, { ...filters, ...patch }, value).map(entry => entry.id),
      report.delivery.find(group => group.key === category)!.itemIds)
    assert.equal(api.toggle({ ...filters, ...patch }, patch.drill!).drill, undefined)
    assert.equal(filters.person, 'owner-a')
  }
  const $ = load(api.render(value, { person: 'owner-a', metric: 'remaining', drill: { chart: 'closure', key: 'blocked' } }))
  assert.match($('[data-ado-chart="delivery"]').text(), /1 of 2 completed/)
  assert.match($('[data-ado-chart="owner"]').text(), /All Task · 9 items/)
  assert.equal($('section[aria-label="Selected work items"] tbody tr').length, 1)
  assert.match($('section[aria-label="Selected work items"] tbody').text(), /Synthetic task 3/)
  assert.equal($('[data-ado-chart="closure"] button[aria-pressed="true"]').text().trim(), '1Investigate blockers1')
  assert.match($.text(), /Chart filter: Path to completion · Investigate blockers/)
  const stateAge = load(api.render(value, { drill: { chart: 'stateAge', key: 'unknown' } }))
  assert.equal(stateAge('[data-ado-chart="age"] [role="group"] button[aria-pressed="true"]').text(), en['ado.age.state'])
  assert.match(stateAge('[data-ado-chart="age"]').text(), /StateChangeDate, not ChangedDate/)
  assert.equal(stateAge('[data-ado-chart="age"] ol button[aria-pressed="true"]').text(), 'Unknown1')
})

test('analytics filters use one primary row and expose active advanced filters outside their disclosure', async () => {
  const api = await renderer
  const $ = load(api.render(snapshot()))
  const toolbar = $('[class*="adoFilterToolbar"]')
  const main = toolbar.find('[class*="adoFilterMain"]')
  assert.equal(toolbar.attr('aria-label'), en['ado.filters'])
  assert.equal(toolbar.find('h2').length, 0)
  assert.deepEqual(main.children('label').map((_index, element) => $(element).children('span').text()).get(),
    ['Item type', 'Person', 'State', 'Search items'])
  assert.equal(main.children('button').text(), en['filter.reset'])
  const more = main.children('details')
  assert.equal(more.attr('open'), undefined)
  assert.equal(more.children('summary').text(), en['ado.filters.more'])
  assert.equal(more.find('label > span').text(), en['filter.tag'])
  assert.equal(more.find('[role="group"] button[aria-pressed]').length, 4)
  assert.equal(toolbar.find('[class*="adoFilterActive"]').length, 0)
  const active = load(api.render(snapshot(), { tag: 'synthetic', risk: 'blocked' }))
  const chips = active('[class*="adoFilterActive"]')
  assert.equal(chips.find('button[aria-label="Clear Tag: synthetic"]').length, 1)
  assert.equal(chips.find('button[aria-label="Clear Blocked"]').length, 1)
  assert.equal(chips.closest('details').length, 0)
  assert.equal(active('[class*="adoFilterAdvanced"] button[aria-pressed="true"]').text(), en['risk.blocked'])
  assert.match(active('[data-ado-chart="delivery"]').text(), /1 of 7 completed/)
})

test('legacy snapshots retain four KPIs, separate estimate fields, state/person filters and item-table semantics', async () => {
  const value = snapshot()
  delete value.analytics
  const $ = load((await renderer).render(value))
  assert.equal($('[data-ado-chart]').length, 0)
  assert.equal($('[class*="adoKpis"] > *').length, 4)
  assert.match($.text(), /3 points/)
  assert.match($.text(), /5 work units/)
  assert.match($.text(), /Remaining work · 2 work units/)
  assert.equal($('h2').filter((_index, element) => $(element).text() === 'By state').length, 1)
  assert.equal($('h2').filter((_index, element) => $(element).text() === 'By person').length, 1)
  assert.equal($('section[aria-label="Selected work items"] tbody tr').length, 9)
})

test('refreshed areas and age bands retain exact filters without crashing or silently broadening the table', async () => {
  const api = await renderer
  const value = snapshot()
  const area = load(api.render(value, { drill: { chart: 'area', key: 'Fixture\\Departed area' } }))
  assert.equal(area('section[aria-label="Selected work items"] tbody tr').length, 0)
  assert.match(area('[data-ado-chart="delivery"]').text(), /1 of 7 completed/)
  assert.match(area('[class*="adoActiveDrill"]').text(), /Fixture\\Departed area/)
  assert.equal(area('[class*="adoActiveDrill"] button').text(), en['ado.analytics.clearDrill'])
  value.analytics!.settings.ageBands = [5, 10, 40]
  const age = load(api.render(value, { drill: { chart: 'age', key: 'gte-20' } }))
  assert.equal(age('section[aria-label="Selected work items"] tbody tr').length, 1)
  assert.match(age('section[aria-label="Selected work items"] tbody').text(), /Synthetic task 3/)
  assert.match(age('[class*="adoActiveDrill"]').text(), /Work age · 20\+ days/)
  assert.match(age('[data-ado-chart="age"]').text(), /40\+ days/)
  assert.equal(age('[data-ado-chart="age"] ol button[aria-pressed="true"]').length, 0)
})

test('empty and excluded-only selections do not draw false completion or history', async () => {
  const api = await renderer
  for (const items of [[], [item(1, { category: 'Unknown' }), item(2, { category: 'Removed' })]]) {
    const value = snapshot()
    value.items = items
    const $ = load(api.render(value))
    assert.match($('[data-ado-chart="delivery"]').text(), /No eligible items; completion is unavailable/)
    assert.equal($('[class*="adoCompletionRing"][data-empty="true"]').length, 1)
    assert.match($('[data-ado-chart="closure"]').text(), /No known unfinished items/)
    assert.equal($('[data-ado-chart="history"] svg').length, 0)
    assert.doesNotMatch($.html(), /NaN|Infinity/)
  }
})

test('history request state is selected-type qualified, accessible and remains separate from current charts', async () => {
  const api = await renderer
  const pending = load(api.render(snapshot(), {}, { status: 'pending', type: 'Task', errorDetail: null }))
  assert.match(pending('[data-ado-chart="history"] [role="status"]').text(), /Loading bounded revision history/)
  assert.equal(pending('[data-ado-chart="history"] button[disabled]').length, 1)
  assert.equal(pending('[data-ado-chart="delivery"]').length, 1)
  const error = load(api.render(snapshot(), {}, { status: 'error', type: 'Task', errorDetail: '<script>synthetic failure</script>' }))
  assert.match(error('[data-ado-chart="history"] [role="alert"]').text(), /synthetic failure/)
  assert.equal(error('script').length, 0)
  assert.equal(error('[data-ado-chart="history"] button').text(), en['ado.history.retry'])
  const another = load(api.render(snapshot(), {}, { status: 'pending', type: 'Feature', errorDetail: null }))
  assert.equal(another('[data-ado-chart="history"] [role="status"]').length, 0)
  const disabled = load(api.render(snapshot(), {}, undefined, 'en', false))
  assert.match(disabled('[data-ado-chart="history"]').text(), /Revision loading is unavailable/)
  assert.equal(disabled('[data-ado-chart="history"] button[disabled]').length, 1)
})

test('loaded history renders step occupancy and daily transition bars with coverage and complete data', async () => {
  const value = snapshot(true)
  const report = buildAdoAnalytics(value, { ...emptyFilters(), type: 'Task' })!
  const $ = load((await renderer).render(value))
  const history = $('[data-ado-chart="history"]')
  assert.equal(history.find('svg[role="img"]').length, 3)
  assert.equal(history.find('svg[role="img"] title').length, 3)
  assert.equal(history.find('svg[role="img"] desc').length, 3)
  assert.doesNotMatch(history.find('[data-ado-history="trend"]').attr('class')!, /adoChartWide/)
  assert.doesNotMatch(history.find('[data-ado-history="state"]').attr('class')!, /adoChartWide/)
  assert.match(history.find('[data-ado-history="events"]').attr('class')!, /adoChartWide/)
  assert.equal(history.find('[data-ado-history="trend"] [class*="adoHistoryDateShort"]').length, 3)
  assert.match(history.text(), /History coverage: 8\/9 items/)
  assert.match(history.text(), /Partial coverage/)
  assert.match(history.text(), /not a full sprint burndown/)
  assert.match(history.text(), /bounded by the configured history limit/)
  assert.match(history.text(), /Items without history: 9/)
  assert.equal(history.find('img').length, 0)
  const rows = history.find('table tbody tr')
  assert.equal(rows.length, 4)
  assert.equal(rows.eq(2).find('td').eq(7).text(), '1')
  assert.equal(rows.eq(2).find('td').eq(8).text(), '1')
  assert.equal(rows.eq(2).find('td').eq(9).text(), '1')
  assert.equal(rows.eq(2).find('td').eq(10).text(), '1')
  const path = history.find('[data-ado-history="trend"] path').attr('d')!
  assert.equal(path, historyGeometry(report.history!.points).line)
  assert.doesNotMatch(path, /[CQST]/)
  assert.ok(report.history!.points[2]!.counts.Completed > report.history!.points[3]!.counts.Completed)
  assert.equal(history.find('[data-ado-history="events"] rect').length, 8)
  for (const category of [...categories, 'notCreated']) {
    assert.ok(history.find(`[data-ado-history="state"] path[data-category="${category}"]`).length, category)
  }
  const css = await readFile(new URL('../src/client/dsh-dashboard.module.css', import.meta.url), 'utf8')
  assert.match(css, /\.adoHistoryGrid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /@container dashboardData \(max-width: 680px\) \{\s*\.adoHistoryGrid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  assert.match(css, /@container adoHistoryPlot \(max-width: 380px\)/)
})

test('no history evidence and one-day evidence remain distinct; long series retain every row and positive bars', async () => {
  const api = await renderer
  const report = buildAdoAnalytics(snapshot(true), { ...emptyFilters(), type: 'Task' })!
  const point = report.history!.points[0]!
  const unavailable = structuredClone(report)
  unavailable.history!.points = []
  unavailable.history!.status = 'unavailable'
  const empty = load(api.history(unavailable))
  assert.equal(empty('svg[role="img"]').length, 0)
  assert.match(empty.text(), /No daily observations are available/)
  const single = structuredClone(report)
  single.history!.points = [point]
  const one = load(api.history(single))
  assert.equal(one('[data-ado-history="trend"] circle').length, 1)
  assert.equal(one('[data-ado-history="state"] path[data-single="true"]').length, 7)
  const long = structuredClone(report)
  long.history!.points = Array.from({ length: 365 }, (_entry, index) => ({
    ...point, date: new Date(Date.UTC(2039, 0, index + 1)).toISOString().slice(0, 10),
  }))
  const all = load(api.history(long))
  assert.equal(all('table tbody tr').length, 365)
  assert.equal(all('[data-ado-history="events"] rect').length, 730)
  assert.ok(all('[data-ado-history="events"] rect').toArray().every(element => Number(all(element).attr('width')) > 0))
})

test('zero-based geometry uses maintained step-after line/area generators without fabricating empty observations', () => {
  const empty = historyGeometry([])
  assert.equal(empty.line, null)
  assert.ok(empty.areas.every(series => series.path === null))
  assert.deepEqual(empty.events, [])
  const points: HistoryPoint[] = [2, 1].map((completed, index) => ({
    date: `2040-04-0${index + 1}`,
    counts: { Proposed: 3 - completed, InProgress: 0, Resolved: 0, Completed: completed, Removed: 0, Unknown: 0 },
    notCreated: 0, completedItemIds: index ? [] : [1, 2], reopenedItemIds: index ? [1] : [],
  }))
  const geometry = historyGeometry(points)
  assert.equal(geometry.line, 'M40,74L624,74L624,132')
  assert.equal(geometry.maxCount, 3)
  assert.equal(geometry.maxEvents, 2)
  assert.equal(geometry.yTicks[0]!.value, 0)
  assert.equal(geometry.yTicks[0]!.y, geometry.bottom)
  assert.equal(geometry.events[0]!.reopened.height, 0)
  assert.equal(geometry.events[1]!.completed.height, 0)
  assert.ok(geometry.events[0]!.x > geometry.left)
  assert.ok(geometry.events.at(-1)!.x < geometry.right)
  assert.equal(geometry.x.at(-1), geometry.right)
  assert.ok(geometry.areas.every(series => !/NaN|Infinity/.test(series.path ?? '')))
  assert.deepEqual(historyGeometry([points[0]!]).x, [(geometry.left + geometry.right) / 2])
})

test('long ownership and area labels remain complete, and new chart styles are ADO-qualified', async () => {
  const value = snapshot()
  const label = `Fixture\\${'Long-area-path-'.repeat(40)}`
  value.items = Array.from({ length: 70 }, (_entry, index) => item(index + 1, {
    areaPath: label, assignee: `Owner ${String(index).padStart(3, '0')}`, assigneeId: `owner-${index}`,
  }))
  const $ = load((await renderer).render(value))
  assert.equal($('[data-ado-chart="owner"] [class*="adoOwnedBars"] > li').length, 70)
  assert.equal($('[data-ado-chart="owner"] table tbody tr').length, 70)
  assert.ok($('[data-ado-chart="area"]').text().includes(label))
  const css = await readFile(new URL('../src/client/dsh-dashboard.module.css', import.meta.url), 'utf8')
  const additions = css.slice(css.indexOf('\n.adoContent {'))
  assert.ok(additions.length > 100)
  const classes = [...additions.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]!)
  assert.ok(classes.every(name => name.startsWith('ado')), classes.filter(name => !name.startsWith('ado')).join(', '))
  assert.match(additions, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(additions, /@container dashboardData \(max-width: 760px\)/)
})

test('ADO analysis strings and accessibility render in English and Chinese with matching placeholders', async () => {
  const api = await renderer
  const $ = load(api.render(snapshot(true), {}, undefined, 'zh'))
  assert.equal($('[data-ado-chart="delivery"] h2').text(), zh['ado.delivery.title'])
  assert.equal($('[data-ado-chart="history"] > header h2').text(), zh['ado.history.title'])
  assert.match($('[data-ado-chart="age"]').text(), /少于 3 天/)
  assert.match($('[data-ado-chart="owner"]').text(), /不表示作者/)
  for (const key of Object.keys(en).filter(key => key.startsWith('ado.') || key.startsWith('export.')) as (keyof typeof en)[]) {
    assert.equal(typeof zh[key], 'string', key)
    assert.deepEqual([...en[key].matchAll(/\{\w+\}/g)].map(match => match[0]).sort(),
      [...zh[key].matchAll(/\{\w+\}/g)].map(match => match[0]).sort(), key)
  }
})
