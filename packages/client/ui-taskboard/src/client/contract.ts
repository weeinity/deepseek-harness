/** Taskboard surface, launcher, and Session navigation props. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TaskboardCreateRequest, TaskboardListAgencyCopilotSessionsValue, TaskboardConnectRequest,
  TaskboardExecutionOptionsValue, TaskboardOpenAgencyCopilotValue, TaskboardSnapshot, TaskboardTask,
  TaskboardUpdatePatch, TaskExecutionId, TaskExecutionSettings, TaskHandover, TaskId, TaskRunRequestId, TaskSchedule, TaskStatus,
  TaskboardSettings, TaskboardRuntimeState,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { createTaskboardNavigationStore } from './navigation-store.ts'

/** Current links resolved by the Session-scoped header entry. */
export interface TaskboardSessionButtonOwnerProps {
  readonly tasks: readonly [TaskboardTask, ...TaskboardTask[]]
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Root-scoped task control sharing navigation state with the main Taskboard. */
    'conversation.session.header.utilities.taskboard': {
      kind: 'single'
      scope: 'root'
      owner: TaskboardSessionButtonOwnerProps
    }
  }
}

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
  & PropsStore<ReturnType<typeof createTaskboardNavigationStore>>
/** Full sidebar launcher props bound by the renderer. */
export type TaskboardLauncherProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'taskboard'> & InjectFace<TaskboardLauncherInjected>
/** Session-scoped association projection into its owned root-scoped control. */
export type TaskboardSessionActionProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsRenderSlots<'conversation.session.header.utilities.taskboard'>
  & InjectFace<Pick<TaskboardSurfaceInjected, 'hooks'>>
/** Layout navigation does not submit work or change task records. */
export interface TaskboardSessionButtonInjected {
  openSurface(): void
}
/** Root control props sharing only navigation intent with Taskboard. */
export type TaskboardSessionButtonProps =
  PropsRuntime<'conversation.session.header.utilities.taskboard'> & PropsLocale<'taskboard'>
  & PropsStore<ReturnType<typeof createTaskboardNavigationStore>>
  & InjectFace<TaskboardSessionButtonInjected>
/** Component-local editable execution inputs; persistence uses explicit optional-field semantics. */
export interface ExecutionDraft {
  readonly prompt: string
  readonly executionSettings: TaskExecutionSettings
  readonly schedule: TaskSchedule | undefined
  readonly handover: TaskHandover | undefined
}
