/** Calendar-day ranges and category occupancy for revision evidence from the current cohort only. */
import { DateTime } from 'luxon'
import type { AdoHistoryRange, HistoryPoint, HistoryReport } from './ado-analytics-model.ts'
import type { AdoSnapshot, StateCategory } from './types.ts'

export const currentCohortWarning = 'History follows only the current cohort; it is not complete sprint history or a sprint burndown.'
export const currentMetadataWarning = 'Historical states use current work-item type state categories; this is not historical board-column history.'
export const partialSourceWarning = 'Current source coverage is partial; history does not reconstruct omitted source members.'

/**
 * Resolve inclusive local calendar dates, capped at snapshot time and the configured maximum days.
 * @param snapshot Snapshot supplying the iteration, time zone, and settings.
 * @returns A bounded range or a reason why no historical range can be represented.
 */
export function adoHistoryRange(snapshot: AdoSnapshot): { range: AdoHistoryRange | null; warnings: string[]; reason?: string } {
  if (!snapshot.analytics) throw new Error('ADO history requires analytics metadata')
  const { timeZone, settings } = snapshot.analytics
  const asOf = DateTime.fromISO(snapshot.generatedAt, { zone: timeZone }).setZone(timeZone)
  if (!asOf.isValid) throw new Error('Invalid ADO snapshot timestamp or history time zone')
  let finish = asOf.startOf('day')
  let start = finish.minus({ days: settings.historyDays - 1 })
  const source = snapshot.iteration ? 'iteration' : 'recent'
  if (snapshot.iteration) {
    const calendarDate = (value: string | undefined) => {
      const date = value?.slice(0, 10)
      return value && date && /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(value, { zone: 'utc' }).isValid
        ? DateTime.fromISO(date, { zone: timeZone }) : null
    }
    const iterationStart = calendarDate(snapshot.iteration.start)
    const iterationFinish = calendarDate(snapshot.iteration.finish)
    if (!iterationStart?.isValid || !iterationFinish?.isValid || iterationStart > iterationFinish) {
      return { range: null, warnings: [], reason: 'Iteration history requires valid start and finish calendar dates.' }
    }
    if (iterationStart > asOf) return { range: null, warnings: [], reason: 'The selected iteration has not started at the snapshot timestamp.' }
    start = iterationStart
    finish = iterationFinish < finish ? iterationFinish : finish
  }
  const earliest = finish.minus({ days: settings.maxHistoryDays - 1 })
  const clipped = start < earliest
  if (clipped) start = earliest
  return {
    range: { start: start.toISODate()!, finish: finish.toISODate()!, timeZone, source, clipped },
    warnings: clipped ? [`History was clipped to the latest ${settings.maxHistoryDays} calendar days of the selected range.`] : [],
  }
}

function knownUnfinished(category: StateCategory): boolean {
  return category === 'Proposed' || category === 'InProgress' || category === 'Resolved'
}

/**
 * Aggregate daily occupancy and observed transitions without inventing observations for omitted items.
 * @param snapshot Validated snapshot and optional loaded revision evidence.
 * @param type Current selected work-item type.
 * @param baseItemIds IDs after type/person/state/tag/text filtering, before chart refinements.
 * @returns Null when evidence is absent or belongs to another selected type.
 */
export function projectAdoHistory(snapshot: AdoSnapshot, type: string, baseItemIds: readonly number[]): HistoryReport | null {
  const history = snapshot.analytics?.history
  if (!history || history.type !== type) return null
  const base = new Set(baseItemIds)
  const available = history.items.filter(item => base.has(item.id))
  const availableIds = new Set(available.map(item => item.id))
  const omittedItemIds = baseItemIds.filter(id => !availableIds.has(id))
  const warnings = new Set([currentCohortWarning, currentMetadataWarning, ...history.warnings])
  if (!snapshot.complete) warnings.add(partialSourceWarning)
  if (omittedItemIds.length) warnings.add('Some current-cohort items have unavailable revision evidence; daily counts cover available items only.')
  const report: HistoryReport = {
    basis: 'current-cohort', status: !available.length ? 'unavailable' : omittedItemIds.length ? 'partial' : 'complete',
    range: history.range, fetchedAt: history.fetchedAt,
    requestedCount: baseItemIds.length, availableCount: available.length, omittedItemIds,
    points: [], warnings: [...warnings],
  }
  if (!available.length || !history.range || history.status === 'unavailable') return report
  const asOf = Date.parse(snapshot.generatedAt)
  const { range } = history
  const timelines = available.map(item => ({
    id: item.id, cursor: -1,
    changes: item.changes.map(change => ({ at: Date.parse(change.at), category: change.category })),
  }))
  const finish = DateTime.fromISO(range.finish, { zone: range.timeZone })
  for (let day = DateTime.fromISO(range.start, { zone: range.timeZone }); day <= finish; day = day.plus({ days: 1 })) {
    const endpoint = Math.min(day.endOf('day').toMillis(), asOf)
    const point: HistoryPoint = {
      date: day.toISODate()!,
      counts: { Proposed: 0, InProgress: 0, Resolved: 0, Completed: 0, Removed: 0, Unknown: 0 },
      notCreated: 0, completedItemIds: [], reopenedItemIds: [],
    }
    for (const timeline of timelines) {
      let completed = false
      let reopened = false
      while (timeline.cursor + 1 < timeline.changes.length && timeline.changes[timeline.cursor + 1]!.at <= endpoint) {
        const before = timeline.cursor < 0 ? undefined : timeline.changes[timeline.cursor]!.category
        const change = timeline.changes[++timeline.cursor]!
        if (change.at >= day.toMillis()) {
          completed ||= change.category === 'Completed' && before !== 'Completed'
          reopened ||= before === 'Completed' && knownUnfinished(change.category)
        }
      }
      if (timeline.cursor < 0) point.notCreated++
      else point.counts[timeline.changes[timeline.cursor]!.category]++
      if (completed) point.completedItemIds.push(timeline.id)
      if (reopened) point.reopenedItemIds.push(timeline.id)
    }
    report.points.push(point)
  }
  return report
}
