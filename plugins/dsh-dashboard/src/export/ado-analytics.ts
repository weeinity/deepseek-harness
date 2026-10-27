/** Static ADO figures and complete data tables render the captured shared report without recalculation. */
import { arc, pie } from 'd3-shape'
import type { AdoAnalyticsReport, AgeGroup, HistoryReport, OwnershipGroup } from '../shared/ado-analytics-model.ts'
import { historyGeometry, historySeries } from '../shared/chart-geometry.ts'
import type { AdoExportSelection } from '../shared/export-types.ts'
import { categories } from '../shared/selection.ts'
import type { AdoSnapshot } from '../shared/types.ts'

interface Markup {
  escape(value: unknown): string
  link(url: string, body: string, className?: string): string
  card(title: string, body: string, note?: string, extraClass?: string): string
  metric(label: string, value: number | null, href: string, tone?: string): string
}

const categoryNames = {
  Proposed: 'Proposed', InProgress: 'In progress', Resolved: 'Resolved (unfinished)',
  Completed: 'Completed', Removed: 'Removed (excluded)', Unknown: 'Unknown (excluded)',
  notCreated: 'Not yet created',
}
const palette = ['#3d82bd', '#8555b0', '#b77c18', '#218568', '#777f8d', '#bd586b', '#9baac0']
const riskNames = { blocked: 'Blocked flag', unassigned: 'Unassigned', overdue: 'Overdue', stale: 'No recent update' }
const closureNames = { ...riskNames, resolved: 'Resolved; closure needed', continue: 'Continue work' }
const dependencyNames = { open: 'Open predecessor observed', unavailable: 'Predecessor evidence unavailable', clear: 'No open predecessor observed' }
const baseScope = 'Type, person, state, tag, and text filters apply. Metric, risk, and chart selections do not narrow these counts.'
const typeScope = 'Every loaded item of the selected type; other filters do not narrow these counts.'

interface BarRow { key: string; label: string; count: number }

/** Keep labels, counts, boundaries, and line styles readable in either offline theme. */
export const adoAnalyticsCss = `
.ado-figure{margin:12px 0 18px}.ado-figure svg{width:100%;height:auto;display:block;max-height:none}.ado-figure text{fill:var(--text);font-size:12px}.ado-figure figcaption{font-size:12px;line-height:1.6;color:var(--muted);margin-top:8px}.ado-figure path,.ado-figure rect{stroke:var(--card);stroke-width:1.5}.ado-figure .history-line{fill:none;stroke:var(--text);stroke-width:3}.ado-figure .history-axis{stroke:var(--muted);stroke-width:1}.ado-figure .history-grid{stroke:var(--line);stroke-width:1}.ado-figure .history-point{fill:var(--text);stroke:var(--card)}.ado-figure .history-reopened{fill:none;stroke:var(--text);stroke-width:1.5}.ado-legend{display:flex;flex-wrap:wrap;gap:8px 16px;padding:0;list-style:none;font-size:12px}.ado-legend li{display:flex;gap:6px;align-items:center}.ado-legend .swatch{border:1px solid var(--muted)}.ado-table caption{text-align:left;font-weight:600;color:var(--text);padding:10px 0}.ado-table td{overflow-wrap:anywhere}.ado-ids{max-width:36rem}.ado-ring{max-width:260px;margin:auto}.ado-history-note{white-space:normal}.ado-scope{border-left:3px solid #8555b0}.ado-source-dates{overflow-wrap:anywhere}
`

/**
 * Render portable graphs from a report captured before matching-row projection.
 * @param snapshot Source metadata and matching rows; it need not contain the full source item set.
 * @param report Exact captured report, including any explicitly loaded history.
 * @param selection Optional captured KPI and full-type state datasets; absence never implies zero.
 * @param markup Shared text escaping and safe-link helpers from the document renderer.
 * @returns Escaped static SVG, all report data rows, source details, and scope warnings.
 */
export function renderAdoAnalytics(snapshot: AdoSnapshot, report: AdoAnalyticsReport, selection: AdoExportSelection | undefined, markup: Markup): string {
  const { escape, link, card, metric } = markup
  const table = (id: string, title: string, headers: string[], rows: unknown[][]) =>
    `<div class="table-scroll"><table class="ado-table" id="${id}-table"><caption>${escape(title)} · data</caption><thead><tr>${headers.map(label => `<th scope="col">${escape(label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  const figure = (id: string, title: string, width: number, height: number, body: string, note = '') =>
    `<figure class="ado-figure"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(title)}" aria-describedby="${id}-table"><title>${escape(title)}</title>${body}</svg>${note ? `<figcaption>${escape(note)}</figcaption>` : ''}</figure>`
  const legend = (keys: readonly string[], labels: Record<string, string>) =>
    `<ul class="ado-legend">${keys.map((key, index) => `<li><span class="swatch" aria-hidden="true" style="background:${palette[index % palette.length]}"></span>${escape(labels[key] ?? key)}</li>`).join('')}</ul>`
  const bars = (id: string, title: string, rows: readonly BarRow[]) => {
    if (!rows.length) return '<p class="note">No groups in this scope.</p>'
    const maximum = Math.max(1, ...rows.map(row => row.count))
    return figure(id, title, 680, 36 * rows.length + 28, rows.map((row, index) =>
      `<text x="8" y="${index * 36 + 21}">${escape(row.label)}</text><rect x="310" y="${index * 36 + 5}" width="${row.count / maximum * 300}" height="22" fill="${palette[index % palette.length]}" /><text x="625" y="${index * 36 + 21}">${escape(row.count)}</text>`).join(''), 'Bars start at zero; labels and the adjacent table give exact counts.')
  }
  const groups = (id: string, title: string, rows: readonly { key: string; count: number; itemIds: number[] }[], label: (row: { key: string }) => string, note: string) => {
    const plotted = rows.map(row => ({ ...row, label: label(row) }))
    return `<div id="${id}">${card(title, bars(id, title, plotted)
      + table(id, title, ['Group', 'Count', 'Work item IDs'], plotted.map(row => [row.label, row.count, row.itemIds.join(', ') || '—'])), note)}</div>`
  }
  const ageLabel = (row: AgeGroup) => row.lower === null ? 'Unknown age'
    : row.upper === null ? `${row.lower}+ days` : `${row.lower}–<${row.upper} days`
  const ages = (id: string, title: string, rows: AgeGroup[], field: string) => {
    const plotted = rows.map(row => ({ ...row, label: ageLabel(row) }))
    return card(title, bars(id, title, plotted) + table(id, title, ['Age band', 'Count', 'Work item IDs'], plotted.map(row => [row.label, row.count, row.itemIds.join(', ') || '—'])),
      `${baseScope} Unfinished eligible items only. Age uses ${field} at ${snapshot.generatedAt}; missing or future dates are unknown. ChangedDate is not state age.`)
  }
  const ownership = (id: string, title: string, rows: OwnershipGroup[], allType: boolean) => {
    const maximum = Math.max(1, ...rows.map(row => row.itemIds.length))
    const chart = rows.length ? figure(id, title, 700, 38 * rows.length + 24, rows.map((row, index) => {
      let x = 285
      const segments = categories.map((key, color) => {
        const value = row.counts[key]
        const width = value / maximum * 320
        const rect = `<rect x="${x}" y="${index * 38 + 5}" width="${width}" height="23" fill="${palette[color]}" />`
        x += width
        return rect
      }).join('')
      return `<text x="8" y="${index * 38 + 21}">${escape(row.label || (row.key === '__unassigned__' ? 'Unassigned' : row.key || 'Area unavailable'))}</text>${segments}<text x="620" y="${index * 38 + 21}">${escape(row.itemIds.length)}</text>`
    }).join(''), allType ? 'All categories describe current ownership. Completed and unfinished counts in the table are not authorship, productivity, performance, or capacity.' : 'All state categories are shown. Unknown and Removed remain outside progress totals.') : ''
    return card(title, chart
      + legend(categories, categoryNames)
      + table(id, title, ['Group', 'Identity / area', 'Completed', 'Unfinished', ...categories.map(key => categoryNames[key]), 'Unfinished with risk', 'Work item IDs'],
        rows.map(row => [row.label || (row.key === '__unassigned__' ? 'Unassigned' : 'Unavailable'), row.key, row.completed, row.remaining, ...categories.map(key => row.counts[key]), row.risks, row.itemIds.join(', ') || '—'])),
      allType ? `${typeScope} Alphabetical, not a productivity ranking. Stacks include Unknown and Removed; eligible completed/unfinished counts exclude them.` : baseScope)
  }
  const historyNote = (history: HistoryReport) => {
    const range = history.range
    return `Source: ${snapshot.source.orgName} / ${snapshot.source.project} / ${snapshot.iteration?.path ?? snapshot.source.path ?? snapshot.source.input}; type: ${report.type}; ${range ? `${range.start}–${range.finish}; timezone ${range.timeZone}; date source: ${range.source === 'iteration' ? 'sprint calendar dates' : 'recent calendar days'}${range.clipped ? '; range clipped' : ''}` : 'Date range unavailable'}; snapshot ${snapshot.generatedAt}; revisions fetched ${history.fetchedAt}; ${history.status}; available ${history.availableCount}/${history.requestedCount} current-cohort items. ${report.sourceComplete ? 'Source complete.' : 'Source partial: loaded items only.'}`
  }
  const historyPanels = () => {
    const history = report.history
    if (!history) return card('Current-cohort history', '<p class="note">History was not loaded for this type. No historical lines or zero-filled dates are shown.</p>')
    const sourceDetails = historyNote(history)
    const warnings = history.warnings.map(value => `<li>${escape(value)}</li>`).join('')
    const omissions = `<p class="note">Omitted current-cohort IDs: ${escape(history.omittedItemIds.join(', ') || 'None')}.</p>`
      + (history.omittedItemIds.length ? table('history-omissions', 'Unavailable revision evidence', ['Work item ID', 'Reason'],
        history.omittedItemIds.map(id => [id, snapshot.analytics?.history?.omitted.find(item => item.id === id)?.reason ?? 'Reason not captured'])) : '')
    const notice = `<p class="ado-history-note note">${escape(sourceDetails)}</p><ul>${warnings}</ul>${omissions}`
    if (history.status === 'unavailable' || !history.range || !history.points.length) return card('Current-cohort history', notice + '<p class="note">History unavailable. No lines or zero-filled dates are shown.</p>')
    const geometry = historyGeometry(history.points)
    const axes = (events: boolean) => (events ? geometry.eventTicks : geometry.yTicks).map(tick =>
      `<line class="history-grid" x1="${geometry.left}" x2="${geometry.right}" y1="${tick.y}" y2="${tick.y}" /><text x="${geometry.left - 8}" y="${tick.y + 4}" text-anchor="end">${tick.value}</text>`).join('')
      + `<line class="history-axis" x1="${geometry.left}" x2="${geometry.right}" y1="${geometry.bottom}" y2="${geometry.bottom}" />`
      + history.points.map((point, index) => {
        if (index !== 0 && index !== history.points.length - 1) return ''
        return `<text x="${geometry.x[index]}" y="${geometry.height - 6}" text-anchor="${history.points.length === 1 ? 'middle' : index ? 'end' : 'start'}">${escape(point.date)}</text>`
      }).join('')
    const lineTitle = 'Completion trend · current cohort'
    const line = figure('history-completion', lineTitle, geometry.width, geometry.height, axes(false)
      + (geometry.line ? `<path class="history-line" d="${escape(geometry.line)}" />` : '')
      + history.points.map((point, index) => `<circle class="history-point" cx="${geometry.x[index]}" cy="${geometry.completedY[index]}" r="3"><title>${escape(`${point.date}: ${point.counts.Completed} completed`)}</title></circle>`).join(''), 'Daily Completed occupancy can decrease after reopening; this is not a full-sprint burnup or burndown.')
    const lineTable = table('history-completion', lineTitle, ['Date', 'Completed'], history.points.map(point => [point.date, point.counts.Completed]))
    const stateTitle = 'State history · current cohort'
    const state = figure('history-state', stateTitle, geometry.width, geometry.height, geometry.areas.map((series, index) =>
      series.path ? `<path d="${escape(series.path)}" fill="${palette[index]}"${history.points.length === 1 ? ` style="stroke:${palette[index]};stroke-width:8"` : ''} />` : '').join('') + axes(false), 'State categories use current metadata. This is not historical board-column flow; not-yet-created and unknown states are distinct.')
    const stateTable = table('history-state', stateTitle, ['Date', ...historySeries.map(key => categoryNames[key])],
      history.points.map(point => [point.date, ...historySeries.map(key => key === 'notCreated' ? point.notCreated : point.counts[key])]))
    const eventsTitle = 'Daily completion and reopening events'
    const groupWidth = Math.min(26, (geometry.right - geometry.left) / history.points.length * 0.75)
    const barWidth = groupWidth * 0.44
    const gap = groupWidth * 0.06
    const events = figure('history-events', eventsTitle, geometry.width, geometry.height, axes(true) + geometry.events.map((event, index) =>
      `<rect x="${event.x - groupWidth / 2}" y="${event.completed.y}" width="${barWidth}" height="${event.completed.height}" fill="${palette[3]}"><title>${escape(`${history.points[index]!.date}: ${history.points[index]!.completedItemIds.length} completed`)}</title></rect><rect class="history-reopened" x="${event.x + gap}" y="${event.reopened.y}" width="${barWidth}" height="${event.reopened.height}"><title>${escape(`${history.points[index]!.date}: ${history.points[index]!.reopenedItemIds.length} reopened`)}</title></rect>`).join(''), 'Filled bars: completed. Outlined bars: reopened. Each item counts once per event kind per day; one item can appear in both. These counts are not throughput or productivity rankings.')
    const eventsTable = table('history-events', eventsTitle, ['Date', 'Distinct completed', 'Distinct reopened', 'Completed IDs', 'Reopened IDs'],
      history.points.map(point => [point.date, point.completedItemIds.length, point.reopenedItemIds.length, point.completedItemIds.join(', ') || '—', point.reopenedItemIds.join(', ') || '—']))
    const scope = `${baseScope} Only available revision histories contribute; omitted items are not zero observations.`
    return card(lineTitle, notice + line + lineTable, scope)
      + card(stateTitle, `<p class="note">${escape(sourceDetails)}</p>` + state + legend(historySeries, categoryNames) + stateTable, scope)
      + card(eventsTitle, `<p class="note">${escape(sourceDetails)}</p>` + events + eventsTable, scope)
  }

  const totals = report.totals
  const ringParts = [{ label: 'Completed', count: totals.completed }, { label: 'Unfinished', count: totals.remaining }]
  const slices = pie<typeof ringParts[number]>().sort(null).value(row => row.count)(ringParts)
  const ringArc = arc<typeof slices[number]>().innerRadius(62).outerRadius(92)
  const ring = totals.eligible ? `<div class="ado-ring">${figure('delivery', 'Delivery completion', 220, 220,
    `<g transform="translate(110,110)">${slices.map((slice, index) => `<path d="${escape(ringArc(slice) ?? '')}" fill="${palette[index ? 0 : 3]}"><title>${escape(`${slice.data.label}: ${slice.data.count}`)}</title></path>`).join('')}</g><text x="110" y="110" text-anchor="middle">${totals.percent === null ? '—' : escape(`${totals.percent.toFixed(1)}%`)}</text><text x="110" y="130" text-anchor="middle">Completed</text>`)}</div>` : '<p class="note">No eligible items; completion percentage unavailable, not zero.</p>'
  const delivery = card('Delivery completion', ring
    + `<p class="note">Completed ${totals.completed}; unfinished ${totals.remaining}; eligible ${totals.eligible}. Unknown ${totals.unknown}; Removed ${totals.removed}.</p>`
    + table('delivery', 'Delivery completion', ['State category', 'Count', 'Work item IDs'], report.delivery.map(row => [categoryNames[row.key], row.count, row.itemIds.join(', ') || '—'])),
    `${baseScope} Only Completed is complete. Resolved is unfinished. Unknown and Removed are excluded from completion percentages.`)
  const metrics = metric('Completed', totals.completed, '#work') + metric('Remaining', totals.remaining, '#work', 'watch')
    + metric('Assigned people', selection?.summary.people ?? null, '#ownership')
    + metric('Items with risk flags', selection?.summary.risks ?? null, '#risks', 'hot')
    + metric('Unknown state category', totals.unknown, '#work') + metric('Removed', totals.removed, '#work')
  const metadata = `<p class="notice ado-source-dates">${escape(snapshot.source.orgName)} / ${escape(snapshot.source.project)} / ${escape(snapshot.source.team ?? '')}<br>${escape(snapshot.iteration?.path ?? snapshot.source.path ?? snapshot.source.input)}<br>Displayed type: ${escape(report.type)}. Parent and task counts are not combined.<br>Snapshot: ${escape(snapshot.generatedAt)}${snapshot.analytics ? `; timezone: ${escape(snapshot.analytics.timeZone)}` : ''}${snapshot.iteration ? `<br>Sprint dates: ${escape(snapshot.iteration.start ?? 'unavailable')} — ${escape(snapshot.iteration.finish ?? 'unavailable')}` : ''}</p>`
  const scope = `<p class="notice ado-scope">${report.sourceComplete ? 'Complete source result.' : 'Partial source result: loaded items only; source-wide totals are unavailable.'} Selected type: ${report.typeItemIds.length} loaded items; base chart scope: ${report.baseItemIds.length}; matching rows across all pages: ${report.matchingItemIds.length}. ${escape(baseScope)} Owner and actual-state charts retain their selected-type scope.</p>`
  const stateChart = selection ? card('Current states', bars('states', 'Current states', selection.states)
    + table('states', 'Current states', ['State', 'Count'], selection.states.map(row => [row.label, row.count])),
  `${typeScope} Unknown and Removed remain in this source-distribution chart.`) : card('Current states', '<p class="note">Full-type state data was not captured; matching rows cannot reconstruct these counts.</p>')
  const estimates = selection ? card('Estimates by field', table('estimates', 'Estimates by field', ['Field', 'Total', 'Items with a value'],
    selection.summary.estimates.map(row => [row.field, row.total, row.count]))
    + `<p class="note">Remaining Work: ${escape(selection.summary.remainingWork ?? 'Unavailable')}; items with a value: ${selection.summary.remainingWorkCount}.</p>`, `${baseScope} Unknown and Removed are excluded. Fields retain their own units; no hours assumption or cross-field sum.`)
    : card('Estimates by field', '<p class="note">Base-scope estimate totals were not captured; matching rows cannot reconstruct them.</p>')
  const matching = new Set(report.matchingItemIds)
  const rows = snapshot.items.filter(work => matching.has(work.id)).map(work =>
    `<tr><td>${link(work.url, `#${escape(work.id)}`, 'inline')}</td><td>${link(work.url, escape(work.title), 'inline')}</td><td>${escape(work.state)}<small>${escape(work.category)}</small></td><td>${escape(work.assignee || 'Unassigned')}</td><td>${work.estimate === undefined ? '—' : `${escape(work.estimate)}<small>${escape(work.estimateField)}</small>`}</td><td>${escape(work.risks.join(', ') || '—')}</td></tr>`).join('')
  const work = `<div id="work">${card('Matching work items', `<div class="table-scroll"><table class="ado-table"><caption>Every active filter; all matching pages</caption><thead><tr>${['ID', 'Work item', 'State', 'Assigned to', 'Estimate / field', 'Flags'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`, 'Source links open externally only when clicked. The table is not the denominator for the charts above.')}</div>`
  const notes = [...snapshot.warnings, ...(!report.sourceComplete ? ['This result is partial. Counts cover loaded items only.'] : [])]
  return `<div class="kpis">${metrics}</div>${metadata}${scope}${link(snapshot.sourceUrl, 'Open source in Azure DevOps', 'source-button')}${delivery}`
    + groups('closure', 'Closure path', report.closure, row => closureNames[row.key as keyof typeof closureNames], `${baseScope} Exclusive precedence: blocked, unassigned, overdue, resolved, stale, continue. These groups partition the ${totals.remaining} unfinished eligible items; a flagged item appears once here.`)
    + groups('risks', 'Overlapping risk flags', report.risks, row => riskNames[row.key as keyof typeof riskNames], `${baseScope} Unfinished eligible items only. Groups overlap; their sum is not a distinct count. Distinct union: ${totals.flagged}. A flag does not prove inactivity or delay.`)
    + `<div class="grid">${ages('age', 'Work-item age', report.age, 'CreatedDate')}${ages('state-age', 'Current-state age', report.stateAge, 'StateChangeDate')}</div>`
    + groups('dependencies', 'Current predecessor signals', report.dependencies.groups, row => dependencyNames[row.key as keyof typeof dependencyNames], `${baseScope} Unfinished eligible items only. Current link and state observations are not proof of actual blocking. Unavailable relations or predecessor states remain unavailable.`)
    + card('Predecessor observations', table('dependency-links', 'Predecessor observations', ['Work item ID', 'Predecessor ID', 'Observed status'],
      report.dependencies.links.map(row => [row.itemId, row.predecessorId ?? 'Unavailable', row.status])), 'Only this snapshot resolves predecessor IDs. No dependency chain or external state is inferred.')
    + ownership('areas', 'Delivery by area', report.areas, false)
    + `<div id="ownership">${ownership('owners', 'Current assignee ownership', report.owners, true)}</div>`
    + stateChart + estimates + historyPanels() + work
    + (notes.length ? card('Data notes', `<ul>${notes.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`) : '')
}
