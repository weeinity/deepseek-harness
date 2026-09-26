/** Serialized planning CAS and durable execution admission over one authoritative task row. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  TaskboardExecutionError, TaskboardInputError, TaskboardMoveInvalidError, TaskboardRevisionConflictError,
  TaskboardSessionInvalidError, TaskboardTaskArchivedError, TaskboardTaskNotFoundError, TaskboardWorkspaceNotFoundError,
} from './errors.ts'
import { taskboardTaskView } from './projection.ts'
import { taskExecutionPrompt } from './prompt.ts'
import { nextTaskScheduleRun } from './schedule.ts'
import { currentTaskRecord, taskboardDomainSpec, taskExecutionSettings, taskScheduleInput } from './spec.ts'
import type { TaskRecord } from './spec.ts'
import { taskStatuses } from './status.ts'
import type {
  AgencyCopilotSessionId as AgencyCopilotSessionIdBrand, TaskboardAdvanceExecutionInput, TaskboardAttachExecutionInput,
  TaskboardBeginExecutionInput, TaskboardBeginExecutionValue, TaskboardConnectInput, TaskboardCreateInput,
  TaskboardDeleteValue, TaskboardDuplicateInput, TaskboardMoveInput, TaskboardRecordExecutionErrorInput, TaskboardRollForwardScheduleInput,
  TaskboardRunRequestLookupInput, TaskboardSettleExecutionInput, TaskboardTask, TaskboardUpdateInput, TaskConnection, TaskExecution,
  TaskExecutionId as TaskExecutionIdBrand, TaskExecutionReceipt, TaskExecutionSettings, TaskHandover, TaskId as TaskIdBrand,
  TaskRunRequestId as TaskRunRequestIdBrand, TaskSchedule, TaskScheduleInput, TaskStatus,
} from './types.ts'

export type * from './types.ts'
export * from './errors.ts'
export { taskboardTaskView } from './projection.ts'
export { nextTaskScheduleRun } from './schedule.ts'
export {
  taskboardDomainSpec, currentTaskRecord, legacyTaskRecord, taskConnection, taskExecution, taskExecutionReceipt,
  taskExecutionSettings, taskHandover, taskPriority, taskRecord, taskSchedule, taskScheduleInput, taskStatus,
} from './spec.ts'

/** Stable identity of one task. */
export type TaskId = TaskIdBrand
/** Stable local Agency Copilot identity, separate from DSH Session identity. */
export type AgencyCopilotSessionId = AgencyCopilotSessionIdBrand
/** Stable identity of one admitted attempt. */
export type TaskExecutionId = TaskExecutionIdBrand
/** Stable caller-owned retry identity. */
export type TaskRunRequestId = TaskRunRequestIdBrand

/**
 * Brand a task identifier.
 * @param value - Raw task id.
 * @returns the compile-time branded identity.
 */
export function TaskId(value: string): TaskId { return value as TaskId }
/**
 * Brand a Host-validated Agency UUID.
 * @param value - UUID validated against the local Agency session store.
 * @returns the branded external conversation identity.
 */
export function AgencyCopilotSessionId(value: string): AgencyCopilotSessionId { return value as AgencyCopilotSessionId }
/**
 * Brand an execution identifier.
 * @param value - Host-generated attempt id.
 * @returns the branded execution identity.
 */
export function TaskExecutionId(value: string): TaskExecutionId { return value as TaskExecutionId }
/**
 * Brand a request identifier.
 * @param value - Caller-generated stable retry id.
 * @returns the branded request identity.
 */
export function TaskRunRequestId(value: string): TaskRunRequestId { return value as TaskRunRequestId }

/** Retention bounds, independently configurable for display and retry protection. */
export interface Config {
  /** Maximum settled attempts retained per task; open attempts are never pruned. */
  executionHistoryLimit?: number
  /** Maximum request receipts retained per task, including every open attempt's receipt. */
  requestDeduplicationLimit?: number
}

/** Validated Taskboard retention defaults. */
export const Config: Schema<Config> = Schema.object({
  executionHistoryLimit: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(20)
    .description('Maximum settled execution attempts retained per task.'),
  requestDeduplicationLimit: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256)
    .description('Maximum request deduplication receipts retained per task, including protected open attempts.'),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Workspace planning and execution state. */
    taskboard: TaskboardService
  }
}

const RANK_STEP = 1024
const ownershipRefresh = Symbol('taskboard.ownershipRefresh')
const ownershipDrain = Symbol('taskboard.ownershipDrain')
const ownershipAdvanceConversation = Symbol('taskboard.ownershipAdvanceConversation')

/** Host-owned activation, linked-conversation observations and quiescence of durable Taskboard writes. */
export interface TaskboardOwnershipCapability {
  /**
   * Reload durable records and bind this owner before exposing the Controller or admitting mutations.
   * @returns completion after fresh validation and ownership checks.
   */
  readonly refresh: () => Promise<void>
  /**
   * Revoke this owner's future admissions without cancelling mutations that have already started.
   * @returns completion after writes queued before revocation have settled; repeated calls share the same drain.
   */
  readonly drain: () => Promise<void>
  /**
   * Update only automatic column, rank, revision and update time; execution history and receipts stay unchanged.
   * @param task - Observed identity, revision, Workspace and connection, captured synchronously before queueing.
   * @param status - Column selected from the linked conversation's current activity.
   * @returns true for committed or identical placement; false for a superseded observation: a missing or archived row,
   * changed revision, Workspace or connection, absent connection, or any pending/running execution.
   * @throws when this owner is unbound, revoked or lost, the service is closing, or durability fails.
   */
  readonly advanceConversation: (task: TaskboardTask, status: 'in_review' | 'in_progress' | 'done') => Promise<boolean>
}

interface OwnershipAuthority {
  verify: () => Promise<void>
  drainage: Promise<void> | undefined
}

/**
 * Bind activation and write quiescence to one Host ownership lifetime.
 * @param taskboard - Initialized domain service whose cache may predate ownership acquisition.
 * @param verifyOwnership - Reject unless the caller holds ownership for this durable Taskboard unit.
 * @returns owner-bound refresh, linked-conversation placement, and drain closures.
 */
export function createTaskboardOwnershipCapability(
  taskboard: TaskboardService,
  verifyOwnership: () => Promise<void>,
): TaskboardOwnershipCapability {
  const authority: OwnershipAuthority = { verify: verifyOwnership, drainage: undefined }
  return {
    refresh: () => taskboard[ownershipRefresh](authority),
    drain: () => taskboard[ownershipDrain](authority),
    advanceConversation: (task, status) => taskboard[ownershipAdvanceConversation](authority, task, status),
  }
}

/** Durable commands; external provider dispatch belongs to the Host runner. */
export class TaskboardService extends Service {
  static inject = ['storageDomain', 'workspaceRegistry']
  static Config = Config
  private domain: Domain<typeof taskboardDomainSpec> | undefined
  private authority: OwnershipAuthority | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  /** Owning facility; Cordis invokes Symbol methods with the consumer's context. */
  private readonly storageDomain: DomainFacility
  private readonly executionHistoryLimit: number
  private readonly requestDeduplicationLimit: number

  /**
   * @param ctx - Context supplying storage and Workspace membership.
   * @param config - Validated retention limits.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'taskboard')
    const resolved = Config(config) as Required<Config>
    this.storageDomain = ctx.storageDomain
    this.executionHistoryLimit = resolved.executionHistoryLimit
    this.requestDeduplicationLimit = resolved.requestDeduplicationLimit
  }

  protected async [Service.init](): Promise<void> {
    this.domain = await this.storageDomain.open(taskboardDomainSpec)
    this.ctx.effect(() => async () => {
      this.closing = true
      await this.operationTail
      await this.domain?.close()
    }, 'taskboard.domainClose')
  }

  /**
   * Replace the cached domain under the startup owner's capability, without publishing intermediate records.
   * @param authority - New owner, checked independently of any previous Runtime.
   * @returns completion after the fresh table is available; failure leaves reads and writes unavailable.
   */
  [ownershipRefresh](authority: OwnershipAuthority): Promise<void> {
    return this.serialize(async () => {
      assertOwnershipActive(authority)
      if (this.authority !== undefined && this.authority !== authority) {
        this.authority.drainage ??= Promise.resolve()
      }
      this.authority = authority
      const previous = this.domain
      this.domain = undefined
      await previous?.close()
      await authority.verify()
      assertOwnershipActive(authority)
      this.assertNotClosing()
      const fresh = await this.storageDomain.open(taskboardDomainSpec)
      try {
        await authority.verify()
        assertOwnershipActive(authority)
        this.assertNotClosing()
      } catch (error) {
        await fresh.close()
        throw error
      }
      this.domain = fresh
    })
  }

  /**
   * Stop this capability's admissions and join writes already queued.
   * @param authority - Only this owner's admissions are revoked; a successor remains independent.
   * @returns the owner's stable quiescence promise.
   */
  [ownershipDrain](authority: OwnershipAuthority): Promise<void> {
    authority.drainage ??= this.operationTail
    return authority.drainage
  }

  /**
   * Commit a linked-conversation observation only while its task and owner remain current.
   * @param authority - Exact owner bound by refresh.
   * @param task - Task snapshot whose identifying fields are captured before enqueueing.
   * @param status - Observed automatic column.
   * @returns true for committed or identical placement; false for a superseded task observation.
   */
  [ownershipAdvanceConversation](
    authority: OwnershipAuthority, task: TaskboardTask, status: 'in_review' | 'in_progress' | 'done',
  ): Promise<boolean> {
    const { id, revision, workspaceId } = task
    const connection = task.connection === undefined ? undefined : { ...task.connection }
    return this.enqueue(async () => {
      const current = this.requireTasks().get(id)
      if (current === undefined || current.archivedAt !== undefined
        || current.revision !== revision || current.workspaceId !== workspaceId
        || current.connection === undefined || !same(current.connection, connection)
        || current.executions.some(isOpen)) return false
      await this.write(id, current, this.automaticStatus(current, status), undefined, 'preserve')
      return true
    }, authority)
  }

  /**
   * List in deterministic board order.
   * @param workspaceId - Optional Workspace filter.
   * @param includeArchived - Include archived records.
   * @returns deeply detached current tasks.
   */
  list(workspaceId?: WorkspaceId, includeArchived: boolean = false): TaskboardTask[] {
    return [...this.requireTasks().entries()]
      .map(([id, record]) => taskboardTaskView(id, record))
      .filter(task => (workspaceId === undefined || task.workspaceId === workspaceId)
        && (includeArchived || task.archivedAt === undefined))
      .sort(compareTasks)
  }

  /**
   * Read one task.
   * @param taskId - Stable identity.
   * @returns detached task or undefined when absent.
   */
  get(taskId: TaskId): TaskboardTask | undefined {
    const record = this.requireTasks().get(taskId)
    return record === undefined ? undefined : taskboardTaskView(taskId, record)
  }

  /**
   * Find a committed retry before provider resolution, even after its displayed history is pruned.
   * @param input - Original manual request identity, expected revision, and initiator; changed caller fields reject.
   * @returns the original execution identity and current task, or undefined for an absent or expired receipt.
   */
  getRunRequest(input: TaskboardRunRequestLookupInput): TaskboardBeginExecutionValue | undefined {
    const current = this.requireTasks().get(input.taskId)
    const receipt = current?.requests.find(item => item.requestId === input.requestId)
    if (current === undefined || receipt === undefined) return undefined
    if (receipt.fingerprint !== requestFingerprint({ ...input, trigger: 'manual' })) {
      throw new TaskboardExecutionError('request-conflict', 'Request id already names different caller inputs')
    }
    return { task: taskboardTaskView(input.taskId, current), executionId: receipt.executionId, replayed: true }
  }

  /**
   * Create a Todo task unless a column is explicit; an existing conversation commits in the same write.
   * @param input - Initial choices; the Host validates Copilot membership before selecting a connection.
   * @param signal - Cancellation checked before the durable write begins.
   * @returns committed task.
   */
  create(input: TaskboardCreateInput, signal?: AbortSignal): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(() => {
      signal?.throwIfAborted()
      return this.createRecord(detached)
    })
  }

  /**
   * Apply planning changes with CAS; open attempts forbid execution-input changes.
   * @param input - Exact revision and patch; null clears handover or schedule.
   * @param signal - Cancellation checked before durability begins.
   * @returns committed task, unchanged for a material no-op.
   */
  update(input: TaskboardUpdateInput, signal?: AbortSignal): Promise<TaskboardTask> {
    const { taskId, expectedRevision, patch } = structuredClone(input)
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.active(taskId, expectedRevision)
      const settings = patch.executionSettings === undefined ? current.executionSettings : normalizeSettings(patch.executionSettings)
      const workspaceId = patch.workspaceId ?? current.workspaceId
      const prompt = patch.prompt ?? current.prompt
      const handover = patch.handover === undefined ? current.handover : patch.handover ?? undefined
      const schedule = patch.schedule === undefined
        ? current.schedule
        : patch.schedule === null ? undefined : resolveSchedule(patch.schedule, taskboardTaskView(taskId, current).schedule)
      const executionChanged = workspaceId !== current.workspaceId || prompt !== current.prompt
        || !same(settings, current.executionSettings) || !same(handover, current.handover) || !same(schedule, current.schedule)
      if (executionChanged) assertNoOpen(current)
      if (workspaceId !== current.workspaceId) this.requireWorkspace(workspaceId)
      const pinned = current.connection !== undefined || current.unresolvedConnections !== undefined
      if (pinned && (workspaceId !== current.workspaceId || !sameComposition(settings, current.executionSettings))) {
        throw new TaskboardExecutionError('connection-conflict', 'Disconnect before changing Workspace, provider, or preset')
      }
      const permissionChanged = workspaceId !== current.workspaceId || !sameComposition(settings, current.executionSettings)
        || settings.permission !== current.executionSettings.permission || !same(handover, current.handover)
      return this.write(taskId, current, {
        ...current, workspaceId, executionSettings: settings, prompt, handover, schedule,
        title: patch.title === undefined ? current.title : normalizedTitle(patch.title),
        description: patch.description === undefined ? current.description : normalizedDescription(patch.description),
        priority: patch.priority === undefined ? current.priority : patch.priority ?? undefined,
        labels: patch.labels === undefined ? current.labels : normalizedLabels(patch.labels),
        permissionConfirmedAt: permissionChanged ? undefined : current.permissionConfirmedAt,
      })
    })
  }

  /**
   * Select the exclusive connection or one preserved legacy choice.
   * @param input - Exact revision and identity; caller validates Copilot Workspace membership.
   * @param signal - Cancellation checked before durability begins.
   * @returns committed connected task.
   */
  connect(input: TaskboardConnectInput, signal?: AbortSignal): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.active(detached.taskId, detached.expectedRevision)
      assertNoOpen(current)
      const settings = detached.executionSettings === undefined
        ? current.executionSettings : normalizeSettings(detached.executionSettings)
      const connection = detached.connection
      if (current.connection !== undefined && !same(connection, current.connection)) {
        throw new TaskboardExecutionError('connection-conflict', 'Disconnect before selecting another conversation')
      }
      if (current.unresolvedConnections !== undefined && !current.unresolvedConnections.some(item => same(item, connection))) {
        throw new TaskboardExecutionError('connection-conflict', 'Select one of the preserved legacy conversations')
      }
      if (connection.kind !== settings.kind) {
        throw new TaskboardExecutionError('settings-conflict', 'Connection provider must match task settings')
      }
      if (current.connection !== undefined && !sameComposition(settings, current.executionSettings)) {
        throw new TaskboardExecutionError('connection-conflict', 'Disconnect before changing the preset')
      }
      this.validateConnection(current.workspaceId, connection)
      return this.write(detached.taskId, current, {
        ...current, connection, unresolvedConnections: undefined, executionSettings: settings,
        permissionConfirmedAt: same(settings, current.executionSettings) ? current.permissionConfirmedAt : undefined,
      })
    })
  }

  /**
   * Clear connection choices without touching provider conversations.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact planning revision.
   * @param signal - Cancellation checked before durability begins.
   * @returns committed disconnected task.
   */
  disconnect(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.active(taskId, expectedRevision)
      assertNoOpen(current)
      return this.write(taskId, current, {
        ...current, connection: undefined, unresolvedConnections: undefined, permissionConfirmedAt: undefined,
      })
    })
  }

  /**
   * Record explicit approval of current permission and handover choices.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact revision displayed to the approving user.
   * @returns committed confirmation; open attempts reject.
   */
  confirmPermissions(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.active(taskId, expectedRevision)
      assertNoOpen(current)
      return this.write(taskId, current, { ...current, permissionConfirmedAt: new Date().toISOString() })
    })
  }

  /**
   * Move or reorder an active task with CAS.
   * @param input - Exact revision and destination.
   * @returns committed task or unchanged same-position task.
   */
  move(input: TaskboardMoveInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const { taskId, expectedRevision, status, beforeTaskId } = detached
      const current = this.active(taskId, expectedRevision)
      if (beforeTaskId === taskId) {
        if (status === current.status) return taskboardTaskView(taskId, current)
        throw new TaskboardMoveInvalidError(beforeTaskId)
      }
      const destination = this.list(current.workspaceId).filter(task => task.id !== taskId && task.status === status)
      const last = destination.at(-1)
      if (status === current.status && beforeTaskId === undefined && (last === undefined || last.rank < current.rank)) {
        return taskboardTaskView(taskId, current)
      }
      return this.write(taskId, current, { ...current, status, rank: rankBefore(destination, beforeTaskId) })
    })
  }

  /**
   * Archive without altering planning status or provider conversations; disable scheduling.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact revision.
   * @returns committed task or unchanged archived record.
   */
  archive(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.record(taskId, expectedRevision)
      assertNoOpen(current)
      if (current.archivedAt !== undefined) return taskboardTaskView(taskId, current)
      const now = new Date().toISOString()
      return this.write(taskId, current, {
        ...current, archivedAt: now,
        schedule: current.schedule === undefined ? undefined : { ...current.schedule, enabled: false, nextRunAt: undefined },
      }, now)
    })
  }

  /**
   * Restore archived planning state without enabling its schedule.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact revision.
   * @returns restored task or unchanged active record.
   */
  restore(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.record(taskId, expectedRevision)
      if (current.archivedAt === undefined) return taskboardTaskView(taskId, current)
      this.requireWorkspace(current.workspaceId)
      return this.write(taskId, current, {
        ...current, archivedAt: undefined,
        schedule: current.schedule === undefined ? undefined : { ...current.schedule, enabled: false, nextRunAt: undefined },
      })
    })
  }

  /**
   * Copy planning and execution choices with fresh identity, no history, and a disabled schedule.
   * @param input - Source revision and optional replacement title.
   * @param signal - Cancellation checked before durability begins.
   * @returns new task; the original is never archived or modified.
   */
  duplicate(input: TaskboardDuplicateInput, signal?: AbortSignal): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(() => {
      signal?.throwIfAborted()
      const current = this.record(detached.taskId, detached.expectedRevision)
      const source = taskboardTaskView(detached.taskId, current)
      const { connection: _connection, ...copy } = source
      return this.createRecord({
        ...copy,
        title: detached.title ?? current.title,
        ...(source.schedule === undefined ? {} : { schedule: {
          enabled: false, cron: source.schedule.cron, timeZone: source.schedule.timeZone,
        } }),
      })
    })
  }

  /**
   * Permanently delete a task without touching Workspace or provider conversations.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact revision checked before deletion.
   * @param signal - Cancellation checked before durability begins; submitted writes settle normally.
   * @returns permanent removal tombstone; an open attempt rejects.
   */
  delete(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardDeleteValue> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.record(taskId, expectedRevision)
      assertNoOpen(current)
      await this.requireTasks().delete(taskId)
      return { taskId, revision: Number.MAX_SAFE_INTEGER }
    })
  }

  /**
   * Persist pending admission, immutable inputs, and In Progress placement before external dispatch.
   * @param input - Stable retry id, execution pins, and manual CAS or exact due occurrence.
   * @param signal - Cancellation checked before durability begins.
   * @returns original execution id on matching replay, even with a stale task revision.
   */
  beginExecution(input: TaskboardBeginExecutionInput, signal?: AbortSignal): Promise<TaskboardBeginExecutionValue> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.record(detached.taskId)
      const fingerprint = requestFingerprint(detached)
      const receipt = current.requests.find(item => item.requestId === detached.requestId)
      if (receipt !== undefined) {
        if (receipt.fingerprint !== fingerprint) {
          throw new TaskboardExecutionError('request-conflict', 'Request id already names different execution inputs')
        }
        return { task: taskboardTaskView(detached.taskId, current), executionId: receipt.executionId, replayed: true }
      }
      if (current.executions.some(item => item.requestId === detached.requestId)) {
        throw new TaskboardExecutionError('request-conflict', 'Request receipt expired; use a new request id')
      }
      if (detached.trigger === 'manual') assertRevision(detached.taskId, current, detached.expectedRevision)
      if (current.archivedAt !== undefined) throw new TaskboardTaskArchivedError(detached.taskId)
      if (current.unresolvedConnections !== undefined) {
        throw new TaskboardExecutionError('unresolved-connections', 'Select one preserved conversation before running')
      }
      assertNoOpen(current)
      this.requireWorkspace(current.workspaceId)
      const settings = resolveExecutionSettings(detached.executionSettings)
      assertEffectiveSettings(current.executionSettings, settings)
      if (requiresPermissionConfirmation(current.executionSettings as TaskExecutionSettings)
        && current.permissionConfirmedAt === undefined) {
        throw new TaskboardExecutionError('permission-unconfirmed', 'Explicitly select and confirm elevated permissions before running')
      }
      const connection = current.connection ?? detached.proposedConnection
      if (connection === undefined) {
        throw new TaskboardExecutionError('connection-conflict', 'An unconnected task requires a Host-reserved conversation identity')
      }
      if (connection.kind !== settings.kind) {
        throw new TaskboardExecutionError('settings-conflict', 'Reserved conversation provider must match execution settings')
      }
      if (current.connection !== undefined) {
        if (detached.proposedConnection !== undefined && !same(current.connection, detached.proposedConnection)) {
          throw new TaskboardExecutionError('connection-conflict', 'Disconnect before reserving another conversation')
        }
        this.validateConnection(current.workspaceId, current.connection)
      }
      const now = new Date().toISOString()
      const schedule = detached.trigger === 'schedule' ? advancedSchedule(current, detached) : current.schedule
      const executionId = TaskExecutionId(randomUUID())
      const execution = {
        id: executionId, requestId: detached.requestId, trigger: detached.trigger,
        ...(detached.trigger === 'schedule' ? { scheduledAt: detached.scheduledAt } : {}),
        requestedAt: now, status: 'pending' as const, connection,
        createsConnection: current.connection === undefined, initiator: detached.initiator,
        workspaceId: current.workspaceId,
        prompt: taskExecutionPrompt(
          current.prompt.trim() === ''
            ? [current.title, current.description].filter(text => text.trim() !== '').join('\n\n')
            : current.prompt,
          current.handover as TaskHandover | undefined,
        ),
        executionSettings: settings, handover: current.handover,
      }
      const task = await this.write(detached.taskId, current, {
        ...this.automaticStatus(current, 'in_progress'), connection, schedule, executions: [...current.executions, execution],
        requests: [...current.requests, { requestId: detached.requestId, executionId, fingerprint }],
      }, now)
      return { task, executionId, replayed: false }
    })
  }

  /**
   * Persist an open attempt's connection, monotonic receipt, or diagnostic without changing its status.
   * @param input - Exact attempt and provider identity; the Host validates Copilot membership.
   * @returns committed task; already committed identities cannot be replaced.
   */
  attachExecution(input: TaskboardAttachExecutionInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const current = this.record(detached.taskId)
      const attempt = requireAttempt(current, detached.executionId)
      assertOpen(attempt)
      if (attempt.executionSettings.kind !== detached.connection.kind
        || (current.connection !== undefined && !same(current.connection, detached.connection))) {
        throw new TaskboardExecutionError('connection-conflict', 'An admitted attempt cannot replace its conversation')
      }
      this.validateConnection(attempt.workspaceId, detached.connection)
      const receipt = mergeReceipt(attempt.receipt, detached.receipt, detached.connection)
      return this.writeAttempt(detached.taskId, current, {
        ...attempt, connection: detached.connection, receipt,
        error: detached.error === undefined ? attempt.error : detached.error ?? undefined,
      }, { ...current, connection: detached.connection })
    })
  }

  /**
   * Observe running work; waiting for input places it in In Review, otherwise In Progress.
   * @param input - Exact attempt, optional input-wait flag, and receipt enrichment; the start timestamp is immutable.
   * @returns committed task, unchanged for a repeated observation; terminal attempts reject.
   */
  advanceExecution(input: TaskboardAdvanceExecutionInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const current = this.record(detached.taskId)
      const attempt = requireAttempt(current, detached.executionId)
      assertOpen(attempt)
      if (attempt.connection === undefined) throw new TaskboardExecutionError('execution-state', 'Attach a conversation before dispatch')
      if (attempt.receipt === undefined) {
        throw new TaskboardExecutionError('execution-state', 'Persist a provider cursor before dispatch')
      }
      if (attempt.startedAt !== undefined && detached.startedAt !== undefined && attempt.startedAt !== detached.startedAt) {
        throw new TaskboardExecutionError('execution-state', 'The committed start timestamp cannot change')
      }
      return this.writeAttempt(detached.taskId, current, {
        ...attempt, status: 'running',
        startedAt: attempt.startedAt ?? detached.startedAt ?? new Date().toISOString(),
        receipt: mergeReceipt(attempt.receipt, detached.receipt, attempt.connection),
        error: detached.error === undefined ? attempt.error : detached.error ?? undefined,
      }, this.automaticStatus(current, detached.waitingForInput === true ? 'in_review' : 'in_progress'))
    })
  }

  /**
   * Persist an open diagnostic without provider lookup or a pending/running transition.
   * @param input - Exact attempt and diagnostic, or null to clear it.
   * @returns committed task; terminal attempts reject and unchanged diagnostics are no-ops.
   */
  recordExecutionError(input: TaskboardRecordExecutionErrorInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const current = this.record(detached.taskId)
      const attempt = requireAttempt(current, detached.executionId)
      assertOpen(attempt)
      return this.writeAttempt(detached.taskId, current, { ...attempt, error: detached.error ?? undefined })
    })
  }

  /**
   * Settle one exact attempt into Done on success or In Review on failure/cancellation.
   * @param input - Terminal outcome; runtime settlement does not use planning CAS.
   * @returns committed task with the terminal diagnostic; matching repeats preserve subsequent human column changes.
   */
  settleExecution(input: TaskboardSettleExecutionInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const current = this.record(detached.taskId)
      const attempt = requireAttempt(current, detached.executionId)
      if (!isOpen(attempt)) {
        if (attempt.status === detached.status && same(attempt.error, detached.error)
          && (detached.endedAt === undefined || detached.endedAt === attempt.endedAt)) {
          return taskboardTaskView(detached.taskId, current)
        }
        throw new TaskboardExecutionError('execution-state', 'The committed terminal outcome cannot change')
      }
      return this.writeAttempt(detached.taskId, current, {
        ...attempt, status: detached.status, error: detached.error, endedAt: detached.endedAt ?? new Date().toISOString(),
      }, this.automaticStatus(current, detached.status === 'succeeded' ? 'done' : 'in_review'))
    })
  }

  /**
   * Advance a due busy/missed occurrence without opening an attempt.
   * @param input - Exact current occurrence and Host-calculated successor.
   * @returns committed task; stale or not-yet-due occurrences reject.
   */
  rollForwardSchedule(input: TaskboardRollForwardScheduleInput): Promise<TaskboardTask> {
    const detached = structuredClone(input)
    return this.enqueue(async () => {
      const current = this.active(detached.taskId)
      return this.write(detached.taskId, current, { ...current, schedule: advancedSchedule(current, detached) })
    })
  }

  private async createRecord(input: TaskboardCreateInput): Promise<TaskboardTask> {
    const workspace = this.requireWorkspace(input.workspaceId)
    const all = this.list(undefined, true)
    const status = input.status ?? 'todo'
    const executionSettings = normalizeSettings(input.executionSettings ?? { kind: 'dsh' })
    if (input.connection !== undefined) {
      if (input.connection.kind !== executionSettings.kind) {
        throw new TaskboardExecutionError('settings-conflict', 'Initial conversation provider must match task settings')
      }
      this.validateConnection(workspace.id, input.connection)
    }
    const now = new Date().toISOString()
    const id = TaskId(randomUUID())
    const record = parseRecord({
      format: 2, revision: 1,
      ordinal: all.reduce((largest, task) => Math.max(largest, task.ordinal), 0) + 1,
      workspaceId: workspace.id, title: normalizedTitle(input.title),
      description: normalizedDescription(input.description ?? ''), status,
      rank: appendRank(all.filter(task => task.workspaceId === workspace.id && task.status === status && task.archivedAt === undefined)),
      priority: input.priority, labels: normalizedLabels(input.labels ?? []),
      prompt: input.prompt ?? '', executionSettings, connection: input.connection,
      handover: input.handover, schedule: input.schedule === undefined ? undefined : resolveSchedule(input.schedule),
      executions: [], requests: [],
      createdAt: now, updatedAt: now,
    })
    await this.requireTasks().put(id, record)
    return taskboardTaskView(id, record)
  }

  private async write(
    taskId: TaskId, current: TaskRecord, candidate: unknown,
    now = new Date().toISOString(), history: 'prune' | 'preserve' = 'prune',
  ): Promise<TaskboardTask> {
    const parsed = parseRecord(candidate)
    if (same(parsed, current)) return taskboardTaskView(taskId, current)
    const settled = parsed.executions.filter(item => !isOpen(item))
    const kept = new Set(settled.slice(-this.executionHistoryLimit).map(item => item.id))
    const executions = parsed.executions.filter(item => isOpen(item) || kept.has(item.id))
    const openIds = new Set(executions.filter(isOpen).map(item => item.requestId))
    const capacity = this.requestDeduplicationLimit - openIds.size
    const settledRequests = parsed.requests.filter(item => !openIds.has(item.requestId))
    const retained = new Set((capacity === 0 ? [] : settledRequests.slice(-capacity)).map(item => item.requestId))
    const record = parseRecord({
      ...parsed, revision: current.revision + 1, updatedAt: now,
      executions: history === 'preserve' ? current.executions : executions,
      requests: history === 'preserve'
        ? current.requests : parsed.requests.filter(item => openIds.has(item.requestId) || retained.has(item.requestId)),
    })
    await this.requireTasks().put(taskId, record)
    return taskboardTaskView(taskId, record)
  }

  private writeAttempt(taskId: TaskId, current: TaskRecord, attempt: unknown, base = current): Promise<TaskboardTask> {
    return this.write(taskId, current, {
      ...base,
      executions: current.executions.map(item => item.id === (attempt as TaskExecution).id ? attempt : item),
    })
  }

  private automaticStatus(current: TaskRecord, status: TaskStatus): TaskRecord {
    if (current.status === status) return current
    const destination = this.list(current.workspaceId).filter(task => task.status === status)
    return { ...current, status, rank: appendRank(destination) }
  }

  private requireTasks(): KvTable<TaskId, TaskRecord> {
    if (this.domain === undefined) throw new Error('Taskboard domain is not initialized')
    return this.domain.table('tasks')
  }

  private record(taskId: TaskId, expectedRevision?: number): TaskRecord {
    const record = this.requireTasks().get(taskId)
    if (record === undefined) throw new TaskboardTaskNotFoundError(taskId)
    if (expectedRevision !== undefined) assertRevision(taskId, record, expectedRevision)
    return record
  }

  private active(taskId: TaskId, expectedRevision?: number): TaskRecord {
    const record = this.record(taskId, expectedRevision)
    if (record.archivedAt !== undefined) throw new TaskboardTaskArchivedError(taskId)
    return record
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new TaskboardWorkspaceNotFoundError(workspaceId)
    return workspace
  }

  private validateConnection(workspaceId: WorkspaceId, connection: TaskConnection): void {
    const workspace = this.requireWorkspace(workspaceId)
    if (connection.kind === 'dsh' && !workspace.sessionIds.includes(connection.sessionId)) {
      throw new TaskboardSessionInvalidError(workspaceId, connection.sessionId)
    }
  }

  private assertNotClosing(): void {
    if (this.closing) throw new Error('Taskboard service is closing')
  }

  private enqueue<T>(operation: () => Promise<T>, admittedAuthority = this.authority): Promise<T> {
    return this.serialize(async () => {
      const authority = admittedAuthority ?? this.authority
      if (authority !== undefined) {
        if (authority !== this.authority) {
          throw Object.assign(new Error('Taskboard ownership is unavailable'), { code: 'ownership-lost' })
        }
        assertOwnershipActive(authority)
        await authority.verify()
        assertOwnershipActive(authority)
      }
      return operation()
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Taskboard service is closing'))
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function assertOwnershipActive(authority: OwnershipAuthority): void {
  if (authority.drainage !== undefined) {
    throw Object.assign(new Error('Taskboard ownership is unavailable'), { code: 'ownership-lost' })
  }
}

/**
 * Determine whether the task needs explicit approval of its permission choice.
 * @param settings - Explicit saved task choices, not inferred Session settings.
 * @returns true for Copilot write access or DSH presets other than read-only and approval-gated workspace-write.
 */
export function requiresPermissionConfirmation(settings: TaskExecutionSettings): boolean {
  if (settings.kind === 'copilot') return settings.permission !== undefined && settings.permission !== 'read-only'
  return settings.permission !== undefined && settings.permission !== 'read-only' && settings.permission !== 'workspace-write'
}

function normalizeSettings(settings: TaskExecutionSettings): TaskExecutionSettings {
  return taskExecutionSettings.parse(settings) as TaskExecutionSettings
}

function resolveExecutionSettings(settings: TaskExecutionSettings): TaskExecutionSettings {
  return taskExecutionSettings.parse(settings.kind === 'copilot'
    ? { ...settings, permission: settings.permission ?? 'read-only' } : settings) as TaskExecutionSettings
}

function assertEffectiveSettings(configured: TaskRecord['executionSettings'], effective: TaskExecutionSettings): void {
  if (configured.kind !== effective.kind) throw new TaskboardExecutionError('settings-conflict', 'Execution provider differs from task settings')
  const permission = configured.kind === 'copilot' ? configured.permission ?? 'read-only' : configured.permission
  if (permission !== undefined && permission !== effective.permission) {
    throw new TaskboardExecutionError('settings-conflict', 'Resolved permission differs from the explicit task choice')
  }
  if (configured.kind === 'dsh' && effective.kind === 'dsh') {
    if (configured.presetId !== undefined && configured.presetId !== effective.presetId) {
      throw new TaskboardExecutionError('settings-conflict', 'Resolved preset differs from the explicit task choice')
    }
    if (configured.model !== undefined && (configured.model.provider !== effective.model?.provider
      || configured.model.model !== effective.model.model
      || (configured.model.reasoningEffort !== undefined && configured.model.reasoningEffort !== effective.model.reasoningEffort))) {
      throw new TaskboardExecutionError('settings-conflict', 'Resolved model differs from the explicit task choice')
    }
  } else if (configured.model !== undefined && configured.model !== effective.model) {
    throw new TaskboardExecutionError('settings-conflict', 'Resolved model differs from the explicit task choice')
  }
}

function sameComposition(left: TaskRecord['executionSettings'], right: TaskRecord['executionSettings']): boolean {
  return left.kind === right.kind && (left.kind !== 'dsh' || right.kind !== 'dsh' || left.presetId === right.presetId)
}

function requestFingerprint(input: {
  readonly taskId: TaskId
  readonly initiator?: TaskConnection
} & (
  | { readonly trigger: 'manual'; readonly expectedRevision: number }
  | { readonly trigger: 'schedule'; readonly scheduledAt: string }
)): string {
  // Defaults, successor calculations, and allocation candidates are Host-derived, not caller retry data.
  return createHash('sha256').update(JSON.stringify({
    taskId: input.taskId, trigger: input.trigger,
    initiator: input.initiator === undefined ? undefined : { kind: input.initiator.kind, sessionId: input.initiator.sessionId },
    ...(input.trigger === 'schedule' ? { scheduledAt: input.scheduledAt } : { expectedRevision: input.expectedRevision }),
  })).digest('hex')
}

function resolveSchedule(input: TaskScheduleInput, previous?: TaskSchedule): TaskSchedule {
  const selected = taskScheduleInput.parse(input)
  const nextRunAt = nextTaskScheduleRun(selected, new Date().toISOString())
  if (previous !== undefined && selected.enabled === previous.enabled
    && selected.cron === previous.cron && selected.timeZone === previous.timeZone) return previous
  return {
    ...selected,
    ...(selected.enabled ? { nextRunAt } : {}),
    ...(previous?.lastTriggeredAt === undefined ? {} : { lastTriggeredAt: previous.lastTriggeredAt }),
  }
}

function advancedSchedule(current: TaskRecord, input: TaskboardRollForwardScheduleInput): TaskRecord['schedule'] {
  const schedule = current.schedule
  if (schedule?.enabled !== true || schedule.nextRunAt !== input.scheduledAt) {
    throw new TaskboardExecutionError('schedule-stale', 'Schedule occurrence is disabled or has already advanced')
  }
  const due = Date.parse(input.scheduledAt)
  const next = Date.parse(input.nextRunAt)
  const now = input.now === undefined ? Date.now() : Date.parse(input.now)
  if (!Number.isFinite(due) || !Number.isFinite(next) || !Number.isFinite(now) || next <= due) {
    throw new TaskboardInputError('Schedule successor must be a valid timestamp after the current occurrence')
  }
  if (due > now) throw new TaskboardExecutionError('schedule-not-due', 'Schedule occurrence is not due')
  return { ...schedule, nextRunAt: input.nextRunAt, lastTriggeredAt: input.scheduledAt }
}

function mergeReceipt(existing: TaskRecord['executions'][number]['receipt'], incoming: TaskExecutionReceipt | undefined,
  connection: TaskConnection): TaskRecord['executions'][number]['receipt'] {
  if (incoming === undefined) return existing
  if (incoming.kind !== connection.kind) throw new TaskboardExecutionError('connection-conflict', 'Receipt provider differs from the conversation')
  if (existing === undefined) return incoming
  const { messageId: oldMessage, ...oldCursor } = existing
  const { messageId: newMessage, ...newCursor } = incoming
  if (!same(oldCursor, newCursor) || (oldMessage !== undefined && newMessage !== undefined && oldMessage !== newMessage)) {
    throw new TaskboardExecutionError('execution-state', 'The committed provider cursor or message identity cannot change')
  }
  return oldMessage === undefined ? incoming : existing
}

function requireAttempt(record: TaskRecord, id: TaskExecutionId): TaskRecord['executions'][number] {
  const attempt = record.executions.find(item => item.id === id)
  if (attempt === undefined) throw new TaskboardExecutionError('execution-not-found', `Execution '${id}' is absent or pruned`)
  return attempt
}
function isOpen(attempt: Pick<TaskExecution, 'status'>): boolean { return attempt.status === 'pending' || attempt.status === 'running' }
function assertOpen(attempt: Pick<TaskExecution, 'status'>): void {
  if (!isOpen(attempt)) throw new TaskboardExecutionError('execution-state', 'Execution is already settled')
}
function assertNoOpen(record: TaskRecord): void {
  if (record.executions.some(isOpen)) throw new TaskboardExecutionError('busy', 'Wait for the current attempt to settle')
}
function parseRecord(candidate: unknown): TaskRecord {
  return currentTaskRecord.parse(JSON.parse(JSON.stringify(candidate)))
}
function same(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right) }
function compareTasks(left: TaskboardTask, right: TaskboardTask): number {
  return taskStatuses.indexOf(left.status) - taskStatuses.indexOf(right.status) || left.rank - right.rank
    || left.ordinal - right.ordinal || String(left.id).localeCompare(String(right.id))
}
function normalizedTitle(title: string): string {
  const value = title.trim()
  if (value === '') throw new TaskboardInputError('Task title must not be blank')
  if (value.length > 240) throw new TaskboardInputError('Task title must not exceed 240 characters')
  return value
}
function normalizedDescription(description: string): string {
  if (description.length > 32_768) throw new TaskboardInputError('Task description must not exceed 32768 characters')
  return description
}
function normalizedLabels(labels: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of labels) {
    const label = raw.trim()
    if (label === '' || seen.has(label)) continue
    if (label.length > 40) throw new TaskboardInputError('Task labels must not exceed 40 characters')
    if (result.length === 12) throw new TaskboardInputError('A task may have at most 12 labels')
    seen.add(label)
    result.push(label)
  }
  return result
}
function assertRevision(taskId: TaskId, record: TaskRecord, expected: number): void {
  if (record.revision !== expected) throw new TaskboardRevisionConflictError(taskId, expected, record.revision)
}
function appendRank(tasks: readonly TaskboardTask[]): number {
  const largest = tasks.reduce((rank, task) => Math.max(rank, task.rank), -RANK_STEP)
  const rank = largest + RANK_STEP
  if (rank <= largest) throw new TaskboardInputError('No numeric rank remains at the column tail')
  return rank
}
function rankBefore(tasks: readonly TaskboardTask[], beforeTaskId?: TaskId): number {
  if (beforeTaskId === undefined) return appendRank(tasks)
  let previous: TaskboardTask | undefined
  for (const next of tasks) {
    if (next.id === beforeTaskId) {
      if (previous === undefined) return next.rank - RANK_STEP
      const rank = previous.rank + (next.rank - previous.rank) / 2
      if (!Number.isFinite(rank) || rank === previous.rank || rank === next.rank) throw new TaskboardMoveInvalidError(beforeTaskId)
      return rank
    }
    previous = next
  }
  throw new TaskboardMoveInvalidError(beforeTaskId)
}

export default TaskboardService
