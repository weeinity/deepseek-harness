/** Shared workflow ordering and manual destinations for projection and command validation. */
import type { TaskStatus } from './types.ts'

/** Board order shared with durable status validation. */
export const taskStatuses = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const satisfies readonly TaskStatus[]

/**
 * Derive manual destinations without exposing the current column as a transition.
 * @param status - Authoritative current task column.
 * @returns a detached list; Todo permits only Backlog, while other columns permit every other status.
 */
export function manualTaskStatuses(status: TaskStatus): readonly TaskStatus[] {
  return status === 'todo' ? ['backlog'] : taskStatuses.filter(candidate => candidate !== status)
}
