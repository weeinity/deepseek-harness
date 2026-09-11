import * as fileSystem from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgencyCopilotSessionId, TaskRunRequestId } from '@deepseek-ai/dsh-taskboard'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  cleanupControllerHarness, controllerHarness as harness, firstId, nativeId, page, roots, secondId,
} from './controller-harness.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

afterEach(async () => {
  try { await cleanupControllerHarness() }
  finally { vi.mocked(fileSystem.realpath).mockReset() }
})

describe('Taskboard existing conversation selection', () => {
  it.each(['ENOENT', 'ENOTDIR'] as const)('omits an Agency folder when canonical lookup fails with %s', async (code) => {
    const b = await harness()
    vi.mocked(fileSystem.realpath).mockRejectedValueOnce(Object.assign(new Error('Folder unavailable'), { code }))
    await expect(b.controller.listAgencyCopilotSessions({ workspaceId: b.workspace.id }, new AbortController().signal))
      .resolves.toEqual({ sessions: [], truncated: false })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each([
    { error: new Error('Filesystem lookup failed'), code: 'host-operation-failed' },
    { error: Object.assign(new Error('Filesystem access denied'), { code: 'EACCES' }), code: 'EACCES' },
  ])('reports unexpected canonical-folder lookup errors without treating discovery as complete (%#)', async ({ error, code }) => {
    const b = await harness()
    vi.mocked(fileSystem.realpath).mockRejectedValueOnce(error)
    await expect(b.controller.listAgencyCopilotSessions({ workspaceId: b.workspace.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/execution-error', message: error.message, details: { code } })
    expect(b.launch).not.toHaveBeenCalled()
  })

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
    expect(b.runtime.run).not.toHaveBeenCalled()
    expect(b.board.list()).toEqual([])
  })

  it('returns matching rows with truncation when further Agency pages remain', async () => {
    const b = await harness()
    b.read.mockResolvedValue(JSON.stringify({
      sessions: [{ session_id: firstId, folder: process.cwd(), status: 'idle', summary: '' }], next_cursor: 'more',
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
    )).rejects.toMatchObject({ code: 'taskboard/workspace-not-found' })
    expect(b.read).not.toHaveBeenCalled()
  })

  it.each(['malformed', 'unavailable', 'cancelled'] as const)('surfaces %s discovery instead of an empty success', async (kind) => {
    const b = await harness()
    const signal = new AbortController()
    if (kind === 'malformed') b.read.mockResolvedValue('{bad JSON')
    if (kind === 'unavailable') b.read.mockRejectedValue(new Error('Agency missing'))
    if (kind === 'cancelled') {
      b.read.mockImplementation(async () => { signal.abort(new Error('Cancelled')); return page() })
    }
    const request = b.controller.listAgencyCopilotSessions({ workspaceId: b.workspace.id }, signal.signal)
    if (kind === 'cancelled') await expect(request).rejects.toThrow('Cancelled')
    else await expect(request).rejects.toMatchObject({ code: 'taskboard/agency-unavailable' })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['idle', 'in_use'] as const)('creates saved content and one existing %s connection in one durable write', async (status) => {
    const b = await harness()
    b.read.mockResolvedValue(page(firstId, process.cwd(), status))
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    const { task } = await b.controller.create({
      workspaceId: b.workspace.id, title: 'Linked task', description: 'Saved content', status: 'in_review',
      prompt: 'Run only when requested', executionSettings: { kind: 'copilot' },
      connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    expect(write).toHaveBeenCalledOnce()
    expect(task).toMatchObject({
      revision: 1, title: 'Linked task', description: 'Saved content', status: 'in_review',
      connection: { kind: 'copilot', sessionId: firstId }, executions: [], prompt: 'Run only when requested',
    })
    expect(task).not.toHaveProperty('sessionId')
    expect(task).not.toHaveProperty('agencyCopilotSessionId')
    expect(b.launch).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness({ pool: b.pool })
    expect(reopened.board.get(task.id)).toEqual(task)
  })

  it('retains the exclusive connection through offline planning edits and disconnects without discovery', async () => {
    const b = await harness()
    const initial = await b.board.create({
      workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' },
      connection: { kind: 'copilot', sessionId: firstId },
    })
    b.read.mockRejectedValue(new Error('Agency offline'))
    const { task: edited } = await b.controller.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Edited', description: 'Metadata only' },
    })
    expect(edited.connection).toEqual(initial.connection)
    const { task: disconnected } = await b.controller.disconnect({ taskId: edited.id, expectedRevision: edited.revision })
    expect(disconnected.connection).toBeUndefined()
    expect(disconnected.status).toBe(initial.status)
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
    expect(b.persistence.create).not.toHaveBeenCalled()
    expect(b.persistence.open).not.toHaveBeenCalled()
  })

  it('requires disconnect before replacing a connection and preserves the unrelated DSH Session', async () => {
    const b = await harness()
    await b.workspace.attachSession(nativeId)
    const initial = await b.board.create({
      workspaceId: b.workspace.id, title: 'Connected DSH', connection: { kind: 'dsh', sessionId: nativeId },
    })
    await expect(b.controller.connect({
      taskId: initial.id, expectedRevision: initial.revision,
      connection: { kind: 'copilot', sessionId: firstId }, executionSettings: { kind: 'copilot' },
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error', details: { code: 'connection-conflict' },
    })
    expect(b.board.get(initial.id)).toEqual(initial)
    const { task: disconnected } = await b.controller.disconnect({ taskId: initial.id, expectedRevision: initial.revision })
    const { task: linked } = await b.controller.connect({
      taskId: initial.id, expectedRevision: disconnected.revision,
      connection: { kind: 'copilot', sessionId: firstId }, executionSettings: { kind: 'copilot' },
    }, new AbortController().signal)
    expect(linked.connection).toEqual({ kind: 'copilot', sessionId: firstId })
    expect(b.workspace.sessionIds).toContain(nativeId)
    expect(b.persisted.has(nativeId)).toBe(true)
    expect(b.persistence.create).not.toHaveBeenCalled()
    expect(b.persistence.open).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it.each(['unaccounted', 'missing', 'valid'] as const)('validates %s DSH Sessions by membership and stat without opening bodies', async (kind) => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'DSH choice' })
    if (kind === 'unaccounted') await b.workspace.detachSession(nativeId)
    else await b.workspace.attachSession(nativeId)
    if (kind === 'missing') b.persisted.delete(nativeId)
    const request = b.controller.connect({
      taskId: task.id, expectedRevision: task.revision, connection: { kind: 'dsh', sessionId: nativeId },
    }, new AbortController().signal)
    if (kind === 'valid') {
      await expect(request).resolves.toMatchObject({ task: { connection: { kind: 'dsh', sessionId: nativeId } } })
      expect(b.persistence.stat).toHaveBeenCalledWith(nativeId)
    } else {
      await expect(request).rejects.toMatchObject({ code: 'taskboard/session-invalid' })
      expect(b.board.get(task.id)).toEqual(task)
    }
    expect(b.persistence.create).not.toHaveBeenCalled()
    expect(b.persistence.open).not.toHaveBeenCalled()
    expect(b.read).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it('cancels DSH association after stat completes without committing a connection', async () => {
    const b = await harness()
    await b.workspace.attachSession(nativeId)
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'DSH choice' })
    const signal = new AbortController()
    b.persistence.stat.mockImplementation(async () => {
      signal.abort(new Error('Cancelled during stat'))
      return b.persisted.get(nativeId)
    })
    await expect(b.controller.connect({
      taskId: task.id, expectedRevision: task.revision, connection: { kind: 'dsh', sessionId: nativeId },
    }, signal.signal)).rejects.toThrow('Cancelled during stat')
    expect(b.board.get(task.id)).toEqual(task)
    expect(b.persistence.create).not.toHaveBeenCalled()
  })

  it('quiesces unfinished discovery before fixture disposal and leaves a fresh Host usable', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Unfinished choice', executionSettings: { kind: 'copilot' } })
    b.read.mockReturnValue(new Promise(() => {}))
    const connecting = b.controller.connect({
      taskId: task.id, expectedRevision: task.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    const state = { settled: false, rejected: false }
    const completion = connecting.then(
      () => { state.settled = true; return undefined },
      (error: unknown) => { state.settled = true; state.rejected = true; return error },
    )
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const nativeSignal = b.spawn.mock.calls[0]?.[0].signal
    await cleanupControllerHarness()
    expect(state).toEqual({ settled: true, rejected: true })
    expect(nativeSignal?.aborted).toBe(true)
    const error = await completion
    expect(error).toBe(nativeSignal?.reason)
    expect(error).toMatchObject({ message: 'Taskboard Controller stopped' })
    expect(b.runtime.dispose).toHaveBeenCalledOnce()
    const restored = await harness({ pool: b.pool })
    expect(restored.board.get(task.id)).toEqual(task)
    await expect(restored.controller.connect({
      taskId: task.id, expectedRevision: task.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)).resolves.toMatchObject({ task: { connection: { kind: 'copilot', sessionId: firstId } } })
    expect(restored.launch).not.toHaveBeenCalled()
    expect(restored.runtime.run).not.toHaveBeenCalled()
  })

  it('requires an explicit preserved legacy choice and never guesses which conversation to open or run', async () => {
    const seed = await harness()
    await seed.workspace.attachSession(nativeId)
    const task = await seed.board.create({ workspaceId: seed.workspace.id, title: 'Legacy', description: 'Preserved context' })
    seed.pool.media.get('taskboard')!.tables.get('tasks')!.set(task.id, {
      revision: task.revision, ordinal: task.ordinal, workspaceId: task.workspaceId,
      title: task.title, description: task.description, status: task.status, rank: task.rank, labels: task.labels,
      createdAt: task.createdAt, updatedAt: task.updatedAt, sessionId: nativeId, agencyCopilotSessionId: firstId,
    })
    await seed.ctx.fiber.dispose()
    roots.splice(roots.indexOf(seed.ctx), 1)
    const b = await harness({ pool: seed.pool, launchEnabled: true })
    const legacy = b.board.get(task.id)!
    expect(legacy.connection).toBeUndefined()
    expect(legacy.unresolvedConnections).toEqual([
      { kind: 'dsh', sessionId: nativeId }, { kind: 'copilot', sessionId: firstId },
    ])
    await expect(b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-not-linked' })
    b.runtime.run.mockImplementation(async request => b.board.beginExecution({
      ...request, trigger: 'manual', executionSettings: { kind: 'dsh', permission: 'default' },
      proposedConnection: { kind: 'dsh', sessionId: nativeId },
    }))
    await expect(b.controller.run({
      taskId: task.id, expectedRevision: legacy.revision, requestId: TaskRunRequestId('legacy'),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error', details: { code: 'unresolved-connections' },
    })
    const { task: selected } = await b.controller.connect({
      taskId: task.id, expectedRevision: legacy.revision,
      connection: { kind: 'copilot', sessionId: firstId }, executionSettings: { kind: 'copilot' },
    }, new AbortController().signal)
    expect(selected.connection).toEqual({ kind: 'copilot', sessionId: firstId })
    expect(selected.unresolvedConnections).toBeUndefined()
    expect(selected.prompt).toBe('Legacy\n\nPreserved context')
    expect(selected.executions).toEqual([])
    expect(b.launch).not.toHaveBeenCalled()
  })

  describe.each(['create', 'connect'] as const)('%s rejects before writing', (operation) => {
    it.each([
      ['missing', 'taskboard/bad-request'],
      ['wrong-identity', 'taskboard/bad-request'],
      ['wrong-workspace', 'taskboard/bad-request'],
      ['missing-folder', 'taskboard/bad-request'],
      ['invalid-uuid', 'taskboard/bad-request'],
      ['incomplete', 'taskboard/agency-unavailable'],
      ['malformed', 'taskboard/agency-unavailable'],
      ['unavailable', 'taskboard/agency-unavailable'],
      ['missing-workspace', 'taskboard/workspace-not-found'],
    ] as const)('%s', async (kind, code) => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
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
      const connection = { kind: 'copilot' as const, sessionId: selected }
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', executionSettings: { kind: 'copilot' }, connection })
        : b.controller.connect({ taskId: initial.id, expectedRevision: initial.revision, connection }, new AbortController().signal)
      await expect(request).rejects.toMatchObject({ code })
      expect(write).not.toHaveBeenCalled()
      expect(b.board.list()).toEqual([initial])
      expect(b.launch).not.toHaveBeenCalled()
      expect(b.runtime.run).not.toHaveBeenCalled()
    })

    it('does not commit when cancellation arrives during discovery', async () => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
      const signal = new AbortController()
      b.read.mockImplementation(async () => { signal.abort(new Error('Cancelled before commit')); return page() })
      const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
      const connection = { kind: 'copilot' as const, sessionId: firstId }
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', executionSettings: { kind: 'copilot' }, connection }, signal.signal)
        : b.controller.connect({ taskId: initial.id, expectedRevision: initial.revision, connection }, signal.signal)
      await expect(request).rejects.toThrow('Cancelled before commit')
      expect(write).not.toHaveBeenCalled()
      expect(b.board.list()).toEqual([initial])
    })

    it('publishes neither partial content nor a connection when the durable write fails', async () => {
      const b = await harness()
      const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
      b.pool.failNextWrites = 1
      const connection = { kind: 'copilot' as const, sessionId: firstId }
      const request = operation === 'create'
        ? b.controller.create({ workspaceId: b.workspace.id, title: 'New', executionSettings: { kind: 'copilot' }, connection })
        : b.controller.connect({ taskId: initial.id, expectedRevision: initial.revision, connection }, new AbortController().signal)
      await expect(request).rejects.toThrow('injected write failure')
      expect(b.board.list()).toEqual([initial])
    })
  })

  it.each(['stale', 'archived'] as const)('rejects an initially %s association without reading Agency', async (kind) => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
    const current = kind === 'stale'
      ? await b.board.update({ taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Changed' } })
      : await b.board.archive(initial.id, initial.revision)
    await expect(b.controller.connect({
      taskId: initial.id, expectedRevision: kind === 'stale' ? initial.revision : current.revision,
      connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)).rejects.toMatchObject({
      code: kind === 'stale' ? 'taskboard/revision-conflict' : 'taskboard/task-archived',
    })
    expect(b.board.get(initial.id)).toEqual(current)
    expect(b.read).not.toHaveBeenCalled()
  })

  it.each(['stale', 'archived', 'workspace-removed'] as const)('rechecks authority after pending discovery becomes %s', async (kind) => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const connecting = b.controller.connect({
      taskId: initial.id, expectedRevision: initial.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    if (kind === 'stale') await b.board.update({ taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Concurrent' } })
    else if (kind === 'archived') await b.board.archive(initial.id, initial.revision)
    else await b.ctx.workspaceRegistry.delete(b.workspace.id)
    const retained = b.board.get(initial.id)
    const code = kind === 'workspace-removed' ? 'taskboard/workspace-not-found' : 'taskboard/revision-conflict'
    const rejected = expect(connecting).rejects.toMatchObject({ code })
    pending.resolve(page())
    await rejected
    expect(b.board.get(initial.id)).toEqual(retained)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['archive', 'disconnect', 'connect'] as const)('serializes association with %s on the same task', async (operation) => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const connecting = b.controller.connect({
      taskId: initial.id, expectedRevision: initial.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const request = { taskId: initial.id, expectedRevision: initial.revision }
    const competing = operation === 'archive' ? b.controller.archive(request)
      : operation === 'disconnect' ? b.controller.disconnect(request)
        : b.controller.connect({ ...request, connection: { kind: 'copilot', sessionId: secondId } }, new AbortController().signal)
    const settled = vi.fn()
    void competing.then(settled, settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    const rejected = expect(competing).rejects.toMatchObject({ code: 'taskboard/revision-conflict' })
    pending.resolve(page())
    const { task: linked } = await connecting
    await rejected
    expect(b.board.get(initial.id)).toEqual(linked)
    expect(b.read).toHaveBeenCalledOnce()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('cancels a queued association before its durable write', async () => {
    const b = await harness()
    const initial = await b.board.create({ workspaceId: b.workspace.id, title: 'Initial', executionSettings: { kind: 'copilot' } })
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const connecting = b.controller.connect({
      taskId: initial.id, expectedRevision: initial.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const cancellation = new AbortController()
    const queued = b.controller.connect({
      taskId: initial.id, expectedRevision: initial.revision + 1, connection: { kind: 'copilot', sessionId: secondId },
    }, cancellation.signal)
    const rejected = expect(queued).rejects.toThrow('Cancelled in the task queue')
    await Promise.resolve()
    cancellation.abort(new Error('Cancelled in the task queue'))
    pending.resolve(page())
    const { task: linked } = await connecting
    await rejected
    expect(b.board.get(initial.id)).toEqual(linked)
    expect(b.read).toHaveBeenCalledOnce()
  })
})

describe('Taskboard deletion and existing conversations', () => {
  it.each([false, true])('deletes only task data without changing Workspace or Sessions (archived=%s)', async (archive) => {
    const b = await harness()
    await b.workspace.attachSession(nativeId)
    const initial = await b.board.create({
      workspaceId: b.workspace.id, title: 'Delete task only', executionSettings: { kind: 'copilot' },
      connection: { kind: 'copilot', sessionId: firstId },
    })
    const current = archive ? await b.board.archive(initial.id, initial.revision) : initial
    const sessions = [...b.workspace.sessionIds]
    const changed = vi.fn()
    const dispose = b.ctx.on('domain/changed', changed)
    await expect(b.controller.delete({ taskId: current.id, expectedRevision: current.revision }))
      .resolves.toEqual({ taskId: current.id, revision: Number.MAX_SAFE_INTEGER })
    expect(b.ctx.workspaceRegistry.get(b.workspace.id)).toBe(b.workspace)
    expect(b.workspace.sessionIds).toEqual(sessions)
    expect(await b.ctx.sessionPersistence.list()).toMatchObject([{ header: { id: nativeId } }])
    expect(changed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      domain: 'taskboard', table: 'tasks', key: current.id, operation: 'deleted',
    }))
    expect(b.read).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
    expect(b.persistence.open).not.toHaveBeenCalled()
    dispose()
  })

  it('waits for admitted Open before deletion without interrupting the conversation', async () => {
    const b = await harness({ launchEnabled: true })
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Linked', executionSettings: { kind: 'copilot' },
      connection: { kind: 'copilot', sessionId: firstId },
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
    pending.resolve(page(firstId, process.cwd(), 'in_use'))
    await expect(opening).resolves.toEqual({ outcome: 'already-running' })
    await expect(deleting).resolves.toEqual({ taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
    await expect(b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/task-not-found' })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['run', 'open', 'archive', 'disconnect', 'connect', 'update'] as const)(
    'keeps durable deletion ahead of a concurrent %s', async (operation) => {
      const b = await harness({ launchEnabled: true })
      const task = await b.board.create({
        workspaceId: b.workspace.id, title: 'Linked', executionSettings: { kind: 'copilot' },
        connection: { kind: 'copilot', sessionId: firstId },
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
      b.runtime.run.mockImplementation(async request => b.board.beginExecution({
        ...request, trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
      }))
      const request = { taskId: task.id, expectedRevision: task.revision }
      const deleting = b.controller.delete(request)
      await entered.promise
      let competing: Promise<unknown>
      switch (operation) {
        case 'run': competing = b.controller.run({ ...request, requestId: TaskRunRequestId('deleted') }, new AbortController().signal); break
        case 'open': competing = b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal); break
        case 'archive': competing = b.controller.archive(request); break
        case 'disconnect': competing = b.controller.disconnect(request); break
        case 'connect': competing = b.controller.connect({ ...request, connection: task.connection! }, new AbortController().signal); break
        case 'update': competing = b.controller.update({ ...request, patch: { title: 'Late edit' } }); break
      }
      const rejected = expect(competing).rejects.toMatchObject({ code: 'taskboard/task-not-found' })
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

  it('cancels deletion waiting for Open and leaves the task available for an explicit retry', async () => {
    const b = await harness({ launchEnabled: true })
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Linked', executionSettings: { kind: 'copilot' },
      connection: { kind: 'copilot', sessionId: firstId },
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
