/** React-free Client Taskboard service and command facade. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TaskboardTask, TaskExecutionId, TaskId } from '@deepseek-ai/dsh-taskboard/types'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  TaskboardCreateRequest, TaskboardListAgencyCopilotSessionsValue, TaskboardMoveRequest, TaskboardOpenAgencyCopilotValue,
  TaskboardUpdateRequest, TaskboardConnectRequest, TaskboardConfirmPermissionsRequest, TaskboardDisconnectRequest,
  TaskboardDuplicateRequest, TaskboardExecutionOptionsValue, TaskboardRestoreRequest, TaskboardRunRequest, TaskboardRunValue,
  TaskboardRuntimeState, TaskboardUpdateSettingsRequest,
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
  /**
   * Create a durable task.
   * @param request - Initial task fields and optional validated existing connection.
   * @returns the committed task.
   */
  create(request: TaskboardCreateRequest): Promise<TaskboardTask>
  /**
   * Update task content with revision CAS; connection changes use dedicated commands.
   * @param request - Task identity, exact current revision, and field patch.
   * @returns the committed task.
   */
  update(request: TaskboardUpdateRequest): Promise<TaskboardTask>
  /**
   * Move a task with revision CAS.
   * @param request - Task identity, exact current revision, and destination.
   * @returns the committed task.
   */
  move(request: TaskboardMoveRequest): Promise<TaskboardTask>
  /**
   * Archive with revision CAS; retain the archived row in the task snapshot.
   * @param taskId - Task identity to archive.
   * @param expectedRevision - Exact current revision.
   */
  archive(taskId: TaskId, expectedRevision: number): Promise<void>
  /**
   * Permanently delete an active or archived task without changing its linked Sessions or terminals.
   * @param taskId - Task identity to delete.
   * @param expectedRevision - Exact current revision; errors preserve Client state without an automatic retry.
   * @returns resolution after the committed removal is installed in the Client snapshot.
   */
  delete(taskId: TaskId, expectedRevision: number): Promise<void>
  /**
   * Read whether this Host deployment permits native Copilot launch.
   * @returns whether native launch is permitted.
   */
  agencyCopilotCapability(): Promise<boolean>
  /**
   * Discover existing local Copilot sessions; rejects when Agency discovery is unavailable.
   * @param workspaceId - Registered Workspace whose canonical folder must match.
   * @returns bounded matching sessions and whether further rows may exist.
   */
  listAgencyCopilotSessions(workspaceId: WorkspaceId): Promise<TaskboardListAgencyCopilotSessionsValue>
  /**
   * Dispatch one attempt; settled runs retain their exact connection for Run Again.
   * @param request - Saved revision and caller-owned retry identity.
   * @returns committed task and durable execution identity after dispatch acknowledgement, not model completion.
   */
  run(request: TaskboardRunRequest): Promise<TaskboardRunValue>
  /** Associate without submitting work.
   * @param request - Exact revision and validated conversation choice.
   * @returns committed task.
   */
  connect(request: TaskboardConnectRequest): Promise<TaskboardTask>
  /** Disconnect without deleting the conversation.
   * @param request - Exact saved revision.
   * @returns committed task.
   */
  disconnect(request: TaskboardDisconnectRequest): Promise<TaskboardTask>
  /** Restore an archived task with scheduling disabled.
   * @param request - Exact archived revision.
   * @returns committed task.
   */
  restore(request: TaskboardRestoreRequest): Promise<TaskboardTask>
  /** Duplicate saved fields without connection, history, or permission confirmation.
   * @param request - Exact source revision.
   * @returns independent committed task.
   */
  duplicate(request: TaskboardDuplicateRequest): Promise<TaskboardTask>
  /** Confirm saved permission and handover inputs.
   * @param request - Exact saved revision.
   * @returns committed task.
   */
  confirmPermissions(request: TaskboardConfirmPermissionsRequest): Promise<TaskboardTask>
  /** Load authoritative presets, permissions, and models.
   * @returns Host catalog and capability information.
   */
  executionOptions(): Promise<TaskboardExecutionOptionsValue>
  /** Persist switches; the follow feed publishes ordered runtime state.
   * @param request - Explicit switches to change.
   * @returns committed Host runtime state.
   */
  updateSettings(request: TaskboardUpdateSettingsRequest): Promise<TaskboardRuntimeState>
  /**
   * Open or resume a task's linked Agency Copilot terminal.
   * @param taskId - Task whose linked Agency identity is addressed.
   * @param executionId - Retained attempt whose connection is opened instead of the current one.
   * @returns the terminal handoff outcome or current running state.
   */
  openAgencyCopilot(taskId: TaskId, executionId?: TaskExecutionId): Promise<TaskboardOpenAgencyCopilotValue['outcome']>
  /**
   * Refresh transient Agency status for linked tasks.
   * @param taskIds - Task identities whose linked Agency status is requested.
   */
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

  async run(request: TaskboardRunRequest): Promise<TaskboardRunValue> {
    const result = await this.model.run(request)
    if (!result.ok) throw new TaskboardCommandError('run', result.error)
    return result.value
  }

  async connect(request: TaskboardConnectRequest): Promise<TaskboardTask> {
    const result = await this.model.connect(request)
    if (!result.ok) throw new TaskboardCommandError('connect', result.error)
    return result.value.task
  }

  async disconnect(request: TaskboardDisconnectRequest): Promise<TaskboardTask> {
    const result = await this.model.disconnect(request)
    if (!result.ok) throw new TaskboardCommandError('disconnect', result.error)
    return result.value.task
  }

  async restore(request: TaskboardRestoreRequest): Promise<TaskboardTask> {
    const result = await this.model.restore(request)
    if (!result.ok) throw new TaskboardCommandError('restore', result.error)
    return result.value.task
  }

  async duplicate(request: TaskboardDuplicateRequest): Promise<TaskboardTask> {
    const result = await this.model.duplicate(request)
    if (!result.ok) throw new TaskboardCommandError('duplicate', result.error)
    return result.value.task
  }

  async confirmPermissions(request: TaskboardConfirmPermissionsRequest): Promise<TaskboardTask> {
    const result = await this.model.confirmPermissions(request)
    if (!result.ok) throw new TaskboardCommandError('confirm permissions', result.error)
    return result.value.task
  }

  async executionOptions(): Promise<TaskboardExecutionOptionsValue> {
    const result = await this.model.executionOptions()
    if (!result.ok) throw new TaskboardCommandError('execution options', result.error)
    return result.value
  }

  async updateSettings(request: TaskboardUpdateSettingsRequest): Promise<TaskboardRuntimeState> {
    const result = await this.model.updateSettings(request)
    if (!result.ok) throw new TaskboardCommandError('update settings', result.error)
    return result.value
  }

  async openAgencyCopilot(taskId: TaskId, executionId?: TaskExecutionId): Promise<TaskboardOpenAgencyCopilotValue['outcome']> {
    const result = await this.model.openAgencyCopilot({ taskId, ...(executionId === undefined ? {} : { executionId }) })
    if (!result.ok) throw new TaskboardCommandError('open Agency Copilot', result.error)
    return result.value.outcome
  }

  async inspectAgencyCopilot(taskIds: readonly TaskId[]): Promise<void> {
    const result = await this.model.inspectAgencyCopilot({ taskIds })
    if (!result.ok) throw new TaskboardCommandError('inspect Agency Copilot', result.error)
  }
}
