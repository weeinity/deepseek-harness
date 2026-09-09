/** Projection of one validated durable task record into the public detached view. */
import type { TaskRecord } from './spec.ts'
import type { TaskboardTask, TaskId } from './types.ts'

/**
 * Detach a durable task record for callers and Remote feeds.
 * @param id - Stable task identity stored as the table key.
 * @param record - Validated durable task record.
 * @returns an exact-optional-safe detached Taskboard task.
 */
export function taskboardTaskView(id: TaskId, record: TaskRecord): TaskboardTask {
  const { labels, priority, sessionId, agencyCopilotSessionId, archivedAt, ...required } = record
  return {
    id,
    ...required,
    labels: [...labels],
    ...(priority === undefined ? {} : { priority }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(agencyCopilotSessionId === undefined ? {} : { agencyCopilotSessionId }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
  }
}
