/** Taskboard surface and launcher prop contracts. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AgencyCopilotSessionId, TaskboardCreateRequest, TaskboardListAgencyCopilotSessionsValue,
  TaskboardOpenAgencyCopilotValue, TaskboardSnapshot, TaskboardTask,
  TaskboardUpdatePatch, TaskId, TaskStatus,
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
  startWork(task: TaskboardTask): Promise<void>
  openSession(sessionId: SessionId): void
  agencyCopilotCapability(): Promise<boolean>
  listAgencyCopilotSessions(workspaceId: WorkspaceId): Promise<TaskboardListAgencyCopilotSessionsValue>
  startAgencyCopilot(task: TaskboardTask): Promise<void>
  openAgencyCopilot(task: TaskboardTask): Promise<TaskboardOpenAgencyCopilotValue['outcome']>
  clearAgencyCopilot(task: TaskboardTask): Promise<void>
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
/** New-task component input. */
export interface NewTaskDraft {
  workspaceId: WorkspaceId
  title: string
  description: string
  agencyCopilotSessionId?: AgencyCopilotSessionId
}
