/** Personal cards preserve source attribution; interpretations come only from the captured snapshot. */
import { IconClockOutlineRegular, IconDataOutlineRegular, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CalendarItem, DashboardSection, PersonalSnapshot, SectionId } from '../shared/types.ts'
import type { AttentionCategory, AttentionFilter, PersonalInsights } from '../shared/insights.ts'
import { displayedAttentionFilter, selectAttention } from '../shared/personal-selection.ts'
import type { DashboardText } from './locale.ts'
import { date, number, referenceDate } from './format.ts'
import { Attribution, Badge, Card, Evidence, Metric, SourceLink, Warnings, sourceName, type ChartStyle } from './presentation.tsx'
import styles from './dsh-dashboard.module.css'
import { AttentionFeedback, AttentionReview, AttentionSummary, ItemAttentionControls, type AttentionActions } from './AttentionControls.tsx'

type PersonalProps = {
  snapshot: PersonalSnapshot
  t: DashboardText
  attentionFilter: AttentionFilter
  onAttentionFilter: (value: AttentionFilter) => void
  policy?: string
  adjustments?: AttentionActions
}

function responseLabel(value: string, t: DashboardText): string {
  switch (value) {
    case 'accepted': case 'tentativelyAccepted': case 'declined': case 'organizer': case 'notResponded': case 'none':
      return t(`response.${value}`)
    default: return value || t('unknown')
  }
}

function findSection(snapshot: PersonalSnapshot, id: SectionId): DashboardSection {
  return snapshot.sections.find(section => section.id === id) ?? { id, source: 'unavailable', items: [] }
}

function ItemSection({ section, snapshot, t }: {
  section: DashboardSection; snapshot: PersonalSnapshot; t: DashboardText
}) {
  const zone = snapshot.timeZone
  const read = section.id === 'urgent' ? 'attention' : section.id
  return <Card title={t(`section.${section.id}`)} meta={<>
    {t('unit.items', { count: number(section.source === 'unavailable' ? null : section.items.length, t) })} <Badge source={section.source} t={t} />
  </>} className={section.id === 'projects' ? styles.projects : undefined}>
    {section.note && <p className={styles.muted}>{section.note}</p>}
    {section.items.length === 0 && <p className={styles.muted}>{t(section.source === 'unavailable' ? 'unavailable' : 'empty')}</p>}
    <ul className={styles.items} data-section={section.id}>{section.items.map(item => <li key={item.id} data-severity={item.severity}>
      <SourceLink url={item.url} t={t} className={styles.itemLink}>
        {section.id === 'people' && <span className={styles.avatar} aria-hidden="true">
          {item.initials || <IconDataOutlineRegular size={14} />}
        </span>}
        {section.id === 'files' && <span className={styles.fileIcon} aria-hidden="true"><IconDataOutlineRegular size={14} /></span>}
        <span className={styles.itemBody}>
          <span className={styles.itemHeading}>
            <strong>{item.title}</strong>
            {item.severity && <span className={styles.badge} data-severity={item.severity}>{t(`severity.${item.severity}`)}</span>}
          </span>
          <span className={styles.itemDetail}>{item.detail}</span>
          <Attribution source={item.source}
            sourceDate={item.sourceDate ?? (item.source === 'reference' ? snapshot.referenceAsOf : undefined)} zone={zone} t={t} />
        </span>
      </SourceLink>
    </li>)}</ul>
    {section.id === 'oof' && snapshot.insights?.oofImpact && <div className={styles.inset}>
      <Evidence value={snapshot.insights.oofImpact} zone={zone} t={t} />
    </div>}
    {section.id === 'oof' && <p className={styles.oofCaveat}>{t('oof.caveat')}</p>}
    <Evidence value={snapshot.insights?.reads[read]} zone={zone} t={t} className={styles.readLine} />
  </Card>
}

function Agenda({ title, items, snapshot, t, advice = false }: {
  title: string; items: CalendarItem[]; snapshot: PersonalSnapshot; t: DashboardText; advice?: boolean
}) {
  const zone = snapshot.timeZone
  const calendar = snapshot.sources.find(source => source.id === 'calendar')
  const unavailable = calendar?.state === 'unavailable' || !calendar
  return <Card title={title} meta={<>
    {t('unit.items', { count: number(unavailable ? null : items.length, t) })} <Badge source={calendar?.state ?? 'unavailable'} t={t} />
  </>}>
    {items.length === 0 ? <p className={styles.muted}>{t(unavailable ? 'unavailable' : 'agenda.empty')}</p>
      : <ol className={styles.agendaItems}>{items.map(item => {
        const recommendation = advice ? snapshot.insights?.agendaAdvice.find(entry => entry.eventId === item.id) : undefined
        return <li key={item.id}>
          <SourceLink url={item.url} t={t} className={styles.agendaRow}>
            <span className={styles.agendaTime}>{item.allDay ? t('agenda.allDay')
              : <><time dateTime={item.start}>{date(item.start, zone, t, 'time')}</time>
                <span aria-hidden="true">–</span><time dateTime={item.end}>{date(item.end, zone, t, 'time')}</time></>}</span>
            <span className={styles.agendaRail} data-recommendation={recommendation?.recommendation} aria-hidden="true" />
            <span className={styles.agendaBody} data-recommendation={recommendation?.recommendation}>
              <span className={styles.itemHeading}><strong>{item.title}</strong>
                {recommendation && <span className={styles.badge}>{t(`agenda.${recommendation.recommendation}`)}</span>}
              </span>
              <span className={styles.itemDetail}>{t('agenda.organizer', { name: item.organizer })}</span>
              <span className={styles.badges}>
                <span className={styles.badge}>{responseLabel(item.response, t)}</span>
                {item.online && <span className={styles.badge}>{t('agenda.online')}</span>}
                {item.free && <span className={styles.badge}>{t('agenda.free')}</span>}
                {item.conflict && <span className={styles.badge} data-severity="watch">{t('agenda.conflict')}</span>}
                {item.optionalOverlap && <span className={styles.badge}>{t('agenda.optionalOverlap')}</span>}
              </span>
              {item.preview && <span className={styles.itemDetail}>{item.preview}</span>}
              {recommendation && <Evidence value={recommendation.reason} zone={zone} t={t} className={styles.agendaAdvice} />}
            </span>
          </SourceLink>
        </li>
      })}</ol>}
    {advice && <Evidence value={snapshot.insights?.reads.agenda} zone={zone} t={t} className={styles.readLine} />}
  </Card>
}

function attentionRows(snapshot: PersonalSnapshot) {
  const metadata = new Map(snapshot.insights?.attention.map(item => [item.itemId, item]))
  return selectAttention(snapshot, 'all').map(item => ({ item, meta: metadata.get(item.id) }))
}

function Attention({ snapshot, t, attentionFilter, onAttentionFilter, adjustments }: PersonalProps) {
  const section = findSection(snapshot, 'urgent')
  const all = attentionRows(snapshot)
  const unavailable = snapshot.insights?.attentionCounts == null
  const filter = displayedAttentionFilter(snapshot, attentionFilter)
  const selected = new Set(selectAttention(snapshot, filter).map(item => item.id))
  const rows = all.filter(({ item }) => selected.has(item.id))
  const counts: Record<AttentionFilter, number> = {
    all: all.length, pastDue: all.filter(row => row.meta?.category === 'pastDue').length,
    thisWeekend: all.filter(row => row.meta?.thisWeekend).length,
  }
  return <section className={`${styles.card} ${styles.attention}`}>
    <div className={styles.attentionHeader}>
      <h2>{t('section.urgent')}</h2>
      <span className={styles.cardMeta}><Badge source={section.source} t={t} /> {t('attention.order')}</span>
      <div className={styles.attentionFilters} role="group" aria-label={t('attention.filter')}>
        {(['all', 'pastDue', 'thisWeekend'] as const).map(option => <button type="button" key={option}
          aria-pressed={filter === option} disabled={option !== 'all' && unavailable}
          onClick={() => { onAttentionFilter(option) }}>
          {t(`attention.filter.${option}`)} {number(section.source === 'unavailable'
            || (option !== 'all' && unavailable) ? null : counts[option], t)}
        </button>)}
      </div>
    </div>
    {snapshot.attention && <AttentionSummary view={snapshot.attention} t={t} />}
    {snapshot.attention && adjustments && <AttentionFeedback actions={adjustments} t={t} />}
    {section.note && <p className={styles.attentionNote}>{section.note}</p>}
    {unavailable && <p className={styles.attentionNote} role="status">{t('attention.classificationsUnavailable')}</p>}
    {rows.length === 0 && <p className={styles.attentionNote}>{t(section.source === 'unavailable' ? 'unavailable' : 'attention.empty')}</p>}
    <ul className={styles.attentionItems}>{rows.map(({ item, meta }) => <li key={item.id}>
      <SourceLink url={item.url} t={t} className={styles.attentionRow}>
        <span className={styles.severityRail} data-tone={meta?.tone ?? 'neutral'} aria-hidden="true" />
        <span className={styles.itemBody}>
          <span className={styles.itemHeading}><strong>{item.title}</strong>
            {item.severity && <span className={styles.badge} data-severity={item.severity}>{t(`severity.${item.severity}`)}</span>}
          </span>
          <span className={styles.itemDetail}>{item.detail}</span>
        </span>
        <span className={styles.consequence} data-tone={meta?.tone ?? 'neutral'}>
          <span className={styles.consequenceCategory}>{t(`attention.${meta?.category ?? 'unclassified'}`)}</span>
          <Evidence value={meta?.consequence} zone={snapshot.timeZone} t={t} />
        </span>
        <Attribution source={item.source}
          sourceDate={item.sourceDate ?? (item.source === 'reference' ? snapshot.referenceAsOf : undefined)} zone={snapshot.timeZone} t={t} />
      </SourceLink>
      {adjustments && snapshot.attention?.items.filter(state => state.itemId === item.id).map(state =>
        <ItemAttentionControls key={state.key} item={state} actions={adjustments} zone={snapshot.timeZone} t={t} />)}
    </li>)}</ul>
    {snapshot.attention && adjustments && <AttentionReview view={snapshot.attention} actions={adjustments} zone={snapshot.timeZone} t={t} />}
  </section>
}

function Consequences({ snapshot, t }: { snapshot: PersonalSnapshot; t: DashboardText }) {
  const sourceCounts = snapshot.insights?.attentionCounts
  const unavailable = sourceCounts === null || sourceCounts === undefined
  const categories: AttentionCategory[] = ['pastDue', 'dueSoon', 'waiting', 'standing']
  if (sourceCounts && sourceCounts.unclassified > 0) categories.push('unclassified')
  const counts = sourceCounts ? categories.map(category => ({ category, count: sourceCounts[category] })) : []
  const max = Math.max(1, ...counts.map(row => row.count))
  const total = sourceCounts ? Object.values(sourceCounts).reduce((sum, count) => sum + count, 0) : null
  return <Card title={t(snapshot.attention ? 'adjustment.sourceGraph' : 'attention.graph')} meta={t('unit.items', { count: number(total, t) })}>
    {snapshot.attention && <p className={styles.muted}>{t('adjustment.sourceGraphHelp')}</p>}
    {unavailable ? <p className={styles.muted}>{t('unavailable')}</p> : <ul className={styles.consequenceBars}>{counts.map(({ category, count }) => {
      const chartStyle: ChartStyle = { '--dashboard-size': `${count / max * 100}%` }
      return <li key={category}>
        <span>{t(`attention.${category}`)}</span>
        <span className={styles.consequenceTrack} aria-hidden="true">
          <span data-category={category} style={chartStyle} />
        </span>
        <strong>{number(count, t)}</strong>
      </li>
    })}</ul>}
    <Evidence value={snapshot.insights?.reads.attention} zone={snapshot.timeZone} t={t} className={styles.readLine} />
  </Card>
}

function Week({ snapshot, t }: { snapshot: PersonalSnapshot; t: DashboardText }) {
  const max = Math.max(1, ...snapshot.weekLoad.map(day => day.meetings))
  const total = snapshot.weekLoad.reduce((sum, day) => sum + day.meetings, 0)
  return <Card title={t('week.title')} meta={snapshot.weekLoad.length === 0 ? t('unavailable') : t('week.total', { count: total })}>
    {snapshot.weekLoad.length === 0 ? <p className={styles.muted}>{t('unavailable')}</p>
      : <ul className={styles.weekBars}>{snapshot.weekLoad.map(day => {
        const label = date(day.date, snapshot.timeZone, t, 'date')
        const chartStyle: ChartStyle = { '--dashboard-size': `${Math.max(0, day.meetings / max * 100)}%` }
        const load = day.meetings >= 7 ? 'heavy' : day.meetings === 2 ? 'light' : 'normal'
        return <li key={day.date} aria-label={t('week.day', { date: label, meetings: day.meetings, minutes: day.minutes })} title={label}>
          <span className={styles.weekValue}>{number(day.meetings, t)}</span>
          <div className={styles.weekTrack} aria-hidden="true"><span className={styles.weekBar} data-load={load} style={chartStyle} /></div>
          <time dateTime={day.date}>{date(day.date, snapshot.timeZone, t, 'weekday')}</time>
          <span className={styles.srOnly}>{t('unit.minutes', { count: number(day.minutes, t) })}</span>
        </li>
      })}</ul>}
    {snapshot.insights?.protectedTime && <div className={styles.inset}>
      <span aria-hidden="true"><IconClockOutlineRegular size={13} /></span>
      <Evidence value={snapshot.insights.protectedTime} zone={snapshot.timeZone} t={t} />
    </div>}
    <Evidence value={snapshot.insights?.reads.weekLoad} zone={snapshot.timeZone} t={t} className={styles.readLine} />
  </Card>
}

function Allocation({ snapshot, t }: { snapshot: PersonalSnapshot; t: DashboardText }) {
  const colors = { customer: 'var(--s1)', training: 'var(--s2)', internal: 'var(--s3)', focus: 'var(--s4)', admin: 'var(--s5)' }
  const total = snapshot.allocation.reduce((sum, item) => sum + item.minutes, 0)
  return <Card title={t('allocation.title')} meta={snapshot.allocation.length === 0 ? t('unavailable') : t('unit.hours', { count: number(total / 60, t) })}>
    {snapshot.allocation.length === 0 ? <p className={styles.muted}>{t('unavailable')}</p> : <>
      <div className={styles.allocationBar} aria-hidden="true">{snapshot.allocation.map(item => {
        const style: ChartStyle = { '--dashboard-size': `${item.percent}%`, '--dashboard-color': colors[item.category] }
        return <span key={item.category} style={style} />
      })}</div>
      <ul className={styles.legend}>{snapshot.allocation.map(item => {
        const style: ChartStyle = { '--dashboard-color': colors[item.category] }
        return <li key={item.category}>
          <span className={styles.swatch} style={style} aria-hidden="true" />
          <span title={t(`allocation.${item.category}`)}>{t(`allocation.${item.category}`)}</span>
          <strong>{t('unit.percent', { count: number(item.percent, t) })}</strong>
          <span className={styles.srOnly}>{t('unit.minutes', { count: number(item.minutes, t) })}</span>
        </li>
      })}</ul>
    </>}
    <p className={styles.allocationCaption}>{t('allocation.caption')}</p>
    <Evidence value={snapshot.insights?.reads.allocation} zone={snapshot.timeZone} t={t} className={styles.readLine} />
  </Card>
}

export function Personal({ snapshot, t, attentionFilter, onAttentionFilter, policy, adjustments }: PersonalProps) {
  const section = (id: SectionId) => <ItemSection key={id} section={findSection(snapshot, id)} snapshot={snapshot} t={t} />
  const metrics = snapshot.metrics
  const stats: { key: keyof PersonalInsights['stats']; label: string; tone: 'critical' | 'warning' | 'accent' | 'healthy' }[] = [
    { key: 'overdueActions', label: t('metric.overdueActions'), tone: 'critical' },
    { key: 'unreadEmails', label: t('metric.emails'), tone: 'accent' },
    { key: 'meetingsNextDay', label: t('metric.meetings'), tone: 'warning' },
    { key: 'teamsUnread', label: t('metric.teams'), tone: 'accent' },
    { key: 'projects', label: t('metric.projects'), tone: 'accent' },
    { key: 'oof', label: t('metric.oof'), tone: 'healthy' },
  ]
  return <div className={styles.content}>
    <div className={styles.summaryLine}>
      <strong>{t('personal.greeting', { name: snapshot.displayName })}</strong>
      <span>{t('personal.day', { date: date(snapshot.generatedAt, snapshot.timeZone, t, 'date') })}</span>
      <span className={styles.dayChip}><span aria-hidden="true"><IconClockOutlineRegular size={12} /></span>
        {t('personal.nextDay', { date: date(snapshot.nextBusinessDay, snapshot.timeZone, t, 'date') })}</span>
    </div>
    <div className={styles.kpis}>{stats.map(({ key, label, tone }) => <Metric key={key} label={label}
      value={number(metrics[key], t)} tone={tone} valueDescription={metrics[key] === null ? t('metric.unknown') : undefined}
      note={<Evidence value={snapshot.insights?.stats[key]} zone={snapshot.timeZone} t={t}
        fallback={key === 'oof' ? [metrics[key] === null ? t('metric.unknown') : '', t('metric.oofNote')].filter(Boolean).join(' · ')
          : key === 'teamsUnread' && metrics[key] === null ? t('metric.teamsUnknown')
            : metrics[key] === null ? t('metric.unknown') : t('insight.unavailable')} />}
    />)}</div>
    <div className={styles.graphRow}>
      <Consequences snapshot={snapshot} t={t} /><Week snapshot={snapshot} t={t} /><Allocation snapshot={snapshot} t={t} />
    </div>
    <Warnings warnings={snapshot.warnings} summary={snapshot.insights?.warningsSummary} zone={snapshot.timeZone} t={t} />
    <Attention snapshot={snapshot} t={t} attentionFilter={attentionFilter} onAttentionFilter={onAttentionFilter} adjustments={adjustments} />
    <div className={styles.agendaBand}>
      <Agenda title={t('agenda', { date: date(snapshot.nextBusinessDay, snapshot.timeZone, t, 'date') })}
        items={snapshot.schedule} snapshot={snapshot} t={t} advice />
      {section('prep')}
    </div>
    <details className={styles.todayDisclosure}>
      <summary>{t('agenda.today')} <span>{t('unit.items', {
        count: number(snapshot.sources.some(source => source.id === 'calendar' && source.state !== 'unavailable') ? snapshot.todayRemaining.length : null, t),
      })}</span></summary>
      <Agenda title={t('agenda.today')} items={snapshot.todayRemaining} snapshot={snapshot} t={t} />
    </details>
    <div className={styles.peopleBand}>{section('reply')}{section('chats')}{section('people')}</div>
    <div className={styles.referenceBand}>{section('actions')}{section('training')}{section('oof')}{section('files')}</div>
    {section('projects')}
    <footer className={styles.sourceDetails}>
      <span aria-hidden="true"><IconLinkOutlineRegular size={13} /></span>
      <span>{t('personal.sourceDetails')}</span>
      {policy && <span>{policy}</span>}
      {snapshot.referenceAsOf && <span>{t('referenceAsOf', { date: referenceDate(snapshot.referenceAsOf, snapshot.timeZone, t) })}</span>}
    </footer>
    <details className={styles.sources}><summary>{t('sources')}</summary>
      <ul className={styles.items}>{snapshot.sources.map(source => <li key={source.id}>
        <strong>{sourceName(source.id, t)}</strong> <Badge source={source.state} t={t} />
        <time dateTime={source.updatedAt}>{date(source.updatedAt, snapshot.timeZone, t)}</time>
        {source.message && <p className={styles.muted}>{source.message}</p>}
      </li>)}</ul>
    </details>
  </div>
}
