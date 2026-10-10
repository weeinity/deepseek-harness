/** Browser-safe planning, connection, and durable execution types. */
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of one Taskboard task. */
export type TaskId = Branded<'TaskId'>
/** Stable identity of one local Agency GitHub Copilot CLI session. */
export type AgencyCopilotSessionId = Branded<'AgencyCopilotSessionId'>
/** Stable identity of one admitted execution attempt. */
export type TaskExecutionId = Branded<'TaskExecutionId'>
/** Caller-owned retry identity, deduplicated independently of displayed attempts. */
export type TaskRunRequestId = Branded<'TaskRunRequestId'>
/** Workflow columns updated by execution observations and permitted manual moves. */
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done'
/** Optional human-assigned task urgency. */
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

/** The sole current conversation; changing its identity requires disconnect. */
export type TaskConnection =
  | { readonly kind: 'dsh'; readonly sessionId: SessionId }
  | { readonly kind: 'copilot'; readonly sessionId: AgencyCopilotSessionId }

/** Explicit task choices; omitted DSH values inherit the connected Session or Host defaults for a new conversation. */
export type TaskExecutionSettings =
  | {
    readonly kind: 'dsh'
    readonly presetId?: AgentPresetRow['id']
    readonly permission?: string
    readonly model?: {
      readonly provider: string
      readonly model: string
      readonly reasoningEffort?: ReasoningEffortId
    }
  }
  | {
    readonly kind: 'copilot'
    readonly model?: string
    /** Omission resolves to read-only, never broader access. */
    readonly permission?: 'read-only' | 'workspace-write' | 'full-access'
  }

/** Frozen user-reviewed context for a subsequent attempt. */
export interface TaskHandover {
  readonly goal: string
  readonly progress: string
  readonly next: string
  readonly references: readonly string[]
  readonly source?: TaskConnection
  readonly frozenAt: string
}

/** User-editable numeric five-field cron expression and explicit IANA timezone. */
export interface TaskScheduleInput {
  readonly enabled: boolean
  readonly cron: string
  readonly timeZone: string
}

/** Domain-calculated occurrence metadata committed with scheduled admission. */
export interface TaskSchedule extends TaskScheduleInput {
  readonly nextRunAt?: string
  readonly lastTriggeredAt?: string
}

/** Provider-owned durable inbox/event cursor for recovery, not a planning status. */
export type TaskExecutionReceipt =
  | { readonly kind: 'dsh'; readonly afterSequence: number; readonly messageId?: string }
  | { readonly kind: 'copilot'; readonly afterCursor: string | null; readonly messageId?: string }

/** Provider or reconciliation diagnostic; its presence does not imply a terminal outcome. */
export interface TaskExecutionDiagnostic {
  readonly code: string
  readonly message: string
}

/** One durable attempt with immutable dispatch inputs and monotonic lifecycle. */
export interface TaskExecution {
  readonly id: TaskExecutionId
  readonly requestId: TaskRunRequestId
  readonly trigger: 'manual' | 'schedule'
  readonly scheduledAt?: string
  readonly requestedAt: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  readonly connection?: TaskConnection
  /** Only the first reservation may materialize this conversation. */
  readonly createsConnection: boolean
  /** Conversation that requested this run, retained for an optional completion announcement. */
  readonly initiator?: TaskConnection
  readonly workspaceId: WorkspaceId
  /** Exact submitted user-message text, including frozen handover; adapters must not append it again. */
  readonly prompt: string
  readonly executionSettings: TaskExecutionSettings
  readonly handover?: TaskHandover
  readonly receipt?: TaskExecutionReceipt
  readonly error?: TaskExecutionDiagnostic
}

/** Detached task state and derived manual destinations; omitted optional values are absent. */
export interface TaskboardTask {
  readonly id: TaskId
  readonly revision: number
  readonly ordinal: number
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  /** Derived manual destinations, excluding the current column; never stored in the task record. */
  readonly allowedManualStatuses: readonly TaskStatus[]
  readonly rank: number
  readonly priority?: TaskPriority
  readonly labels: readonly string[]
  readonly connection?: TaskConnection
  /** Preserved legacy choices; admission is blocked until one is explicitly selected. */
  readonly unresolvedConnections?: readonly TaskConnection[]
  /** A blank prompt uses the current title and nonblank description, separated by a blank line, at admission. */
  readonly prompt: string
  readonly executionSettings: TaskExecutionSettings
  readonly executions: readonly TaskExecution[]
  readonly schedule?: TaskSchedule
  readonly handover?: TaskHandover
  /** Explicit approval of current permission and handover choices. */
  readonly permissionConfirmedAt?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt?: string
}

/** New task fields; an existing connection commits atomically and is never changed through planning edits. */
export interface TaskboardCreateInput {
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly description?: string
  /** Omission starts the task in Todo. */
  readonly status?: TaskStatus
  readonly priority?: TaskPriority
  readonly labels?: readonly string[]
  readonly prompt?: string
  readonly executionSettings?: TaskExecutionSettings
  /** Existing conversation; the Host validates Copilot membership before calling create. */
  readonly connection?: TaskConnection
  readonly schedule?: TaskScheduleInput
  readonly handover?: TaskHandover
}

/** Mutable task fields; null explicitly clears an optional value. */
export interface TaskboardUpdatePatch {
  readonly workspaceId?: WorkspaceId
  readonly title?: string
  readonly description?: string
  readonly priority?: TaskPriority | null
  readonly labels?: readonly string[]
  readonly prompt?: string
  readonly executionSettings?: TaskExecutionSettings
  readonly schedule?: TaskScheduleInput | null
  readonly handover?: TaskHandover | null
}

/** Revision-checked planning mutation. */
export interface TaskboardUpdateInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly patch: TaskboardUpdatePatch
}

/** Revision-checked selection; the Host validates Copilot Workspace membership. */
export interface TaskboardConnectInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly connection: TaskConnection
  /** Required when selecting a legacy choice of another configured kind. */
  readonly executionSettings?: TaskExecutionSettings
}

/** Revision-checked duplication; the source remains unchanged. */
export interface TaskboardDuplicateInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly title?: string
}

/** Durable deletion receipt, permanently retiring the task UUID. */
export interface TaskboardDeleteValue {
  readonly taskId: TaskId
  readonly revision: number
}

/** Compare-and-set column and rank mutation. */
export interface TaskboardMoveInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly status: TaskStatus
  readonly beforeTaskId?: TaskId
}

/** Admission inputs; supplied pins retain explicit task choices, while omitted DSH values preserve inheritance intent. */
export type TaskboardBeginExecutionInput = {
  readonly taskId: TaskId
  readonly requestId: TaskRunRequestId
  readonly executionSettings: TaskExecutionSettings
  /** Host-minted identity required for an unconnected task; never replaces a current connection. */
  readonly proposedConnection?: TaskConnection
  readonly initiator?: TaskConnection
} & (
  | { readonly trigger: 'manual'; readonly expectedRevision: number }
  | {
    readonly trigger: 'schedule'
    readonly scheduledAt: string
    readonly nextRunAt: string
    /** Host clock used for deterministic due-occurrence comparison. */
    readonly now?: string
  }
)

/** Replays return the original identity even after its displayed attempt is pruned. */
export interface TaskboardBeginExecutionValue {
  readonly task: TaskboardTask
  readonly executionId: TaskExecutionId
  readonly replayed: boolean
}

/** Retry lookup using caller-owned fields, before resolving provider defaults or inspecting conversations. */
export interface TaskboardRunRequestLookupInput {
  readonly taskId: TaskId
  readonly requestId: TaskRunRequestId
  readonly expectedRevision: number
  readonly initiator?: TaskConnection
}

/** Persist an open attempt's reserved identity, receipt, or diagnostic without changing its status. */
export interface TaskboardAttachExecutionInput {
  readonly taskId: TaskId
  readonly executionId: TaskExecutionId
  readonly connection: TaskConnection
  readonly receipt?: TaskExecutionReceipt
  /** Omission preserves an open diagnostic; null explicitly clears it without changing execution status. */
  readonly error?: TaskExecutionDiagnostic | null
}

/** Observe running work and its input requirement without replacing committed receipt or start facts. */
export interface TaskboardAdvanceExecutionInput {
  readonly taskId: TaskId
  readonly executionId: TaskExecutionId
  readonly receipt?: TaskExecutionReceipt
  readonly startedAt?: string
  /** True places the task in In Review; omitted or false places active work in In Progress. */
  readonly waitingForInput?: boolean
  /** Omission preserves an open diagnostic; null explicitly clears it. */
  readonly error?: TaskExecutionDiagnostic | null
}

/** Diagnostic-only write that does not require the provider or Workspace to remain available. */
export interface TaskboardRecordExecutionErrorInput {
  readonly taskId: TaskId
  readonly executionId: TaskExecutionId
  /** Null clears the diagnostic without changing lifecycle status. */
  readonly error: TaskExecutionDiagnostic | null
}

/** Settle exactly one open attempt without relying on an old planning revision. */
export interface TaskboardSettleExecutionInput {
  readonly taskId: TaskId
  readonly executionId: TaskExecutionId
  readonly status: 'succeeded' | 'failed' | 'cancelled'
  readonly error?: TaskExecutionDiagnostic
  readonly endedAt?: string
}

/** Skip a due busy/missed occurrence without manufacturing an execution attempt. */
export interface TaskboardRollForwardScheduleInput {
  readonly taskId: TaskId
  readonly scheduledAt: string
  readonly nextRunAt: string
  readonly now?: string
}
