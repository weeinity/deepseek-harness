/** Locale-owned units and zone-aware dates; absent values never become zero. */
import type { DashboardText } from './locale.ts'
import type { DashboardSettings } from '../shared/types.ts'
import { refreshClockSlots } from '../shared/schedule.ts'

export function number(value: number | null | undefined, t: DashboardText): string {
  return value === null || value === undefined ? t('value.unavailable')
    : new Intl.NumberFormat(t('format.locale'), { maximumFractionDigits: 1 }).format(value)
}

export function date(value: string, zone: string, t: DashboardText, mode: 'date' | 'time' | 'full' | 'weekday' = 'full'): string {
  // Date-only values name a calendar day, not a UTC instant to shift into the previous day.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value)
  return new Intl.DateTimeFormat(t('format.locale'), {
    timeZone: day ? 'UTC' : zone,
    ...(mode === 'weekday' ? { weekday: 'short' } : mode === 'time' && !day ? { hour: 'numeric', minute: '2-digit' } : {
      year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
      ...(mode === 'full' && !day ? { hour: 'numeric', minute: '2-digit' } : {}),
    }),
  }).format(new Date(value))
}

/** Describe the same inclusive wall-clock slots used by the refresh scheduler. */
export function refreshPolicy(settings: DashboardSettings, t: DashboardText): string {
  const slots = refreshClockSlots(settings)
  const clock = (minutes: number) => new Intl.DateTimeFormat(t('format.locale'), {
    timeZone: 'UTC', hour: 'numeric', minute: '2-digit',
  }).format(new Date(minutes * 60_000))
  const values = {
    minutes: settings.refreshMinutes,
    minute: String(settings.refreshMinute).padStart(2, '0'),
    start: clock(slots.first), end: clock(slots.last), zone: settings.timeZone,
  }
  return t(settings.refreshMinutes === 60 ? 'header.refreshHourly' : 'header.refreshPolicy', values)
}

/** Preserve saved human-written refresh labels rather than inventing a timestamp. */
export function referenceDate(value: string, zone: string, t: DashboardText): string {
  return /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value))
    ? date(value, zone, t, 'date') : value
}

/** Compact only ISO source dates; human-written refresh labels remain available verbatim in attribution. */
export function compactSourceDate(value: string, zone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) return null
  if (value.length === 10) return value
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(value))
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)?.value).join('-')
}

export function estimate(value: number, field: string | undefined, t: DashboardText): string {
  const count = number(value, t)
  if (field === 'Microsoft.VSTS.Scheduling.StoryPoints') {
    return t('unit.points', { count })
  }
  if (field === 'Microsoft.VSTS.Scheduling.OriginalEstimate' || field === 'Microsoft.VSTS.Scheduling.RemainingWork'
    || field === 'Microsoft.VSTS.Scheduling.CompletedWork') return t('unit.work', { count })
  return t('unit.field', { count, field: field ?? t('unknown') })
}
