import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgencyCopilotSessionId, TaskboardCreateRequest, TaskboardDeleteValue, TaskboardInspectAgencyCopilotValue, TaskboardTask,
  TaskboardTaskValue, TaskId, TaskStatus,
} from '../src/types.ts'
import { ClientTaskboardModel } from '../src/client/model.ts'
import { TaskboardClientController, TaskboardCommandError } from '../src/client/service.ts'

const id = (value: string): TaskId => value as TaskId
function task(value: string, status: TaskStatus, rank: number, revision = 1): TaskboardTask {
  return {
    id: id(value), revision, ordinal: Number(value.slice(1)), workspaceId: 'w1' as TaskboardTask['workspaceId'],
    title: value, description: '', status, rank, labels: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}
function ok(value: TaskboardTask): RemoteResult<TaskboardTaskValue> { return { ok: true, value: { task: value } } }
function remote() {
  return {
    create: vi.fn((request: TaskboardCreateRequest) => Promise.resolve(ok(task('t9', request.status ?? 'backlog', 0)))),
    update: vi.fn(), move: vi.fn(), archive: vi.fn(), delete: vi.fn(), agencyCopilotCapability: vi.fn(),
    startAgencyCopilot: vi.fn(), clearAgencyCopilot: vi.fn(), openAgencyCopilot: vi.fn(), inspectAgencyCopilot: vi.fn(),
    listAgencyCopilotSessions: vi.fn(),
    async *follow(): AsyncGenerator<never> {},
  }
}

describe('ClientTaskboardModel', () => {
  it('forwards Workspace session discovery through the service without changing task state', async () => {
    const wire = remote()
    const value = {
      sessions: [{ sessionId: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId, summary: 'Existing', status: 'in_use' }],
      truncated: true,
    }
    wire.listAgencyCopilotSessions.mockResolvedValue({ ok: true, value })
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire as never)
      const controller = new TaskboardClientController(ctx, model)
      const initial = task('t1', 'todo', 0)
      model.replaceBaseline({ tasks: [initial] })
      const before = controller.list.getSnapshot()
      await expect(controller.listAgencyCopilotSessions(initial.workspaceId)).resolves.toBe(value)
      expect(wire.listAgencyCopilotSessions).toHaveBeenCalledExactlyOnceWith({ workspaceId: initial.workspaceId })
      expect(controller.list.getSnapshot()).toBe(before)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['remote-failure', 'rejected-fetch'] as const)('surfaces %s during session discovery', async (kind) => {
    const wire = remote()
    const failure = new RemoteError('taskboard/agency-unavailable', 'Agency is offline', {})
    const rejected = new TypeError('Failed to fetch')
    if (kind === 'remote-failure') wire.listAgencyCopilotSessions.mockResolvedValue({ ok: false, error: failure })
    else wire.listAgencyCopilotSessions.mockRejectedValue(rejected)
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire as never)
      const controller = new TaskboardClientController(ctx, model)
      const before = controller.list.getSnapshot()
      const request = controller.listAgencyCopilotSessions(task('t1', 'todo', 0).workspaceId)
      if (kind === 'remote-failure') {
        await expect(request).rejects.toBeInstanceOf(TaskboardCommandError)
        await expect(request).rejects.toMatchObject({ operation: 'list Agency Copilot sessions', failure })
      } else await expect(request).rejects.toBe(rejected)
      expect(controller.list.getSnapshot()).toBe(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('forwards existing-session create and edit fields intact and installs atomic echoes', async () => {
    const wire = remote()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const initial = { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId }
    const cleared = { ...task('t1', 'todo', 0, 2), title: 'Edited' }
    wire.create.mockResolvedValue(ok(initial))
    wire.update.mockResolvedValue(ok(cleared))
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire as never)
      const controller = new TaskboardClientController(ctx, model)
      const creating = { workspaceId: initial.workspaceId, title: initial.title, agencyCopilotSessionId: sessionId }
      await expect(controller.create(creating)).resolves.toEqual(initial)
      expect(wire.create).toHaveBeenCalledExactlyOnceWith(creating)
      expect(controller.list.getSnapshot().tasks).toEqual([initial])
      const updating = {
        taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Edited', agencyCopilotSessionId: null },
      }
      await expect(controller.update(updating)).resolves.toEqual(cleared)
      expect(wire.update).toHaveBeenCalledExactlyOnceWith(updating)
      expect(controller.list.getSnapshot().tasks).toEqual([cleared])
    } finally { await ctx.fiber.dispose() }
  })

  it('sorts baselines and every upsert by status/rank/ordinal/id', () => {
    const model = new ClientTaskboardModel(remote() as never)
    model.replaceBaseline({ tasks: [task('t3', 'done', 0), task('t2', 'todo', 1024), task('t1', 'todo', 0)] })
    expect(model.getSnapshot().tasks.map(row => row.id)).toEqual(['t1', 't2', 't3'])
    model.upsertTask(task('t2', 'backlog', 0, 2))
    expect(model.getSnapshot().tasks.map(row => row.id)).toEqual(['t2', 't1', 't3'])
  })

  it('retains a newer unary echo across a stale reconnect baseline until stream catch-up', async () => {
    const wire = remote()
    const updated = { ...task('t1', 'todo', 0, 2), title: 'new' }
    wire.update.mockResolvedValue(ok(updated))
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0, 1)] })
    await model.update({ taskId: id('t1'), expectedRevision: 1, patch: { title: 'new' } })
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0, 1)] })
    expect(model.getSnapshot().tasks[0]).toMatchObject({ revision: 2, title: 'new' })
    model.upsertTask(updated)
    model.replaceBaseline({ tasks: [updated] })
    expect(model.getSnapshot().tasks[0]).toMatchObject({ revision: 2, title: 'new' })
  })

  it('treats an absent complete baseline as authoritative over an older unary echo', async () => {
    const wire = remote()
    const updated = { ...task('t1', 'todo', 0, 2), title: 'locally edited' }
    wire.update.mockResolvedValue(ok(updated))
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0, 1)] })
    await model.update({ taskId: id('t1'), expectedRevision: 1, patch: { title: 'locally edited' } })
    model.replaceBaseline({ tasks: [] })
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('retains the committed archive echo against delayed older stream upserts and baselines', async () => {
    const wire = remote()
    const archived = { ...task('t1', 'todo', 0, 2), archivedAt: '2026-01-02T00:00:00.000Z' }
    wire.archive.mockResolvedValue(ok(archived))
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0, 1)] })
    await model.archive({ taskId: id('t1'), expectedRevision: 1 })
    expect(model.getSnapshot().tasks).toEqual([archived])
    model.upsertTask(task('t1', 'todo', 0, 1))
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0, 1)] })
    expect(model.getSnapshot().tasks).toEqual([archived])
  })

  it.each(['remote-failure', 'rejected-fetch'] as const)(
    'preserves the task on %s and archives only after an explicit successful retry',
    async (failureMode) => {
      const wire = remote()
      const initial = task('t1', 'done', 0)
      const archived = { ...initial, revision: 2, archivedAt: '2026-01-02T00:00:00.000Z' }
      const failure = new RemoteError('gateway/internal', 'Failed to fetch', {})
      const rejected = new TypeError('Failed to fetch')
      if (failureMode === 'remote-failure') wire.archive.mockResolvedValueOnce({ ok: false, error: failure })
      else wire.archive.mockRejectedValueOnce(rejected)
      wire.archive.mockResolvedValueOnce(ok(archived))
      const ctx = new Context()
      try {
        const model = new ClientTaskboardModel(wire as never)
        const controller = new TaskboardClientController(ctx, model)
        model.replaceBaseline({ tasks: [initial] })
        const before = controller.list.getSnapshot()
        const archiving = controller.archive(initial.id, initial.revision)
        if (failureMode === 'remote-failure') {
          await expect(archiving).rejects.toBeInstanceOf(TaskboardCommandError)
          await expect(archiving).rejects.toMatchObject({ operation: 'archive', failure })
        } else {
          await expect(archiving).rejects.toBe(rejected)
        }
        expect(controller.list.getSnapshot()).toBe(before)
        expect(wire.archive).toHaveBeenCalledExactlyOnceWith({ taskId: initial.id, expectedRevision: 1 })
        await controller.archive(initial.id, initial.revision)
        expect(wire.archive).toHaveBeenCalledTimes(2)
        expect(controller.list.getSnapshot().tasks).toEqual([archived])
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )

  it('does not reactivate an archived stream row when a stale mutation settles before a stale baseline', async () => {
    const wire = remote()
    const delayed = Promise.withResolvers<RemoteResult<TaskboardTaskValue>>()
    wire.update.mockReturnValue(delayed.promise)
    const model = new ClientTaskboardModel(wire as never)
    const initial = task('t1', 'todo', 0)
    const updated = { ...initial, title: 'Edited', revision: 2 }
    const archived = { ...updated, revision: 3, archivedAt: '2026-01-02T00:00:00.000Z' }
    model.replaceBaseline({ tasks: [initial] })
    const updating = model.update({ taskId: initial.id, expectedRevision: 1, patch: { title: 'Edited' } })
    model.upsertTask(archived)
    delayed.resolve(ok(updated))
    await updating
    model.handleCarrierFailure()
    model.replaceBaseline({ tasks: [initial] })
    expect(model.getSnapshot().tasks).toEqual([archived])
    model.upsertTask(updated)
    expect(model.getSnapshot().tasks).toEqual([archived])
  })

  it('restores archived baseline rows across reconnects and a fresh Client model', () => {
    const archived = { ...task('t1', 'in_review', 0, 2), archivedAt: '2026-01-02T00:00:00.000Z' }
    const baseline = { tasks: [archived, task('t2', 'done', 0)] }
    const model = new ClientTaskboardModel(remote() as never)
    model.replaceBaseline(baseline)
    model.handleCarrierFailure()
    expect(model.getSnapshot()).toMatchObject({ tasks: baseline.tasks, state: 'loading', phase: 'ready' })
    model.replaceBaseline(baseline)
    expect(model.getSnapshot()).toMatchObject({ tasks: baseline.tasks, state: 'idle' })
    const refreshed = new ClientTaskboardModel(remote() as never)
    refreshed.replaceBaseline(baseline)
    expect(refreshed.getSnapshot().tasks).toEqual(baseline.tasks)
  })

  it('keeps actual deletion tombstones against delayed archive echoes and stale baselines', async () => {
    const wire = remote()
    const delayed = Promise.withResolvers<RemoteResult<TaskboardTaskValue>>()
    wire.archive.mockReturnValue(delayed.promise)
    const initial = task('t1', 'todo', 0)
    const archived = { ...initial, revision: 2, archivedAt: '2026-01-02T00:00:00.000Z' }
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [initial] })
    const archiving = model.archive({ taskId: initial.id, expectedRevision: 1 })
    model.removeTask(initial.id, Number.MAX_SAFE_INTEGER)
    delayed.resolve(ok(archived))
    await archiving
    model.replaceBaseline({ tasks: [archived] })
    model.upsertTask(initial)
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('removes archived rows omitted from a complete baseline', async () => {
    const wire = remote()
    const archived = { ...task('t1', 'todo', 0, 2), archivedAt: '2026-01-02T00:00:00.000Z' }
    wire.archive.mockResolvedValue(ok(archived))
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0)] })
    await model.archive({ taskId: id('t1'), expectedRevision: 1 })
    model.replaceBaseline({ tasks: [] })
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('ignores a removal older than the retained task revision', () => {
    const model = new ClientTaskboardModel(remote() as never)
    const current = task('t1', 'todo', 0, 3)
    model.replaceBaseline({ tasks: [current] })
    model.removeTask(current.id, 2)
    model.upsertTask(task('t1', 'todo', 0, 1))
    model.replaceBaseline({ tasks: [current] })
    expect(model.getSnapshot().tasks).toEqual([current])
    model.removeTask(current.id, 3)
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('installs Start with Copilot echoes and isolates transient Agency status failures', async () => {
    const wire = remote()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const linked = { ...task('t1', 'todo', 0, 2), agencyCopilotSessionId: sessionId }
    wire.startAgencyCopilot.mockResolvedValue({ ok: true, value: { task: linked, launch: 'accepted' } })
    wire.inspectAgencyCopilot.mockResolvedValueOnce({
      ok: true,
      value: { observations: [{ taskId: id('t1'), sessionId, status: 'idle' }] },
    }).mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('taskboard/agency-unavailable', 'offline', {}),
    })
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [task('t1', 'todo', 0)] })
    await model.startAgencyCopilot({ taskId: id('t1'), expectedRevision: 1 })
    expect(model.getSnapshot().tasks[0]).toMatchObject({ revision: 2, agencyCopilotSessionId: sessionId })
    await model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    expect(model.getSnapshot()).toMatchObject({
      state: 'idle', agencyState: 'idle', agencyByTask: { t1: { status: 'idle' } },
    })
    await model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    expect(model.getSnapshot()).toMatchObject({ state: 'idle', agencyState: 'error' })
    expect(model.getSnapshot().agencyByTask[id('t1')]).toMatchObject({ status: 'idle' })
  })

  it('merges overlapping Agency refreshes per task with newest-request wins', async () => {
    const wire = remote()
    const sessionOne = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const sessionTwo = '2eb3dbf2-8b82-4863-b505-520708dcce80' as AgencyCopilotSessionId
    const first = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    const second = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    wire.inspectAgencyCopilot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [
      { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionOne },
      { ...task('t2', 'todo', 1), agencyCopilotSessionId: sessionTwo },
    ] })
    const all = model.inspectAgencyCopilot({ taskIds: [id('t1'), id('t2')] })
    const one = model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    second.resolve({ ok: true, value: { observations: [
      { taskId: id('t1'), sessionId: sessionOne, status: 'in_use' },
    ] } })
    await one
    first.resolve({ ok: true, value: { observations: [
      { taskId: id('t1'), sessionId: sessionOne, status: 'idle' },
      { taskId: id('t2'), sessionId: sessionTwo, status: 'idle' },
    ] } })
    await all
    expect(model.getSnapshot().agencyByTask).toMatchObject({
      t1: { status: 'in_use' }, t2: { status: 'idle' },
    })
    expect(model.getSnapshot().agencyState).toBe('idle')
  })

  it.each(['echo', 'baseline', 'clear'] as const)(
    'prunes current and delayed Agency observations after a link changes through %s',
    async (arrival) => {
      const wire = remote()
      const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
      const replacement = '2eb3dbf2-8b82-4863-b505-520708dcce80' as AgencyCopilotSessionId
      const initial = { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId }
      const changed = arrival === 'clear'
        ? task('t1', 'todo', 0, 2)
        : { ...initial, revision: 2, agencyCopilotSessionId: replacement }
      const observed: RemoteResult<TaskboardInspectAgencyCopilotValue> = {
        ok: true, value: { observations: [{ taskId: initial.id, sessionId, status: 'idle' }] },
      }
      const delayed = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
      wire.inspectAgencyCopilot.mockResolvedValueOnce(observed).mockReturnValueOnce(delayed.promise)
      wire.update.mockResolvedValue(ok(changed))
      const model = new ClientTaskboardModel(wire as never)
      model.replaceBaseline({ tasks: [initial] })
      await model.inspectAgencyCopilot({ taskIds: [initial.id] })
      const refreshing = model.inspectAgencyCopilot({ taskIds: [initial.id] })
      if (arrival === 'baseline') model.replaceBaseline({ tasks: [changed] })
      else {
        await model.update({
          taskId: initial.id, expectedRevision: 1, patch: { agencyCopilotSessionId: arrival === 'clear' ? null : replacement },
        })
      }
      expect(model.getSnapshot().agencyByTask).toEqual({})
      delayed.resolve(observed)
      await refreshing
      expect(model.getSnapshot().agencyByTask).toEqual({})
      expect(model.getSnapshot().tasks).toEqual([changed])
    },
  )

  it.each(['echo', 'upsert', 'baseline', 'remove'] as const)(
    'drops Agency observations on archive or deletion through %s, including in-flight results',
    async (arrival) => {
      const wire = remote()
      const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
      const linked = { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId }
      const archived = { ...linked, revision: 2, archivedAt: '2026-01-02T00:00:00.000Z' }
      const observed: RemoteResult<TaskboardInspectAgencyCopilotValue> = {
        ok: true, value: { observations: [{ taskId: linked.id, sessionId, status: 'idle' }] },
      }
      const delayed = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
      wire.inspectAgencyCopilot.mockResolvedValueOnce(observed).mockReturnValueOnce(delayed.promise)
      wire.archive.mockResolvedValue(ok(archived))
      const model = new ClientTaskboardModel(wire as never)
      model.replaceBaseline({ tasks: [linked] })
      await model.inspectAgencyCopilot({ taskIds: [linked.id] })
      expect(model.getSnapshot().agencyByTask[linked.id]).toMatchObject({ status: 'idle' })
      const refreshing = model.inspectAgencyCopilot({ taskIds: [linked.id] })
      switch (arrival) {
        case 'echo': await model.archive({ taskId: linked.id, expectedRevision: 1 }); break
        case 'upsert': model.upsertTask(archived); break
        case 'baseline': model.replaceBaseline({ tasks: [archived] }); break
        case 'remove': model.removeTask(linked.id, Number.MAX_SAFE_INTEGER); break
      }
      expect(model.getSnapshot().agencyByTask).toEqual({})
      delayed.resolve(observed)
      await refreshing
      expect(model.getSnapshot().agencyByTask).toEqual({})
      expect(model.getSnapshot().tasks).toEqual(arrival === 'remove' ? [] : [archived])
    },
  )

  it('publishes one stable snapshot after a microtask batch', async () => {
    const model = new ClientTaskboardModel(remote() as never)
    const listener = vi.fn()
    model.subscribe(listener)
    model.replaceBaseline({ tasks: [] })
    model.upsertTask(task('t1', 'todo', 0))
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    expect(model.getSnapshot()).toBe(model.getSnapshot())
  })

  it('retains the Remote error instance and typed details on a terminal stream failure', () => {
    const model = new ClientTaskboardModel(remote() as never)
    const failure = new RemoteError('taskboard/task-not-found', 'Task was removed', { taskId: id('t1') })
    model.handleStreamFailure(failure)
    expect(model.getSnapshot().error).toBe(failure)
    expect(remoteErrorOf(model.getSnapshot().error)).toMatchObject({
      code: 'taskboard/task-not-found', details: { taskId: id('t1') },
    })
  })

  it.each([new Error('Broken stream'), 'Broken stream'])('normalizes an unclassified stream failure into an Error', (error) => {
    const model = new ClientTaskboardModel(remote() as never)
    model.handleStreamFailure(error)
    const failure = model.getSnapshot().error
    expect(failure).toBeInstanceOf(Error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'gateway/internal', message: 'Broken stream', details: {}, cause: error,
    })
  })

  it('records a rejected Agency inspection as a Remote error while preserving the original rejection', async () => {
    const wire = remote()
    const error = new Error('Agency inspection failed')
    wire.inspectAgencyCopilot.mockRejectedValue(error)
    const model = new ClientTaskboardModel(wire as never)
    await expect(model.inspectAgencyCopilot({ taskIds: [id('t1')] })).rejects.toBe(error)
    expect(model.getSnapshot().agencyError).toBeInstanceOf(Error)
    expect(remoteErrorOf(model.getSnapshot().agencyError)).toMatchObject({
      code: 'gateway/internal', message: error.message, cause: error,
    })
  })

  it.each([false, true])('deletes an active or archived linked row only after a successful receipt (archived=%s)', async (archived) => {
    const wire = remote()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const initial = {
      ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId,
      ...(archived ? { archivedAt: '2026-01-02T00:00:00.000Z' } : {}),
    }
    const retained = task('t2', 'todo', 1)
    const pending = Promise.withResolvers<RemoteResult<TaskboardDeleteValue>>()
    wire.delete.mockReturnValue(pending.promise)
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire as never)
      const controller = new TaskboardClientController(ctx, model)
      model.replaceBaseline({ tasks: [initial, retained] })
      const before = controller.list.getSnapshot()
      const deleting = controller.delete(initial.id, initial.revision)
      expect(controller.list.getSnapshot()).toBe(before)
      pending.resolve({ ok: true, value: { taskId: initial.id, revision: Number.MAX_SAFE_INTEGER } })
      await expect(deleting).resolves.toBeUndefined()
      expect(wire.delete).toHaveBeenCalledExactlyOnceWith({ taskId: initial.id, expectedRevision: initial.revision })
      expect(controller.list.getSnapshot().tasks).toEqual([retained])
      expect(wire.openAgencyCopilot).not.toHaveBeenCalled()
      expect(wire.clearAgencyCopilot).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['remote-failure', 'rejected-fetch'] as const)(
    'preserves task and Agency observation on deletion %s and retries only on request',
    async (kind) => {
      const wire = remote()
      const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
      const initial = { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId }
      const failure = new RemoteError('taskboard/revision-conflict', 'Current revision changed', {
        taskId: initial.id, expectedRevision: initial.revision, actualRevision: initial.revision + 1,
      })
      const rejected = new TypeError('Failed to fetch')
      if (kind === 'remote-failure') wire.delete.mockResolvedValueOnce({ ok: false, error: failure })
      else wire.delete.mockRejectedValueOnce(rejected)
      wire.delete.mockResolvedValueOnce({ ok: true, value: { taskId: initial.id, revision: Number.MAX_SAFE_INTEGER } })
      wire.inspectAgencyCopilot.mockResolvedValue({
        ok: true, value: { observations: [{ taskId: initial.id, sessionId, status: 'in_use' }] },
      })
      const ctx = new Context()
      try {
        const model = new ClientTaskboardModel(wire as never)
        const controller = new TaskboardClientController(ctx, model)
        model.replaceBaseline({ tasks: [initial] })
        await model.inspectAgencyCopilot({ taskIds: [initial.id] })
        const before = controller.list.getSnapshot()
        const deleting = controller.delete(initial.id, initial.revision)
        if (kind === 'remote-failure') {
          await expect(deleting).rejects.toBeInstanceOf(TaskboardCommandError)
          await expect(deleting).rejects.toMatchObject({ operation: 'delete', failure })
        } else await expect(deleting).rejects.toBe(rejected)
        expect(controller.list.getSnapshot()).toBe(before)
        expect(wire.delete).toHaveBeenCalledExactlyOnceWith({ taskId: initial.id, expectedRevision: initial.revision })
        await controller.delete(initial.id, initial.revision)
        expect(controller.list.getSnapshot()).toMatchObject({ tasks: [], agencyByTask: {} })
        expect(wire.delete).toHaveBeenCalledTimes(2)
      } finally { await ctx.fiber.dispose() }
    },
  )

  it('keeps deletion authoritative over later higher-revision echoes, baselines, and Agency observations', async () => {
    const wire = remote()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const initial = { ...task('t1', 'todo', 0), agencyCopilotSessionId: sessionId }
    const observed: RemoteResult<TaskboardInspectAgencyCopilotValue> = {
      ok: true, value: { observations: [{ taskId: initial.id, sessionId, status: 'in_use' }] },
    }
    const delayedObservation = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    const delayedUpdate = Promise.withResolvers<RemoteResult<TaskboardTaskValue>>()
    wire.inspectAgencyCopilot.mockResolvedValueOnce(observed).mockReturnValueOnce(delayedObservation.promise)
    wire.update.mockReturnValue(delayedUpdate.promise)
    wire.delete.mockResolvedValue({ ok: true, value: { taskId: initial.id, revision: Number.MAX_SAFE_INTEGER } })
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [initial] })
    await model.inspectAgencyCopilot({ taskIds: [initial.id] })
    const refreshing = model.inspectAgencyCopilot({ taskIds: [initial.id] })
    const updating = model.update({ taskId: initial.id, expectedRevision: 1, patch: { title: 'Delayed edit' } })
    await model.delete({ taskId: initial.id, expectedRevision: 3 })
    expect(model.getSnapshot()).toMatchObject({ tasks: [], agencyByTask: {} })
    delayedUpdate.resolve(ok({ ...initial, revision: 2, title: 'Delayed edit' }))
    delayedObservation.resolve(observed)
    await Promise.all([updating, refreshing])
    model.upsertTask({ ...initial, revision: 3 })
    model.handleCarrierFailure()
    model.replaceBaseline({ tasks: [{ ...initial, revision: 3 }] })
    expect(model.getSnapshot()).toMatchObject({ tasks: [], agencyByTask: {}, state: 'idle' })
    model.replaceBaseline({ tasks: [] })
    model.upsertTask(initial)
    const reusedOrdinal = { ...task('t2', 'todo', 0), ordinal: initial.ordinal }
    model.upsertTask(reusedOrdinal)
    expect(model.getSnapshot().tasks).toEqual([reusedOrdinal])
  })

  it('accepts a delayed deletion receipt after a feed tombstone without reviving the task', async () => {
    const wire = remote()
    const initial = task('t1', 'todo', 0)
    const delayed = Promise.withResolvers<RemoteResult<TaskboardDeleteValue>>()
    wire.delete.mockReturnValue(delayed.promise)
    const model = new ClientTaskboardModel(wire as never)
    model.replaceBaseline({ tasks: [initial] })
    const deleting = model.delete({ taskId: initial.id, expectedRevision: initial.revision })
    model.removeTask(initial.id, Number.MAX_SAFE_INTEGER)
    model.replaceBaseline({ tasks: [initial] })
    delayed.resolve({ ok: true, value: { taskId: initial.id, revision: Number.MAX_SAFE_INTEGER } })
    await deleting
    model.upsertTask({ ...initial, revision: 2 })
    expect(model.getSnapshot().tasks).toEqual([])
  })
})
