import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskboardExecutionError, TaskExecutionId, TaskId, TaskRunRequestId } from '@deepseek-ai/dsh-taskboard'
import { AgencyCopilotHost } from '../src/agency.ts'
import {
  cleanupControllerHarness, controllerHarness, firstId, initialRuntime, nativeId, page, roots, secondId,
} from './controller-harness.ts'

const releaseHandoffs: Array<() => void> = []
afterEach(async () => {
  for (const release of releaseHandoffs.splice(0)) release()
  try { await cleanupControllerHarness() }
  finally { vi.useRealTimers() }
})

async function connected(options: Parameters<typeof controllerHarness>[0] = {}) {
  const b = await controllerHarness({ launchEnabled: true, ...options })
  const task = await b.board.create({
    workspaceId: b.workspace.id, title: 'Saved title', description: 'Planning only',
    prompt: 'Work must only be sent by Run', executionSettings: { kind: 'copilot' },
    connection: { kind: 'copilot', sessionId: firstId },
  })
  return { ...b, task }
}

describe('Taskboard Controller execution delegation', () => {
  it('delegates exact run identity and cancellation to the runtime, returning real durable admission', async () => {
    const b = await controllerHarness()
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Planning title', description: 'Not the prompt',
      prompt: 'Inspect the failing test', executionSettings: { kind: 'copilot' },
    })
    b.runtime.run.mockImplementation(async (request, signal) => {
      signal.throwIfAborted()
      const admitted = await b.board.beginExecution({
        ...request, trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
        proposedConnection: { kind: 'copilot', sessionId: firstId },
      })
      await b.board.attachExecution({
        taskId: task.id, executionId: admitted.executionId, connection: { kind: 'copilot', sessionId: firstId },
        receipt: { kind: 'copilot', afterCursor: 'before-dispatch' },
      })
      const current = await b.board.advanceExecution({
        taskId: task.id, executionId: admitted.executionId,
        receipt: { kind: 'copilot', afterCursor: 'before-dispatch', messageId: 'accepted-input' },
      })
      return { task: current, executionId: admitted.executionId }
    })
    const request = { taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('manual-1') }
    const caller = new AbortController()
    const result = await b.controller.run(request, caller.signal)
    expect(b.runtime.run).toHaveBeenCalledOnce()
    const received = b.runtime.run.mock.calls[0]
    expect(received?.[0]).toBe(request)
    const cancellation = received?.[1]
    expect(cancellation?.aborted).toBe(false)
    const reason = new Error('Caller stopped after admission')
    caller.abort(reason)
    expect(cancellation?.aborted).toBe(true)
    expect(cancellation?.reason).toBe(reason)
    expect(result.task).toEqual(b.board.get(task.id))
    expect(result.task.executions).toMatchObject([{
      id: result.executionId, requestId: request.requestId, status: 'running', prompt: 'Inspect the failing test',
      connection: { kind: 'copilot', sessionId: firstId },
    }])
    expect(result.task.status).toBe('in_progress')
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('has no success-shaped execution fallback and maps runtime business failures', async () => {
    const b = await connected()
    const request = { taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('manual-1') }
    await expect(b.controller.run(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error', message: 'Unexpected Taskboard runtime.run',
      details: { taskId: b.task.id, code: 'host-operation-failed' },
    })
    b.runtime.run.mockRejectedValue(new TaskboardExecutionError('busy', 'Attempt is already running'))
    await expect(b.controller.run(request, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error', details: { taskId: b.task.id, code: 'busy' },
    })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('preserves Host execution error codes without requiring domain error types', async () => {
    const b = await connected()
    b.runtime.run.mockRejectedValue(Object.assign(new Error('Taskboard execution ownership is unavailable'), { code: 'ownership-lost' }))
    await expect(b.controller.run({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('ownership-lost'),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error',
      details: { taskId: b.task.id, code: 'ownership-lost' },
    })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('preserves an opaque runtime rejection without mutating the task', async () => {
    const b = await connected()
    b.runtime.run.mockRejectedValue('Execution provider disconnected')
    await expect(b.controller.run({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('provider-disconnected'),
    }, new AbortController().signal)).rejects.toBe('Execution provider disconnected')
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('preserves stale-revision and archived admission failures from the real domain', async () => {
    const b = await connected()
    b.runtime.run.mockImplementation(async (request, signal) => {
      signal.throwIfAborted()
      return b.board.beginExecution({ ...request, trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' } })
    })
    const request = { taskId: b.task.id, expectedRevision: 99, requestId: TaskRunRequestId('manual-1') }
    await expect(b.controller.run(request, new AbortController().signal)).rejects.toMatchObject({ code: 'taskboard/revision-conflict' })
    const archived = await b.board.archive(b.task.id, b.task.revision)
    await expect(b.controller.run({ ...request, expectedRevision: archived.revision }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/task-archived' })
    expect(b.board.get(b.task.id)).toEqual(archived)
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('rejects cancelled admission before invoking the runtime or native work', async () => {
    const b = await connected()
    const cancelled = new AbortController()
    cancelled.abort(new Error('Cancelled before admission'))
    await expect(b.controller.run({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('cancelled'),
    }, cancelled.signal)).rejects.toThrow('Cancelled before admission')
    expect(b.runtime.run).not.toHaveBeenCalled()
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('delegates settings changes and publishes only the runtime observation supplied after commit', async () => {
    const b = await controllerHarness()
    const stream = b.follow()
    await stream.next()
    b.runtime.updateSettings.mockImplementation(async (patch) => {
      const next = { ...initialRuntime, settings: { ...initialRuntime.settings, ...patch } }
      b.runtime.emit(next)
      return b.runtime.snapshot()
    })
    const patch = { announceToAgent: true, preventIdleSleep: true }
    const value = await b.controller.updateSettings({ patch })
    expect(b.runtime.updateSettings).toHaveBeenCalledExactlyOnceWith(patch)
    expect(value.settings).toEqual({ enabled: true, announceToAgent: true, preventIdleSleep: true })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'runtime', value } })
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it('does not publish settings that the runtime failed to persist', async () => {
    const b = await controllerHarness()
    const stream = b.follow()
    await stream.next()
    const next = stream.next()
    const delivered = vi.fn()
    void next.then(delivered)
    b.runtime.updateSettings.mockRejectedValue(new Error('Settings write failed'))
    await expect(b.controller.updateSettings({ patch: { preventIdleSleep: true } })).rejects.toThrow('Settings write failed')
    expect(b.runtime.snapshot()).toEqual(initialRuntime)
    expect(delivered).not.toHaveBeenCalled()
    const observed = { ...initialRuntime, scheduler: { error: 'Scheduler unavailable' } }
    b.runtime.emit(observed)
    expect(await next).toEqual({ done: false, value: { type: 'runtime', value: observed } })
  })
})

describe('Taskboard Controller existing-conversation navigation', () => {
  it.each(['idle', 'in_use', 'missing', 'unknown'] as const)('opens %s state without replaying or recreating work', async (status) => {
    const b = await connected()
    b.read.mockResolvedValue(status === 'idle' || status === 'in_use' ? page(firstId, process.cwd(), status)
      : JSON.stringify({ sessions: [], ...(status === 'unknown' ? { next_cursor: 'more' } : {}) }))
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    if (status === 'idle') {
      await expect(opening).resolves.toEqual({ outcome: 'resume-accepted' })
      expect(b.launch.mock.calls[0]?.[1].slice(-2)).toEqual(['copilot', '--resume=' + firstId])
      expect(b.launch.mock.calls[0]?.[1]).not.toContain('--interactive')
      expect(b.launch.mock.calls[0]?.[1]).not.toContain(b.task.prompt)
    } else if (status === 'in_use') {
      await expect(opening).resolves.toEqual({ outcome: 'already-running' })
      expect(b.launch).not.toHaveBeenCalled()
    } else {
      await expect(opening).rejects.toMatchObject({
        code: status === 'missing' ? 'taskboard/bad-request' : 'taskboard/agency-unavailable',
      })
      expect(b.launch).not.toHaveBeenCalled()
    }
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.persistence.create).not.toHaveBeenCalled()
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it.each([false, true])('permits current conversation navigation without changing planning data (archived=%s)', async (archive) => {
    const b = await connected()
    const task = archive ? await b.board.archive(b.task.id, b.task.revision) : b.task
    await expect(b.controller.openAgencyCopilot({ taskId: task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'resume-accepted' })
    expect(b.board.get(task.id)).toEqual(task)
    expect(b.runtime.run).not.toHaveBeenCalled()
    if (archive) {
      b.read.mockClear()
      expect(await b.controller.inspectAgencyCopilot({ taskIds: [task.id] }, new AbortController().signal)).toEqual({ observations: [] })
      expect(b.read).not.toHaveBeenCalled()
    }
  })

  it.each(['idle', 'in_use', 'missing', 'unknown', 'workspace_mismatch'] as const)(
    'inspects %s without changing saved tasks and deduplicates shared conversations', async (status) => {
      const b = await connected()
      const shared = await b.board.create({
        workspaceId: b.workspace.id, title: 'Shared conversation', executionSettings: { kind: 'copilot' },
        connection: { kind: 'copilot', sessionId: firstId },
      })
      const toArchive = await b.board.create({
        workspaceId: b.workspace.id, title: 'Archived conversation', executionSettings: { kind: 'copilot' },
        connection: { kind: 'copilot', sessionId: secondId },
      })
      const archived = await b.board.archive(toArchive.id, toArchive.revision)
      const unconnected = await b.board.create({ workspaceId: b.workspace.id, title: 'No conversation' })
      const native = await b.board.create({
        workspaceId: b.workspace.id, title: 'DSH', connection: { kind: 'dsh', sessionId: nativeId },
      })
      b.read.mockResolvedValue(status === 'missing' || status === 'unknown'
        ? JSON.stringify({ sessions: [], ...(status === 'unknown' ? { next_cursor: 'more' } : {}) })
        : page(firstId, status === 'workspace_mismatch' ? resolve('packages') : process.cwd(), status === 'in_use' ? 'in_use' : 'idle'))
      await expect(b.controller.inspectAgencyCopilot({
        taskIds: [b.task.id, shared.id, archived.id, unconnected.id, native.id, TaskId('absent')],
      }, new AbortController().signal)).resolves.toEqual({
        observations: [
          { taskId: b.task.id, sessionId: firstId, status },
          { taskId: shared.id, sessionId: firstId, status },
        ],
      })
      expect(b.read).toHaveBeenCalledTimes(status === 'unknown' ? 10 : 1)
      expect(b.board.get(b.task.id)).toEqual(b.task)
      expect(b.board.get(shared.id)).toEqual(shared)
      expect(b.board.get(archived.id)).toEqual(archived)
      expect(b.launch).not.toHaveBeenCalled()
      expect(b.runtime.run).not.toHaveBeenCalled()
    },
  )

  it('rejects an oversized inspection without invoking discovery', async () => {
    const b = await connected()
    await expect(b.controller.inspectAgencyCopilot({
      taskIds: Array.from({ length: 101 }, () => b.task.id),
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'taskboard/bad-request' })
    expect(b.read).not.toHaveBeenCalled()
  })

  it.each([false, true])('opens retained history using its original Workspace after current inputs change (archived=%s)', async (archive) => {
    const b = await connected()
    const admitted = await b.board.beginExecution({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('historical'),
      trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
    })
    await b.board.attachExecution({
      taskId: b.task.id, executionId: admitted.executionId, connection: { kind: 'copilot', sessionId: firstId },
      receipt: { kind: 'copilot', afterCursor: 'before-historical-dispatch' },
    })
    await b.board.advanceExecution({ taskId: b.task.id, executionId: admitted.executionId })
    const settled = await b.board.settleExecution({ taskId: b.task.id, executionId: admitted.executionId, status: 'succeeded' })
    const disconnected = await b.board.disconnect(b.task.id, settled.revision)
    const other = await b.ctx.workspaceRegistry.create(resolve('packages'))
    const edited = await b.board.update({
      taskId: b.task.id, expectedRevision: disconnected.revision,
      patch: { workspaceId: other.id, executionSettings: { kind: 'dsh' }, prompt: 'New work' },
    })
    const current = archive ? await b.board.archive(edited.id, edited.revision) : edited
    await expect(b.controller.openAgencyCopilot({
      taskId: current.id, executionId: admitted.executionId,
    }, new AbortController().signal)).resolves.toEqual({ outcome: 'resume-accepted' })
    expect(b.launch.mock.calls[0]?.[1]).toContain(b.workspace.path)
    expect(b.launch.mock.calls[0]?.[1].slice(-2)).toEqual(['copilot', '--resume=' + firstId])
    expect(b.launch.mock.calls[0]?.[1]).not.toContain(b.task.prompt)
    await expect(b.controller.openAgencyCopilot({ taskId: current.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-not-linked' })
    expect(b.board.get(current.id)).toEqual(current)
  })

  it('does not fall back from an absent execution or a DSH connection to another conversation', async () => {
    const b = await connected()
    await expect(b.controller.openAgencyCopilot({
      taskId: b.task.id, executionId: TaskExecutionId('not-retained'),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/execution-error', details: { code: 'execution-not-found' },
    })
    await b.workspace.attachSession(nativeId)
    const native = await b.board.create({
      workspaceId: b.workspace.id, title: 'DSH', connection: { kind: 'dsh', sessionId: nativeId },
    })
    await expect(b.controller.openAgencyCopilot({ taskId: native.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-not-linked' })
    await expect(b.controller.openAgencyCopilot({ taskId: TaskId('missing') }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/task-not-found' })
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each([
    [new Error('Stop this wait'), 'Stop this wait'],
    ['Stop this wait', 'Taskboard caller aborted'],
  ])('coalesces accepted opens while cancellation only stops that caller (%#)', async (reason, message) => {
    const b = await connected()
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const cancelled = new AbortController()
    const first = b.controller.openAgencyCopilot({ taskId: b.task.id }, cancelled.signal)
    const second = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const rejected = expect(first).rejects.toThrow(message)
    cancelled.abort(reason)
    await rejected
    pending.resolve(page())
    await expect(second).resolves.toEqual({ outcome: 'resume-accepted' })
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'resume-accepted' })
    expect(b.read).toHaveBeenCalledOnce()
    expect(b.launch).toHaveBeenCalledOnce()
  })

  it('reports an owned open attempt as running without another discovery or terminal', async () => {
    const b = await connected()
    await b.board.beginExecution({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('running'),
      trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
    })
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'already-running' })
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('reports an opaque navigation failure and permits a new handoff without changing the connection', async () => {
    const b = await connected()
    const inspection = vi.spyOn(AgencyCopilotHost.prototype, 'inspect')
      .mockRejectedValueOnce('Native status stream disconnected')
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .rejects.toMatchObject({
        code: 'taskboard/execution-error', message: 'Native status stream disconnected',
        details: { taskId: b.task.id, code: 'host-operation-failed' },
      })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
    inspection.mockRestore()
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'resume-accepted' })
    expect(b.launch).toHaveBeenCalledOnce()
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it.each([
    { launchEnabled: false },
    { platform: 'linux' as const },
    { environment: { SSH_CONNECTION: 'remote transport' } },
    { environment: { SSH_TTY: 'remote terminal' } },
  ])('rejects native navigation outside the local launch fence (%#)', async (options) => {
    const b = await connected(options)
    expect(b.controller.agencyCopilotCapability()).toEqual({ launch: false })
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-local-only' })
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('does not treat project-defined SSH values as the Host connection origin', async () => {
    const b = await connected({ projectEnvironment: { SSH_CONNECTION: 'project-only' } })
    expect(b.controller.agencyCopilotCapability()).toEqual({ launch: true })
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'resume-accepted' })
  })

  it.each(['resolve', 'launch'] as const)('keeps the saved identity after %s failure and permits an explicit open retry', async (failure) => {
    const b = await connected()
    if (failure === 'resolve') {
      b.resolveExecutable.mockImplementation(async (name) => {
        if (name === 'wt.exe') throw new Error('Terminal unavailable')
        return 'C:\\Agency\\agency.exe'
      })
    } else b.controls.launchError = new Error('Broker failed')
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-launch-failed' })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    b.resolveExecutable.mockImplementation(async name => name === 'wt.exe' ? 'C:\\WindowsApps\\wt.exe' : 'C:\\Agency\\agency.exe')
    b.controls.launchError = undefined
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .resolves.toEqual({ outcome: 'resume-accepted' })
    expect(b.launch.mock.calls.at(-1)?.[1].slice(-2)).toEqual(['copilot', '--resume=' + firstId])
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it('rejects a changed connection after asynchronous inspection without opening either identity', async () => {
    const b = await connected()
    const pending = Promise.withResolvers<string>()
    b.read.mockReturnValue(pending.promise)
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    const cleared = await b.board.disconnect(b.task.id, b.task.revision)
    const current = await b.board.connect({
      taskId: cleared.id, expectedRevision: cleared.revision, connection: { kind: 'copilot', sessionId: secondId },
    })
    const rejected = expect(opening).rejects.toMatchObject({ code: 'taskboard/agency-not-linked' })
    pending.resolve(page())
    await rejected
    expect(b.board.get(current.id)).toEqual(current)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('rejects a Workspace mismatch without changing the saved connection', async () => {
    const b = await connected()
    b.read.mockResolvedValue(page(firstId, resolve('packages')))
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'taskboard/agency-workspace-mismatch' })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it.each(['malformed', 'unavailable', 'cancelled'] as const)('surfaces %s current-conversation inspection', async (kind) => {
    const b = await connected()
    const cancellation = new AbortController()
    if (kind === 'malformed') b.read.mockResolvedValue('{bad JSON')
    else if (kind === 'unavailable') b.read.mockRejectedValue(new Error('Agency unavailable'))
    else b.read.mockImplementation(async () => {
      cancellation.abort(new Error('Inspection cancelled'))
      return page()
    })
    const inspecting = b.controller.inspectAgencyCopilot({ taskIds: [b.task.id] }, cancellation.signal)
    if (kind === 'cancelled') await expect(inspecting).rejects.toThrow('Inspection cancelled')
    else await expect(inspecting).rejects.toMatchObject({ code: 'taskboard/agency-unavailable' })
    expect(b.board.get(b.task.id)).toEqual(b.task)
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('refuses historical navigation when its original Workspace is no longer registered', async () => {
    const b = await connected()
    const admitted = await b.board.beginExecution({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('removed-workspace'),
      trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
    })
    const settled = await b.board.settleExecution({ taskId: b.task.id, executionId: admitted.executionId, status: 'cancelled' })
    const archived = await b.board.archive(b.task.id, settled.revision)
    await b.ctx.workspaceRegistry.delete(b.workspace.id)
    await expect(b.controller.openAgencyCopilot({
      taskId: b.task.id, executionId: admitted.executionId,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'taskboard/workspace-not-found', details: { workspaceId: b.workspace.id },
    })
    expect(b.board.get(b.task.id)).toEqual(archived)
    expect(b.read).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('rechecks a queued handoff identity before reading or opening a replacement conversation', async () => {
    const b = await connected()
    const entered = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<string>()
    b.read.mockImplementation(async () => { entered.resolve(undefined); return pending.promise })
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    try {
      await entered.promise
      const disconnected = await b.board.disconnect(b.task.id, b.task.revision)
      const replacement = await b.board.connect({
        taskId: b.task.id, expectedRevision: disconnected.revision, connection: { kind: 'copilot', sessionId: secondId },
      })
      const queued = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
      const rejected = expect(queued).rejects.toMatchObject({
        code: 'taskboard/agency-not-linked', message: 'Task Copilot connection changed before opening',
      })
      const cleared = await b.board.disconnect(b.task.id, replacement.revision)
      const current = await b.board.connect({
        taskId: b.task.id, expectedRevision: cleared.revision, connection: { kind: 'copilot', sessionId: firstId },
      })
      pending.resolve(page())
      await expect(opening).resolves.toEqual({ outcome: 'resume-accepted' })
      await rejected
      expect(b.board.get(b.task.id)).toEqual(current)
      expect(b.read).toHaveBeenCalledOnce()
      expect(b.launch).toHaveBeenCalledOnce()
    } finally { pending.resolve(page()) }
  })

  it('expires cooldowns without evicting a newer pending handoff after a wall-clock jump', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const b = await connected({ config: { agencyOpenCooldownMs: 25 } })
    const request = { taskId: b.task.id }
    await b.controller.openAgencyCopilot(request, new AbortController().signal)
    vi.setSystemTime(Date.now() + 25)
    const pending = Promise.withResolvers<string>()
    const entered = Promise.withResolvers<undefined>()
    b.read.mockImplementationOnce(async () => { entered.resolve(undefined); return pending.promise })
    const second = b.controller.openAgencyCopilot(request, new AbortController().signal)
    try {
      await entered.promise
      await vi.advanceTimersByTimeAsync(25)
      const joined = b.controller.openAgencyCopilot(request, new AbortController().signal)
      pending.resolve(page())
      await expect(second).resolves.toEqual({ outcome: 'resume-accepted' })
      await expect(joined).resolves.toEqual({ outcome: 'resume-accepted' })
      expect(b.launch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(25)
      await b.controller.openAgencyCopilot(request, new AbortController().signal)
      expect(b.launch).toHaveBeenCalledTimes(3)
    } finally { pending.resolve(page()) }
  })

  it('cancels a queued historical handoff on Host disposal after its caller stops waiting', async () => {
    const b = await connected()
    const admitted = await b.board.beginExecution({
      taskId: b.task.id, expectedRevision: b.task.revision, requestId: TaskRunRequestId('queued-history'),
      trigger: 'manual', executionSettings: { kind: 'copilot', permission: 'read-only' },
    })
    const settled = await b.board.settleExecution({ taskId: b.task.id, executionId: admitted.executionId, status: 'cancelled' })
    const disconnected = await b.board.disconnect(b.task.id, settled.revision)
    const current = await b.board.connect({
      taskId: b.task.id, expectedRevision: disconnected.revision, connection: { kind: 'copilot', sessionId: secondId },
    })
    const entered = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<string>()
    b.read.mockImplementation(async () => { entered.resolve(undefined); return pending.promise })
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    const rejectedOpening = expect(opening).rejects.toThrow('Taskboard Controller stopped')
    try {
      await entered.promise
      const cancellation = new AbortController()
      const queued = b.controller.openAgencyCopilot({
        taskId: b.task.id, executionId: admitted.executionId,
      }, cancellation.signal)
      const rejectedCaller = expect(queued).rejects.toThrow('Queued caller stopped')
      cancellation.abort(new Error('Queued caller stopped'))
      await rejectedCaller
      await b.ctx.fiber.dispose()
      roots.splice(roots.indexOf(b.ctx), 1)
      await rejectedOpening
      const reopened = await controllerHarness({ pool: b.pool })
      expect(reopened.board.get(b.task.id)).toEqual(current)
      expect(b.read).toHaveBeenCalledOnce()
      expect(b.launch).not.toHaveBeenCalled()
    } finally { pending.resolve(page()) }
  })

  it.each([false, true])('waits for an admitted broker during disposal without a late cooldown (runtimeFails=%s)', async (runtimeFails) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const b = await connected()
    const shutdownError = new Error('Runtime shutdown failed')
    const reported = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => {})
    if (runtimeFails) b.runtime.dispose.mockRejectedValueOnce(shutdownError)
    const created = Promise.withResolvers<undefined>()
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn(() => child)
    releaseHandoffs.push(() => { child.emit('spawn') })
    b.launch.mockImplementation(() => { created.resolve(undefined); return child })
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    const rejected = expect(opening).rejects.toThrow('Taskboard Controller stopped')
    try {
      await created.promise
      const disposed = vi.fn()
      const disposal = b.ctx.fiber.dispose()
      void disposal.then(disposed)
      await rejected
      expect(disposed).not.toHaveBeenCalled()
      expect(reported).not.toHaveBeenCalled()
      child.emit('spawn')
      await disposal
      roots.splice(roots.indexOf(b.ctx), 1)
      expect(b.runtime.dispose).toHaveBeenCalledOnce()
      expect(b.runtime.listeners.size).toBe(0)
      if (runtimeFails) expect(reported).toHaveBeenCalledExactlyOnceWith(shutdownError)
      else expect(reported).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { child.emit('spawn') }
  })

  it('cancels before discovery and quiesces an admitted handoff on Controller disposal', async () => {
    const b = await connected()
    const cancelled = new AbortController()
    cancelled.abort(new Error('Already cancelled'))
    await expect(b.controller.openAgencyCopilot({ taskId: b.task.id }, cancelled.signal)).rejects.toThrow('Already cancelled')
    expect(b.read).not.toHaveBeenCalled()
    b.read.mockReturnValue(new Promise(() => {}))
    const opening = b.controller.openAgencyCopilot({ taskId: b.task.id }, new AbortController().signal)
    const rejected = expect(opening).rejects.toThrow('Taskboard Controller stopped')
    await vi.waitFor(() => { expect(b.read).toHaveBeenCalledOnce() })
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    await rejected
    expect(b.runtime.dispose).toHaveBeenCalledOnce()
    expect(b.launch).not.toHaveBeenCalled()
  })
})
