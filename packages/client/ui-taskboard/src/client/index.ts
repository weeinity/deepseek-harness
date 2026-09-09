/** Native Taskboard browser plugin: controller-backed board surface and sidebar launcher. */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  ITaskboard, TaskboardTask, TaskboardUpdatePatch,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { Taskboard } from './Taskboard.tsx'
import { TaskboardLauncher } from './TaskboardLauncher.tsx'
import type { TaskboardLauncherInjected, TaskboardSurfaceInjected } from './contract.ts'
import { en, zh, type TaskboardKey } from './locales.ts'

export type {
  TaskboardLauncherInjected, TaskboardLauncherProps, TaskboardSurfaceInjected, TaskboardSurfaceProps,
} from './contract.ts'
export type { TaskboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Native Taskboard copy. */ taskboard: TaskboardKey }
}

const NS = 'taskboard'
const SURFACE = 'taskboard'
/** Required Client services. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiSession', 'uiWorkspace', 'taskboard', 'connection']

/** Register the Taskboard surface and sidebar launcher. */
export function apply(ctx: Context): void {
  const taskboard = ctx.get('taskboard') as ITaskboard
  const sessions = ctx.get('sessions') as ISessions
  const layout = ctx.get('layout') as ILayout
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-taskboard: dictionaries')

  const updateTask = async (task: TaskboardTask, patch: TaskboardUpdatePatch): Promise<TaskboardTask> =>
    taskboard.update({ taskId: task.id, expectedRevision: task.revision, patch })
  const openSession = (sessionId: Parameters<ISessions['open']>[0]): void => {
    sessions.open(sessionId)
    layout.closeMainSurface()
  }
  const surfaceInjected = (): TaskboardSurfaceInjected => ({
    hooks: { taskboard: taskboard.list },
    createTask: request => taskboard.create(request),
    updateTask: async (task, patch) => { await updateTask(task, patch) },
    moveTask: async (task, status, beforeTaskId) => {
      await taskboard.move({
        taskId: task.id,
        expectedRevision: task.revision,
        status,
        ...(beforeTaskId === undefined ? {} : { beforeTaskId }),
      })
    },
    archiveTask: async (task) => { await taskboard.archive(task.id, task.revision) },
    deleteTask: async (task) => { await taskboard.delete(task.id, task.revision) },
    startWork: async (task) => {
      const sessionId = await sessions.create({ workspaceId: task.workspaceId })
      const linked = await updateTask(task, { sessionId })
      if (linked.status !== 'in_progress') {
        await taskboard.move({
          taskId: linked.id,
          expectedRevision: linked.revision,
          status: 'in_progress',
        })
      }
      openSession(sessionId)
    },
    openSession,
    agencyCopilotCapability: () => taskboard.agencyCopilotCapability(),
    listAgencyCopilotSessions: workspaceId => taskboard.listAgencyCopilotSessions(workspaceId),
    startAgencyCopilot: async (task) => { await taskboard.startAgencyCopilot(task.id, task.revision) },
    openAgencyCopilot: task => taskboard.openAgencyCopilot(task.id),
    clearAgencyCopilot: async (task) => { await taskboard.clearAgencyCopilot(task.id, task.revision) },
    refreshAgencyCopilot: async (tasks) => {
      const taskIds = [...new Set(tasks.flatMap(task =>
        task.agencyCopilotSessionId === undefined ? [] : [task.id]))]
      for (let offset = 0; offset < taskIds.length; offset += 100) {
        await taskboard.inspectAgencyCopilot(taskIds.slice(offset, offset + 100))
      }
    },
    isLoopback: connection.isLoopback,
    closeSurface: () => { layout.closeMainSurface() },
  })
  const launcherInjected = (): TaskboardLauncherInjected => ({
    hooks: { taskboard: taskboard.list },
    toggleSurface: () => { layout.toggleMainSurface(SURFACE) },
  })

  ctx.slots.inject('main.surface', function* () {
    yield ctx.slots.register({ name: 'main.surface', key: 'taskboard', locale: NS, inject: surfaceInjected }, Taskboard)
    yield layout.registerMainSurface(SURFACE)
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'taskboard', order: 10, locale: NS, inject: launcherInjected,
  }, TaskboardLauncher))
}
