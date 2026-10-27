/** Read-only ADO source form, single-type metrics, chart filters, table, and item details. */
import { useEffect, useId, useRef, useState } from 'react'
import type { PropsStore } from '@deepseek-ai/dsh-client-store'
import type { AdoItem, AdoSnapshot, AdoSource } from '../shared/types.ts'
import type { createDashboardStore, Preferences } from './stores.ts'
import type { DashboardKey, DashboardText } from './locale.ts'
import { date, estimate, number } from './format.ts'
import {
  baseFilters, filterItems, groupCounts, pageItems, selectedType, summarize,
  type Filters, type SortKey,
} from '../shared/selection.ts'
import { buildAdoAnalytics } from '../shared/ado-analytics.ts'
import { AdoDataTable, AdoDelivery, AdoInterventions, AdoOwnership, adoDrillLabel } from './AdoCharts.tsx'
import { AdoHistory, type AdoHistoryState } from './AdoHistory.tsx'
import { Card, Metric, SourceLink, Warnings, type ChartStyle } from './presentation.tsx'
import { parseSource } from './source.ts'
import styles from './dsh-dashboard.module.css'

type Actions = PropsStore<ReturnType<typeof createDashboardStore>>['actions']

export function SourceForm({ source, onSubmit, t }: {
  source: AdoSource | null; onSubmit: (source: AdoSource) => void; t: DashboardText
}) {
  const [draft, setDraft] = useState<AdoSource>(() => source ?? {
    input: '', orgName: '', project: '', mode: 'iteration', includeChildren: false,
  })
  const [invalid, setInvalid] = useState(false)
  const id = useId()
  const fields = [
    ['input', 'ado.input'], ['orgName', 'ado.org'], ['project', 'ado.project'],
    ['team', 'ado.team'], ['path', 'ado.path'],
  ] as const
  return <Card title={t('ado.source')}>
    <p id={`${id}-help`} className={styles.muted}>{t('ado.sourceHelp')}</p>
    <form className={styles.sourceForm} aria-describedby={`${id}-help`} onSubmit={event => {
      event.preventDefault()
      const parsed = parseSource(draft)
      setInvalid(parsed === null)
      if (parsed !== null) onSubmit(parsed)
    }}>
      {fields.map(([field, label]) => <label key={field} className={field === 'input' ? styles.wide : undefined}>
        <span>{t(label)}</span>
        <input value={draft[field] ?? ''} maxLength={field === 'orgName' ? 128 : field === 'project' || field === 'team' ? 256 : 512}
          required={field === 'input'} autoComplete="off" spellCheck={false}
          placeholder={field === 'input' ? t('ado.inputPlaceholder') : undefined}
          onChange={event => {
            const value = event.currentTarget.value
            setDraft(previous => {
              if (field === 'input') {
                const next = { ...previous, input: value }
                delete next.path
                return next
              }
              if ((field === 'path' || field === 'team') && value === '') {
                const next = { ...previous }
                delete next[field]
                return next
              }
              return { ...previous, [field]: value }
            })
          }} />
      </label>)}
      <label><span>{t('ado.mode')}</span><select value={draft.mode} onChange={event => {
        const mode = event.currentTarget.value
        if (mode === 'iteration' || mode === 'area' || mode === 'query') setDraft(previous => ({ ...previous, mode }))
      }}>
        <option value="iteration">{t('ado.iteration')}</option>
        <option value="area">{t('ado.area')}</option>
        <option value="query">{t('ado.query')}</option>
      </select></label>
      <label className={styles.checkbox}><input type="checkbox" checked={draft.includeChildren ?? false}
        onChange={event => { const includeChildren = event.currentTarget.checked; setDraft(previous => ({ ...previous, includeChildren })) }} />
        <span>{t('ado.children')}</span>
      </label>
      <button type="submit" className={styles.primary}>{t('ado.load')}</button>
      {invalid && <p className={styles.warning} role="alert">{t('ado.invalid')}</p>}
    </form>
  </Card>
}

function FilterSelect({ label, value, options, onChange, all }: {
  label: string; value: string; options: { value: string; label: string }[]
  onChange: (value: string) => void; all?: string
}) {
  return <label><span>{label}</span><select value={value} onChange={event => { onChange(event.currentTarget.value) }}>
    {all !== undefined && <option value="">{all}</option>}
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
}

function Chart({ title, groups, value, choose, t, description }: {
  title: string; groups: { key: string; label: string; count: number }[]
  value: string; choose: (value: string) => void; t: DashboardText; description?: string
}) {
  const max = Math.max(1, ...groups.map(group => group.count))
  return <Card title={title}><p className={styles.muted}>{description ?? t('ado.chartsHelp')}</p>
    <ul className={styles.chartList}>{groups.map(group => {
      const chartStyle: ChartStyle = { '--dashboard-size': `${group.count / max * 100}%` }
      return <li key={group.key}><button type="button" onClick={() => { choose(value === group.key ? '' : group.key) }}
        aria-pressed={value === group.key} className={styles.chartButton}>
        <span>{group.label || t('filter.unassigned')}</span><strong>{number(group.count, t)}</strong>
        <span className={styles.horizontalTrack} aria-hidden="true"><span style={chartStyle} /></span>
      </button></li>
    })}</ul>
    {description && <>
      {groups.length === 0 && <p className={styles.adoChartEmpty}>{t('ado.analytics.empty')}</p>}
      <AdoDataTable title={title} headings={[t('table.state'), t('ado.analytics.count')]}
        rows={groups.map(group => ({ key: group.key, cells: [group.label, number(group.count, t)] }))} t={t} />
    </>}
  </Card>
}

function ItemDetail({ item, onClose, zone, t }: {
  item: AdoItem; onClose: () => void; zone: string; t: DashboardText
}) {
  const heading = useId()
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    panel.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [item.id])
  return <aside ref={panel} tabIndex={-1} className={styles.detail} role="region" aria-labelledby={heading}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className={styles.summaryLine}><h2 id={heading}>{t('detail.title', { id: item.id })}</h2>
      <button type="button" onClick={onClose}>{t('detail.close')}</button></div>
    <h3>{item.title}</h3>
    <SourceLink url={item.url} t={t} kind="workItem">{t('source.open')}</SourceLink>
    <dl className={styles.detailFields}>
      <dt>{t('table.type')}</dt><dd>{item.type}</dd>
      <dt>{t('table.state')}</dt><dd>{item.state}</dd>
      <dt>{t('detail.category')}</dt><dd>{t(`category.${item.category}`)}</dd>
      <dt>{t('table.assignee')}</dt><dd>{item.assignee || t('filter.unassigned')}</dd>
      <dt>{t('detail.area')}</dt><dd>{item.areaPath}</dd>
      <dt>{t('detail.iteration')}</dt><dd>{item.iterationPath}</dd>
      <dt>{t('detail.tags')}</dt><dd>{item.tags.join(' · ') || t('unavailable')}</dd>
      <dt>{t('table.priority')}</dt><dd>{number(item.priority, t)}</dd>
      <dt>{t('table.changedAt')}</dt><dd>{item.changedAt ? date(item.changedAt, zone, t) : t('unavailable')}</dd>
      <dt>{t('detail.due')}</dt><dd>{item.dueDate ? date(item.dueDate, zone, t, 'date') : t('unavailable')}</dd>
      <dt>{t('detail.estimate')}</dt><dd>{item.estimate === undefined ? t('unavailable') : estimate(item.estimate, item.estimateField, t)}</dd>
    </dl>
    <div className={styles.badges}>{item.risks.length === 0 ? <p>{t('detail.noRisks')}</p>
      : item.risks.map(risk => <span key={risk} className={styles.warning}>{t(`risk.${risk}`)}</span>)}</div>
  </aside>
}

export function Ado({ snapshot, prefs, actions, zone, t, history, loadHistory }: {
  snapshot: AdoSnapshot; prefs: Preferences; actions: Actions; zone: string; t: DashboardText
  history?: AdoHistoryState; loadHistory?: () => void
}) {
  const type = selectedType(snapshot, prefs.filters.type)
  const filters: Filters = { ...prefs.filters, type }
  const types = [...new Set(snapshot.items.map(item => item.type))].sort()
  const typedItems = snapshot.items.filter(item => item.type === type)
  const base = filterItems(snapshot.items, baseFilters(filters), snapshot)
  const metrics = summarize(base)
  const report = buildAdoAnalytics(snapshot, filters)
  const rows = filterItems(snapshot.items, filters, snapshot)
  const pagination = pageItems(rows, prefs.sort, prefs.direction, prefs.page, prefs.pageSize)
  const selected = rows.find(item => item.id === prefs.selection)
  const columns: { key: SortKey; label: DashboardKey }[] = [
    { key: 'id', label: 'table.id' }, { key: 'title', label: 'table.titleColumn' },
    { key: 'type', label: 'table.type' }, { key: 'state', label: 'table.state' },
    { key: 'assignee', label: 'table.assignee' }, { key: 'priority', label: 'table.priority' },
    { key: 'changedAt', label: 'table.changedAt' },
  ]
  const metricCards = [
    { key: 'completed', value: metrics.completed, label: 'ado.completed' },
    { key: 'remaining', value: metrics.remaining, label: 'ado.remaining' },
    { key: 'risks', value: metrics.risks, label: 'ado.risks' },
  ] as const
  const typeControl = <FilterSelect label={t('filter.type')} value={type} options={types.map(value => ({ value, label: value }))}
    onChange={value => { actions.clear(); actions.filter({ type: value }) }} />
  const personControl = <FilterSelect label={t('filter.person')} value={filters.person} all={t('filter.all')}
    options={groupCounts(typedItems, 'person').map(group => ({ value: group.key, label: group.label || t('filter.unassigned') }))}
    onChange={person => { actions.filter({ person }) }} />
  const stateControl = <FilterSelect label={t('filter.state')} value={filters.state} all={t('filter.all')}
    options={groupCounts(typedItems, 'state').map(group => ({ value: group.key, label: group.label }))}
    onChange={state => { actions.filter({ state }) }} />
  const tagControl = <FilterSelect label={t('filter.tag')} value={filters.tag} all={t('filter.all')}
    options={[...new Set(typedItems.flatMap(item => item.tags))].sort().map(value => ({ value, label: value }))}
    onChange={tag => { actions.filter({ tag }) }} />
  const searchControl = <label className={report ? styles.adoFilterSearch : styles.wide}><span>{t('filter.text')}</span>
    <input type="search" value={filters.text} placeholder={t('filter.textPlaceholder')}
      onChange={event => { actions.filter({ text: event.currentTarget.value }) }} /></label>
  const resetControl = <button type="button" onClick={() => { actions.clear() }}>{t('filter.reset')}</button>
  const riskControls = <div className={styles.badges} role="group" aria-label={t('ado.risks')}>
    {(['unassigned', 'blocked', 'stale', 'overdue'] as const).map(risk =>
      <button key={risk} type="button" aria-pressed={filters.risk === risk}
        onClick={() => { actions.filter({ risk: filters.risk === risk ? '' : risk }) }}>{t(`risk.${risk}`)}</button>)}
  </div>
  const filterControls = report ? <section className={styles.adoFilterToolbar} aria-label={t('ado.filters')}>
    <div className={styles.adoFilterMain}>
      {typeControl}{personControl}{stateControl}{searchControl}
      <details className={styles.adoFilterAdvanced} onKeyDown={event => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false
          event.currentTarget.querySelector('summary')?.focus()
          event.stopPropagation()
        }
      }}>
        <summary>{t('ado.filters.more')}</summary>
        <div className={styles.adoAdvancedBody}>{tagControl}{riskControls}</div>
      </details>
      {resetControl}
    </div>
    {(filters.tag || filters.risk || filters.metric || filters.drill) && <div className={styles.adoFilterActive}>
      {filters.tag && <button type="button" onClick={() => { actions.filter({ tag: '' }) }}
        aria-label={t('ado.filters.clear', { label: `${t('filter.tag')}: ${filters.tag}` })}>
        {t('filter.tag')}: {filters.tag}<span aria-hidden="true">×</span>
      </button>}
      {filters.risk && <button type="button" onClick={() => { actions.filter({ risk: '' }) }}
        aria-label={t('ado.filters.clear', { label: t(`risk.${filters.risk}`) })}>
        {t(`risk.${filters.risk}`)}<span aria-hidden="true">×</span>
      </button>}
      {filters.metric && <button type="button" onClick={() => { actions.filter({ metric: '' }) }}
        aria-label={t('ado.filters.clear', { label: t(`ado.${filters.metric}`) })}>
        {t('filter.active', { label: t(`ado.${filters.metric}`) })}<span aria-hidden="true">×</span>
      </button>}
      {filters.drill && <p className={styles.adoActiveDrill}>
        <span>{adoDrillLabel(report, filters.drill, t)}</span>
        <button type="button" onClick={() => { actions.filter({ drill: undefined }) }}>{t('ado.analytics.clearDrill')}</button>
      </p>}
    </div>}
  </section> : <Card title={t('ado.filters')}>
    <div className={styles.filters}>{typeControl}{personControl}{stateControl}{tagControl}{searchControl}{resetControl}</div>
    {riskControls}
    {filters.metric && <p>{t('filter.active', { label: t(`ado.${filters.metric}`) })}</p>}
  </Card>
  const estimates = <Card title={t('ado.estimates')}>
    <p className={styles.muted}>{t('ado.estimatesHelp')}</p>
    <ul className={styles.estimateList}>{metrics.estimates.map(entry => <li key={entry.field}>
      <strong>{estimate(entry.total, entry.field, t)}</strong>
      <span>{entry.field}</span><small>{t('unit.coverage', { count: entry.count })}</small>
    </li>)}</ul>
    {metrics.estimates.length === 0 && <p>{t('unavailable')}</p>}
    <p>{t('ado.remainingWork', { value: metrics.remainingWork === null ? t('unavailable')
      : t('unit.work', { count: number(metrics.remainingWork, t) }) })}
      {metrics.remainingWork !== null && <small> · {t('unit.coverage', { count: metrics.remainingWorkCount })}</small>}
    </p>
  </Card>
  return <div className={`${styles.content} ${styles.adoContent}`}>
    <div className={styles.summaryLine}><h2>{snapshot.iteration?.name ?? snapshot.source.path ?? snapshot.source.input}</h2>
      <SourceLink url={snapshot.sourceUrl} t={t} kind="ado">{t('source.open')}</SourceLink>
      <span className={styles.muted}>{t('updated', { time: date(snapshot.generatedAt, zone, t) })}</span></div>
    {/* Iteration bounds are UTC calendar dates, not viewer-local timestamps. */}
    {(snapshot.iteration?.start || snapshot.iteration?.finish) && <p className={styles.muted}>
      {snapshot.iteration.start && t('ado.starts', { date: date(snapshot.iteration.start, 'UTC', t, 'date') })}
      {snapshot.iteration.start && snapshot.iteration.finish && ' · '}
      {snapshot.iteration.finish && t('ado.finishes', { date: date(snapshot.iteration.finish, 'UTC', t, 'date') })}
    </p>}
    {!snapshot.complete && <p className={styles.warning}>{t('ado.partial')}</p>}
    <Warnings warnings={snapshot.warnings} t={t} />
    <p>{type ? t('ado.singleType', { type }) : t('ado.noType')}</p>
    {report && <><p className={styles.adoChartDescription}>{t('ado.analytics.scopeHelp')}</p>{filterControls}</>}
    <div className={styles.adoKpis}>{metricCards.map(card => <Metric key={card.key} label={t(card.label)}
      value={number(card.value, t)} active={filters.metric === card.key}
      onClick={() => { actions.filter({ metric: filters.metric === card.key ? '' : card.key }) }} />)}
      <Metric label={t('ado.people')} value={number(metrics.people, t)} />
    </div>
    <p className={styles.exclusions}>{t('ado.exclusions', { unknown: metrics.unknown, removed: metrics.removed })}</p>
    {report ? <>
      <AdoDelivery report={report} filters={filters} onFilter={actions.filter} t={t} />
      <AdoInterventions report={report} filters={filters} onFilter={actions.filter} onSelect={actions.select} snapshot={snapshot} t={t} />
      <AdoHistory report={report} history={history} loadHistory={loadHistory} t={t} />
      <AdoOwnership report={report} filters={filters} onFilter={actions.filter} t={t} />
      <div className={styles.adoChartGrid}>{estimates}
        <div className={styles.adoActualStates}>
          <Chart title={t('ado.states')} groups={groupCounts(typedItems, 'state')} value={filters.state}
            description={t('ado.state.help')} choose={state => { actions.filter({ state }) }} t={t} />
        </div>
      </div>
    </> : <>
      {estimates}
      <div className={styles.grid2}>
        <Chart title={t('ado.states')} groups={groupCounts(typedItems, 'state')} value={filters.state}
          choose={state => { actions.filter({ state }) }} t={t} />
        <Chart title={t('ado.assignees')} groups={groupCounts(typedItems, 'person')} value={filters.person}
          choose={person => { actions.filter({ person }) }} t={t} />
      </div>
      {filterControls}
    </>}
    <section className={styles.card} aria-label={t('table.title')}>
      <div className={styles.summaryLine}><h2>{t('table.title')}</h2><span>{t('table.count', { count: pagination.total })}</span></div>
      <div className={styles.tableScroll}>
        <table>
          <caption className={styles.srOnly}>{t('table.title')}</caption>
          <thead><tr>{columns.map(column => <th scope="col" key={column.key}
            aria-sort={prefs.sort === column.key ? prefs.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
            <button type="button" onClick={() => { actions.sort(column.key) }}
              aria-label={t('table.sort', { column: t(column.label) })}>
              {t(column.label)} {prefs.sort === column.key && <span aria-hidden="true">{prefs.direction === 'asc' ? '↑' : '↓'}</span>}
            </button>
          </th>)}<th scope="col">{t('table.details')}</th></tr></thead>
          <tbody>{pagination.items.map(item => <tr key={item.id} data-selected={item.id === prefs.selection}>
            <td><SourceLink url={item.url} t={t} kind="workItem">{item.id}</SourceLink></td>
            <td className={styles.titleCell}><SourceLink url={item.url} t={t} kind="workItem">{item.title}</SourceLink>
              {item.risks.length > 0 && <div className={styles.muted}>{item.risks.map(risk => t(`risk.${risk}`)).join(' · ')}</div>}</td>
            <td>{item.type}</td><td>{item.state}</td><td>{item.assignee || t('filter.unassigned')}</td>
            <td>{number(item.priority, t)}</td>
            <td>{item.changedAt ? date(item.changedAt, zone, t, 'date') : t('unavailable')}</td>
            <td><button type="button" aria-label={t('table.openDetails', { id: item.id })}
              aria-expanded={prefs.selection === item.id}
              onClick={() => { actions.select(prefs.selection === item.id ? null : item.id) }}>{t('table.details')}</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {pagination.total === 0 && <p>{t('table.empty')}</p>}
      <div className={styles.pagination}>
        <button type="button" disabled={pagination.page === 0} onClick={() => { actions.page(pagination.page - 1) }}>{t('page.previous')}</button>
        <span aria-live="polite">{t('page.label', { page: pagination.page + 1, pages: pagination.pages })}</span>
        <button type="button" disabled={pagination.page + 1 === pagination.pages}
          onClick={() => { actions.page(pagination.page + 1) }}>{t('page.next')}</button>
        <label><span>{t('page.size')}</span><select value={prefs.pageSize}
          onChange={event => { actions.pageSize(Number(event.currentTarget.value)) }}>
          {[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}
        </select></label>
      </div>
    </section>
    {selected && <ItemDetail item={selected} onClose={() => { actions.select(null) }} zone={zone} t={t} />}
  </div>
}
