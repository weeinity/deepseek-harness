/** Browser-safe and Host service vocabulary for the durable Taskboard. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of one Taskboard task. */
export type TaskId = Branded<'TaskId'>

/** Stable identity of one local Agency GitHub Copilot CLI session. */
export type AgencyCopilotSessionId = Branded<'AgencyCopilotSessionId'>

/** The five visible Taskboard columns. */
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done'

/** Optional human-assigned task urgency. */
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

/** One durable Taskboard task. */
export interface TaskboardTask {
  readonly id: TaskId
  readonly revision: number
  readonly ordinal: number
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly description: string
  readonly status: TaskStatus
  readonly rank: number
  readonly priority?: TaskPriority
  readonly labels: readonly string[]
  readonly sessionId?: SessionId
  /** Independent local Agency Copilot terminal identity, never a DSH Session id. */
  readonly agencyCopilotSessionId?: AgencyCopilotSessionId
  readonly createdAt: string
  readonly updatedAt: string
  readonly archivedAt?: string
}

/** Fields accepted when creating a Taskboard task. */
export interface TaskboardCreateInput {
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly description?: string
  readonly status?: TaskStatus
  readonly priority?: TaskPriority
  readonly labels?: readonly string[]
  /** Existing Agency identity validated by the Host against this Workspace. */
  readonly agencyCopilotSessionId?: AgencyCopilotSessionId
}

/** Mutable task fields; null clears an optional value. */
export interface TaskboardUpdatePatch {
  readonly title?: string
  readonly description?: string
  readonly priority?: TaskPriority | null
  readonly labels?: readonly string[]
  readonly sessionId?: SessionId | null
  /** Host-validated Agency identity; omission retains it and null clears it. */
  readonly agencyCopilotSessionId?: AgencyCopilotSessionId | null
}

/** Compare-and-set task update request. */
export interface TaskboardUpdateInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly patch: TaskboardUpdatePatch
}

/** Durable task deletion receipt; the maximum safe revision permanently retires its UUID. */
export interface TaskboardDeleteValue {
  readonly taskId: TaskId
  /** Number.MAX_SAFE_INTEGER, matching Taskboard feed removal tombstones. */
  readonly revision: number
}

/** Dedicated compare-and-set mutation for a Host-validated Agency Copilot link. */
export interface TaskboardSetAgencyCopilotSessionInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly agencyCopilotSessionId: AgencyCopilotSessionId | null
}

/** Compare-and-set column and rank mutation. */
export interface TaskboardMoveInput {
  readonly taskId: TaskId
  readonly expectedRevision: number
  readonly status: TaskStatus
  readonly beforeTaskId?: TaskId
}
