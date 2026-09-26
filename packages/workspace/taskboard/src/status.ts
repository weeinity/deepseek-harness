/** Shared workflow ordering and manual destinations for projection and commands. */
import type { TaskStatus } from './types.ts'

/** Stable board order shared with durable task projection. */
export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const satisfies readonly TaskStatus[]

/**
 * Derive manual destinations without exposing the current column as a transition.
 * @param status - Authoritative current task column.
 * @returns a detached list containing every other status.
 */
export function manualTaskStatuses(status: TaskStatus): readonly TaskStatus[] {
  return taskStatuses.filter(candidate => candidate !== status)
}
