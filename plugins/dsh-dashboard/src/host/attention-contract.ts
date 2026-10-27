/** Proposal authority is captured from admitted Personal Work evidence, not model arguments. */
import type { DashboardQuestionId, DashboardSnapshotId } from '../shared/chat.ts'
import type { AttentionItemState, AttentionProposal, AttentionToolInput } from '../shared/attention.ts'

export interface AttentionGrant {
  snapshotId: DashboardSnapshotId
  expiresAt: string
  items: readonly AttentionItemState[]
}

export interface AttentionProposalRequest {
  sessionId: string
  questionId: DashboardQuestionId
  callId: string
  evidenceDigest: string
  grant: AttentionGrant
  input: AttentionToolInput
}

/** Persist a proposal only; applying it requires a separate authenticated confirmation.
 * @param request Native execution identity and the exact admitted evidence.
 * @param signal Cancellation before durable admission.
 * @returns A pending, immutable confirmation receipt; no item is adjusted.
 */
export type ProposeAttention = (request: AttentionProposalRequest, signal: AbortSignal) => Promise<AttentionProposal>
