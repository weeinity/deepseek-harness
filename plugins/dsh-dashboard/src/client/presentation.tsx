/** Pure shared presentation for validated links, cards, freshness, and resource feedback. */
import type { CSSProperties, ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SourceState } from '../shared/types.ts'
import type { EvidenceText } from '../shared/insights.ts'
import { safeSourceUrl } from '../shared/urls.ts'
import type { DashboardText } from './locale.ts'
import type { Resource } from './owner.ts'
import { compactSourceDate } from './format.ts'
import styles from './dsh-dashboard.module.css'

export type ChartStyle = CSSProperties & {
  '--dashboard-size'?: string
  '--dashboard-ring'?: string
  '--dashboard-color'?: string
}

export function SourceLink({ url, children, t, className, kind }: {
  url: string; children: ReactNode; t: DashboardText; className?: string; kind?: 'ado' | 'workItem'
}) {
  let safe = safeSourceUrl(url)
  if (safe !== undefined && kind !== undefined) {
    const parsed = new URL(safe)
    if ((parsed.hostname !== 'dev.azure.com' && !parsed.hostname.endsWith('.visualstudio.com'))
      || (kind === 'workItem' && !/\/_workitems\/edit\/\d+\/?$/i.test(parsed.pathname))) safe = undefined
  }
  return safe === undefined
    ? <span className={className}>{children}<small className={styles.muted}> · {t('source.unavailableLink')}</small></span>
    : <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>
}

export function Card({ title, children, tone, id, meta, className }: {
  title: string; children: ReactNode; tone?: 'attention'; id?: string; meta?: ReactNode; className?: string
}) {
  return <section className={`${styles.card} ${tone === 'attention' ? styles.attention : ''} ${className ?? ''}`} id={id}>
    <div className={styles.cardHeader}><h2>{title}</h2>{meta && <span className={styles.cardMeta}>{meta}</span>}</div>{children}
  </section>
}

export function Badge({ source, t }: { source: SourceState; t: DashboardText }) {
  return <span className={styles.badge} data-source={source}>{t(`source.${source}`)}</span>
}

export function Attribution({ source, sourceDate, zone, t }: {
  source: SourceState; sourceDate?: string; zone: string; t: DashboardText
}) {
  const label = [t(`source.${source}`), sourceDate ?? (source === 'reference' ? t('reference.undated') : '')].filter(Boolean).join(' · ')
  const shortDate = source === 'reference' && sourceDate ? compactSourceDate(sourceDate, zone) : null
  return <span className={styles.attribution} data-source={source} title={label} aria-label={label} role="note">
    <span>{t(`freshness.${source}`)}</span>
    {shortDate && <span aria-hidden="true"> · {shortDate}</span>}
    {!sourceDate && source === 'reference' && <span> · {t('reference.dateUnknown')}</span>}
  </span>
}

/** Interpretations are supplied by the snapshot; missing producers get an explicit unavailable label. */
export function Evidence({ value, zone, t, className, fallback }: {
  value?: EvidenceText; zone: string; t: DashboardText; className?: string; fallback?: string
}) {
  return <span className={`${styles.evidence} ${className ?? ''}`}>
    <span>{value?.text || fallback || t('insight.unavailable')}</span>{' '}
    <Attribution source={value?.source ?? 'unavailable'} sourceDate={value?.sourceDate} zone={zone} t={t} />
  </span>
}

export function sourceName(id: string, t: DashboardText): string {
  switch (id) {
    case 'calendar': case 'profile': case 'inbox': case 'mail': case 'teams': case 'chats': case 'files':
      return t(`source.${id}`)
    case 'reference': return t('source.referenceName')
    default: return id
  }
}

export function Warnings({ warnings, t, summary, zone = 'UTC' }: {
  warnings: readonly string[]; t: DashboardText; summary?: EvidenceText; zone?: string
}) {
  return warnings.length === 0 ? null : <details className={styles.warnings} aria-label={t('warnings')}>
    <summary>
      <span aria-hidden="true"><IconWarningOutlineRegular size={14} /></span>
      <strong>{t('warnings.count', { count: warnings.length })}</strong>
      <span className={styles.warningSummary}>{summary
        ? <Evidence value={summary} zone={zone} t={t} /> : t('warnings.expand')}</span>
      <span aria-hidden="true"><IconChevronDownOutlineRegular size={13} /></span>
    </summary>
    <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
  </details>
}

export function ResourceStatus({ resource, t, previousSource = false }: {
  resource: Resource<unknown>; t: DashboardText; previousSource?: boolean
}) {
  return <div aria-live="polite" aria-atomic="true" className={styles.feedback}>
    {resource.status === 'pending' && <p role="status">{t(resource.data === null ? 'loading' : 'refresh.retained')}</p>}
    {(resource.stale || previousSource) && <p className={styles.warning}>
      {previousSource || resource.previousSource ? t('previousSource') : t('stale')}
    </p>}
    {resource.error !== null && <p role="alert" className={styles.warning}>
      {t(resource.error === 'invalid' ? 'request.invalid' : 'request.error')}
      {resource.errorDetail && <span className={styles.errorDetail}>{resource.errorDetail}</span>}
    </p>}
  </div>
}

export function Metric({ label, value, note, onClick, active, tone, valueDescription }: {
  label: string; value: string; note?: ReactNode; onClick?: () => void; active?: boolean
  tone?: 'critical' | 'warning' | 'accent' | 'healthy'; valueDescription?: string
}) {
  const body = <><span className={styles.metricValue} title={valueDescription}>{value}
    {valueDescription && <span className={styles.srOnly}>{valueDescription}</span>}
  </span><span className={styles.metricLabel}>{label}</span>
    {note && <span className={styles.metricNote}>{note}</span>}</>
  return onClick === undefined
    ? <div className={styles.metric} data-tone={tone}>{body}</div>
    : <button type="button" className={styles.metric} data-tone={tone} onClick={onClick} aria-pressed={active}>{body}</button>
}
