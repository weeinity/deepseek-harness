/** Semantic errors exposed by durable Taskboard commands. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskId } from './types.ts'

/** Task lookup failed. */
export class TaskboardTaskNotFoundError extends Error {
  /** @param taskId - Missing task identity. */
  constructor(readonly taskId: TaskId) {
    super(`Task '${taskId}' not found`)
    this.name = 'TaskboardTaskNotFoundError'
  }
}

/** A caller mutated an obsolete revision. */
export class TaskboardRevisionConflictError extends Error {
  /**
   * @param taskId - Conflicting task identity.
   * @param expected - Caller revision.
   * @param actual - Authoritative revision.
   */
  constructor(readonly taskId: TaskId, readonly expected: number, readonly actual: number) {
    super(`Task '${taskId}' revision ${expected} is stale; current revision is ${actual}`)
    this.name = 'TaskboardRevisionConflictError'
  }
}

/** A task request named an unavailable Workspace. */
export class TaskboardWorkspaceNotFoundError extends Error {
  /** @param workspaceId - Missing Workspace identity. */
  constructor(readonly workspaceId: WorkspaceId) {
    super(`Workspace '${workspaceId}' not found`)
    this.name = 'TaskboardWorkspaceNotFoundError'
  }
}

/** A DSH connection does not belong to the task Workspace. */
export class TaskboardSessionInvalidError extends Error {
  /**
   * @param workspaceId - Task Workspace.
   * @param sessionId - Invalid Session identity.
   */
  constructor(readonly workspaceId: WorkspaceId, readonly sessionId: SessionId) {
    super(`Session '${sessionId}' is not accounted to Workspace '${workspaceId}'`)
    this.name = 'TaskboardSessionInvalidError'
  }
}

/** A rank anchor is absent or belongs to another visible column. */
export class TaskboardMoveInvalidError extends Error {
  /** @param beforeTaskId - Invalid destination anchor. */
  constructor(readonly beforeTaskId: TaskId) {
    super(`Task rank anchor '${beforeTaskId}' is not in the destination column`)
    this.name = 'TaskboardMoveInvalidError'
  }
}

/** An archived task must be restored before ordinary mutation. */
export class TaskboardTaskArchivedError extends Error {
  /** @param taskId - Archived task identity. */
  constructor(readonly taskId: TaskId) {
    super(`Task '${taskId}' is archived`)
    this.name = 'TaskboardTaskArchivedError'
  }
}

/** A command failed semantic input validation. */
export class TaskboardInputError extends Error {
  /** @param message - Human-readable validation failure. */
  constructor(message: string) {
    super(message)
    this.name = 'TaskboardInputError'
  }
}

/** Admission or lifecycle preconditions failed without changing durable state. */
export class TaskboardExecutionError extends Error {
  /**
   * @param code - Stable reason for the rejected command.
   * @param message - Human-readable recovery guidance.
   */
  constructor(
    readonly code: 'busy' | 'unresolved-connections' | 'connection-conflict' | 'settings-conflict'
      | 'permission-unconfirmed' | 'request-conflict' | 'execution-not-found' | 'execution-state'
      | 'schedule-stale' | 'schedule-not-due',
    message: string,
  ) {
    super(message)
    this.name = 'TaskboardExecutionError'
  }
}
