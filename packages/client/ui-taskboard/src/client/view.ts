/** Pure Taskboard presentation derivations. */
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgencyCopilotObservationStatus, TaskboardTask, TaskPriority, TaskStatus,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TaskboardSurfaceProps } from './contract.ts'

/** Stable visible Taskboard column order. */
export const TASK_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']
/** Selectable task priorities in ascending order. */
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high', 'urgent']

type Translate = TaskboardSurfaceProps['t']

/**
 * Retain command diagnostics across direct and opaque rejections.
 * @param reason - Client command rejection or decoded Remote failure.
 * @returns the command diagnostic.
 */
export function taskboardErrorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Label the observed CLI state without implying a task has completed.
 * @param status - Most recent Agency observation, or unavailable when inspection failed.
 * @param t - Taskboard translator.
 * @returns localized CLI state.
 */
export function agencyStatusLabel(status: AgencyCopilotObservationStatus | 'unavailable' | undefined, t: Translate): string {
  switch (status) {
    case 'in_use': return t('copilotRunning')
    case 'idle': return t('copilotIdle')
    case 'missing': return t('copilotNotStarted')
    case 'workspace_mismatch': return t('copilotWorkspaceMismatch')
    case 'unavailable': return t('copilotUnavailable')
    case 'unknown':
    case undefined: return t('copilotUnknown')
    default: return assertNever(status)
  }
}

/**
 * Format a task timestamp using the shared relative-time buckets and the active locale.
 * @param t - Taskboard translator.
 * @param timestamp - Persisted task timestamp.
 * @param now - Current render time in epoch milliseconds.
 * @returns localized compact relative time.
 */
export function taskTimeLabel(t: Translate, timestamp: string, now: number): string {
  const { unit, n } = relativeTime(new Date(timestamp).getTime(), now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/** Return the localized status label.
 * @param t - Taskboard translator.
 * @param status - Durable column status.
 * @returns localized status label.
 */
export function statusLabel(t: Translate, status: TaskStatus): string {
  switch (status) {
    case 'backlog': return t('backlog')
    case 'todo': return t('todo')
    case 'in_progress': return t('inProgress')
    case 'in_review': return t('inReview')
    case 'done': return t('done')
    default: return assertNever(status)
  }
}

/** Return the localized priority label.
 * @param t - Taskboard translator.
 * @param priority - Optional task priority.
 * @returns localized priority label.
 */
export function priorityLabel(t: Translate, priority: TaskPriority | undefined): string {
  switch (priority) {
    case undefined: return t('priorityNone')
    case 'low': return t('priorityLow')
    case 'medium': return t('priorityMedium')
    case 'high': return t('priorityHigh')
    case 'urgent': return t('priorityUrgent')
    default: return assertNever(priority)
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable Taskboard value: ${String(value)}`)
}

/** Format the stable human-facing task identifier.
 * @param t - Taskboard translator.
 * @param task - Durable task.
 * @returns localized task code.
 */
export function taskCode(t: Translate, task: TaskboardTask): string {
  return t('taskId', { ordinal: String(task.ordinal).padStart(3, '0') })
}

/** Derive live execution decoration without changing durable task status.
 * @param task - Task with an optional linked Session.
 * @param sessions - Current DSH Session list state.
 * @returns live running, job, and blocked decoration.
 */
export function taskActivity(task: TaskboardTask, sessions: SessionListState): {
  readonly running: boolean
  readonly jobs: number
  readonly blocked: boolean
} {
  if (task.connection?.kind !== 'dsh') return { running: false, jobs: 0, blocked: false }
  const sessionId = task.connection.sessionId
  const projection: GoalProjection | null | undefined = sessions.byId[sessionId]?.projectionValues?.goal
  const blocked = projection?.goal.phase === 'blocked'
  return {
    running: sessions.byId[sessionId]?.running === true,
    jobs: sessions.jobsBySession[sessionId]?.filter(job => job.status === 'running' || job.status === 'stopping').length ?? 0,
    blocked,
  }
}

/** Resolve a task's current Workspace display title.
 * @param task - Workspace-owned task.
 * @param workspaces - Current Workspace projection.
 * @returns display title or raw Workspace id fallback.
 */
export function workspaceTitle(task: TaskboardTask, workspaces: WorkspaceSnapshot): string {
  return workspaces.items.find(workspace => workspace.workspaceId === task.workspaceId)?.title
    ?? String(task.workspaceId)
}
