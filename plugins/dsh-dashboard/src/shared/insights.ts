/** Snapshot-owned interpretations retain the evidence and date that qualify their claims. */
import { z } from 'zod'

export const attentionCategorySchema = z.enum(['pastDue', 'dueSoon', 'waiting', 'standing', 'unclassified'])
export type AttentionCategory = z.infer<typeof attentionCategorySchema>
export const attentionFilterSchema = z.enum(['all', 'pastDue', 'thisWeekend'])
export type AttentionFilter = z.infer<typeof attentionFilterSchema>

export const evidenceTextSchema = z.object({
  text: z.string(),
  source: z.enum(['live', 'partial', 'reference', 'unavailable']),
  sourceDate: z.string().optional(),
  evidenceIds: z.array(z.string()),
})
export type EvidenceText = z.infer<typeof evidenceTextSchema>

export const personalInsightsSchema = z.object({
  warningsSummary: evidenceTextSchema,
  stats: z.object({
    overdueActions: evidenceTextSchema,
    unreadEmails: evidenceTextSchema,
    meetingsNextDay: evidenceTextSchema,
    teamsUnread: evidenceTextSchema,
    projects: evidenceTextSchema,
    oof: evidenceTextSchema,
  }),
  attention: z.array(z.object({
    itemId: z.string(),
    category: attentionCategorySchema,
    consequence: evidenceTextSchema,
    thisWeekend: z.boolean(),
    rank: z.number().int().nonnegative(),
    tone: z.enum(['critical', 'warning', 'accent', 'neutral']),
  })),
  /** Source-wide counts survive row filtering; null means classification evidence is unavailable. */
  attentionCounts: z.object({
    pastDue: z.number().int().nonnegative(),
    dueSoon: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    standing: z.number().int().nonnegative(),
    unclassified: z.number().int().nonnegative(),
  }).nullable(),
  reads: z.object({
    attention: evidenceTextSchema,
    weekLoad: evidenceTextSchema,
    allocation: evidenceTextSchema,
    agenda: evidenceTextSchema,
    prep: evidenceTextSchema,
    reply: evidenceTextSchema,
    chats: evidenceTextSchema,
    people: evidenceTextSchema,
    projects: evidenceTextSchema,
    actions: evidenceTextSchema,
    training: evidenceTextSchema,
    oof: evidenceTextSchema,
    files: evidenceTextSchema,
  }),
  protectedTime: evidenceTextSchema.optional(),
  agendaAdvice: z.array(z.object({
    eventId: z.string(),
    recommendation: z.enum(['keep', 'optional']),
    reason: evidenceTextSchema,
  })),
  oofImpact: evidenceTextSchema.optional(),
})
export type PersonalInsights = z.infer<typeof personalInsightsSchema>
