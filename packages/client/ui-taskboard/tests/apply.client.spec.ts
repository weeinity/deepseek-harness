import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { TaskboardLauncherInjected, TaskboardSurfaceInjected } from '../src/client/contract.ts'
import type { AgencyCopilotSessionId, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'

function taskFixture(): TaskboardTask {
  return {
    id: 'task' as TaskboardTask['id'], revision: 4, ordinal: 1,
    workspaceId: 'workspace' as TaskboardTask['workspaceId'],
    title: 'Linked', description: '', status: 'todo', rank: 0, labels: [],
    createdAt: '', updatedAt: '',
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const subscribe = () => () => {}
  const snapshot = {
    tasks: [], state: 'idle' as const, phase: 'ready' as const, error: null,
    agencyByTask: {}, agencyState: 'idle' as const, agencyError: null,
  }
  const taskboard = {
    list: { getSnapshot: () => snapshot, subscribe },
    create: vi.fn(), update: vi.fn(), move: vi.fn(), archive: vi.fn(), delete: vi.fn(),
    agencyCopilotCapability: vi.fn(async () => true), startAgencyCopilot: vi.fn(),
    listAgencyCopilotSessions: vi.fn(),
    openAgencyCopilot: vi.fn(), clearAgencyCopilot: vi.fn(), inspectAgencyCopilot: vi.fn(),
  }
  const sessions = { create: vi.fn(), open: vi.fn() }
  const registerMainSurface = vi.fn(() => vi.fn())
  const toggleMainSurface = vi.fn()
  const closeMainSurface = vi.fn()
  const layout = { registerMainSurface, toggleMainSurface, closeMainSurface }
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('taskboard', taskboard as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('layout', layout as never)
  ctx.provide('uiSession', {} as never)
  ctx.provide('uiWorkspace', {} as never)
  ctx.provide('connection', { isLoopback: true } as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'main.surface': { kind: 'keyed', scope: 'root' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  return { ctx, layout, sessions, slots, taskboard }
}

describe('ui-taskboard apply', () => {
  it('declares its activation barriers', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'uiSession', 'uiWorkspace', 'taskboard', 'connection'])
  })

  it('registers a keyed main surface before its layout identity and a narrow launcher face', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.layout.registerMainSurface).toHaveBeenCalledWith('taskboard')
    const surface = b.slots.entries('main.surface')[0]!
    const launcher = b.slots.entries('sidebar.footer.action')[0]!
    expect(surface.options.key).toBe('taskboard')
    expect(launcher.options).toMatchObject({ id: 'taskboard', order: 10 })
    const surfaceFace = (surface.inject as unknown as () => TaskboardSurfaceInjected)()
    const launcherFace = (launcher.inject as unknown as () => TaskboardLauncherInjected)()
    expect(Object.keys(surfaceFace).sort()).toEqual([
      'agencyCopilotCapability', 'archiveTask', 'clearAgencyCopilot', 'closeSurface', 'createTask', 'deleteTask', 'hooks', 'isLoopback', 'listAgencyCopilotSessions', 'moveTask',
      'openAgencyCopilot', 'openSession', 'refreshAgencyCopilot', 'startAgencyCopilot', 'startWork', 'updateTask',
    ])
    expect(Object.keys(launcherFace).sort()).toEqual(['hooks', 'toggleSurface'])
    launcherFace.toggleSurface()
    expect(b.layout.toggleMainSurface).toHaveBeenCalledWith('taskboard')
    await fiber.dispose()
    expect(b.slots.entries('main.surface')).toEqual([])
    expect(b.slots.entries('sidebar.footer.action')).toEqual([])
    expect(b.layout.registerMainSurface.mock.results[0]?.value).toHaveBeenCalledOnce()
  })

  it('forwards existing-session discovery and atomic task writes without opening a session', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const surface = b.slots.entries('main.surface')[0]!
      const face = (surface.inject as unknown as () => TaskboardSurfaceInjected)()
      const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
      const task: TaskboardTask = { ...taskFixture(), agencyCopilotSessionId: sessionId }
      const catalog = { sessions: [{ sessionId, status: 'idle' }], truncated: false }
      b.taskboard.listAgencyCopilotSessions.mockResolvedValue(catalog)
      b.taskboard.create.mockResolvedValue(task)
      await expect(face.listAgencyCopilotSessions(task.workspaceId)).resolves.toBe(catalog)
      expect(b.taskboard.listAgencyCopilotSessions).toHaveBeenCalledExactlyOnceWith(task.workspaceId)
      const creation = { workspaceId: task.workspaceId, title: task.title, agencyCopilotSessionId: sessionId }
      await expect(face.createTask(creation)).resolves.toBe(task)
      expect(b.taskboard.create).toHaveBeenCalledExactlyOnceWith(creation)
      await face.updateTask(task, { title: 'Edited', agencyCopilotSessionId: null })
      expect(b.taskboard.update).toHaveBeenCalledExactlyOnceWith({
        taskId: task.id, expectedRevision: task.revision, patch: { title: 'Edited', agencyCopilotSessionId: null },
      })
      await face.deleteTask(task)
      expect(b.taskboard.delete).toHaveBeenCalledExactlyOnceWith(task.id, task.revision)
      expect(b.taskboard.startAgencyCopilot).not.toHaveBeenCalled()
      expect(b.taskboard.openAgencyCopilot).not.toHaveBeenCalled()
      expect(b.sessions.create).not.toHaveBeenCalled()
      expect(b.sessions.open).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await b.ctx.fiber.dispose()
    }
  })

  it('opens the linked Session before returning from Taskboard after a successful start', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const face = (b.slots.entries('main.surface')[0]!.inject as unknown as () => TaskboardSurfaceInjected)()
      const task = taskFixture()
      const sessionId = 'created-session' as NonNullable<TaskboardTask['sessionId']>
      b.sessions.create.mockResolvedValue(sessionId)
      b.taskboard.update.mockResolvedValue({ ...task, revision: 5, sessionId })
      await face.startWork(task)
      expect(b.sessions.create).toHaveBeenCalledWith({ workspaceId: task.workspaceId })
      expect(b.taskboard.update).toHaveBeenCalledWith({
        taskId: task.id, expectedRevision: 4, patch: { sessionId },
      })
      expect(b.taskboard.move).toHaveBeenCalledWith({
        taskId: task.id, expectedRevision: 5, status: 'in_progress',
      })
      expect(b.sessions.open).toHaveBeenCalledWith(sessionId)
      expect(b.layout.closeMainSurface).toHaveBeenCalledOnce()
      expect(b.sessions.open.mock.invocationCallOrder[0]).toBeLessThan(
        b.layout.closeMainSurface.mock.invocationCallOrder[0]!,
      )
    } finally {
      await fiber.dispose()
      await b.ctx.fiber.dispose()
    }
  })

  it('retains Taskboard selection when starting work cannot commit the task link', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    try {
      await fiber.await()
      const face = (b.slots.entries('main.surface')[0]!.inject as unknown as () => TaskboardSurfaceInjected)()
      b.sessions.create.mockResolvedValue('created-session')
      b.taskboard.update.mockRejectedValue(new Error('task revision changed'))
      await expect(face.startWork(taskFixture())).rejects.toThrow('task revision changed')
      expect(b.taskboard.move).not.toHaveBeenCalled()
      expect(b.sessions.open).not.toHaveBeenCalled()
      expect(b.layout.closeMainSurface).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
      await b.ctx.fiber.dispose()
    }
  })
})
