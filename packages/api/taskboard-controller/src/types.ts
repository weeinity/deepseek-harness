/** Browser-safe Taskboard Remote request, result, and stream vocabulary. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AgencyCopilotSessionId, TaskboardConnectInput, TaskboardCreateInput, TaskboardDuplicateInput,
  TaskboardMoveInput, TaskboardTask, TaskboardUpdateInput, TaskConnection, TaskExecutionId, TaskId, TaskRunRequestId,
} from '@deepseek-ai/dsh-taskboard/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskboardRuntimeState, TaskboardSettings } from './runtime-types.ts'

export type {
  TaskboardCreateInput, TaskboardDeleteValue, TaskboardMoveInput, TaskboardTask, TaskboardUpdateInput,
  AgencyCopilotSessionId, TaskboardUpdatePatch, TaskConnection, TaskExecution, TaskExecutionId,
  TaskExecutionSettings, TaskHandover, TaskId, TaskPriority, TaskRunRequestId, TaskSchedule, TaskScheduleInput, TaskStatus,
} from '@deepseek-ai/dsh-taskboard/types'
export type { TaskboardPowerState, TaskboardRuntimeState, TaskboardSettings } from './runtime-types.ts'

/** Optional Workspace filter for a current Taskboard snapshot. */
export interface TaskboardListRequest { readonly workspaceId?: WorkspaceId }
/** Requested tasks with authoritative Host runtime. */
export type TaskboardListValue = TaskboardBaseline
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
/** Admit work with a caller-owned identity that is safe to retry after a transport failure. */
export interface TaskboardRunRequest {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly requestId: TaskRunRequestId
  readonly initiator?: TaskConnection
}
/** Dispatch acknowledgement and its durable attempt identity; model completion remains asynchronous. */
export interface TaskboardRunValue { readonly task: TaskboardTask; readonly executionId: TaskExecutionId }
/** Select one validated existing conversation without submitting work. */
export type TaskboardConnectRequest = TaskboardConnectInput
/** Disconnect without deleting or submitting to the current conversation. */
export interface TaskboardDisconnectRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Restore an archived task with its schedule disabled. */
export interface TaskboardRestoreRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Confirm the saved execution permission and handover choices. */
export interface TaskboardConfirmPermissionsRequest { readonly taskId: TaskId; readonly expectedRevision: number }
/** Create an independent copy without connection, history, or permission confirmation. */
export type TaskboardDuplicateRequest = TaskboardDuplicateInput
/** Authoritative selectable execution options; an empty model catalog offers no inferred options. */
export interface TaskboardExecutionOptionsValue {
  readonly presets: readonly { readonly id: string; readonly name: string; readonly broken?: string; readonly isDefault: boolean }[]
  readonly permissions: readonly { readonly name: string }[]
  readonly models: readonly { readonly provider: string; readonly model: string; readonly name: string }[]
  readonly timeZone: string
  readonly copilotAvailable: boolean
}
/** Persist only explicitly edited Taskboard switches. */
export interface TaskboardUpdateSettingsRequest { readonly patch: Partial<TaskboardSettings> }

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
/** Navigate a current or retained historical Agency conversation without submitting work or recreating a missing conversation. */
export interface TaskboardOpenAgencyCopilotRequest {
  readonly taskId: TaskId
  /** Address a retained execution's connection instead of the current connection. */
  readonly executionId?: TaskExecutionId
}
/** Inspect transient Agency state for linked tasks without launching a process. */
export interface TaskboardInspectAgencyCopilotRequest { readonly taskIds: readonly TaskId[] }
/** Best-effort terminal handoff outcome for a linked Copilot identity. */
export interface TaskboardOpenAgencyCopilotValue {
  readonly outcome: 'launch-pending' | 'already-running' | 'resume-accepted'
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

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Task content or the selected Agency identity is invalid. */
    'taskboard/bad-request': Record<never, never>
    /** Execution admission, schedule, connection, or permission validation failed. */
    'taskboard/execution-error': { readonly taskId?: TaskId; readonly code: string }
    /** The requested task does not exist. */
    'taskboard/task-not-found': { readonly taskId: TaskId }
    /** The task is archived and cannot accept this operation. */
    'taskboard/task-archived': { readonly taskId: TaskId }
    /** The task's Workspace is not registered. */
    'taskboard/workspace-not-found': { readonly workspaceId: WorkspaceId }
    /** The durable task revision differs from the requested revision. */
    'taskboard/revision-conflict': { readonly taskId: TaskId; readonly expectedRevision: number; readonly actualRevision: number }
    /** The selected DSH Session does not belong to the task's Workspace. */
    'taskboard/session-invalid': { readonly workspaceId: WorkspaceId; readonly sessionId: SessionId }
    /** The task's destination cannot use the requested anchor. */
    'taskboard/move-invalid': { readonly beforeTaskId: TaskId }
    /** Agency discovery is unavailable or incomplete. */
    'taskboard/agency-unavailable': Record<never, never>
    /** This Host deployment does not permit native Agency launch. */
    'taskboard/agency-local-only': Record<never, never>
    /** The task has no matching Agency link for the requested operation. */
    'taskboard/agency-not-linked': { readonly taskId: TaskId }
    /** The task already has an Agency link. */
    'taskboard/agency-already-linked': { readonly taskId: TaskId }
    /** The linked Agency session belongs to another Workspace. */
    'taskboard/agency-workspace-mismatch': { readonly taskId: TaskId }
    /** The Agency terminal handoff failed. */
    'taskboard/agency-launch-failed': { readonly taskId: TaskId }
  }
}

/** Complete reconnect baseline of active and archived tasks in registered Workspaces. */
export interface TaskboardBaseline { readonly tasks: readonly TaskboardTask[]; readonly runtime: TaskboardRuntimeState }
/** One ordered task change; archives upsert, task or Workspace deletions remove. */
export type TaskboardFollowIncrement =
  | { readonly type: 'upsert'; readonly task: TaskboardTask }
  | { readonly type: 'remove'; readonly taskId: TaskId; readonly revision: number }
  | { readonly type: 'runtime'; readonly value: TaskboardRuntimeState }
/** Taskboard state stream; every generation begins with a complete baseline. */
export type TaskboardFollowFrame =
  | { readonly type: 'baseline'; readonly value: TaskboardBaseline }
  | TaskboardFollowIncrement
