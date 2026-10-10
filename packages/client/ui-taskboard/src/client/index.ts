/** Native Taskboard browser plugin with sidebar and linked-Session navigation. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ITaskboard, TaskboardTask, TaskboardUpdatePatch,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type {} from '@deepseek-ai/dsh-api-job-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Taskboard } from './Taskboard.tsx'
import { TaskboardLauncher } from './TaskboardLauncher.tsx'
import { TaskSessionAction, TaskSessionButton } from './TaskSessionAction.tsx'
import type { TaskboardSessionActionInjected, TaskboardSessionButtonInjected, TaskboardSurfaceInjected } from './contract.ts'
import { en, zh, type TaskboardKey } from './locales.ts'
import { createTaskboardNavigationStore } from './navigation-store.ts'

export type {
  TaskboardLauncherProps, TaskboardSurfaceInjected, TaskboardSurfaceProps,
} from './contract.ts'
export type { TaskboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Native Taskboard copy. */ taskboard: TaskboardKey }
}

const NS = 'taskboard'
const SURFACE = 'taskboard' as MainPanelId
/** Required Client services. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiSession', 'uiWorkspace', 'taskboard', 'jobs', 'connection']

/**
 * Register Taskboard, its sidebar launcher, and linked-Session navigation.
 * @param ctx - Client context supplying task and navigation services.
 */
export function apply(ctx: Context): void {
  const taskboard = ctx.get('taskboard') as ITaskboard
  const layout = ctx.get('layout') as ILayout
  const connection = ctx.get('connection') as ConnectionHandle
  const navigation = createTaskboardNavigationStore()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-taskboard: dictionaries')
  const t = ctx.locale.bind(NS)

  const updateTask = async (task: TaskboardTask, patch: TaskboardUpdatePatch): Promise<TaskboardTask> =>
    taskboard.update({ taskId: task.id, expectedRevision: task.revision, patch })
  const openSession = (sessionId: SessionId): void => { ctx.uiWorkspace.openSession(sessionId) }
  const surfaceInjected = (): TaskboardSurfaceInjected => ({
    hooks: { taskboard: taskboard.list, jobs: ctx.jobs.state },
    watchJobRows: sessionId => ctx.jobs.watchRows(sessionId),
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
    closeSurface: () => { layout.selectPanel(null) },
  })

  ctx.slots.inject('main', function* () {
    yield ctx.slots.register({ name: 'main', key: SURFACE, locale: NS, store: navigation, inject: surfaceInjected }, Taskboard)
    yield ctx.slots.inject('conversation.session.header.utilities', function* () {
      yield ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'taskboard', order: -20,
        children: { 'conversation.session.header.utilities.taskboard': { kind: 'single', scope: 'root' } },
        inject: (): TaskboardSessionActionInjected => ({ hooks: { taskboard: taskboard.list } }),
      }, TaskSessionAction)
      yield ctx.slots.register({
        name: 'conversation.session.header.utilities.taskboard', locale: NS, store: navigation,
        inject: (): TaskboardSessionButtonInjected => ({ openSurface: () => { layout.selectPanel(SURFACE) } }),
      }, TaskSessionButton)
    })
  })
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: SURFACE, order: 20, locale: NS, label: () => t('launcher'),
  }, TaskboardLauncher))
}
