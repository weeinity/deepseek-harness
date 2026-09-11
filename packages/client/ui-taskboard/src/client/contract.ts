/** Taskboard surface and launcher prop contracts. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TaskboardCreateRequest, TaskboardListAgencyCopilotSessionsValue, TaskboardConnectRequest,
  TaskboardExecutionOptionsValue, TaskboardOpenAgencyCopilotValue, TaskboardSnapshot, TaskboardTask,
  TaskboardUpdatePatch, TaskExecutionId, TaskExecutionSettings, TaskHandover, TaskId, TaskRunRequestId, TaskSchedule, TaskStatus,
  TaskboardSettings, TaskboardRuntimeState,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** Registrant-private data and commands consumed by the full Taskboard surface. */
export interface TaskboardSurfaceInjected {
  readonly hooks: { readonly taskboard: HostObservable<TaskboardSnapshot> }
  createTask(request: TaskboardCreateRequest): Promise<TaskboardTask>
  updateTask(task: TaskboardTask, patch: TaskboardUpdatePatch): Promise<void>
  moveTask(task: TaskboardTask, status: TaskStatus, beforeTaskId?: TaskId): Promise<void>
  archiveTask(task: TaskboardTask): Promise<void>
  deleteTask(task: TaskboardTask): Promise<void>
  /**
   * Dispatch saved execution inputs, project Host workflow updates, then open an acknowledged DSH Session.
   * @param task - Current saved revision.
   * @param requestId - Stable retry identity for this user action.
   * @returns completion after dispatch acknowledgement and DSH navigation, not model completion.
   */
  startWork(task: TaskboardTask, requestId: TaskRunRequestId): Promise<void>
  connectTask(task: TaskboardTask, connection: TaskboardConnectRequest['connection'], executionSettings?: TaskExecutionSettings): Promise<void>
  disconnectTask(task: TaskboardTask): Promise<void>
  restoreTask(task: TaskboardTask): Promise<void>
  confirmPermissions(task: TaskboardTask): Promise<void>
  executionOptions(): Promise<TaskboardExecutionOptionsValue>
  updateSettings(patch: Partial<TaskboardSettings>): Promise<TaskboardRuntimeState>
  openSession(sessionId: SessionId): void
  agencyCopilotCapability(): Promise<boolean>
  listAgencyCopilotSessions(workspaceId: WorkspaceId): Promise<TaskboardListAgencyCopilotSessionsValue>
  openAgencyCopilot(task: TaskboardTask, executionId?: TaskExecutionId): Promise<TaskboardOpenAgencyCopilotValue['outcome']>
  refreshAgencyCopilot(tasks: readonly TaskboardTask[]): Promise<void>
  readonly isLoopback: boolean
  closeSurface(): void
}

/** Narrow face consumed only by the sidebar Taskboard launcher. */
export interface TaskboardLauncherInjected {
  readonly hooks: { readonly taskboard: HostObservable<TaskboardSnapshot> }
  toggleSurface(): void
}

/** Full main-surface props bound by the renderer. */
export type TaskboardSurfaceProps =
  PropsRuntime<'main.surface'> & PropsLocale<'taskboard'> & InjectFace<TaskboardSurfaceInjected>
/** Full sidebar launcher props bound by the renderer. */
export type TaskboardLauncherProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'taskboard'> & InjectFace<TaskboardLauncherInjected>
/** Component-local editable execution inputs; persistence uses explicit optional-field semantics. */
export interface ExecutionDraft {
  readonly prompt: string
  readonly executionSettings: TaskExecutionSettings
  readonly schedule: TaskSchedule | undefined
  readonly handover: TaskHandover | undefined
}
