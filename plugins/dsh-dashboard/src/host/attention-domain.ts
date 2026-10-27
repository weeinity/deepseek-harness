/**
 * One journal record commits both an item decision and its request/proposal receipt.
 * Native single-document JSON rejects malformed envelopes and incompatible versions.
 * Each low-frequency personal adjustment rewrites the whole journal; records are never discarded.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import {
  attentionActionIdSchema, attentionDispositionSchema, attentionFingerprintSchema,
  attentionMutationSchema, attentionProposalSchema, attentionTargetSchema, attentionWriteSchema,
} from '../shared/attention.ts'

const decisionSchema = z.object({
  target: attentionTargetSchema,
  disposition: attentionDispositionSchema,
}).strict()

const actionRecordSchema = z.object({
  sequence: z.number().int().positive(),
  request: attentionWriteSchema,
  fingerprint: attentionFingerprintSchema,
  at: z.iso.datetime(),
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('mutation'),
      before: decisionSchema.nullable(),
      after: decisionSchema,
      result: attentionMutationSchema,
    }).strict(),
    z.object({ kind: z.literal('replay'), actionId: attentionActionIdSchema }).strict(),
    z.object({ kind: z.literal('cancel') }).strict(),
  ]),
}).strict()

const proposalRecordSchema = z.object({
  proposal: attentionProposalSchema.omit({ actionId: true }).extend({ status: z.literal('pending') }),
  callId: z.string().min(1),
  evidenceDigest: z.string().min(1),
  grantDigest: attentionFingerprintSchema,
  fingerprint: attentionFingerprintSchema,
  present: z.boolean(),
  createdSequence: z.number().int().nonnegative(),
}).strict()

export type AttentionDecision = z.infer<typeof decisionSchema>
export type AttentionActionRecord = z.infer<typeof actionRecordSchema>
export type AttentionProposalRecord = z.infer<typeof proposalRecordSchema>

/** Version-one authoritative journal, persisted through the native JSON single-document layout. */
export const dashboardAttentionDomain = defineDomain({
  name: 'dashboard_attention',
  version: 1,
  layout: 'single',
  tables: {
    actions: domainTable<string, AttentionActionRecord>(actionRecordSchema),
    proposals: domainTable<string, AttentionProposalRecord>(proposalRecordSchema),
  },
})
