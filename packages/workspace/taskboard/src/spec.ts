/** Durable Taskboard domain declaration. */
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AgencyCopilotSessionId, TaskId, TaskPriority, TaskStatus } from './types.ts'

const taskId = z.string().transform(value => value as TaskId)
const workspaceId = z.string().transform(value => value as WorkspaceId)
const agencyCopilotSessionId = z.uuid().transform(value => value as AgencyCopilotSessionId)

/** Durable task status schema. */
export const taskStatus = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done']) satisfies z.ZodType<TaskStatus>
/** Durable task priority schema. */
export const taskPriority = z.enum(['low', 'medium', 'high', 'urgent']) satisfies z.ZodType<TaskPriority>

/** Stored value of one Taskboard task. */
export const taskRecord = z.object({
  revision: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  workspaceId,
  title: z.string(),
  description: z.string(),
  status: taskStatus,
  rank: z.number(),
  priority: taskPriority.optional(),
  labels: z.array(z.string()),
  sessionId: z.string().transform(SessionId).optional(),
  agencyCopilotSessionId: agencyCopilotSessionId.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
})

/** Stored task value inferred from the durability schema. */
export type TaskRecord = z.infer<typeof taskRecord>

/** Per-record Taskboard domain routed to its configured storage backend. */
export const taskboardDomainSpec = defineDomain({
  name: 'taskboard',
  version: 1,
  layout: 'per-record',
  tables: { tasks: domainTable<TaskId, TaskRecord>(taskRecord) },
})

/**
 * Brand a durable Taskboard key at the storage boundary.
 * @param value - Raw storage record key.
 * @returns branded Taskboard identity.
 */
export const storedTaskId = (value: string): TaskId => taskId.parse(value)
