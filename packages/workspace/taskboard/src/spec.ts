/** Validated current records and one-way decoding of released Taskboard records. */
import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  AgencyCopilotSessionId, TaskExecutionId, TaskId, TaskPriority, TaskRunRequestId, TaskStatus,
} from './types.ts'
import { taskStatuses } from './status.ts'

const taskId = z.string().min(1).transform(value => value as TaskId)
const workspaceId = z.string().min(1).transform(value => value as WorkspaceId)
const sessionId = z.string().min(1).transform(SessionId)
const copilotId = z.uuid().transform(value => value as AgencyCopilotSessionId)
const executionId = z.string().min(1).transform(value => value as TaskExecutionId)
const requestId = z.string().min(1).transform(value => value as TaskRunRequestId)
const timestamp = z.iso.datetime({ offset: true })
const text = z.string().max(32_768)

/** Durable workflow column, preserved as recorded on reads. */
export const taskStatus = z.enum(taskStatuses) satisfies z.ZodType<TaskStatus>
/** Durable human-assigned priority. */
export const taskPriority = z.enum(['low', 'medium', 'high', 'urgent']) satisfies z.ZodType<TaskPriority>
/** Exclusive provider conversation identity. */
export const taskConnection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dsh'), sessionId }).strict(),
  z.object({ kind: z.literal('copilot'), sessionId: copilotId }).strict(),
])
/** Durable task choices; omitted Copilot permission remains read-only when resolved. */
export const taskExecutionSettings = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dsh'),
    presetId: z.string().min(1).optional(),
    permission: z.string().min(1).optional(),
    model: z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).transform(value => value as ReasoningEffortId).optional(),
    }).strict().optional(),
  }).strict(),
  z.object({
    kind: z.literal('copilot'),
    model: z.string().min(1).optional(),
    permission: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
  }).strict(),
])
/** Frozen context retained independently of planning edits. */
export const taskHandover = z.object({
  goal: text, progress: text, next: text,
  references: z.array(z.string().max(4096)).max(64),
  source: taskConnection.optional(),
  frozenAt: timestamp,
}).strict()
const scheduleFields = {
  enabled: z.boolean(),
  cron: z.string().min(1).max(256),
  timeZone: z.string().min(1).max(128),
}
/** User-editable schedule fields; occurrence metadata cannot be supplied by callers. */
export const taskScheduleInput = z.object(scheduleFields).strict()
/** Validated durable occurrence metadata. */
export const taskSchedule = z.object({
  ...scheduleFields,
  nextRunAt: timestamp.optional(),
  lastTriggeredAt: timestamp.optional(),
}).strict().refine(value => !value.enabled || value.nextRunAt !== undefined, 'An enabled schedule needs nextRunAt')
/** Provider recovery cursor attached before external dispatch. */
export const taskExecutionReceipt = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dsh'), afterSequence: z.number().int().nonnegative(), messageId: z.string().min(1).optional(),
  }).strict(),
  z.object({
    kind: z.literal('copilot'), afterCursor: z.string().min(1).nullable(), messageId: z.string().min(1).optional(),
  }).strict(),
])
/** Stored immutable inputs and lifecycle facts for one attempt. */
export const taskExecution = z.object({
  id: executionId, requestId,
  trigger: z.enum(['manual', 'schedule']),
  scheduledAt: timestamp.optional(),
  requestedAt: timestamp,
  startedAt: timestamp.optional(),
  endedAt: timestamp.optional(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
  connection: taskConnection.optional(),
  createsConnection: z.boolean(),
  initiator: taskConnection.optional(),
  workspaceId,
  prompt: z.string().min(1).max(65_536),
  executionSettings: taskExecutionSettings,
  handover: taskHandover.optional(),
  receipt: taskExecutionReceipt.optional(),
  error: z.object({ code: z.string().min(1), message: text }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string): void => { ctx.addIssue({ code: 'custom', message }) }
  const open = value.status === 'pending' || value.status === 'running'
  if (open === (value.endedAt !== undefined)) invalid('Only settled attempts have endedAt')
  if ((value.trigger === 'schedule') !== (value.scheduledAt !== undefined)) invalid('Scheduled attempts need scheduledAt')
  if (value.status === 'running'
    && (value.startedAt === undefined || value.connection === undefined || value.receipt === undefined)) {
    invalid('Running attempts need startedAt, a connection, and a provider receipt')
  }
  if (value.status === 'pending' && value.startedAt !== undefined) invalid('Pending attempts cannot have startedAt')
  if (value.createsConnection && value.connection === undefined) invalid('Conversation creation requires its reserved identity')
  if (value.connection !== undefined && value.connection.kind !== value.executionSettings.kind) {
    invalid('Attempt connection kind must match its settings')
  }
  if (value.receipt !== undefined && value.receipt.kind !== value.connection?.kind) {
    invalid('Receipt kind must match the attached connection')
  }
  if (value.startedAt !== undefined && Date.parse(value.startedAt) < Date.parse(value.requestedAt)) {
    invalid('startedAt precedes admission')
  }
  if (value.endedAt !== undefined && Date.parse(value.endedAt) < Date.parse(value.startedAt ?? value.requestedAt)) {
    invalid('endedAt precedes the attempt')
  }
})

const planningFields = {
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  ordinal: z.number().int().positive(),
  workspaceId,
  title: z.string(),
  description: z.string(),
  status: taskStatus,
  rank: z.number(),
  priority: taskPriority.optional(),
  labels: z.array(z.string()),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.optional(),
}

/** Released V1 record; the absence of a format tag is not accepted for current fields. */
export const legacyTaskRecord = z.object({
  ...planningFields,
  sessionId: sessionId.optional(),
  agencyCopilotSessionId: copilotId.optional(),
}).strict()

/** Current authoritative record; request receipts outlive displayed attempt retention. */
export const currentTaskRecord = z.object({
  format: z.literal(2),
  ...planningFields,
  connection: taskConnection.optional(),
  unresolvedConnections: z.array(taskConnection).min(2).max(2).optional(),
  prompt: z.string().max(65_536),
  executionSettings: taskExecutionSettings,
  executions: z.array(taskExecution),
  schedule: taskSchedule.optional(),
  handover: taskHandover.optional(),
  permissionConfirmedAt: timestamp.optional(),
  requests: z.array(z.object({ requestId, executionId, fingerprint: z.string().min(1) }).strict()),
}).strict().superRefine((value, ctx) => {
  const invalid = (message: string): void => { ctx.addIssue({ code: 'custom', message }) }
  if (value.connection !== undefined && value.connection.kind !== value.executionSettings.kind) {
    invalid('Current connection kind must match task settings')
  }
  if (value.unresolvedConnections !== undefined) {
    if (value.connection !== undefined || new Set(value.unresolvedConnections.map(item => item.kind)).size !== 2) {
      invalid('Unresolved legacy choices must contain both kinds and no current connection')
    }
  }
  const open = value.executions.filter(item => item.status === 'pending' || item.status === 'running')
  if (open.length > 1) invalid('Only one attempt may remain open')
  if (open.length !== 0 && (value.archivedAt !== undefined || value.unresolvedConnections !== undefined)) {
    invalid('Archived or unresolved tasks cannot have open attempts')
  }
  for (const attempt of open) {
    if (attempt.workspaceId !== value.workspaceId || attempt.executionSettings.kind !== value.executionSettings.kind
      || JSON.stringify(attempt.connection) !== JSON.stringify(value.connection)) {
      invalid('Open attempt must retain the task Workspace and current connection')
    }
    if (!value.requests.some(request => request.requestId === attempt.requestId && request.executionId === attempt.id)) {
      invalid('Open attempt must retain its request receipt')
    }
  }
  if (value.archivedAt !== undefined && value.schedule?.enabled === true) invalid('Archived schedules must be disabled')
  if (new Set(value.executions.map(item => item.id)).size !== value.executions.length
    || new Set(value.executions.map(item => item.requestId)).size !== value.executions.length
    || new Set(value.requests.map(item => item.requestId)).size !== value.requests.length
    || new Set(value.requests.map(item => item.executionId)).size !== value.requests.length) {
    invalid('Attempt and request identities must be unique')
  }
  for (const request of value.requests) {
    const attempt = value.executions.find(item => item.id === request.executionId || item.requestId === request.requestId)
    if (attempt !== undefined && (attempt.id !== request.executionId || attempt.requestId !== request.requestId)) {
      invalid('Request receipt and retained attempt identities must agree')
    }
  }
})

/** Current record type shared by storage and projection. */
export type TaskRecord = z.infer<typeof currentTaskRecord>

/** Validating one-way V1 decoder; no history or legacy choice is discarded. */
export const taskRecord = z.union([
  currentTaskRecord,
  legacyTaskRecord.transform((legacy): z.input<typeof currentTaskRecord> => {
    const { sessionId: dsh, agencyCopilotSessionId: copilot, ...planning } = legacy
    const connections = [
      ...(dsh === undefined ? [] : [{ kind: 'dsh' as const, sessionId: dsh }]),
      ...(copilot === undefined ? [] : [{ kind: 'copilot' as const, sessionId: copilot }]),
    ]
    return {
      ...planning, format: 2 as const,
      prompt: legacy.description === '' ? legacy.title : `${legacy.title}\n\n${legacy.description}`,
      executionSettings: connections.length === 1 && copilot !== undefined
        ? { kind: 'copilot' as const, permission: 'read-only' as const }
        : { kind: 'dsh' as const },
      executions: [], requests: [],
      ...(connections.length === 1 ? { connection: connections[0] } : {}),
      ...(connections.length === 2 ? { unresolvedConnections: connections } : {}),
    }
  }).pipe(currentTaskRecord),
])

/** V2 writes with explicit compatibility for validated V1 decoding. */
export const taskboardDomainSpec = defineDomain({
  name: 'taskboard',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  tables: { tasks: domainTable<TaskId, TaskRecord>(taskRecord) },
})

/**
 * Brand a durable table key.
 * @param value - Raw storage key.
 * @returns validated nonempty task identity.
 */
export const storedTaskId = (value: string): TaskId => taskId.parse(value)
