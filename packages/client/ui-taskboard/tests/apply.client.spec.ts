import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ITaskboard, TaskboardRunValue, TaskExecutionId, TaskRunRequestId } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import { apply, inject } from '../src/client/index.ts'
import type {
  TaskboardSessionActionInjected, TaskboardSessionButtonInjected, TaskboardSurfaceInjected,
} from '../src/client/contract.ts'
import { copilot, dsh, options, runtime, task } from './fixtures.client.ts'

const surfaceFunctions = [
  'watchJobRows', 'createTask', 'updateTask', 'moveTask', 'archiveTask', 'deleteTask',
  'startWork', 'connectTask', 'disconnectTask', 'restoreTask', 'confirmPermissions',
  'executionOptions', 'openSession', 'agencyCopilotCapability', 'listAgencyCopilotSessions',
  'openAgencyCopilot', 'refreshAgencyCopilot', 'closeSurface',
] as const satisfies readonly (keyof TaskboardSurfaceInjected)[]

function isTaskboardSurfaceInjected(value: object): value is TaskboardSurfaceInjected {
  const hooks: unknown = Reflect.get(value, 'hooks')
  return typeof hooks === 'object' && hooks !== null
    && typeof Reflect.get(hooks, 'taskboard') === 'object'
    && typeof Reflect.get(hooks, 'jobs') === 'object'
    && typeof Reflect.get(value, 'isLoopback') === 'boolean'
    && surfaceFunctions.every(key => typeof Reflect.get(value, key) === 'function')
}

function isTaskboardSessionActionInjected(value: object): value is TaskboardSessionActionInjected {
  const hooks: unknown = Reflect.get(value, 'hooks')
  return typeof hooks === 'object' && hooks !== null
    && typeof Reflect.get(hooks, 'taskboard') === 'object'
}

function isTaskboardSessionButtonInjected(value: object): value is TaskboardSessionButtonInjected {
  return typeof Reflect.get(value, 'openSurface') === 'function'
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const taskboard = {
    list: { getSnapshot: () => ({ tasks: [], runtime, state: 'idle', phase: 'ready', error: null, agencyByTask: {}, agencyState: 'idle', agencyError: null }), subscribe: () => () => {} },
    create: vi.fn(), update: vi.fn(), move: vi.fn(), archive: vi.fn(), delete: vi.fn(),
    run: vi.fn<ITaskboard['run']>(async () => ({ task: task({ connection: dsh }), executionId: 'run' as TaskExecutionId })),
    connect: vi.fn(), disconnect: vi.fn(), restore: vi.fn(), confirmPermissions: vi.fn(),
    executionOptions: vi.fn(async () => options), updateSettings: vi.fn(async () => runtime),
    agencyCopilotCapability: vi.fn(async () => true), listAgencyCopilotSessions: vi.fn(),
    openAgencyCopilot: vi.fn(), inspectAgencyCopilot: vi.fn(),
  }
  const sessions = { create: vi.fn(), open: vi.fn(), binding: vi.fn() }
  const layout = { selectPanel: vi.fn() }
  const uiWorkspace = { openSession: vi.fn() }
  const jobs = {
    state: { getSnapshot: () => ({ rows: {}, observed: {} }), subscribe: () => () => {} },
    watchRows: vi.fn(() => () => {}),
  }
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('taskboard', taskboard as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('jobs', jobs as never)
  ctx.provide('layout', layout as never)
  ctx.provide('uiSession', {} as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('connection', { isLoopback: true } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const declareRoot = () => slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' },
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const disposeRoot = declareRoot()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const face = slots.entries('main')[0]!.inject!()
  if (!isTaskboardSurfaceInjected(face)) throw new Error('Taskboard surface injection is incomplete')
  return { ctx, taskboard, sessions, jobs, layout, uiWorkspace, slots, fiber, face, declareRoot, disposeRoot }
}

describe('ui-taskboard apply', () => {
  it('registers a root board and an always-accessible launcher, and disposes every registration', async () => {
    const b = await bench()
    try {
      expect(inject).toEqual(['slots', 'locale', 'layout', 'sessions', 'uiSession', 'uiWorkspace', 'taskboard', 'jobs', 'connection'])
      const launcher = b.slots.entries('sidebar.panellist')[0]!
      expect(launcher.options.id).toBe('taskboard')
      expect((launcher.options.label as () => string)()).toBe('Taskboard')
      expect(b.face).not.toHaveProperty('updateSettings')
      expect(b.taskboard.updateSettings).not.toHaveBeenCalled()
      expect(b.face.hooks.jobs).toBe(b.jobs.state)
      expect(b.slots.entries('conversation.session.header.utilities').map(entry => entry.options.id)).toEqual(['taskboard'])
      await b.fiber.dispose()
      expect(b.slots.entries('main')).toEqual([])
      expect(b.slots.entries('sidebar.panellist')).toEqual([])
      expect(b.slots.entries('conversation.session.header.utilities')).toEqual([])
      expect(b.slots.entries('conversation.session.header.utilities.taskboard')).toEqual([])
    } finally { await b.ctx.fiber.dispose() }
  })

  it('shares root navigation with the Session control and opens Taskboard without dispatching work', async () => {
    const b = await bench()
    try {
      const board = b.slots.entries('main')[0]!
      const header = b.slots.entries('conversation.session.header.utilities')[0]!
      const control = b.slots.entries('conversation.session.header.utilities.taskboard')[0]!
      expect(header.options.order).toBe(-20)
      expect(header.store).toBeUndefined()
      expect(control.store).toBe(board.store)
      expect(control.store).toBeDefined()
      const headerFace = header.inject!()
      if (!isTaskboardSessionActionInjected(headerFace)) throw new Error('Taskboard Session action injection is incomplete')
      expect(headerFace.hooks.taskboard).toBe(b.taskboard.list)
      const controlFace = control.inject!()
      if (!isTaskboardSessionButtonInjected(controlFace)) throw new Error('Taskboard Session button injection is incomplete')
      controlFace.openSurface()
      expect(b.layout.selectPanel).toHaveBeenCalledExactlyOnceWith('taskboard')
      expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
      for (const operation of ['create', 'update', 'move', 'run', 'connect', 'disconnect'] as const) {
        expect(b.taskboard[operation]).not.toHaveBeenCalled()
      }
    } finally { await b.ctx.fiber.dispose() }
  })

  it('removes and restores Session navigation with the owning slot declarations', async () => {
    const b = await bench()
    try {
      b.disposeRoot()
      await vi.waitFor(() => {
        expect(b.slots.entries('conversation.session.header.utilities')).toEqual([])
        expect(b.slots.entries('conversation.session.header.utilities.taskboard')).toEqual([])
        expect(b.slots.entries('main')).toEqual([])
      })
      b.declareRoot()
      await vi.waitFor(() => {
        expect(b.slots.entries('conversation.session.header.utilities')).toHaveLength(1)
        expect(b.slots.entries('conversation.session.header.utilities.taskboard')).toHaveLength(1)
        expect(b.slots.entries('main')).toHaveLength(1)
      })
    } finally { await b.ctx.fiber.dispose() }
  })

  it('dispatches Run and Run Again only through the Host with the saved revision and retry identity', async () => {
    const b = await bench()
    try {
      const row = task({ connection: dsh })
      const requestId = 'request' as TaskRunRequestId
      await b.face.startWork(row, requestId)
      await b.face.startWork(row, requestId)
      expect(b.taskboard.run).toHaveBeenNthCalledWith(1, { taskId: row.id, expectedRevision: row.revision, requestId })
      expect(b.taskboard.run).toHaveBeenNthCalledWith(2, { taskId: row.id, expectedRevision: row.revision, requestId })
      expect(b.sessions.create).not.toHaveBeenCalled()
      expect(b.sessions.binding).not.toHaveBeenCalled()
      expect(b.uiWorkspace.openSession).toHaveBeenNthCalledWith(1, dsh.sessionId)
      expect(b.uiWorkspace.openSession).toHaveBeenNthCalledWith(2, dsh.sessionId)
      expect(b.taskboard.move).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('opens DSH only after successful Host dispatch acknowledgement, never for the pending reservation', async () => {
    const b = await bench()
    const acknowledgement = Promise.withResolvers<TaskboardRunValue>()
    const result = { task: task({ connection: dsh }), executionId: 'run' as TaskExecutionId }
    b.taskboard.run.mockReturnValue(acknowledgement.promise)
    const pending = b.face.startWork(task(), 'request' as TaskRunRequestId)
    try {
      expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
      acknowledgement.resolve(result)
      await pending
      expect(b.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(dsh.sessionId)
      expect(b.sessions.create).not.toHaveBeenCalled()
      expect(b.sessions.binding).not.toHaveBeenCalled()
    } finally {
      acknowledgement.resolve(result)
      await pending
      await b.ctx.fiber.dispose()
    }
  })

  it('keeps Copilot dispatch separate from terminal navigation', async () => {
    const b = await bench()
    try {
      b.taskboard.run.mockResolvedValue({ task: task({ connection: copilot, executionSettings: { kind: 'copilot' } }),
        executionId: 'run' as TaskExecutionId })
      await b.face.startWork(task({ executionSettings: { kind: 'copilot' } }), 'request' as TaskRunRequestId)
      expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
      expect(b.taskboard.openAgencyCopilot).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('propagates admission failure without navigation or a separate status command', async () => {
    const b = await bench()
    try {
      b.taskboard.run.mockRejectedValue(new Error('Connected Session missing'))
      await expect(b.face.startWork(task(), 'request' as TaskRunRequestId)).rejects.toThrow('Connected Session missing')
      expect(b.sessions.create).not.toHaveBeenCalled()
      expect(b.uiWorkspace.openSession).not.toHaveBeenCalled()
      expect(b.taskboard.move).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('creates, connects, disconnects and opens without submitting work', async () => {
    const b = await bench()
    try {
      const row = task()
      const creation = { workspaceId: row.workspaceId, title: row.title, connection: copilot }
      await b.face.createTask(creation)
      expect(b.taskboard.create).toHaveBeenCalledExactlyOnceWith(creation)
      await b.face.connectTask(row, copilot, { kind: 'copilot' })
      expect(b.taskboard.connect).toHaveBeenCalledExactlyOnceWith({ taskId: row.id, expectedRevision: row.revision, connection: copilot, executionSettings: { kind: 'copilot' } })
      await b.face.connectTask(row, dsh)
      expect(b.taskboard.connect).toHaveBeenLastCalledWith({ taskId: row.id, expectedRevision: row.revision, connection: dsh })
      await b.face.disconnectTask(row)
      expect(b.taskboard.disconnect).toHaveBeenCalledWith({ taskId: row.id, expectedRevision: row.revision })
      b.face.openSession(dsh.sessionId)
      expect(b.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith(dsh.sessionId)
      await b.face.openAgencyCopilot(row)
      expect(b.taskboard.openAgencyCopilot).toHaveBeenCalledExactlyOnceWith(row.id, undefined)
      await b.face.openAgencyCopilot(row, 'history' as TaskExecutionId)
      expect(b.taskboard.openAgencyCopilot).toHaveBeenNthCalledWith(2, row.id, 'history')
      expect(b.taskboard.run).not.toHaveBeenCalled()
      expect(b.sessions.create).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('forwards authoritative options, confirmation and revision-checked manual mutations', async () => {
    const b = await bench()
    try {
      const row = task({ status: 'in_progress' })
      await expect(b.face.executionOptions()).resolves.toBe(options)
      await b.face.confirmPermissions(row)
      await b.face.restoreTask(row)
      await b.face.updateTask(row, { prompt: 'Separate prompt' })
      await b.face.moveTask(row, 'in_review')
      await b.face.moveTask(row, 'in_review', row.id)
      await b.face.agencyCopilotCapability()
      await b.face.listAgencyCopilotSessions(row.workspaceId)
      b.face.closeSurface()
      await b.face.archiveTask(row)
      await b.face.deleteTask(row)
      expect(b.taskboard.confirmPermissions).toHaveBeenCalledWith({ taskId: row.id, expectedRevision: row.revision })
      expect(b.taskboard.restore).toHaveBeenCalledWith({ taskId: row.id, expectedRevision: row.revision })
      expect(b.taskboard.update).toHaveBeenCalledWith({ taskId: row.id, expectedRevision: row.revision, patch: { prompt: 'Separate prompt' } })
      expect(b.taskboard.move).toHaveBeenCalledWith({ taskId: row.id, expectedRevision: row.revision, status: 'in_review' })
      expect(b.taskboard.archive).toHaveBeenCalledWith(row.id, row.revision)
      expect(b.taskboard.delete).toHaveBeenCalledWith(row.id, row.revision)
      expect(b.taskboard.move).toHaveBeenLastCalledWith({ taskId: row.id, expectedRevision: row.revision, status: 'in_review', beforeTaskId: row.id })
      expect(b.taskboard.agencyCopilotCapability).toHaveBeenCalledOnce()
      expect(b.taskboard.listAgencyCopilotSessions).toHaveBeenCalledWith(row.workspaceId)
      expect(b.layout.selectPanel).toHaveBeenLastCalledWith(null)
    } finally { await b.ctx.fiber.dispose() }
  })

  it('inspects only exclusively connected Copilot tasks', async () => {
    const b = await bench()
    try {
      const linked = task({ connection: copilot, executionSettings: { kind: 'copilot' } })
      await b.face.refreshAgencyCopilot([task(), task({ connection: dsh }), linked, linked])
      expect(b.taskboard.inspectAgencyCopilot).toHaveBeenCalledExactlyOnceWith([linked.id])
      await b.face.refreshAgencyCopilot([])
      expect(b.taskboard.inspectAgencyCopilot).toHaveBeenCalledOnce()
    } finally { await b.ctx.fiber.dispose() }
  })
})
