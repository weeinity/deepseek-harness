/** Host-issued snapshot references bind dashboard questions to a single source and selection. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { Filters, SortKey } from './selection.ts'
import { attentionFilterSchema, type AttentionFilter } from './insights.ts'
import { adoDrillSchema } from './ado-analytics-schema.ts'

export type DashboardSnapshotId = Branded<'DashboardSnapshotId'>
export type DashboardScopeId = Branded<'DashboardScopeId'>
export type DashboardQuestionId = Branded<'DashboardQuestionId'>

export const snapshotIdSchema = z.uuid().transform(value => value as DashboardSnapshotId)
export const scopeIdSchema = z.string().regex(/^(?:personal|ado:[a-f0-9]{64})$/)
  .transform(value => value as DashboardScopeId)
export const questionIdSchema = z.uuid().transform(value => value as DashboardQuestionId)

export interface DashboardChatScope {
  id: DashboardScopeId
  title: string
}

export interface SnapshotReceipt {
  id: DashboardSnapshotId
  scope: DashboardChatScope
  expiresAt: string
}

export const receiptSchema = z.object({
  id: snapshotIdSchema,
  scope: z.object({ id: scopeIdSchema, title: z.string().min(1) }).strict(),
  expiresAt: z.iso.datetime(),
}).strict()

export interface AdoChatSelection {
  view: 'ado'
  analyticsVersion?: 1
  filters: Filters
  selectedItem: number | null
  sort: SortKey
  direction: 'asc' | 'desc'
  page: number
  pageSize: number
  stale: boolean
}

export type DashboardChatSelection = {
  view: 'personal'
  stale: boolean
  /** Omission preserves the wire identity of requests accepted before attention filtering existed. */
  attentionFilter?: AttentionFilter
  attentionVersion?: 1
} | AdoChatSelection

const filterText = z.string().max(512)
export const filtersSchema = z.object({
  type: filterText,
  person: filterText,
  state: filterText,
  tag: filterText,
  text: filterText,
  metric: z.enum(['', 'completed', 'remaining', 'risks']),
  risk: z.enum(['', 'unassigned', 'blocked', 'stale', 'overdue']),
  drill: adoDrillSchema.optional(),
}).strict() satisfies z.ZodType<Filters>

export const chatSelectionSchema = z.discriminatedUnion('view', [
  z.object({
    view: z.literal('personal'), stale: z.boolean(), attentionFilter: attentionFilterSchema.optional(),
    attentionVersion: z.literal(1).optional(),
  }).strict(),
  z.object({
    view: z.literal('ado'),
    analyticsVersion: z.literal(1).optional(),
    filters: filtersSchema,
    selectedItem: z.number().int().positive().nullable(),
    sort: z.enum(['id', 'title', 'type', 'state', 'assignee', 'priority', 'changedAt']),
    direction: z.enum(['asc', 'desc']),
    page: z.number().int().nonnegative(),
    pageSize: z.number().int().min(1).max(1000),
    stale: z.boolean(),
  }).strict(),
]) satisfies z.ZodType<DashboardChatSelection>

export const chatOpenSchema = z.object({ snapshotId: snapshotIdSchema }).strict()

/** The transport also enforces its 32-KiB body limit; the configured question limit is checked by the Host. */
export const chatSendSchema = z.object({
  snapshotId: snapshotIdSchema,
  scopeId: scopeIdSchema,
  requestId: questionIdSchema,
  question: z.string().trim().min(1).max(16_000),
  selection: chatSelectionSchema,
}).strict()

export type DashboardChatSend = z.infer<typeof chatSendSchema>

export const chatOpenedSchema = z.object({
  sessionId: z.string().min(1).max(256),
  scope: z.object({ id: scopeIdSchema, title: z.string().min(1) }).strict(),
}).strict()

export const chatSentSchema = z.object({
  sessionId: z.string().min(1).max(256),
  requestId: questionIdSchema,
}).strict()
