/** Configuration and wire validation for bounded, current-cohort ADO evidence. */
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { AdoAnalyticsSettings, AdoAnalyticsSnapshot, AdoDrill, AdoHistory, AgeGroup } from './ado-analytics-model.ts'
import type { AdoSnapshot } from './types.ts'
import { adoHistoryRange } from './ado-history.ts'

const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const categorySchema = z.enum(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed', 'Unknown'])
const timeZoneSchema = z.string().min(1).refine(value => DateTime.fromMillis(0, { zone: value }).isValid, 'Invalid time zone')
const instantSchema = z.iso.datetime({ offset: true }).refine(value => DateTime.fromISO(value).isValid, 'Invalid ISO timestamp')
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => DateTime.fromISO(value, { zone: 'utc' }).toISODate() === value, 'Invalid calendar date')
const idsSchema = z.array(idSchema).refine(ids => new Set(ids).size === ids.length, 'Duplicate work-item IDs')

const settingsFields = {
  ageBands: z.array(z.number().int().min(1).max(3650)).min(1).max(6)
    .refine(values => values.every((value, index) => index === 0 || value > values[index - 1]!), 'Age thresholds must strictly increase'),
  historyDays: z.number().int().min(1).max(366),
  maxHistoryDays: z.number().int().min(1).max(366),
  maxHistoryItems: z.number().int().min(1).max(1000),
  maxRevisionsPerItem: z.number().int().min(1).max(10000),
  revisionPageSize: z.number().int().min(1).max(200),
  historyConcurrency: z.number().int().min(1).max(8),
  historyTimeoutMs: z.number().int().min(1000).max(300000),
  maxHistoryRequests: z.number().int().min(1).max(5000),
}
const validHistoryWindow = (value: AdoAnalyticsSettings) => value.historyDays <= value.maxHistoryDays
const historyWindowMessage = 'historyDays must not exceed maxHistoryDays'
const requiredSettingsSchema = z.object(settingsFields).strict().refine(validHistoryWindow, historyWindowMessage)

/** Configuration may omit fields; snapshot DTOs must supply every resolved setting. */
export const adoAnalyticsSettingsSchema = z.object({
  ageBands: settingsFields.ageBands.default([7, 14, 30]),
  historyDays: settingsFields.historyDays.default(30),
  maxHistoryDays: settingsFields.maxHistoryDays.default(120),
  maxHistoryItems: settingsFields.maxHistoryItems.default(200),
  maxRevisionsPerItem: settingsFields.maxRevisionsPerItem.default(1000),
  revisionPageSize: settingsFields.revisionPageSize.default(50),
  historyConcurrency: settingsFields.historyConcurrency.default(4),
  historyTimeoutMs: settingsFields.historyTimeoutMs.default(120000),
  maxHistoryRequests: settingsFields.maxHistoryRequests.default(400),
}).strict().refine(validHistoryWindow, historyWindowMessage) satisfies z.ZodType<AdoAnalyticsSettings>

/**
 * Decode a self-describing age selection independently of the current configured chart bands.
 * @param key Unknown bucket or a canonical lt-N, L-U, or gte-N key.
 * @returns Half-open bounds, or null for malformed or out-of-range keys.
 */
export function adoAgeInterval(key: string): Pick<AgeGroup, 'lower' | 'upper'> | null {
  if (key === 'unknown') return { lower: null, upper: null }
  const match = /^(?:(lt|gte)-([1-9]\d{0,3})|([1-9]\d{0,3})-([1-9]\d{0,3}))$/.exec(key)
  if (!match) return null
  const lower = match[1] === 'lt' ? 0 : Number(match[2] ?? match[3])
  const upper = match[1] === 'gte' ? null : Number(match[2] ?? match[4])
  if (lower > 3650 || (upper !== null && (upper > 3650 || upper <= lower))) return null
  return { lower, upper }
}

const ageKeySchema = z.string().max(512).refine(key => adoAgeInterval(key) !== null, 'Invalid age interval key')

/** Absent areas remain valid selections; closed keys and age interval syntax are validated on the wire. */
export const adoDrillSchema: z.ZodType<AdoDrill> = z.discriminatedUnion('chart', [
  z.object({ chart: z.literal('category'), key: categorySchema }).strict(),
  z.object({ chart: z.literal('area'), key: z.string().min(1).max(512) }).strict(),
  z.object({ chart: z.literal('age'), key: ageKeySchema }).strict(),
  z.object({ chart: z.literal('stateAge'), key: ageKeySchema }).strict(),
  z.object({ chart: z.literal('dependency'), key: z.enum(['open', 'unavailable', 'clear']) }).strict(),
  z.object({ chart: z.literal('closure'), key: z.enum(['blocked', 'unassigned', 'overdue', 'resolved', 'stale', 'continue']) }).strict(),
])

const rangeSchema = z.object({
  start: dateSchema,
  finish: dateSchema,
  timeZone: timeZoneSchema,
  source: z.enum(['iteration', 'recent']),
  clipped: z.boolean(),
}).strict().refine(range => range.start <= range.finish, 'History range is reversed')

const itemHistorySchema = z.object({
  id: idSchema,
  changes: z.array(z.object({ at: instantSchema, category: categorySchema }).strict()).min(1),
}).strict().refine(item => item.changes.every((change, index) =>
  index === 0 || Date.parse(change.at) > Date.parse(item.changes[index - 1]!.at)), 'History timestamps must strictly increase')

/** Available and omitted IDs must partition the requested cohort exactly. */
export const adoHistorySchema = z.object({
  basis: z.literal('current-cohort'),
  type: z.string().min(1),
  status: z.enum(['complete', 'partial', 'unavailable']),
  fetchedAt: instantSchema,
  range: rangeSchema.nullable(),
  requestedItemIds: idsSchema,
  items: z.array(itemHistorySchema),
  omitted: z.array(z.object({ id: idSchema, reason: z.string().min(1).max(600) }).strict()),
  warnings: z.array(z.string().min(1).max(2000)),
}).strict().superRefine((history, ctx) => {
  const represented = [...history.items.map(item => item.id), ...history.omitted.map(item => item.id)]
  const requested = new Set(history.requestedItemIds)
  if (new Set(represented).size !== represented.length
    || represented.length !== requested.size || represented.some(id => !requested.has(id))) {
    ctx.addIssue({ code: 'custom', message: 'Available and omitted IDs must partition the requested cohort' })
  }
  const expected = !history.items.length ? 'unavailable' : history.omitted.length ? 'partial' : 'complete'
  if (history.status !== expected) ctx.addIssue({ code: 'custom', message: 'History status disagrees with item coverage' })
  if (!history.range && history.items.length) ctx.addIssue({ code: 'custom', message: 'Available history requires a range' })
}) satisfies z.ZodType<AdoHistory>

export const adoAnalyticsSnapshotSchema = z.object({
  version: z.literal(1),
  timeZone: timeZoneSchema,
  settings: requiredSettingsSchema,
  history: adoHistorySchema.optional(),
}).strict().superRefine((analytics, ctx) => {
  const range = analytics.history?.range
  if (!range) return
  if (range.timeZone !== analytics.timeZone) ctx.addIssue({ code: 'custom', message: 'History time zone differs from its snapshot' })
  const days = DateTime.fromISO(range.finish, { zone: range.timeZone })
    .diff(DateTime.fromISO(range.start, { zone: range.timeZone }), 'days').days + 1
  if (days > analytics.settings.maxHistoryDays) ctx.addIssue({ code: 'custom', message: 'History exceeds its configured calendar-day limit' })
}) satisfies z.ZodType<AdoAnalyticsSnapshot>

/**
 * Validate incoming history against its receipt-bound snapshot, not a caller-selected cohort.
 * @param value Untrusted history JSON.
 * @param snapshot Snapshot that supplied the selected type and revision fences.
 * @returns Validated history; throws for another cohort, range, or future observation.
 */
export function validateAdoHistory(value: unknown, snapshot: AdoSnapshot): AdoHistory {
  const history = adoHistorySchema.parse(value)
  if (!snapshot.analytics) throw new Error('ADO history requires analytics metadata')
  const analytics = adoAnalyticsSnapshotSchema.parse({ ...snapshot.analytics, history })
  const cohort = snapshot.items.filter(item => item.type === history.type)
  if (!cohort.length) throw new Error('ADO history requires an existing selected type')
  const expected = new Set(cohort.map(item => item.id))
  if (history.requestedItemIds.length !== expected.size || history.requestedItemIds.some(id => !expected.has(id))) {
    throw new Error('ADO history does not match the snapshot type cohort')
  }
  const asOf = DateTime.fromISO(snapshot.generatedAt, { zone: analytics.timeZone })
  if (!asOf.isValid) throw new Error('Invalid ADO snapshot timestamp')
  if (history.range && history.range.finish > asOf.toISODate()!) throw new Error('ADO history range exceeds the snapshot date')
  if (history.items.some(item => item.changes.some(change => Date.parse(change.at) > asOf.toMillis()))) {
    throw new Error('ADO history observation exceeds the snapshot timestamp')
  }
  const expectedRange = adoHistoryRange(snapshot).range
  if (history.range === null ? expectedRange !== null : expectedRange === null
    || history.range.start !== expectedRange.start || history.range.finish !== expectedRange.finish
    || history.range.source !== expectedRange.source || history.range.clipped !== expectedRange.clipped) {
    throw new Error('ADO history range does not match its snapshot settings and iteration')
  }
  if (history.items.length && cohort.length > analytics.settings.maxHistoryItems) throw new Error('ADO history exceeds the configured cohort limit')
  const byId = new Map(cohort.map(item => [item.id, item]))
  for (const item of history.items) {
    const fence = byId.get(item.id)!.revision
    if (fence === undefined || fence > analytics.settings.maxRevisionsPerItem || item.changes.length > fence) {
      throw new Error('ADO history does not match its captured revision fence')
    }
  }
  return history
}
