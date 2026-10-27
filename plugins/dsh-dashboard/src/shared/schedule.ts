/** Wall-clock refresh slots are anchored inside each configured local workday. */
import type { DashboardSettings } from './types.ts'

export type RefreshSchedule = Pick<DashboardSettings, 'refreshMinutes' | 'refreshMinute' | 'workdayStart' | 'workdayEnd'>

/**
 * Resolve the inclusive first and last refresh slots in minutes after local midnight.
 * @param settings - validated refresh interval, minute offset, and workday hours.
 * @returns clock-minute positions; the end-of-workday hour is exclusive.
 */
export function refreshClockSlots(settings: RefreshSchedule): { first: number; last: number } {
  const first = settings.workdayStart * 60 + settings.refreshMinute
  return {
    first,
    last: first + Math.floor((settings.workdayEnd * 60 - 1 - first) / settings.refreshMinutes) * settings.refreshMinutes,
  }
}
