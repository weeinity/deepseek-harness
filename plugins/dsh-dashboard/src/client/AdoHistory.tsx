/** Optional revision history renders observed current-cohort data without issuing requests. */
import { useId } from 'react'
import type { AdoAnalyticsReport, HistoryReport } from '../shared/ado-analytics-model.ts'
import { historyGeometry, type HistoryGeometry } from '../shared/chart-geometry.ts'
import { categories } from '../shared/selection.ts'
import { AdoChartCard, AdoDataTable, AdoLegend } from './AdoCharts.tsx'
import { date, number } from './format.ts'
import type { DashboardText } from './locale.ts'
import { Warnings } from './presentation.tsx'
import styles from './dsh-dashboard.module.css'

/** Parent-owned request status; the selected work-item type qualifies an in-flight request. */
export interface AdoHistoryState {
  status: 'idle' | 'pending' | 'ready' | 'error'
  type: string | null
  errorDetail: string | null
}

function Axes({ geometry, history, events = false, t }: {
  geometry: HistoryGeometry; history: HistoryReport; events?: boolean; t: DashboardText
}) {
  const ticks = events ? geometry.eventTicks : geometry.yTicks
  const last = history.points.length - 1
  const indices = [...new Set([0, Math.floor(last / 2), last])].filter(index => index >= 0)
  const compactDate = new Intl.DateTimeFormat(t('format.locale'), { month: 'short', day: 'numeric', timeZone: 'UTC' })
  return <g className={styles.adoChartAxes} aria-hidden="true">
    {ticks.map(tick => <g key={tick.value}>
      <line x1={geometry.left} x2={geometry.right} y1={tick.y} y2={tick.y} />
      <text x={geometry.left - 8} y={tick.y + 4} textAnchor="end">{number(tick.value, t)}</text>
    </g>)}
    {indices.map(index => <text key={index} x={events ? geometry.events[index]!.x : geometry.x[index]} y={geometry.height - 8}
      textAnchor={index === 0 && last > 0 ? 'start' : index === last && last > 0 ? 'end' : 'middle'}>
      <tspan className={styles.adoHistoryDateFull}>{date(history.points[index]!.date, 'UTC', t, 'date')}</tspan>
      <tspan className={styles.adoHistoryDateShort}>{compactDate.format(new Date(history.points[index]!.date))}</tspan>
    </text>)}
  </g>
}

function HistoryChart({ kind, history, geometry, t }: {
  kind: 'trend' | 'state' | 'events'; history: HistoryReport; geometry: HistoryGeometry; t: DashboardText
}) {
  const id = useId()
  const first = history.points[0]!
  const last = history.points.at(-1)!
  const summary = t('ado.history.summary', {
    days: number(history.points.length, t), first: number(first.counts.Completed, t), last: number(last.counts.Completed, t),
  })
  const groupWidth = Math.min(26, (geometry.right - geometry.left) / Math.max(1, history.points.length) * .75)
  const barWidth = groupWidth * .44
  const barGap = groupWidth * .06
  return <section className={`${styles.adoHistoryChart} ${kind === 'events' ? styles.adoChartWide : ''}`}
    aria-labelledby={`${id}-title`} data-ado-history={kind}>
    <div className={styles.adoChartHeader}><h3 id={`${id}-title`}>{t(`ado.history.${kind}`)}</h3>
      <span className={styles.adoChartScope}>{t('ado.analytics.count')}</span></div>
    <p className={styles.adoChartDescription}>{t(`ado.history.${kind}Help`)}</p>
    {kind === 'state' && <AdoLegend t={t} history />}
    {kind === 'events' && <ul className={styles.adoLegend}>
      <li><span className={styles.adoSwatch} data-category="Completed" aria-hidden="true" />{t('ado.history.completedEvents')}</li>
      <li><span className={styles.adoSwatch} data-category="reopened" aria-hidden="true" />{t('ado.history.reopenedEvents')}</li>
    </ul>}
    <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} className={styles.adoHistorySvg}
      role="img" aria-labelledby={`${id}-svg-title ${id}-svg-description`}>
      <title id={`${id}-svg-title`}>{t(`ado.history.${kind}`)}</title>
      <desc id={`${id}-svg-description`}>{summary} {t(`ado.history.${kind}Help`)}</desc>
      <Axes geometry={geometry} history={history} events={kind === 'events'} t={t} />
      {kind === 'trend' && <>
        {geometry.line && <path d={geometry.line} className={styles.adoTrendLine} />}
        {geometry.x.map((x, index) => <circle key={index} cx={x} cy={geometry.completedY[index]} r={history.points.length === 1 ? 4 : 2.5}
          className={styles.adoTrendDot} />)}
        <text x={geometry.x.at(-1)} y={Math.max(geometry.top + 12, geometry.completedY.at(-1)! - 9)}
          textAnchor={geometry.x.length > 1 ? 'end' : 'middle'} className={styles.adoTrendLabel}>
          {t('unit.items', { count: number(last.counts.Completed, t) })}
        </text>
      </>}
      {kind === 'state' && geometry.areas.map(series => series.path
        ? <path key={series.key} d={series.path} data-category={series.key} className={styles.adoHistoryArea}
          data-single={history.points.length === 1 || undefined} /> : null)}
      {kind === 'events' && geometry.events.map((event, index) => <g key={index}>
        <rect x={event.x - groupWidth / 2} y={event.completed.y} width={barWidth} height={event.completed.height}
          data-category="Completed" className={styles.adoEventBar} />
        <rect x={event.x + barGap} y={event.reopened.y} width={barWidth} height={event.reopened.height}
          data-category="reopened" className={styles.adoEventBar} />
      </g>)}
    </svg>
    <p className={styles.adoChartFootnote}>{kind === 'trend' ? summary : t('ado.history.current')}</p>
  </section>
}

function HistoryData({ history, t }: { history: HistoryReport; t: DashboardText }) {
  return <AdoDataTable title={t('ado.history.table')} t={t}
    headings={[t('ado.history.date'), ...categories.map(key => t(`category.${key}`)),
      t('ado.history.notCreated'), t('ado.history.completedEvents'), t('ado.history.reopenedEvents'),
      `${t('ado.history.completedEvents')} · ${t('ado.analytics.itemIds')}`,
      `${t('ado.history.reopenedEvents')} · ${t('ado.analytics.itemIds')}`]}
    rows={history.points.map(point => ({
      key: point.date,
      cells: [point.date, ...categories.map(key => number(point.counts[key], t)),
        number(point.notCreated, t), number(point.completedItemIds.length, t), number(point.reopenedItemIds.length, t),
        point.completedItemIds.join(', ') || t('value.unavailable'),
        point.reopenedItemIds.join(', ') || t('value.unavailable')],
    }))} />
}

/** Revision loading stays parent-owned; absent or unavailable evidence never produces a trend.
 * @param props Shared report, optional request state, and parent loading callback.
 * @returns Coverage-qualified completion, state history, and daily transition charts.
 */
export function AdoHistory({ report, history: request, loadHistory, t }: {
  report: AdoAnalyticsReport; history?: AdoHistoryState; loadHistory?: () => void; t: DashboardText
}) {
  const history = report.history
  const selectedRequest = request?.type === report.type ? request : undefined
  const pending = selectedRequest?.status === 'pending'
  const failed = selectedRequest?.status === 'error'
  const geometry = history?.points.length ? historyGeometry(history.points) : null
  return <AdoChartCard chart="history" title={t('ado.history.title')} description={t('ado.history.help')}
    scope={t('ado.analytics.scope', { type: report.type, count: number(report.baseItemIds.length, t) })} wide>
    <div className={styles.adoHistoryToolbar}>
      {(!history || history.status !== 'complete' || failed) && <button type="button" onClick={loadHistory}
        disabled={pending || !loadHistory}>{t(failed || history ? 'ado.history.retry' : 'ado.history.load')}</button>}
      {history && <span className={styles.adoCoverage} data-status={history.status}>
        <strong>{t('ado.history.coverage', { available: number(history.availableCount, t), requested: number(history.requestedCount, t) })}</strong>
        <span>{t(`ado.history.${history.status}`)}</span>
      </span>}
    </div>
    <div className={styles.adoHistoryStatus} aria-live="polite" aria-atomic="true">
      {pending && <p role="status">{t('ado.history.loading')}</p>}
      {failed && <p role="alert" className={styles.adoHistoryError}>{t('ado.history.error')}
        {selectedRequest.errorDetail && <span>{selectedRequest.errorDetail}</span>}</p>}
    </div>
    {!history && <p className={styles.adoChartEmpty}>{t(loadHistory ? 'ado.history.absent' : 'ado.history.disabled')}</p>}
    {history && <>
      <div className={styles.adoHistoryMetadata}>
        {history.range && <><strong>{t('ado.history.range', {
          start: date(history.range.start, 'UTC', t, 'date'), finish: date(history.range.finish, 'UTC', t, 'date'),
          zone: history.range.timeZone,
        })}</strong><span>{t(`ado.history.rangeSource.${history.range.source}`)}</span></>}
        <span>{t('ado.history.fetched', { time: date(history.fetchedAt, history.range?.timeZone ?? 'UTC', t) })}</span>
      </div>
      {history.range?.clipped && <p className={styles.adoChartFootnote}>{t('ado.history.clipped')}</p>}
      {history.omittedItemIds.length > 0 && <p className={styles.adoChartFootnote}>
        {t('ado.history.omitted', { ids: history.omittedItemIds.join(', ') })}</p>}
      <Warnings warnings={history.warnings} t={t} />
      {geometry ? <div className={styles.adoHistoryGrid}>
        <HistoryChart kind="trend" history={history} geometry={geometry} t={t} />
        <HistoryChart kind="state" history={history} geometry={geometry} t={t} />
        <HistoryChart kind="events" history={history} geometry={geometry} t={t} />
      </div> : <p className={styles.adoChartEmpty}>{t('ado.history.empty')}</p>}
      <HistoryData history={history} t={t} />
    </>}
  </AdoChartCard>
}
