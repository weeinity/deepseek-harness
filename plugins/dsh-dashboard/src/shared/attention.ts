/** Local Personal Work adjustments; source records and ADO views remain unchanged. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { questionIdSchema, snapshotIdSchema } from './chat.ts'

export type AttentionKey = Branded<'AttentionKey'>
export type AttentionActionId = Branded<'AttentionActionId'>
export type AttentionProposalId = Branded<'AttentionProposalId'>
export const attentionKeySchema = z.string().regex(/^attention:[a-f0-9]{64}$/)
  .transform(value => value as AttentionKey)
export const attentionActionIdSchema = z.uuid().transform(value => value as AttentionActionId)
export const attentionProposalIdSchema = z.uuid().transform(value => value as AttentionProposalId)
export const attentionFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const attentionIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hide') }).strict(),
  z.object({ kind: z.literal('handle') }).strict(),
  z.object({ kind: z.literal('restore') }).strict(),
  z.object({ kind: z.literal('snooze'), until: z.iso.datetime({ offset: true }) }).strict(),
])
export type AttentionIntent = z.infer<typeof attentionIntentSchema>

export const attentionDispositionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('visible') }).strict(),
  z.object({ mode: z.literal('hidden') }).strict(),
  z.object({ mode: z.literal('handled') }).strict(),
  z.object({ mode: z.literal('snoozed'), until: z.iso.datetime({ offset: true }) }).strict(),
])
export type AttentionDisposition = z.infer<typeof attentionDispositionSchema>

export const attentionTargetSchema = z.object({
  key: attentionKeySchema,
  title: z.string().min(1),
  url: z.string().min(1),
  fingerprint: attentionFingerprintSchema,
}).strict()
export type AttentionTarget = z.infer<typeof attentionTargetSchema>

/** A null itemId retains a saved decision whose item is absent from the loaded briefing. */
export const attentionItemStateSchema = attentionTargetSchema.extend({
  itemId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  disposition: attentionDispositionSchema,
  effective: attentionDispositionSchema,
  changed: z.boolean(),
  ambiguous: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
  lastActionId: attentionActionIdSchema.optional(),
  undoable: z.boolean(),
}).strict()
export type AttentionItemState = z.infer<typeof attentionItemStateSchema>

/** Counts distinguish the loaded personal view from the unchanged source population. */
export const attentionViewSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  evaluatedAt: z.iso.datetime(),
  nextExpiry: z.iso.datetime().optional(),
  sourceCount: z.number().int().nonnegative().nullable(),
  loadedCount: z.number().int().nonnegative(),
  visibleCount: z.number().int().nonnegative(),
  hiddenCount: z.number().int().nonnegative(),
  handledCount: z.number().int().nonnegative(),
  snoozedCount: z.number().int().nonnegative(),
  items: z.array(attentionItemStateSchema),
}).strict()
export type AttentionView = z.infer<typeof attentionViewSchema>

export const attentionProposalSchema = z.object({
  id: attentionProposalIdSchema,
  sessionId: z.string().min(1),
  questionId: questionIdSchema,
  target: attentionTargetSchema,
  intent: attentionIntentSchema,
  expectedRevision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: z.enum(['pending', 'applied', 'cancelled', 'expired', 'stale']),
  actionId: attentionActionIdSchema.optional(),
}).strict()
export type AttentionProposal = z.infer<typeof attentionProposalSchema>

export const attentionMutationSchema = z.object({
  id: attentionActionIdSchema,
  itemKey: attentionKeySchema,
  kind: z.enum(['hide', 'handle', 'snooze', 'restore', 'undo']),
  revision: z.number().int().positive(),
  before: attentionDispositionSchema,
  after: attentionDispositionSchema,
  at: z.iso.datetime(),
  undoable: z.boolean(),
}).strict()
export type AttentionMutation = z.infer<typeof attentionMutationSchema>

export const attentionReadSchema = z.object({ view: z.literal('personal') }).strict()
const command = { requestId: attentionActionIdSchema, snapshotId: snapshotIdSchema }
export const attentionWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    ...command, kind: z.literal('apply'), itemKey: attentionKeySchema,
    expectedRevision: z.number().int().nonnegative(), intent: attentionIntentSchema,
  }).strict(),
  z.object({ ...command, kind: z.literal('undo'), actionId: attentionActionIdSchema }).strict(),
  z.object({ ...command, kind: z.literal('confirm'), proposalId: attentionProposalIdSchema }).strict(),
  z.object({ ...command, kind: z.literal('cancel'), proposalId: attentionProposalIdSchema }).strict(),
])
export type AttentionWrite = z.infer<typeof attentionWriteSchema>

export const attentionRejectionCodes = ['STALE', 'AMBIGUOUS', 'SCOPE', 'EXPIRED', 'CONFLICT', 'INVALID_INTENT'] as const
export type AttentionRejectionCode = typeof attentionRejectionCodes[number]
const rejectionCodes = new Set<string>(attentionRejectionCodes)

/** Classify codes reserved for a proven command-admission rejection.
 * @param code Host or wire error code; publication failures must not use these codes.
 * @returns Whether the rejected payload is known not to have changed an item.
 */
export function isAttentionRejectionCode(code: string): code is AttentionRejectionCode {
  return rejectionCodes.has(code)
}

/** The model chooses one captured item and operation, never an application route or source scope. */
export const attentionToolInputSchema = z.object({
  itemKey: attentionKeySchema,
  intent: attentionIntentSchema,
}).strict()
export type AttentionToolInput = z.infer<typeof attentionToolInputSchema>

/** Keep raw rows available for review; consumers explicitly select the effective attention view.
 * @param view Host-evaluated decisions captured with the source snapshot.
 * @param itemId Identifier of a row in that snapshot, not a persistent adjustment key.
 * @returns Whether the row belongs in the displayed attention section.
 */
export function attentionItemVisible(view: AttentionView | undefined, itemId: string): boolean {
  const item = view?.items.find(entry => entry.itemId === itemId)
  return item === undefined || item.effective.mode === 'visible'
}
