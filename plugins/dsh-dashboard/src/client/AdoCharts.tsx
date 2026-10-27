/** Current-state ADO charts consume shared report populations and only change table selections. */
import { useId, useState, type ReactNode } from 'react'
import type {
  AdoAnalyticsReport, AdoDrill, AgeGroup, AnalyticsGroup, OwnershipGroup,
} from '../shared/ado-analytics-model.ts'
import type { AdoSnapshot, StateCategory } from '../shared/types.ts'
import { adoAgeInterval } from '../shared/ado-analytics-schema.ts'
import { categories, type Filters } from '../shared/selection.ts'
import type { DashboardText } from './locale.ts'
import { number } from './format.ts'
import { SourceLink, type ChartStyle } from './presentation.tsx'
import styles from './dsh-dashboard.module.css'

type ChartActions = { filters: Filters; onFilter: (patch: Partial<Filters>) => void; t: DashboardText }
type ReportProps = ChartActions & { report: AdoAnalyticsReport }

/** Toggle a chart selection without discarding the native or metric/risk filters.
 * @param filters Current work-item filters.
 * @param drill Clicked chart group.
 * @returns A filter patch that clears a repeated selection.
 */
export function adoDrillFilter(filters: Filters, drill: AdoDrill): Pick<Filters, 'drill'> {
  return { drill: filters.drill?.chart === drill.chart && filters.drill.key === drill.key ? undefined : drill }
}

/** Label configured half-open day intervals without guessing their thresholds.
 * @param group Report interval; two null bounds identify unavailable dates.
 * @param t Dashboard translator.
 * @returns Localized interval including its day unit.
 */
export function ageLabel(group: Pick<AgeGroup, 'lower' | 'upper'>, t: DashboardText): string {
  if (group.lower === null) return t('unknown')
  if (group.upper === null) return t('ado.age.over', { lower: number(group.lower, t) })
  return group.lower === 0 ? t('ado.age.under', { upper: number(group.upper, t) })
    : t('ado.age.range', { lower: number(group.lower, t), upper: number(group.upper, t) })
}

/** ADO-only card with a named chart region and an adjacent scope/interpretation.
 * @param props Localized labels and chart content.
 * @returns A labelled section with a stable chart identifier.
 */
export function AdoChartCard({ chart, title, description, scope, children, wide = false }: {
  chart: string; title: string; description: string; scope?: string; children: ReactNode; wide?: boolean
}) {
  const id = useId()
  return <section className={`${styles.adoChartCard} ${wide ? styles.adoChartWide : ''}`}
    data-ado-chart={chart} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
    <header className={styles.adoChartHeader}><h2 id={`${id}-title`}>{title}</h2>
      {scope && <span className={styles.adoChartScope}>{scope}</span>}
    </header>
    <p id={`${id}-description`} className={styles.adoChartDescription}>{description}</p>
    {children}
  </section>
}

/** Complete accessible chart data remains available without hover interaction.
 * @param props Localized table title, headers and full rows.
 * @returns A disclosure containing an overflow-contained semantic table.
 */
export function AdoDataTable({ title, headings, rows, t }: {
  title: string; headings: string[]; rows: { key: string; cells: ReactNode[] }[]; t: DashboardText
}) {
  return <details className={styles.adoDataDisclosure}>
    <summary>{t('ado.analytics.data')} · {title}</summary>
    <div className={styles.adoDataScroll} tabIndex={0} role="region" aria-label={title}>
      <table><caption>{title}</caption>
        <thead><tr>{headings.map((heading, index) => <th scope="col" key={index}>{heading}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}>{row.cells.map((cell, index) => index === 0
          ? <th scope="row" key={index}>{cell}</th> : <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>
      {rows.length === 0 && <p className={styles.adoChartEmpty}>{t('ado.analytics.empty')}</p>}
    </div>
  </details>
}

/** The same category palette labels current bars and revision-history areas.
 * @param props Translator and optional not-yet-created history series.
 * @returns A text-labelled, noninteractive legend.
 */
export function AdoLegend({ t, history = false }: { t: DashboardText; history?: boolean }) {
  return <ul className={styles.adoLegend}>{categories.map(category => <li key={category}>
    <span className={styles.adoSwatch} data-category={category} aria-hidden="true" />{t(`category.${category}`)}
  </li>)}{history && <li><span className={styles.adoSwatch} data-category="notCreated" aria-hidden="true" />
    {t('ado.history.notCreated')}</li>}</ul>
}

function groupTable(groups: readonly AnalyticsGroup[], label: (group: AnalyticsGroup) => string, t: DashboardText) {
  return groups.map(group => ({
    key: group.key,
    cells: [label(group), number(group.count, t), group.itemIds.join(', ') || t('value.unavailable')],
  }))
}

function groupHeadings(t: DashboardText) {
  return [t('ado.analytics.group'), t('ado.analytics.count'), t('ado.analytics.itemIds')]
}

function unfinishedScope(report: AdoAnalyticsReport, t: DashboardText) {
  return t('ado.analytics.unfinishedScope', { count: number(report.totals.remaining, t) })
}

function baseScope(report: AdoAnalyticsReport, t: DashboardText) {
  return t('ado.analytics.scope', { type: report.type, count: number(report.baseItemIds.length, t) })
}

function CountBars({ groups, max, label, active, choose, numbered = false, tone = 'neutral', t }: {
  groups: readonly AnalyticsGroup[]; max: number; label: (group: AnalyticsGroup) => string
  active: (key: string) => boolean; choose: (key: string) => void
  numbered?: boolean; tone?: 'neutral' | 'risk'; t: DashboardText
}) {
  return <ol className={styles.adoCountBars} data-numbered={numbered || undefined}>{groups.map((group, index) => {
    const style: ChartStyle = { '--dashboard-size': `${max > 0 ? group.count / max * 100 : 0}%` }
    return <li key={group.key}><button type="button" className={styles.adoCountButton}
      aria-pressed={active(group.key)} onClick={() => { choose(group.key) }}>
      {numbered && <span className={styles.adoStepNumber} aria-hidden="true">{index + 1}</span>}
      <span className={styles.adoCountBody}>
        <span className={styles.adoCountLabel}>{label(group)}<strong>{number(group.count, t)}</strong></span>
        <span className={styles.adoBarTrack} aria-hidden="true"><span style={style} data-tone={tone} /></span>
      </span>
    </button></li>
  })}</ol>
}

/** Delivery hero with excluded states kept outside its completion denominator.
 * @param props Shared report and native table selection actions.
 * @returns Current completion, workflow stages, and exact category data.
 */
export function AdoDelivery({ report, filters, onFilter, t }: ReportProps) {
  const totals = report.totals
  const progressStyle: ChartStyle = { '--dashboard-ring': `${totals.percent ?? 0}%` }
  const choose = (key: string) => { onFilter(adoDrillFilter(filters, { chart: 'category', key })) }
  return <AdoChartCard chart="delivery" title={t('ado.delivery.title')} description={t('ado.delivery.help')}
    scope={baseScope(report, t)} wide>
    <div className={styles.adoDeliveryHero}>
      <div className={styles.adoCompletion}>
        <div className={styles.adoCompletionRing} style={progressStyle} aria-hidden="true"
          data-empty={totals.percent === null || undefined}><span>
          <strong>{totals.percent === null ? t('value.unavailable') : t('unit.percent', { count: number(totals.percent, t) })}</strong>
          <span>{t('ado.completed')}</span>
        </span></div>
        <div className={styles.adoCompletionText}>
          <strong>{t('ado.delivery.ratio', { completed: number(totals.completed, t), eligible: number(totals.eligible, t) })}</strong>
          <span>{t('ado.delivery.remaining', { count: number(totals.remaining, t) })}</span>
          {totals.percent === null && <p className={styles.adoChartEmpty}>{t('ado.analytics.noEligible')}</p>}
        </div>
      </div>
      <div className={styles.adoStagePanel}>
        <h3>{t('ado.delivery.stages')}</h3>
        <div className={styles.adoStageTrack} aria-hidden="true">{report.delivery.filter(group =>
          group.key !== 'Unknown' && group.key !== 'Removed').map(group => <span key={group.key}
          data-category={group.key} style={{ '--dashboard-size': `${totals.eligible ? group.count / totals.eligible * 100 : 0}%` } as ChartStyle} />)}</div>
        <div className={styles.adoStageGrid}>{report.delivery.map(group => <button key={group.key} type="button"
          data-category={group.key} aria-pressed={filters.drill?.chart === 'category' && filters.drill.key === group.key}
          onClick={() => { choose(group.key) }}>
          <span><span className={styles.adoSwatch} data-category={group.key} aria-hidden="true" />{t(`category.${group.key}`)}</span>
          <strong>{number(group.count, t)}</strong>
        </button>)}</div>
        <p className={styles.adoChartFootnote}>{t('ado.delivery.excluded', {
          unknown: number(totals.unknown, t), removed: number(totals.removed, t),
        })}</p>
      </div>
    </div>
    <AdoDataTable title={t('ado.delivery.table')} headings={groupHeadings(t)}
      rows={groupTable(report.delivery, group => t(`category.${group.key as StateCategory}`), t)} t={t} />
  </AdoChartCard>
}

function Closure({ report, filters, onFilter, t }: ReportProps) {
  const label = (group: AnalyticsGroup) => t(`ado.closure.${report.closure.find(entry => entry.key === group.key)!.key}`)
  return <AdoChartCard chart="closure" title={t('ado.closure.title')} description={t('ado.closure.help')}
    scope={unfinishedScope(report, t)}>
    <CountBars groups={report.closure} max={report.totals.remaining} label={label}
      active={key => filters.drill?.chart === 'closure' && filters.drill.key === key}
      choose={key => { onFilter(adoDrillFilter(filters, { chart: 'closure', key })) }} numbered t={t} />
    {report.totals.remaining === 0 && <p className={styles.adoChartEmpty}>{t('ado.closure.empty')}</p>}
    <AdoDataTable title={t('ado.closure.title')} headings={groupHeadings(t)}
      rows={groupTable(report.closure, label, t)} t={t} />
  </AdoChartCard>
}

function Risk({ report, filters, onFilter, t }: ReportProps) {
  const label = (group: AnalyticsGroup) => t(`risk.${report.risks.find(entry => entry.key === group.key)!.key}`)
  return <AdoChartCard chart="risk" title={t('ado.risk.title')} description={t('ado.risk.help')}
    scope={unfinishedScope(report, t)}>
    <p className={styles.adoRiskUnion}><strong>{number(report.totals.flagged, t)}</strong>
      <span>{t('ado.risk.union', { count: number(report.totals.flagged, t) })}</span></p>
    <CountBars groups={report.risks} max={report.totals.remaining} label={label} tone="risk"
      active={key => filters.risk === key}
      choose={key => { const risk = report.risks.find(group => group.key === key)!.key; onFilter({ risk: filters.risk === risk ? '' : risk }) }}
      t={t} />
    {report.totals.flagged === 0 && <p className={styles.adoChartEmpty}>{t('ado.risk.none')}</p>}
    <AdoDataTable title={t('ado.risk.title')} headings={groupHeadings(t)} rows={groupTable(report.risks, label, t)} t={t} />
  </AdoChartCard>
}

function Age({ report, filters, onFilter, t }: ReportProps) {
  const [mode, setMode] = useState<'age' | 'stateAge'>(() => filters.drill?.chart === 'stateAge' ? 'stateAge' : 'age')
  const groups = report[mode]
  const label = (group: AnalyticsGroup) => ageLabel(groups.find(entry => entry.key === group.key)!, t)
  return <AdoChartCard chart="age" title={t('ado.age.title')}
    description={t(mode === 'age' ? 'ado.age.workHelp' : 'ado.age.stateHelp')} scope={unfinishedScope(report, t)}>
    <div className={styles.adoModeToggle} role="group" aria-label={t('ado.age.mode')}>
      {(['age', 'stateAge'] as const).map(value => <button type="button" key={value}
        aria-pressed={mode === value} onClick={() => { setMode(value) }}>
        {t(value === 'age' ? 'ado.age.work' : 'ado.age.state')}</button>)}
    </div>
    <CountBars groups={groups} max={report.totals.remaining} label={label}
      active={key => filters.drill?.chart === mode && filters.drill.key === key}
      choose={key => { onFilter(adoDrillFilter(filters, { chart: mode, key })) }} t={t} />
    {report.totals.remaining === 0 && <p className={styles.adoChartEmpty}>{t('ado.closure.empty')}</p>}
    <AdoDataTable title={t('ado.age.work')} headings={groupHeadings(t)}
      rows={groupTable(report.age, group => ageLabel(report.age.find(entry => entry.key === group.key)!, t), t)} t={t} />
    <AdoDataTable title={t('ado.age.state')} headings={groupHeadings(t)}
      rows={groupTable(report.stateAge, group => ageLabel(report.stateAge.find(entry => entry.key === group.key)!, t), t)} t={t} />
  </AdoChartCard>
}

function Dependencies({ report, snapshot, filters, onFilter, onSelect, t }: ReportProps & {
  snapshot: AdoSnapshot; onSelect: (id: number) => void
}) {
  const label = (group: AnalyticsGroup) => t(`ado.dependency.${report.dependencies.groups.find(entry => entry.key === group.key)!.key}`)
  const items = new Map(snapshot.items.map(item => [item.id, item]))
  const itemCell = (id: number | null) => {
    if (id === null) return t('unavailable')
    const item = items.get(id)
    return item ? <div className={styles.adoDependencyItem}>
      <SourceLink url={item.url} kind="workItem" t={t}>{id} · {item.title}</SourceLink>
      {report.matchingItemIds.includes(id) && <button type="button" onClick={() => { onSelect(id) }}
        aria-label={t('table.openDetails', { id })}>{t('table.details')}</button>}
    </div> : String(id)
  }
  return <AdoChartCard chart="dependency" title={t('ado.dependency.title')} description={t('ado.dependency.help')}
    scope={unfinishedScope(report, t)}>
    <CountBars groups={report.dependencies.groups} max={report.totals.remaining} label={label}
      active={key => filters.drill?.chart === 'dependency' && filters.drill.key === key}
      choose={key => { onFilter(adoDrillFilter(filters, { chart: 'dependency', key })) }} t={t} />
    {report.totals.remaining === 0 && <p className={styles.adoChartEmpty}>{t('ado.closure.empty')}</p>}
    <AdoDataTable title={t('ado.dependency.title')} headings={groupHeadings(t)}
      rows={groupTable(report.dependencies.groups, label, t)} t={t} />
    <AdoDataTable title={t('ado.dependency.links')}
      headings={[t('ado.dependency.item'), t('ado.dependency.predecessor'), t('ado.dependency.status')]}
      rows={report.dependencies.links.map((link, index) => ({
        key: `${link.itemId}-${link.predecessorId}-${index}`,
        cells: [itemCell(link.itemId), itemCell(link.predecessorId), t(`ado.dependency.status.${link.status}`)],
      }))} t={t} />
    {report.dependencies.links.length === 0 && <p className={styles.adoChartFootnote}>{t('ado.dependency.noLinks')}</p>}
  </AdoChartCard>
}

/** Intervention charts retain their base-filter population while selecting rows.
 * @param props Shared report, snapshot item references, and table actions.
 * @returns Closure, flags, age, and predecessor panels in a two-column grid.
 */
export function AdoInterventions(props: ReportProps & { snapshot: AdoSnapshot; onSelect: (id: number) => void }) {
  return <div className={styles.adoChartGrid}>
    <Closure {...props} /><Risk {...props} /><Age {...props} /><Dependencies {...props} />
  </div>
}

function OwnedBars({ groups, kind, filters, onFilter, t }: ChartActions & {
  groups: OwnershipGroup[]; kind: 'owner' | 'area'
}) {
  const max = Math.max(1, ...groups.map(group => group.itemIds.length))
  return <div className={styles.adoGroupScroll} tabIndex={0} role="region" aria-label={t(kind === 'owner' ? 'ado.owner.title' : 'ado.area.title')}>
    <ul className={styles.adoOwnedBars}>{groups.map(group => {
      const active = kind === 'owner' ? filters.person === group.key : filters.drill?.chart === 'area' && filters.drill.key === group.key
      return <li key={group.key}><button type="button" aria-pressed={active} className={styles.adoOwnedButton}
        onClick={() => { onFilter(kind === 'owner' ? { person: active ? '' : group.key }
          : adoDrillFilter(filters, { chart: 'area', key: group.key })) }}>
        <span className={styles.adoOwnedHeading}><strong>{group.label || t(kind === 'owner' ? 'filter.unassigned' : 'ado.area.unknown')}</strong>
          <span>{t('unit.items', { count: number(group.itemIds.length, t) })}</span></span>
        <span className={styles.adoStackBar} aria-hidden="true">{categories.map(key => <span key={key}
          data-category={key} style={{ '--dashboard-size': `${group.counts[key] / max * 100}%` } as ChartStyle} />)}</span>
        <span className={styles.adoOwnedMeta}>
          <span>{t('ado.owner.outcomes', { completed: number(group.completed, t), remaining: number(group.remaining, t) })}</span>
          <span>{t('ado.owner.risks', { count: number(group.risks, t) })}</span>
          {(group.counts.Unknown + group.counts.Removed) > 0 && <span>{t('ado.owner.excluded', { count: number(group.counts.Unknown + group.counts.Removed, t) })}</span>}
        </span>
      </button></li>
    })}</ul>
    {groups.length === 0 && <p className={styles.adoChartEmpty}>{t('ado.analytics.empty')}</p>}
  </div>
}

function OwnedTable({ groups, title, t }: { groups: OwnershipGroup[]; title: string; t: DashboardText }) {
  return <AdoDataTable title={title}
    headings={[t('ado.analytics.group'), ...categories.map(key => t(`category.${key}`)), t('ado.risks'), t('ado.analytics.itemIds')]}
    rows={groups.map(group => ({
      key: group.key,
      cells: [group.label || t('filter.unassigned'), ...categories.map(key => number(group.counts[key], t)),
        number(group.risks, t), group.itemIds.join(', ')],
    }))} t={t} />
}

/** Area progress follows base filters; ownership intentionally retains the entire selected type.
 * @param props Shared aggregate groups and native table filter actions.
 * @returns Category-stacked area and alphabetically ordered current-ownership charts.
 */
export function AdoOwnership({ report, filters, onFilter, t }: ReportProps) {
  return <div className={styles.adoChartGrid}>
    <AdoChartCard chart="area" title={t('ado.area.title')} description={t('ado.area.help')} scope={baseScope(report, t)}>
      <AdoLegend t={t} /><OwnedBars groups={report.areas} kind="area" filters={filters} onFilter={onFilter} t={t} />
      <OwnedTable groups={report.areas} title={t('ado.area.title')} t={t} />
    </AdoChartCard>
    <AdoChartCard chart="owner" title={t('ado.owner.title')} description={t('ado.owner.help')}
      scope={t('ado.analytics.typeScope', { type: report.type, count: number(report.typeItemIds.length, t) })}>
      <AdoLegend t={t} /><OwnedBars groups={report.owners} kind="owner" filters={filters} onFilter={onFilter} t={t} />
      <p className={styles.adoChartFootnote}>{t('ado.owner.legend')}</p>
      <OwnedTable groups={report.owners} title={t('ado.owner.title')} t={t} />
    </AdoChartCard>
  </div>
}

/** Human-readable active drill labels use the report's keys and configured age bounds.
 * @param report Current shared report.
 * @param drill Selected chart group.
 * @param t Dashboard translator.
 * @returns Localized active selection description.
 */
export function adoDrillLabel(report: AdoAnalyticsReport, drill: AdoDrill, t: DashboardText): string {
  let chart: string
  let label: string
  switch (drill.chart) {
    case 'category':
      chart = t('ado.delivery.title')
      label = t(`category.${report.delivery.find(group => group.key === drill.key)!.key}`)
      break
    case 'closure':
      chart = t('ado.closure.title')
      label = t(`ado.closure.${report.closure.find(group => group.key === drill.key)!.key}`)
      break
    case 'dependency':
      chart = t('ado.dependency.title')
      label = t(`ado.dependency.${report.dependencies.groups.find(group => group.key === drill.key)!.key}`)
      break
    case 'area':
      chart = t('ado.area.title')
      label = report.areas.find(group => group.key === drill.key)?.label || drill.key
      break
    case 'age': case 'stateAge': {
      chart = t(drill.chart === 'age' ? 'ado.age.work' : 'ado.age.state')
      const group = report[drill.chart].find(entry => entry.key === drill.key) ?? adoAgeInterval(drill.key)
      label = group ? ageLabel(group, t) : drill.key
      break
    }
  }
  return t('ado.analytics.selected', { chart, label })
}
