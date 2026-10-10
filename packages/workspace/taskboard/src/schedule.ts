/** Numeric five-field cron evaluation without timers or registered scheduled jobs. */
import { Cron } from 'croner'
import { TaskboardInputError } from './errors.ts'
import type { TaskScheduleInput } from './types.ts'

/**
 * Calculate the next occurrence after an instant using the schedule's timezone.
 * @param schedule - Numeric five-field cron expression and explicit IANA timezone.
 * @param after - ISO timestamp excluded from the search.
 * @returns the next occurrence as a UTC ISO timestamp; invalid or impossible schedules reject.
 */
export function nextTaskScheduleRun(schedule: Pick<TaskScheduleInput, 'cron' | 'timeZone'>, after: string): string {
  const fields = schedule.cron.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new TaskboardInputError('Task schedules require exactly five cron fields')
  }
  if (fields.some(field => !/^[\d*,/-]+$/.test(field))) {
    throw new TaskboardInputError('Task cron fields accept only numbers, wildcards, lists, ranges, and steps')
  }
  const start = new Date(after)
  if (!Number.isFinite(start.getTime())) throw new TaskboardInputError('Schedule search requires a valid timestamp')
  let job: Cron | undefined
  try {
    if (/^[+-]/.test(schedule.timeZone)) throw new TaskboardInputError('Task schedules require an IANA timezone, not a fixed offset')
    const timeZone = new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }).resolvedOptions().timeZone
    job = new Cron(schedule.cron, { timezone: timeZone, paused: true })
    const next = job.nextRun(start)
    if (next === null) throw new TaskboardInputError('Task schedule has no future occurrence')
    return next.toISOString()
  } catch (error) {
    if (error instanceof TaskboardInputError) throw error
    throw new TaskboardInputError(`Invalid task schedule: ${String(error)}`)
  } finally {
    job?.stop()
  }
}
