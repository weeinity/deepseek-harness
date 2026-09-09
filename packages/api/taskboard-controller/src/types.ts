/** Browser-safe Taskboard Remote request, result, and stream vocabulary. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AgencyCopilotSessionId, TaskboardCreateInput, TaskboardMoveInput, TaskboardTask,
  TaskboardUpdateInput, TaskId,
} from '@deepseek-ai/dsh-taskboard/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

export type {
  TaskboardCreateInput, TaskboardDeleteValue, TaskboardMoveInput, TaskboardTask, TaskboardUpdateInput,
  AgencyCopilotSessionId, TaskboardUpdatePatch, TaskId, TaskPriority, TaskStatus,
} from '@deepseek-ai/dsh-taskboard/types'

/** Optional Workspace filter for a current Taskboard snapshot. */
export interface TaskboardListRequest { readonly workspaceId?: WorkspaceId }
/** Active and archived tasks matching a list request in registered Workspaces. */
export interface TaskboardListValue { readonly tasks: readonly TaskboardTask[] }
/** Durable create request. */
export type TaskboardCreateRequest = TaskboardCreateInput
/** Durable create or mutation response. */
export interface TaskboardTaskValue { readonly task: TaskboardTask }
/** Durable revision-checked content mutation. */
export type TaskboardUpdateRequest = TaskboardUpdateInput
/** Durable revision-checked status/rank mutation. */
export type TaskboardMoveRequest = TaskboardMoveInput
/** Durable revision-checked archive request. */
export interface TaskboardArchiveRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Permanently delete an active or archived task at its exact current revision. */
export interface TaskboardDeleteRequest { readonly taskId: TaskId; readonly expectedRevision: number }

/** Whether this Host deployment permits local desktop Copilot launch. */
export interface TaskboardAgencyCopilotCapabilityValue { readonly launch: boolean }
/** Existing local Agency Copilot session in the requested Workspace. */
export interface AgencyCopilotSessionOption {
  readonly sessionId: AgencyCopilotSessionId
  readonly summary?: string
  readonly status: 'idle' | 'in_use'
}
/** Discover existing local Agency Copilot sessions for a registered Workspace. */
export interface TaskboardListAgencyCopilotSessionsRequest { readonly workspaceId: WorkspaceId }
/** Workspace-filtered Agency rows; truncated means the bounded scan is incomplete. */
export interface TaskboardListAgencyCopilotSessionsValue {
  readonly sessions: readonly AgencyCopilotSessionOption[]
  readonly truncated: boolean
}
/** Start a fresh Agency Copilot terminal for one exact task revision. */
export interface TaskboardStartAgencyCopilotRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Clear a task's independent Agency Copilot identity with revision CAS. */
export interface TaskboardClearAgencyCopilotRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Open or resume the already-linked Agency Copilot terminal. */
export interface TaskboardOpenAgencyCopilotRequest { readonly taskId: TaskId }
/** Inspect transient Agency state for linked tasks without launching a process. */
export interface TaskboardInspectAgencyCopilotRequest { readonly taskIds: readonly TaskId[] }
/** Host-accepted fresh Copilot launch and committed task link. */
export interface TaskboardStartAgencyCopilotValue { readonly task: TaskboardTask; readonly launch: 'accepted' }
/** Best-effort terminal handoff outcome for a linked Copilot identity. */
export interface TaskboardOpenAgencyCopilotValue {
  readonly outcome: 'launch-pending' | 'already-running' | 'resume-accepted' | 'create-retry-accepted'
}
/** Transient Agency status; durable task planning status remains independent. */
export type AgencyCopilotObservationStatus = 'unknown' | 'missing' | 'workspace_mismatch' | 'idle' | 'in_use'
/** One transient status observation tied to the task and durable external identity. */
export interface AgencyCopilotObservation {
  readonly taskId: TaskId
  readonly sessionId: AgencyCopilotSessionId
  readonly status: AgencyCopilotObservationStatus
}
/** Bounded transient observations for linked tasks. */
export interface TaskboardInspectAgencyCopilotValue { readonly observations: readonly AgencyCopilotObservation[] }

/** Stable Taskboard failure details returned by unary methods. */
export interface TaskboardErrorDetailsMap {
  'bad-request': Record<never, never>
  'task-not-found': { readonly taskId: TaskId }
  'task-archived': { readonly taskId: TaskId }
  'workspace-not-found': { readonly workspaceId: WorkspaceId }
  'revision-conflict': { readonly taskId: TaskId; readonly expectedRevision: number; readonly actualRevision: number }
  'session-invalid': { readonly workspaceId: WorkspaceId; readonly sessionId: SessionId }
  'move-invalid': { readonly beforeTaskId: TaskId }
  'agency-unavailable': Record<never, never>
  'agency-local-only': Record<never, never>
  'agency-not-linked': { readonly taskId: TaskId }
  'agency-already-linked': { readonly taskId: TaskId }
  'agency-workspace-mismatch': { readonly taskId: TaskId }
  'agency-launch-failed': { readonly taskId: TaskId }
}

/** Taskboard business failure returned without throwing a carrier error. */
export type TaskboardError = {
  [Code in keyof TaskboardErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: TaskboardErrorDetailsMap[Code]
  }
}[keyof TaskboardErrorDetailsMap]

/**
 * Return whether an open Remote failure belongs to the Taskboard business subset.
 * @param error - Open generated Remote failure.
 * @returns whether the failure code belongs to Taskboard business errors.
 */
export function isTaskboardError(error: { readonly code: string }): error is TaskboardError {
  return ['bad-request', 'task-not-found', 'task-archived', 'workspace-not-found',
    'revision-conflict', 'session-invalid', 'move-invalid', 'agency-unavailable', 'agency-local-only', 'agency-not-linked',
    'agency-already-linked', 'agency-workspace-mismatch', 'agency-launch-failed'].includes(error.code)
}

/** Complete reconnect baseline of active and archived tasks in registered Workspaces. */
export interface TaskboardBaseline { readonly tasks: readonly TaskboardTask[] }
/** One ordered task change; archives upsert, task or Workspace deletions remove. */
export type TaskboardFollowIncrement =
  | { readonly type: 'upsert'; readonly task: TaskboardTask }
  | { readonly type: 'remove'; readonly taskId: TaskId; readonly revision: number }
/** Taskboard state stream; every generation begins with a complete baseline. */
export type TaskboardFollowFrame =
  | { readonly type: 'baseline'; readonly value: TaskboardBaseline }
  | TaskboardFollowIncrement
