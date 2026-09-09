/** Durable revision-checked Taskboard service over the domain data form. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { taskboardTaskView } from './projection.ts'
import { taskboardDomainSpec, taskRecord } from './spec.ts'
import type { TaskRecord } from './spec.ts'
import type {
  AgencyCopilotSessionId as AgencyCopilotSessionIdBrand, TaskboardCreateInput, TaskboardDeleteValue, TaskboardMoveInput,
  TaskboardSetAgencyCopilotSessionInput, TaskboardTask, TaskboardUpdateInput, TaskId as TaskIdBrand, TaskStatus,
} from './types.ts'

export type * from './types.ts'
export { taskboardTaskView } from './projection.ts'
export { taskboardDomainSpec, taskPriority, taskRecord, taskStatus } from './spec.ts'

/** Stable identity of one Taskboard task. */
export type TaskId = TaskIdBrand

/**
 * Brand a raw string as a Taskboard identity.
 * @param value - Raw task id.
 * @returns the compile-time branded identity.
 */
export function TaskId(value: string): TaskId { return value as TaskId }

/** Stable identity of one local Agency GitHub Copilot CLI session. */
export type AgencyCopilotSessionId = AgencyCopilotSessionIdBrand

/**
 * Brand a validated UUID as an Agency Copilot session identity.
 * @param value - UUID minted by the Host or validated in an Agency local-session row.
 * @returns the separately branded external identity.
 */
export function AgencyCopilotSessionId(value: string): AgencyCopilotSessionId {
  return value as AgencyCopilotSessionId
}

/** Task lookup failed. */
export class TaskboardTaskNotFoundError extends Error {
  /** @param taskId - Missing task identity. */
  constructor(readonly taskId: TaskId) {
    super(`Task '${taskId}' not found`)
    this.name = 'TaskboardTaskNotFoundError'
  }
}

/** A caller mutated an obsolete task revision. */
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

/** A Session link does not belong to the task's Workspace. */
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

/** An archived task cannot return to an active board through ordinary mutation. */
export class TaskboardTaskArchivedError extends Error {
  /** @param taskId - Archived task identity. */
  constructor(readonly taskId: TaskId) {
    super(`Task '${taskId}' is archived`)
    this.name = 'TaskboardTaskArchivedError'
  }
}

/** A Taskboard command failed its semantic input validation. */
export class TaskboardInputError extends Error {
  /** @param message - Stable human-readable validation failure. */
  constructor(message: string) {
    super(message)
    this.name = 'TaskboardInputError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Workspace Taskboard service. */
    taskboard: TaskboardService
  }
}

const STATUS_ORDER: readonly TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']
const RANK_STEP = 1024

/** Durable Taskboard command and query service. */
export class TaskboardService extends Service {
  static inject = ['storageDomain', 'workspaceRegistry']

  private tasks?: KvTable<TaskId, TaskRecord>
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false

  /** @param ctx - Host context containing storage and Workspace services. */
  constructor(ctx: Context) { super(ctx, 'taskboard') }

  /** Open the durable domain and attach its drain-before-close lifecycle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(taskboardDomainSpec)
    this.tasks = domain.table('tasks')
    this.ctx.effect(() => async () => {
      this.closing = true
      await this.operationTail
      await domain.close()
    }, 'taskboard.domainClose')
  }

  /**
   * List tasks in deterministic board order.
   * @param workspaceId - Optional Workspace filter.
   * @param includeArchived - Include archived tasks when true.
   * @returns detached current tasks.
   */
  list(workspaceId?: WorkspaceId, includeArchived: boolean = false): TaskboardTask[] {
    const rows = [...this.requireTasks().entries()]
      .map(([id, record]) => taskboardTaskView(id, record))
      .filter(task => (workspaceId === undefined || task.workspaceId === workspaceId)
        && (includeArchived || task.archivedAt === undefined))
    return rows.sort(compareTasks)
  }

  /**
   * Read one task by identity.
   * @param taskId - Stable task identity.
   * @returns detached task or undefined when absent.
   */
  get(taskId: TaskId): TaskboardTask | undefined {
    const record = this.requireTasks().get(taskId)
    return record === undefined ? undefined : taskboardTaskView(taskId, record)
  }

  /**
   * Create a durable task and optional Host-validated Agency link in one write.
   * @param input - Initial fields; the caller must validate an Agency identity against its Workspace.
   * @param signal - Cancellation checked at the serialized write slot, before durability begins.
   * @returns the committed task.
   */
  create(input: TaskboardCreateInput, signal?: AbortSignal): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const workspace = this.requireWorkspace(input.workspaceId)
      const status = input.status ?? 'backlog'
      const allTasks = this.list(undefined, true)
      const destination = allTasks.filter(task => task.workspaceId === workspace.id
        && task.archivedAt === undefined && task.status === status)
      const id = TaskId(randomUUID())
      const now = new Date().toISOString()
      const candidate: TaskRecord = {
        revision: 1,
        ordinal: allTasks.reduce((largest, task) => Math.max(largest, task.ordinal), 0) + 1,
        workspaceId: workspace.id,
        title: normalizedTitle(input.title),
        description: normalizedDescription(input.description ?? ''),
        status,
        rank: appendRank(destination),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        labels: normalizedLabels(input.labels ?? []),
        ...(input.agencyCopilotSessionId === undefined ? {} : { agencyCopilotSessionId: input.agencyCopilotSessionId }),
        createdAt: now,
        updatedAt: now,
      }
      const record = taskRecord.parse(candidate)
      await this.requireTasks().put(id, record)
      return taskboardTaskView(id, record)
    })
  }

  /**
   * Update content and independent Session links in one revision-checked write.
   * @param input - Mutable fields; the caller must validate a newly selected Agency identity against the task Workspace.
   * @param signal - Cancellation checked at the serialized write slot, before durability begins.
   * @returns the committed task, or the unchanged task for a material no-op.
   */
  update(input: TaskboardUpdateInput, signal?: AbortSignal): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.requireActiveRecord(input.taskId)
      assertRevision(input.taskId, current, input.expectedRevision)
      const sessionId = input.patch.sessionId === undefined ? current.sessionId : input.patch.sessionId ?? undefined
      if (sessionId !== undefined) this.assertSession(current.workspaceId, sessionId)
      const agencyCopilotSessionId = input.patch.agencyCopilotSessionId === undefined
        ? current.agencyCopilotSessionId
        : input.patch.agencyCopilotSessionId ?? undefined
      if (agencyCopilotSessionId !== undefined && agencyCopilotSessionId !== current.agencyCopilotSessionId) {
        this.requireWorkspace(current.workspaceId)
      }
      const priority = input.patch.priority === undefined ? current.priority : input.patch.priority ?? undefined
      const title = input.patch.title === undefined ? current.title : normalizedTitle(input.patch.title)
      const description = input.patch.description === undefined
        ? current.description
        : normalizedDescription(input.patch.description)
      const labels = input.patch.labels === undefined ? current.labels : normalizedLabels(input.patch.labels)
      if (title === current.title && description === current.description && priority === current.priority
        && sessionId === current.sessionId && agencyCopilotSessionId === current.agencyCopilotSessionId
        && sameStrings(labels, current.labels)) {
        return taskboardTaskView(input.taskId, current)
      }
      const candidate: TaskRecord = {
        revision: current.revision + 1,
        ordinal: current.ordinal,
        workspaceId: current.workspaceId,
        title,
        description,
        status: current.status,
        rank: current.rank,
        ...(priority === undefined ? {} : { priority }),
        labels: [...labels],
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(agencyCopilotSessionId === undefined ? {} : { agencyCopilotSessionId }),
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      }
      const record = taskRecord.parse(candidate)
      await this.requireTasks().put(input.taskId, record)
      return taskboardTaskView(input.taskId, record)
    })
  }

  /**
   * Set or clear one Host-validated Agency Copilot terminal identity with revision CAS.
   * @param input - Task, exact revision, and the validated identity or null to clear.
   * @returns the committed task, or the unchanged task for a material no-op.
   */
  setAgencyCopilotSession(input: TaskboardSetAgencyCopilotSessionInput): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.requireActiveRecord(input.taskId)
      assertRevision(input.taskId, current, input.expectedRevision)
      const agencyCopilotSessionId = input.agencyCopilotSessionId ?? undefined
      if (agencyCopilotSessionId === current.agencyCopilotSessionId) {
        return taskboardTaskView(input.taskId, current)
      }
      const record = taskRecord.parse({
        ...current,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        ...(agencyCopilotSessionId === undefined ? { agencyCopilotSessionId: undefined } : { agencyCopilotSessionId }),
      })
      await this.requireTasks().put(input.taskId, record)
      return taskboardTaskView(input.taskId, record)
    })
  }

  /**
   * Move a task into a column and optionally before another task.
   * @param input - Exact revision and destination position.
   * @returns the committed task, or unchanged current task for a same-position move.
   */
  move(input: TaskboardMoveInput): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.requireActiveRecord(input.taskId)
      assertRevision(input.taskId, current, input.expectedRevision)
      if (input.beforeTaskId === input.taskId) {
        if (input.status === current.status) return taskboardTaskView(input.taskId, current)
        throw new TaskboardMoveInvalidError(input.beforeTaskId)
      }
      const destination = this.list(current.workspaceId)
        .filter(task => task.id !== input.taskId && task.status === input.status)
      const last = destination.at(-1)
      if (input.status === current.status && input.beforeTaskId === undefined
        && (last === undefined || last.rank < current.rank)) {
        return taskboardTaskView(input.taskId, current)
      }
      const rank = rankBefore(destination, input.beforeTaskId)
      const candidate = taskRecord.parse({
        ...current,
        revision: current.revision + 1,
        status: input.status,
        rank,
        updatedAt: new Date().toISOString(),
      })
      await this.requireTasks().put(input.taskId, candidate)
      return taskboardTaskView(input.taskId, candidate)
    })
  }

  /**
   * Archive one task with revision CAS.
   * @param taskId - Task identity.
   * @param expectedRevision - Exact current revision.
   * @returns the committed archived task; repeated exact-revision archive is unchanged.
   */
  archive(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    return this.enqueue(async () => {
      const current = this.requireRecord(taskId)
      assertRevision(taskId, current, expectedRevision)
      if (current.archivedAt !== undefined) return taskboardTaskView(taskId, current)
      const now = new Date().toISOString()
      const record = taskRecord.parse({ ...current, revision: current.revision + 1, updatedAt: now, archivedAt: now })
      await this.requireTasks().put(taskId, record)
      return taskboardTaskView(taskId, record)
    })
  }

  /**
   * Permanently delete an active or archived task without changing its Workspace, Sessions, or terminals.
   * @param taskId - Task identity; a missing task rejects.
   * @param expectedRevision - Exact current revision, checked in the serialized mutation slot.
   * @param signal - Cancellation checked before the durable deletion begins; an in-flight deletion settles normally.
   * @returns a durable removal receipt with Number.MAX_SAFE_INTEGER as the tombstone revision.
   */
  delete(taskId: TaskId, expectedRevision: number, signal?: AbortSignal): Promise<TaskboardDeleteValue> {
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const current = this.requireRecord(taskId)
      assertRevision(taskId, current, expectedRevision)
      if (!(await this.requireTasks().delete(taskId))) throw new TaskboardTaskNotFoundError(taskId)
      return { taskId, revision: Number.MAX_SAFE_INTEGER }
    })
  }

  private requireTasks(): KvTable<TaskId, TaskRecord> {
    if (this.tasks === undefined) throw new Error('Taskboard domain is not initialized')
    return this.tasks
  }

  private requireRecord(taskId: TaskId): TaskRecord {
    const record = this.requireTasks().get(taskId)
    if (record === undefined) throw new TaskboardTaskNotFoundError(taskId)
    return record
  }

  private requireActiveRecord(taskId: TaskId): TaskRecord {
    const record = this.requireRecord(taskId)
    if (record.archivedAt !== undefined) throw new TaskboardTaskArchivedError(taskId)
    return record
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new TaskboardWorkspaceNotFoundError(workspaceId)
    return workspace
  }

  private assertSession(workspaceId: WorkspaceId, sessionId: SessionId): void {
    const workspace = this.requireWorkspace(workspaceId)
    if (!workspace.sessionIds.includes(sessionId)) throw new TaskboardSessionInvalidError(workspaceId, sessionId)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Taskboard service is closing'))
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function compareTasks(left: TaskboardTask, right: TaskboardTask): number {
  return STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
    || left.rank - right.rank
    || left.ordinal - right.ordinal
    || String(left.id).localeCompare(String(right.id))
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
  return tasks.reduce((largest, task) => Math.max(largest, task.rank), -RANK_STEP) + RANK_STEP
}

function rankBefore(tasks: readonly TaskboardTask[], beforeTaskId?: TaskId): number {
  if (beforeTaskId === undefined) return appendRank(tasks)
  const index = tasks.findIndex(task => task.id === beforeTaskId)
  if (index === -1) throw new TaskboardMoveInvalidError(beforeTaskId)
  const nextTask = tasks[index]
  if (nextTask === undefined) throw new TaskboardMoveInvalidError(beforeTaskId)
  const next = nextTask.rank
  if (index === 0) return next - RANK_STEP
  const previousTask = tasks[index - 1]
  if (previousTask === undefined) throw new TaskboardMoveInvalidError(beforeTaskId)
  const previous = previousTask.rank
  const rank = previous + (next - previous) / 2
  if (!Number.isFinite(rank) || rank === previous || rank === next) throw new TaskboardMoveInvalidError(beforeTaskId)
  return rank
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export default TaskboardService
