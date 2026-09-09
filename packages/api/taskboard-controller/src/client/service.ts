/** React-free Client Taskboard service and command facade. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TaskboardTask, TaskId } from '@deepseek-ai/dsh-taskboard/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  TaskboardCreateRequest, TaskboardListAgencyCopilotSessionsValue, TaskboardMoveRequest, TaskboardOpenAgencyCopilotValue,
  TaskboardUpdateRequest,
} from '../types.ts'
import type { ClientTaskboardModel, TaskboardSnapshot } from './model.ts'

/** Structured Taskboard command failure preserving carrier details. */
export class TaskboardCommandError extends Error {
  override readonly name = 'TaskboardCommandError'

  /**
   * @param operation - Command that failed.
   * @param failure - Complete generated Remote failure.
   */
  constructor(readonly operation: string, readonly failure: RemoteFailure) {
    super(`Taskboard ${operation} failed: ${failure.code}: ${failure.message}`)
  }
}

/** Client Taskboard service consumed by presentation plugins. */
export interface ITaskboard {
  /** Host-authoritative active and archived task rows and stream lifecycle. */
  readonly list: ObservableSnapshot<TaskboardSnapshot>
  /** Create a durable task. */
  create(request: TaskboardCreateRequest): Promise<TaskboardTask>
  /** Update task content or linkage with revision CAS. */
  update(request: TaskboardUpdateRequest): Promise<TaskboardTask>
  /** Move a task with revision CAS. */
  move(request: TaskboardMoveRequest): Promise<TaskboardTask>
  /** Archive with revision CAS; retain the archived row in the task snapshot. */
  archive(taskId: TaskId, expectedRevision: number): Promise<void>
  /**
   * Permanently delete an active or archived task without changing its linked Sessions or terminals.
   * @param taskId - Task identity to delete.
   * @param expectedRevision - Exact current revision; errors preserve Client state without an automatic retry.
   * @returns resolution after the committed removal is installed in the Client snapshot.
   */
  delete(taskId: TaskId, expectedRevision: number): Promise<void>
  /** Read whether this Host deployment permits native Copilot launch. */
  agencyCopilotCapability(): Promise<boolean>
  /**
   * Discover existing local Copilot sessions; rejects when Agency discovery is unavailable.
   * @param workspaceId - Registered Workspace whose canonical folder must match.
   * @returns bounded matching sessions and whether further rows may exist.
   */
  listAgencyCopilotSessions(workspaceId: WorkspaceId): Promise<TaskboardListAgencyCopilotSessionsValue>
  /** Start a fresh Host-generated Agency Copilot terminal for a task. */
  startAgencyCopilot(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>
  /** Open or resume a task's linked Agency Copilot terminal. */
  openAgencyCopilot(taskId: TaskId): Promise<TaskboardOpenAgencyCopilotValue['outcome']>
  /** Clear the durable Agency Copilot link without touching the terminal. */
  clearAgencyCopilot(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask>
  /** Refresh transient Agency status for linked tasks. */
  inspectAgencyCopilot(taskIds: readonly TaskId[]): Promise<void>
}

/** Owns the bare Taskboard snapshot and mutation commands. */
export class TaskboardClientController extends Service implements ITaskboard {
  readonly list: ObservableSnapshot<TaskboardSnapshot>

  /**
   * @param ctx - Client context.
   * @param model - Remote-backed Taskboard model.
   */
  constructor(ctx: Context, private readonly model: ClientTaskboardModel) {
    super(ctx, 'taskboard')
    this.list = model
  }

  async create(request: TaskboardCreateRequest): Promise<TaskboardTask> {
    const result = await this.model.create(request)
    if (!result.ok) throw new TaskboardCommandError('create', result.error)
    return result.value.task
  }

  async update(request: TaskboardUpdateRequest): Promise<TaskboardTask> {
    const result = await this.model.update(request)
    if (!result.ok) throw new TaskboardCommandError('update', result.error)
    return result.value.task
  }

  async move(request: TaskboardMoveRequest): Promise<TaskboardTask> {
    const result = await this.model.move(request)
    if (!result.ok) throw new TaskboardCommandError('move', result.error)
    return result.value.task
  }

  async archive(taskId: TaskId, expectedRevision: number): Promise<void> {
    const result = await this.model.archive({ taskId, expectedRevision })
    if (!result.ok) throw new TaskboardCommandError('archive', result.error)
  }

  async delete(taskId: TaskId, expectedRevision: number): Promise<void> {
    const result = await this.model.delete({ taskId, expectedRevision })
    if (!result.ok) throw new TaskboardCommandError('delete', result.error)
  }

  async agencyCopilotCapability(): Promise<boolean> {
    const result = await this.model.agencyCopilotCapability()
    if (!result.ok) throw new TaskboardCommandError('read Agency Copilot capability', result.error)
    return result.value.launch
  }

  async listAgencyCopilotSessions(workspaceId: WorkspaceId): Promise<TaskboardListAgencyCopilotSessionsValue> {
    const result = await this.model.listAgencyCopilotSessions({ workspaceId })
    if (!result.ok) throw new TaskboardCommandError('list Agency Copilot sessions', result.error)
    return result.value
  }

  async startAgencyCopilot(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    const result = await this.model.startAgencyCopilot({ taskId, expectedRevision })
    if (!result.ok) throw new TaskboardCommandError('start Agency Copilot', result.error)
    return result.value.task
  }

  async openAgencyCopilot(taskId: TaskId): Promise<TaskboardOpenAgencyCopilotValue['outcome']> {
    const result = await this.model.openAgencyCopilot({ taskId })
    if (!result.ok) throw new TaskboardCommandError('open Agency Copilot', result.error)
    return result.value.outcome
  }

  async clearAgencyCopilot(taskId: TaskId, expectedRevision: number): Promise<TaskboardTask> {
    const result = await this.model.clearAgencyCopilot({ taskId, expectedRevision })
    if (!result.ok) throw new TaskboardCommandError('clear Agency Copilot', result.error)
    return result.value.task
  }

  async inspectAgencyCopilot(taskIds: readonly TaskId[]): Promise<void> {
    const result = await this.model.inspectAgencyCopilot({ taskIds })
    if (!result.ok) throw new TaskboardCommandError('inspect Agency Copilot', result.error)
  }
}
