/** Host execution adapters address the exact conversation reserved by a durable attempt. */
import type {
  TaskConnection, TaskExecution, TaskExecutionReceipt,
} from '@deepseek-ai/dsh-taskboard/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Observed execution state; unknown evidence never implies successful completion. */
export type TaskExecutionObservation =
  | {
    /** Waiting denotes an outstanding question or approval for this execution's conversation. */
    readonly state: 'pending' | 'running' | 'waiting'
    readonly receipt?: TaskExecutionReceipt
  }
  | {
    readonly state: 'settled'
    readonly outcome: 'succeeded' | 'failed' | 'cancelled'
    readonly receipt?: TaskExecutionReceipt
    readonly error?: { readonly code: string; readonly message: string }
  }

/** Activity of the exact linked-chat turn that requested human input, without an execution receipt. */
export type TaskConversationObservation =
  | { readonly state: 'waiting' | 'running' }
  | { readonly state: 'settled'; readonly outcome: 'succeeded' | 'failed' | 'cancelled' }

/** Read-only tracking of an observed question's turn; disposing Taskboard never cancels that turn. */
export interface TaskConversationAttention {
  /**
   * Follow pending input, resumption, and the captured turn's exact ending.
   * @param signal - Cancellation of inspection, not of the borrowed conversation.
   * @returns repeatable terminal evidence after its durability barrier, or current activity.
   */
  observe(signal: AbortSignal): Promise<TaskConversationObservation>
}

/** Provider operations shared by manual dispatch, cron, and restart reconciliation. */
export interface TaskExecutionAdapter {
  /**
   * Capture a currently attributable human-input wait in a linked conversation.
   * @param connection - Current task connection; no conversation is created or activated.
   * @param workspaceId - Workspace that owns the connection.
   * @returns a read-only turn monitor, or undefined when no supported wait is observed.
   */
  attention?(connection: TaskConnection, workspaceId: WorkspaceId): TaskConversationAttention | undefined
  /**
   * Verify that an existing conversation belongs to the requested Workspace and is not busy.
   * @param connection - Exact existing conversation, never a replacement candidate.
   * @param workspaceId - Task Workspace.
   * @param signal - Cancellation of the observation only.
   */
  validateConnection(connection: TaskConnection, workspaceId: WorkspaceId, signal: AbortSignal): Promise<void>
  /**
   * Materialize a Host-reserved identity for a first run; never submit its prompt.
   * @param execution - Durable attempt carrying its reserved connection and settings.
   * @param signal - Cancellation of provisioning.
   */
  create(execution: TaskExecution, signal: AbortSignal): Promise<void>
  /**
   * Resolve the existing conversation, apply explicit settings, and capture a pre-submission cursor.
   * @param execution - Durable attempt whose conversation must already exist.
   * @param signal - Cancellation of preparation.
   * @returns the cursor to persist before submitting any input.
   */
  prepare(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionReceipt>
  /**
   * Submit one attempt without recreating its conversation or retrying uncertain acceptance.
   * @param execution - Durable attempt including its persisted pre-submission receipt.
   * @param signal - Cancellation of this adapter operation, not authority to stop borrowed work.
   * @returns the accepted message receipt; completion is observed separately.
   */
  submit(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionReceipt>
  /**
   * Inspect the attempt's receipts and completion evidence without submitting input.
   * Terminal evidence must remain repeatable until release or global disposal;
   * providers must not expire an unacknowledged terminal observation.
   * @param execution - Attempt to reconcile, including after a Host restart.
   * @param signal - Cancellation of inspection.
   * @returns known activity or a terminal outcome supported by execution evidence.
   */
  observe(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionObservation>
  /**
   * Acknowledge durable terminal settlement and release per-attempt attachments
   * and cached evidence without cancelling borrowed conversation work.
   * Idempotent, including after restart when no local attachment exists.
   * Rejection reports cleanup failure, not a change to the committed outcome.
   * @param execution - Acknowledged attempt identity and receipt; lifecycle fields
   * may predate settlement if retention removed its displayed record.
   * @returns resolution after owned per-attempt resources have been released.
   */
  release?(execution: TaskExecution): Promise<void>
  /**
   * Stop adapter-owned work and await resource release without deleting conversation data.
   * @returns resolution after owned processes and callbacks reach quiescence.
   */
  dispose(): Promise<void>
}
