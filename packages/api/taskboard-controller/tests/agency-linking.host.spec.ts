import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import TaskboardService, { AgencyCopilotSessionId } from '@deepseek-ai/dsh-taskboard'
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskboardController from '../src/index.ts'

const firstId = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
const secondId = AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80')
const roots: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

function page(sessionId = firstId, folder = process.cwd(), status: 'idle' | 'in_use' = 'idle'): string {
  return JSON.stringify({ sessions: [{ session_id: sessionId, folder, status, summary: 'Inspect the logs' }] })
}

async function harness(pool = new MemoryMediaPool(), launchEnabled = false) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [{
    version: 0, id: SessionId('native'), createdAt: 0, cwd: process.cwd(),
  }] } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TaskboardService)
  const workspace = await ctx.workspaceRegistry.create(process.cwd())
  const read = vi.fn(async () => page())
  const spawn = vi.fn((_spec: SubprocessSpawnSpec): SubprocessHandle => {
    let output = ''
    return {
      pid: 7, stdin: undefined, stdout: undefined, stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: read().then((text) => {
        output = text
        return { exitCode: 0, signal: null }
      }),
      terminate: () => {},
      waitForExit: async () => true,
    }
  })
  ctx.provide('subprocess', { resolveExecutable: async () => 'C:\\Agency\\agency.exe', spawn } as never)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose },
  } as never)
  const launch = vi.fn(() => { throw new Error('Selection must not launch a terminal') })
  const controller = new TaskboardController(
    ctx, { agencyCopilotLaunch: launchEnabled }, { agency: { platform: 'win32', spawnBroker: launch } },
  )
  return { ctx, pool, facility, board: ctx.taskboard, workspace, read, spawn, launch, controller }
}

describe('Taskboard existing Agency session selection', () => {
  it('lists only canonical Workspace matches with summary/status and no folder disclosure', async () => {
    const b = await harness()
    b.read.mockResolvedValue(JSON.stringify({ sessions: [
      { session_id: firstId, folder: resolve('packages') + sep + '..', summary: 'Inspect logs', status: 'idle' },
      { session_id: secondId, folder: process.cwd(), summary: null, status: 'in_use' },
      { session_id: 'e4720b81-7665-4f72-8848-4c88fbd380fa', folder: resolve('packages'), summary: 'Other', status: 'idle' },
      { session_id: '1e323f11-5fd0-438f-aaf5-c8c10b2d3b95', folder: null, status: 'idle' },
    ] }))
    await expect(b.controller.listAgencyCopilotSessions(
      { workspaceId: b.workspace.id }, new AbortController().signal,
    )).resolves.toEqual({
      sessions: [
        { sessionId: firstId, summary: 'Inspect logs', status: 'idle' },
        { sessionId: secondId, status: 'in_use' },
      ],
      truncated: false,
    })

    expect(b.spawn).toHaveBeenCalledOnce()
    expect(b.launch).not.toHaveBeenCalled()
    expect(b.board.list()).toEqual([])
  })

  it('returns matching rows with truncation when further Agency pages remain', async () => {
    const b = await harness()
    b.read.mockResolvedValue(JSON.stringify({
      sessions: [{ session_id: firstId, folder: process.cwd(), status: 'idle', summary: '' }],
      next_cursor: 'more',
    }))
    await expect(b.controller.listAgencyCopilotSessions(
      { workspaceId: b.workspace.id }, new AbortController().signal,
    )).resolves.toEqual({ sessions: [{ sessionId: firstId, status: 'idle', summary: '' }], truncated: true })
    expect(b.read).toHaveBeenCalledTimes(10)
  })

  it('rejects an unregistered Workspace without running Agency discovery', async () => {
    const b = await harness()
    await expect(b.controller.listAgencyCopilotSessions(
      { workspaceId: WorkspaceId('missing') }, new AbortController().signal,
    )).rejects.toMatchObject({ failure: { code: 'workspace-not-found' } })
    expect(b.read).not.toHaveBeenCalled()
  })

  it.each(['malformed', 'unavailable', 'cancelled'] as const)('surfaces %s discovery instead of an empty success', async (kind) => {
    const b = await harness()
    const signal = new AbortController()
    if (kind === 'malformed') b.read.mockResolvedValue('{bad JSON')
    if (kind === 'unavailable') b.read.mockRejectedValue(new Error('Agency missing'))
    if (kind === 'cancelled') {
      b.read.mockImplementation(async () => {
        signal.abort(new Error('Cancelled'))
        return page()
      })
    }
    const request = b.controller.listAgencyCopilotSessions({ workspaceId: b.workspace.id }, signal.signal)
    if (kind === 'cancelled') await expect(request).rejects.toThrow('Cancelled')
    else await expect(request).rejects.toMatchObject({ failure: { code: 'agency-unavailable' } })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['idle', 'in_use'] as const)('creates content and an existing %s session in one durable write', async (status) => {
    const b = await harness()
    b.read.mockResolvedValue(page(firstId, process.cwd(), status))
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    const { task } = await b.controller.create({
      workspaceId: b.workspace.id, title: 'Linked task', description: 'Saved content', status: 'in_review',
      agencyCopilotSessionId: firstId,
    }, new AbortController().signal)
    expect(write).toHaveBeenCalledOnce()
    expect(task).toMatchObject({
      revision: 1, title: 'Linked task', description: 'Saved content', status: 'in_review', agencyCopilotSessionId: firstId,
    })
    expect(b.board.list()).toEqual([task])
    expect(b.launch).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness(b.pool)
    expect(reopened.board.get(task.id)).toEqual(task)
  })

  it('updates content and Agency link atomically while retaining the DSH Session and planning status', async () => {
    const b = await harness()
    await b.workspace.attachSession(SessionId('native'))
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', agencyCopilotSessionId: firstId })
    const native = await b.board.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { sessionId: SessionId('native') },
    })
    b.read.mockResolvedValue(page(secondId))
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    const { task } = await b.controller.update({
      taskId: native.id, expectedRevision: native.revision,
      patch: { title: 'Edited', description: 'Linked existing conversation', agencyCopilotSessionId: secondId },
    }, new AbortController().signal)
    expect(write).toHaveBeenCalledOnce()
    expect(task).toMatchObject({
      revision: native.revision + 1, title: 'Edited', description: 'Linked existing conversation',
      sessionId: 'native', agencyCopilotSessionId: secondId, status: 'backlog',
    })
    expect(b.launch).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness(b.pool)
    expect(reopened.board.get(task.id)).toEqual(task)
  })

  it('retains an omitted or unchanged link while discovery is offline and clears without discovery', async () => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', agencyCopilotSessionId: firstId })
    b.read.mockRejectedValue(new Error('Agency offline'))
    const { task: unchanged } = await b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision,
      patch: { title: 'Edited', agencyCopilotSessionId: firstId },
    })
    const { task: retained } = await b.controller.update({
      taskId: initial.id, expectedRevision: unchanged.revision, patch: { description: 'Metadata only' },
    })
    expect(retained.agencyCopilotSessionId).toBe(firstId)
    const { task: cleared } = await b.controller.update({
      taskId: initial.id, expectedRevision: retained.revision, patch: { agencyCopilotSessionId: null, title: 'Cleared' },
    })
    expect(cleared).toMatchObject({ title: 'Cleared', revision: retained.revision + 1 })
    expect(cleared.agencyCopilotSessionId).toBeUndefined()
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('clears a selected link through the dedicated command without affecting the DSH Session', async () => {
    const b = await harness()
    await b.workspace.attachSession(SessionId('native'))
    const { task } = await b.controller.create({
      workspaceId: b.workspace.id, title: 'Linked', agencyCopilotSessionId: firstId,
    })
    const native = await b.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { sessionId: SessionId('native') },
    })
    b.read.mockClear().mockRejectedValue(new Error('Agency offline'))
    const { task: cleared } = await b.controller.clearAgencyCopilot({
      taskId: native.id, expectedRevision: native.revision,
    })
    expect(cleared.agencyCopilotSessionId).toBeUndefined()
    expect(cleared.sessionId).toBe('native')
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  describe.each(['create', 'update'] as const)('%s rejects before writing', (operation) => {
    it.each([
      ['missing', 'bad-request'],
      ['wrong-identity', 'bad-request'],
      ['wrong-workspace', 'bad-request'],
      ['missing-folder', 'bad-request'],
      ['invalid-uuid', 'bad-request'],
      ['incomplete', 'agency-unavailable'],
      ['malformed', 'agency-unavailable'],
      ['unavailable', 'agency-unavailable'],
      ['missing-workspace', 'workspace-not-found'],
    ] as const)('%s', async (kind, code) => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
      let selected = firstId
      switch (kind) {
        case 'missing': b.read.mockResolvedValue(JSON.stringify({ sessions: [] })); break
        case 'wrong-identity': b.read.mockResolvedValue(page(secondId)); break
        case 'wrong-workspace': b.read.mockResolvedValue(page(firstId, resolve('packages'))); break
        case 'missing-folder': b.read.mockResolvedValue(JSON.stringify({ sessions: [{ session_id: firstId, status: 'idle' }] })); break
        case 'invalid-uuid': selected = AgencyCopilotSessionId('not-a-uuid'); break
        case 'incomplete': b.read.mockResolvedValue(JSON.stringify({ sessions: [], next_cursor: 'more' })); break
        case 'malformed': b.read.mockResolvedValue('{bad JSON'); break
        case 'unavailable': b.read.mockRejectedValue(new Error('Agency offline')); break
        case 'missing-workspace': await b.ctx.workspaceRegistry.delete(b.workspace.id); break
      }
      const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', agencyCopilotSessionId: selected })
        : b.controller.update({
          taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Edited', agencyCopilotSessionId: selected },
        })
      await expect(request).rejects.toMatchObject({ failure: { code } })
      expect(write).not.toHaveBeenCalled()
      expect(b.board.list()).toEqual([initial])
      expect(b.launch).not.toHaveBeenCalled()
    })

    it('does not commit when cancellation arrives during discovery', async () => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
      const signal = new AbortController()
      b.read.mockImplementation(async () => {
        signal.abort(new Error('Cancelled before commit'))
        return page()
      })
      const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', agencyCopilotSessionId: firstId }, signal.signal)
        : b.controller.update({
          taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Edited', agencyCopilotSessionId: firstId },
        }, signal.signal)
      await expect(request).rejects.toThrow('Cancelled before commit')
      expect(write).not.toHaveBeenCalled()
      expect(b.board.list()).toEqual([initial])
    })

    it('publishes neither partial content nor a link when the durable write fails', async () => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
      b.pool.failNextWrites = 1
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', agencyCopilotSessionId: firstId })
        : b.controller.update({
          taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Edited', agencyCopilotSessionId: firstId },
        })
      await expect(request).rejects.toThrow('injected write failure')
      expect(b.board.list()).toEqual([initial])
    })
  })

  it.each(['stale', 'archived'] as const)('rejects an initially %s edit without reading Agency', async (kind) => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
    const current = kind === 'stale'
      ? await b.board.update({ taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Changed' } })
      : await b.board.archive(initial.id, initial.revision)
    await expect(b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Stale', agencyCopilotSessionId: firstId },
    })).rejects.toMatchObject({ failure: { code: kind === 'stale' ? 'revision-conflict' : 'task-archived' } })
    expect(b.board.get(initial.id)).toEqual(current)
    expect(b.read).not.toHaveBeenCalled()
  })

  it.each(['stale', 'archived', 'workspace-removed'] as const)(
    'checks authoritative state after asynchronous discovery becomes %s',
    async (kind) => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
      const pending = Promise.withResolvers<string>()
      b.read.mockReturnValue(pending.promise)
      const updating = b.controller.update({
        taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Relinked', agencyCopilotSessionId: firstId },
      })
      await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
      if (kind === 'stale') {
        await b.board.update({ taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Concurrent' } })
      } else if (kind === 'archived') await b.board.archive(initial.id, initial.revision)
      else await b.ctx.workspaceRegistry.delete(b.workspace.id)
      const retained = b.board.get(initial.id)
      const code = kind === 'stale' ? 'revision-conflict' : kind === 'archived' ? 'task-archived' : 'workspace-not-found'
      const rejected = expect(updating).rejects.toMatchObject({ failure: { code } })
      pending.resolve(page())
      await rejected
      expect(b.board.get(initial.id)).toEqual(retained)
      expect(b.launch).not.toHaveBeenCalled()
    },
  )

  it.each(['archive', 'clear', 'start', 'open'] as const)('serializes relinking with %s on the same task', async (operation) => {
    const b = await harness(undefined, true)
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', agencyCopilotSessionId: firstId })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const updating = b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { agencyCopilotSessionId: secondId },
    })
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const revision = initial.revision
    let competing: Promise<unknown>
    if (operation === 'archive') competing = b.controller.archive({ taskId: initial.id, expectedRevision: revision })
    else if (operation === 'clear') competing = b.controller.clearAgencyCopilot({ taskId: initial.id, expectedRevision: revision })
    else if (operation === 'start') {
      competing = b.controller.startAgencyCopilot({ taskId: initial.id, expectedRevision: revision }, new AbortController().signal)
    } else competing = b.controller.openAgencyCopilot({ taskId: initial.id }, new AbortController().signal)
    const settled = vi.fn()
    void competing.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    pending.resolve(page(secondId))
    const { task: linked } = await updating
    await expect(competing).rejects.toMatchObject({ failure: {
      code: operation === 'open' ? 'agency-not-linked' : 'revision-conflict',
    } })
    expect(b.board.get(initial.id)).toEqual(linked)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('cancels an edit waiting for the Agency task lock before its durable write', async () => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial' })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const linking = b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { agencyCopilotSessionId: firstId },
    })
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const cancellation = new AbortController()
    const editing = b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision + 1, patch: { title: 'Cancelled' },
    }, cancellation.signal)
    const rejected = expect(editing).rejects.toThrow('Cancelled in the task queue')
    cancellation.abort(new Error('Cancelled in the task queue'))
    pending.resolve(page())
    const { task: linked } = await linking
    await rejected
    expect(b.board.get(initial.id)).toEqual(linked)
  })
})

describe('Taskboard deletion and Agency operations', () => {
  it.each([false, true])('deletes a linked task without changing Workspace or external sessions (archived=%s)', async (archived) => {
    const b = await harness()
    await b.workspace.attachSession(SessionId('native'))
    const initial = await b.board.create({
      workspaceId: b.workspace.id, title: 'Delete task only', agencyCopilotSessionId: firstId,
    })
    const linked = await b.board.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { sessionId: SessionId('native') },
    })
    const current = archived ? await b.board.archive(linked.id, linked.revision) : linked
    const sessions = [...b.workspace.sessionIds]
    const changed = vi.fn()
    const dispose = b.ctx.on('domain/changed', changed)
    await expect(b.controller.delete({
      taskId: current.id, expectedRevision: current.revision,
    })).resolves.toEqual({ taskId: current.id, revision: Number.MAX_SAFE_INTEGER })
    expect(b.ctx.workspaceRegistry.get(b.workspace.id)).toBe(b.workspace)
    expect(b.workspace.sessionIds).toEqual(sessions)
    expect(await b.ctx.sessionPersistence.list()).toMatchObject([{ id: SessionId('native') }])
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      domain: 'taskboard', table: 'tasks', key: current.id, operation: 'deleted',
    }))
    expect(b.read).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
    dispose()
  })

  it('waits for an admitted Open before deleting without interrupting the Agency session', async () => {
    const b = await harness(undefined, true)
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Linked', agencyCopilotSessionId: firstId,
    })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const opening = b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const deleting = b.controller.delete({ taskId: task.id, expectedRevision: task.revision })
    const settled = vi.fn()
    void deleting.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(b.board.get(task.id)).toEqual(task)
    pending.resolve(page(firstId, process.cwd(), 'in_use'))
    await expect(opening).resolves.toEqual({ outcome: 'already-running' })
    await expect(deleting).resolves.toEqual({ taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
    await expect(b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'task-not-found' } })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['start', 'open', 'archive', 'clear', 'update'] as const)(
    'holds the task lock until durable deletion settles before %s',
    async (operation) => {
      const b = await harness(undefined, true)
      const task = await b.board.create({
        workspaceId: b.workspace.id, title: 'Linked', agencyCopilotSessionId: firstId,
      })
      const table = b.facility.get('taskboard')!.table('tasks')
      const remove = table.delete.bind(table)
      const entered = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      vi.spyOn(table, 'delete').mockImplementation(async (key) => {
        entered.resolve(undefined)
        await resume.promise
        return remove(key)
      })
      const request = { taskId: task.id, expectedRevision: task.revision }
      const deleting = b.controller.delete(request)
      await entered.promise
      let competing: Promise<unknown>
      switch (operation) {
        case 'start': competing = b.controller.startAgencyCopilot(request, new AbortController().signal); break
        case 'open': competing = b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal); break
        case 'archive': competing = b.controller.archive(request); break
        case 'clear': competing = b.controller.clearAgencyCopilot(request); break
        case 'update': competing = b.controller.update({ ...request, patch: { title: 'Late edit' } }); break
      }
      const rejected = expect(competing).rejects.toMatchObject({ failure: { code: 'task-not-found' } })
      expect(b.read).not.toHaveBeenCalled()
      expect(b.board.get(task.id)).toEqual(task)
      resume.resolve(undefined)
      await deleting
      await rejected
      expect(b.read).not.toHaveBeenCalled()
      expect(b.launch).not.toHaveBeenCalled()
      expect(b.board.get(task.id)).toBeUndefined()
    },
  )

  it('cancels a delete waiting for the Agency lock and leaves the task available', async () => {
    const b = await harness(undefined, true)
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Linked', agencyCopilotSessionId: firstId,
    })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const opening = b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const signal = new AbortController()
    const deleting = b.controller.delete({ taskId: task.id, expectedRevision: task.revision }, signal.signal)
    const rejected = expect(deleting).rejects.toThrow('Cancelled while waiting')
    signal.abort(new Error('Cancelled while waiting'))
    pending.resolve(page(firstId, process.cwd(), 'in_use'))
    await opening
    await rejected
    expect(b.board.get(task.id)).toEqual(task)
    await b.controller.delete({ taskId: task.id, expectedRevision: task.revision })
    expect(b.board.get(task.id)).toBeUndefined()
    expect(b.launch).not.toHaveBeenCalled()
  })
})
