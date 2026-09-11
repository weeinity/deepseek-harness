/** Projection of one validated durable task record into the public detached view. */
import type { TaskRecord } from './spec.ts'
import type { TaskboardTask, TaskId } from './types.ts'
import { manualTaskStatuses } from './status.ts'

/**
 * Detach a durable task record for callers and Remote feeds.
 * @param id - Stable task identity stored as the table key.
 * @param record - Validated durable task record.
 * @returns an exact-optional-safe detached Taskboard task.
 */
export function taskboardTaskView(id: TaskId, record: TaskRecord): TaskboardTask {
  const { format: _format, requests: _requests, ...task } = record
  // Records contain JSON values only; omitted optional keys stay absent in every nested value.
  return JSON.parse(JSON.stringify({
    id, ...task, allowedManualStatuses: manualTaskStatuses(record.status),
  })) as TaskboardTask
}
