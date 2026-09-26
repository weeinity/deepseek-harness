/** Native Taskboard browser plugin with sidebar and linked-Session navigation. */
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
import { TaskSessionAction, TaskSessionButton } from './TaskSessionAction.tsx'
import type { TaskboardLauncherInjected, TaskboardSessionButtonInjected, TaskboardSurfaceInjected } from './contract.ts'
import { en, zh, type TaskboardKey } from './locales.ts'
import { createTaskboardNavigationStore } from './navigation-store.ts'

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

/**
 * Register Taskboard, its sidebar launcher, and linked-Session navigation.
 * @param ctx - Client context supplying task and navigation services.
 */
export function apply(ctx: Context): void {
  const taskboard = ctx.get('taskboard') as ITaskboard
  const sessions = ctx.get('sessions') as ISessions
  const layout = ctx.get('layout') as ILayout
  const connection = ctx.get('connection') as ConnectionHandle
  const navigation = createTaskboardNavigationStore()
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
    startWork: async (task, requestId) => {
      const result = await taskboard.run({ taskId: task.id, expectedRevision: task.revision, requestId })
      if (result.task.connection?.kind === 'dsh') openSession(result.task.connection.sessionId)
    },
    connectTask: async (task, selected, executionSettings) => {
      await taskboard.connect({
        taskId: task.id, expectedRevision: task.revision, connection: selected,
        ...(executionSettings === undefined ? {} : { executionSettings }),
      })
    },
    disconnectTask: async (task) => { await taskboard.disconnect({ taskId: task.id, expectedRevision: task.revision }) },
    restoreTask: async (task) => { await taskboard.restore({ taskId: task.id, expectedRevision: task.revision }) },
    confirmPermissions: async (task) => { await taskboard.confirmPermissions({ taskId: task.id, expectedRevision: task.revision }) },
    executionOptions: () => taskboard.executionOptions(),
    updateSettings: patch => taskboard.updateSettings({ patch }),
    openSession,
    agencyCopilotCapability: () => taskboard.agencyCopilotCapability(),
    listAgencyCopilotSessions: workspaceId => taskboard.listAgencyCopilotSessions(workspaceId),
    openAgencyCopilot: (task, executionId) => taskboard.openAgencyCopilot(task.id, executionId),
    refreshAgencyCopilot: async (tasks) => {
      const taskIds = [...new Set(tasks.flatMap(task =>
        task.connection?.kind === 'copilot' ? [task.id] : []))]
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
    yield ctx.slots.register({ name: 'main.surface', key: 'taskboard', locale: NS, store: navigation, inject: surfaceInjected }, Taskboard)
    yield layout.registerMainSurface(SURFACE)
    yield ctx.slots.inject('conversation.session.header.utilities', function* () {
      yield ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'taskboard', order: -20,
        children: { 'conversation.session.header.utilities.taskboard': { kind: 'single', scope: 'root' } },
        inject: (): Pick<TaskboardSurfaceInjected, 'hooks'> => ({ hooks: { taskboard: taskboard.list } }),
      }, TaskSessionAction)
      yield ctx.slots.register({
        name: 'conversation.session.header.utilities.taskboard', locale: NS, store: navigation,
        inject: (): TaskboardSessionButtonInjected => ({ openSurface: () => { layout.openMainSurface(SURFACE) } }),
      }, TaskSessionButton)
    })
  })
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'taskboard', order: 10, locale: NS, inject: launcherInjected,
  }, TaskboardLauncher))
}
