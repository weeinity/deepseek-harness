/** Validate every server response before it enters the observable client model. */
import { z } from 'zod'
import { adoSourceSchema } from '../shared/requests.ts'
import { receiptSchema } from '../shared/chat.ts'
import { attentionMutationSchema, attentionProposalSchema, attentionViewSchema } from '../shared/attention.ts'
import { personalInsightsSchema } from '../shared/insights.ts'
import { adoAnalyticsSnapshotSchema, validateAdoHistory } from '../shared/ado-analytics-schema.ts'
import type { AdoSnapshot, DashboardSettings, PersonalSnapshot } from '../shared/types.ts'

const text = z.string()
const count = z.number().int().nonnegative()
const amount = z.number().nonnegative()
const timestamp = text.refine(value => Number.isFinite(Date.parse(value)))
const timeZone = text.refine(value => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  } catch {
    // Intl rejects unsupported time zone identifiers.
    return false
  }
})
const sourceState = z.enum(['live', 'partial', 'reference', 'unavailable'])
const calendarItem = z.object({
  id: text, title: text, start: timestamp, end: timestamp, url: text,
  organizer: text, response: text, online: z.boolean(), allDay: z.boolean(),
  free: z.boolean(), conflict: z.boolean(), optionalOverlap: z.boolean(), preview: text,
})

export const settingsSchema = z.object({
  cacheSeconds: z.number().int().min(0).max(3600).default(600),
  timeZone, refreshMinutes: z.number().int().min(1).max(1440),
  refreshMinute: z.number().int().min(0).max(59),
  workdayStart: z.number().int().min(0).max(23),
  workdayEnd: z.number().int().min(1).max(24),
  hasReference: z.boolean(), defaultAdoSource: adoSourceSchema.optional(),
  maxChatQuestionChars: z.number().int().min(1).max(16_000),
}).refine(value => value.workdayEnd > value.workdayStart) satisfies z.ZodType<DashboardSettings>

export const personalSchema = z.object({
  kind: z.literal('personal'), generatedAt: timestamp, timeZone, displayName: text,
  email: text.optional(), nextBusinessDay: timestamp,
  sources: z.array(z.object({
    id: text, state: sourceState, updatedAt: timestamp, message: text.optional(),
  })),
  metrics: z.object({
    overdueActions: count.nullable(), attentionItems: count, unreadEmails: count.nullable(),
    meetingsNextDay: count.nullable(), teamsUnread: count.nullable(), projects: count,
    oof: count.nullable(),
  }),
  schedule: z.array(calendarItem), todayRemaining: z.array(calendarItem),
  weekLoad: z.array(z.object({ date: timestamp, meetings: count, minutes: amount })),
  allocation: z.array(z.object({
    category: z.enum(['customer', 'training', 'internal', 'focus', 'admin']),
    minutes: amount, percent: amount.max(100),
  })),
  sections: z.array(z.object({
    id: z.enum(['urgent', 'prep', 'projects', 'reply', 'actions', 'training', 'oof', 'people', 'chats', 'files']),
    source: sourceState, note: text.optional(),
    items: z.array(z.object({
      id: text, title: text, detail: text, url: text, source: z.enum(['live', 'reference']),
      severity: z.enum(['hot', 'watch', 'active']).optional(), sourceDate: text.optional(),
      initials: text.optional(),
    })),
  })),
  referenceAsOf: text.optional(), warnings: z.array(text),
  insights: personalInsightsSchema.optional(),
  attention: attentionViewSchema.optional(),
}).superRefine((snapshot, ctx) => {
  if (snapshot.attention) {
    const view = snapshot.attention
    const rows = snapshot.sections.find(section => section.id === 'urgent')?.items ?? []
    const current = view.items.filter(item => item.itemId !== null)
    const ids = new Set(current.map(item => item.itemId))
    if (view.loadedCount !== current.length || ids.size !== current.length
      || new Set(rows.map(item => item.id)).size !== rows.length || rows.some(item => !ids.has(item.id))
      || (['visible', 'hidden', 'handled', 'snoozed'] as const).some(mode =>
        view[`${mode}Count`] !== current.filter(item => item.effective.mode === mode).length)) {
      ctx.addIssue({ code: 'custom', path: ['attention'], message: 'Each displayed row needs local attention metadata; counts must match the captured loaded population.' })
    }
  }
  if (snapshot.insights === undefined) return
  const attentionSection = snapshot.sections.find(section => section.id === 'urgent')
  const rows = attentionSection?.items ?? []
  const ids = new Set(rows.map(item => item.id))
  const classified = new Set(snapshot.insights.attention.map(item => item.itemId))
  if (ids.size !== rows.length || classified.size !== snapshot.insights.attention.length || classified.size !== ids.size
    || [...classified].some(id => !ids.has(id))) {
    ctx.addIssue({ code: 'custom', path: ['insights', 'attention'], message: 'Attention classifications must match the snapshot attention rows exactly.' })
  }
  const counts = snapshot.insights.attentionCounts
  const represented = new Map<(typeof snapshot.insights.attention)[number]['category'], number>()
  for (const item of snapshot.insights.attention) represented.set(item.category, (represented.get(item.category) ?? 0) + 1)
  const available = attentionSection !== undefined && attentionSection.source !== 'unavailable'
  if ((counts !== null) !== available || (counts !== null && (
    Object.values(counts).reduce((sum, count) => sum + count, 0) !== snapshot.metrics.attentionItems
    || [...represented].some(([category, count]) => count > counts[category])
  ))) {
    ctx.addIssue({ code: 'custom', path: ['insights', 'attentionCounts'], message: 'Source-wide attention counts must match the loaded source population and availability.' })
  }
  const events = new Set(snapshot.schedule.map(event => event.id))
  const advised = new Set(snapshot.insights.agendaAdvice.map(item => item.eventId))
  if (advised.size !== snapshot.insights.agendaAdvice.length || [...advised].some(id => !events.has(id))) {
    ctx.addIssue({ code: 'custom', path: ['insights', 'agendaAdvice'], message: 'Meeting advice must reference unique events in this snapshot schedule.' })
  }
}) satisfies z.ZodType<PersonalSnapshot>

export const adoSchema = z.object({
  kind: z.literal('ado'), generatedAt: timestamp, source: adoSourceSchema, sourceUrl: text,
  iteration: z.object({
    name: text, path: text, id: text, start: timestamp.optional(), finish: timestamp.optional(),
  }).optional(),
  items: z.array(z.object({
    id: count.positive(), title: text, type: text, state: text,
    category: z.enum(['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed', 'Unknown']),
    assignee: text, assigneeId: text, areaPath: text, iterationPath: text,
    tags: z.array(text), url: text, changedAt: timestamp.optional(), dueDate: timestamp.optional(),
    estimate: amount.optional(), estimateField: text.optional(), remainingWork: amount.optional(),
    priority: count.optional(), risks: z.array(z.enum(['unassigned', 'blocked', 'stale', 'overdue'])),
    revision: count.positive().max(Number.MAX_SAFE_INTEGER).optional(),
    project: text.min(1).optional(), createdAt: timestamp.optional(), stateChangedAt: timestamp.optional(),
    predecessors: z.array(count.positive().max(Number.MAX_SAFE_INTEGER).nullable()).optional(),
  })),
  complete: z.boolean(), warnings: z.array(text), defaultType: text,
  analytics: adoAnalyticsSnapshotSchema.optional(),
}).superRefine((snapshot, ctx) => {
  const ids = new Set(snapshot.items.map(item => item.id))
  if (ids.size !== snapshot.items.length) {
    ctx.addIssue({ code: 'custom', path: ['items'], message: 'Work-item IDs must be unique.' })
  }
  const history = snapshot.analytics?.history
  if (!history) return
  try {
    validateAdoHistory(history, snapshot)
  } catch {
    // The shared history validator rejects invalid ranges, cohort membership, and revision evidence.
    ctx.addIssue({ code: 'custom', path: ['analytics', 'history'], message: 'History does not match its captured snapshot.' })
  }
}) satisfies z.ZodType<AdoSnapshot>

export const responseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown(), receipt: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.object({
    code: text, message: text, details: z.unknown().optional(),
  }) }),
])

/**
 * Bound a validated Host or native diagnostic for plain-text display.
 * @param message - public diagnostic string, never a caught JavaScript exception.
 * @returns at most 512 Unicode code points, or null for a blank message.
 */
export function boundedDiagnostic(message: string): string | null {
  const characters = Array.from(message.trim())
  return characters.length === 0 ? null
    : characters.length > 512 ? `${characters.slice(0, 511).join('')}…` : characters.join('')
}

/** Successful snapshots require a validated, Host-issued receipt alongside their value. */
export const snapshotResponseSchema = z.object({
  ok: z.literal(true), value: z.unknown(), receipt: receiptSchema,
})

/** Local acknowledgements carry the evaluated Personal view and its matching question receipt. */
export const attentionResponseSchema = z.object({
  ok: z.literal(true), value: personalSchema.refine(value => value.attention !== undefined),
  receipt: receiptSchema.refine(value => value.scope.id === 'personal'),
  proposals: z.array(attentionProposalSchema), mutation: attentionMutationSchema.optional(),
})
