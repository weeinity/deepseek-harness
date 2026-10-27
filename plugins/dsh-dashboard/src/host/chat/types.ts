/** Host-only inputs; callers resolve and freeze the displayed snapshot before submission. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AttentionGrant, ProposeAttention } from '../attention-contract.ts'
import type {
  DashboardChatScope, DashboardQuestionId, DashboardScopeId, DashboardSnapshotId,
} from '../../shared/chat.ts'

export type {
  DashboardChatScope, DashboardQuestionId, DashboardScopeId, DashboardSnapshotId,
} from '../../shared/chat.ts'

/** Deployment limits and dedicated single-user Dashboard directories. */
export interface DashboardChatConfig {
  readonly lockDirectory: string
  /** Absolute dedicated directory; created and realpath-resolved before its cwd is recorded in new Sessions. */
  readonly workingDirectory: string
  readonly maxQuestionBytes: number
  /** UTF-8 limit for the complete model-facing snapshot, including source details and framing. */
  readonly maxContextBytes: number
  readonly maxOutputTokens: number
  /** Optional Host capability; absence keeps every Dashboard conversation tool-free. */
  readonly proposeAttention?: ProposeAttention
  /** Stop dependent writers and await their admitted writes before releasing the shared lock.
   * Runs once on every teardown path, including failed initialization; rejection is preserved after cleanup.
   * @returns Dependent teardown, or nothing when the dependency has not been constructed.
   */
  readonly beforeReleaseOwnership?: () => void | Promise<void>
}

/** Host-computed identity available without retrieving the original snapshot. */
export interface DashboardChatReconciliation {
  readonly scopeId: DashboardScopeId
  readonly requestId: DashboardQuestionId
  /** Lowercase SHA-256 hex of the complete schema-parsed original wire request. */
  readonly requestFingerprint: string
}

/** Durable native inbox admission, not successful model completion. */
export interface DashboardChatReceipt {
  readonly sessionId: SessionId
  readonly requestId: DashboardQuestionId
}

/** One approved, immutable question and its exact displayed evidence. */
export interface DashboardChatSubmission {
  readonly scope: DashboardChatScope
  readonly requestId: DashboardQuestionId
  /** Host-computed lowercase SHA-256 hex of the complete schema-parsed wire request. */
  readonly requestFingerprint: string
  readonly question: string
  readonly contextText: string
  readonly snapshotId: DashboardSnapshotId
  /** Host-only authority from the exact compiled Personal evidence, never reconstructed from history. */
  readonly attentionGrant?: AttentionGrant
}
