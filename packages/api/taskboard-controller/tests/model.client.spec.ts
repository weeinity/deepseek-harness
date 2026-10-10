import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteStream, RemoteStreamCarrierError, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { streamHandle } from '@deepseek-ai/dsh-remote-mock'
import type {
  AgencyCopilotSessionId, TaskboardInspectAgencyCopilotValue, TaskboardListValue, TaskboardRuntimeState, TaskboardTask,
  TaskboardTaskValue, TaskConnection, TaskExecutionId, TaskId, TaskRunRequestId, TaskboardFollowFrame,
} from '../src/types.ts'
import { ClientTaskboardModel } from '../src/client/model.ts'
import { TaskboardClientController, TaskboardCommandError } from '../src/client/service.ts'
import { apply, createTaskboardStateStream, type TaskboardRemote } from '../src/client/index.ts'

const runtime: TaskboardRuntimeState = {
  settings: { enabled: true, announceToAgent: false, preventIdleSleep: false }, timeZone: 'UTC',
  power: { phase: 'disabled', platform: 'test', runningSessions: 0, enabledSchedules: 0, sessionStateKnown: true }, scheduler: {},
}
const connection: TaskConnection = { kind: 'copilot', sessionId: 'copilot-one' as AgencyCopilotSessionId }
const id = (value: string) => value as TaskId
function task(overrides: Partial<TaskboardTask> = {}): TaskboardTask {
  const status = overrides.status ?? 'todo'
  const statuses: readonly TaskboardTask['status'][] = ['backlog', 'todo', 'in_progress', 'in_review', 'done']
  return {
    id: id('t1'), revision: 1, ordinal: 1, workspaceId: 'workspace' as TaskboardTask['workspaceId'], title: 'Task',
    description: '', prompt: '', executionSettings: { kind: 'dsh' }, executions: [],
    status: 'todo', rank: 0, labels: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...overrides,
    allowedManualStatuses: statuses.filter(candidate => candidate !== status),
  }
}
const baseline = (tasks: readonly TaskboardTask[]): TaskboardListValue => ({ tasks, runtime })
const ok = (row: TaskboardTask): RemoteResult<TaskboardTaskValue> => ({ ok: true, value: { task: row } })
function remote() {
  return {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), move: vi.fn(), archive: vi.fn(), delete: vi.fn(), run: vi.fn(),
    connect: vi.fn(), disconnect: vi.fn(), duplicate: vi.fn(), restore: vi.fn(), confirmPermissions: vi.fn(),
    executionOptions: vi.fn(), updateSettings: vi.fn(), agencyCopilotCapability: vi.fn(),
    listAgencyCopilotSessions: vi.fn(), openAgencyCopilot: vi.fn(), inspectAgencyCopilot: vi.fn(),
    follow: () => streamHandle<never>((async function* () {})()),
  }
}

function streamRemote(generations: readonly {
  frames: readonly TaskboardFollowFrame[]
  error?: Error
  hold?: boolean
}[]) {
  const signals: AbortSignal[] = []
  const namespace: TaskboardRemote = {
    ...remote(),
    follow(signal = new AbortController().signal) {
      return streamHandle((async function* () {
        const generation = generations[signals.length]
        signals.push(signal)
        if (generation === undefined) throw new Error('Unexpected follow generation')
        for (const frame of generation.frames) yield frame
        if (generation.error !== undefined) throw generation.error
        if (generation.hold) await new Promise<undefined>((resolve) => {
          if (signal.aborted) resolve(undefined)
          else signal.addEventListener('abort', () => { resolve(undefined) }, { once: true })
        })
      })())
    },
  }
  return {
    signals,
    client: {
      taskboard: namespace,
      $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream({
        generation: { getSnapshot: () => ({ id: 1, host: { home: 'Q:\\fixture' } }), subscribe: () => () => {} },
      }, options),
    },
  }
}

describe('Taskboard Client follow lifecycle', () => {
  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    'projects Host workflow and manual destinations through follow frames ending in %s',
    async (outcome) => {
      const row = task({ connection, executionSettings: { kind: 'copilot' } })
      const running: TaskboardTask['executions'][number] = {
        id: 'run' as TaskExecutionId, requestId: 'request' as TaskRunRequestId,
        trigger: 'manual', status: 'running', requestedAt: '2026-01-01T01:00:00Z', startedAt: '2026-01-01T01:01:00Z',
        workspaceId: row.workspaceId, createsConnection: false, connection, prompt: 'Saved', executionSettings: row.executionSettings,
      }
      const active = task({ ...row, revision: 2, status: 'in_progress', executions: [running] })
      const waiting = task({ ...active, revision: 3, status: 'in_review' })
      const resumed = task({ ...active, revision: 4 })
      const settled = task({ ...active, revision: 5, status: outcome === 'succeeded' ? 'done' : 'in_review',
        executions: [{ ...running, status: outcome, endedAt: '2026-01-01T01:02:00Z' }] })
      const updates = [active, waiting, resumed, settled]
      const wire = streamRemote([{ frames: [
        { type: 'baseline', value: baseline([row]) }, ...updates.map(task => ({ type: 'upsert' as const, task })),
      ], hold: true }])
      const model = new ClientTaskboardModel(wire.client.taskboard)
      const observed: (TaskboardTask | undefined)[] = []
      const failed = vi.fn()
      const control = createTaskboardStateStream(wire.client, { failed, accept: {
        replaceBaseline: (value) => { model.replaceBaseline(value) },
        upsertTask: (task) => { model.upsertTask(task); observed.push(model.getSnapshot().tasks[0]) },
        removeTask: (id, revision) => { model.removeTask(id, revision) },
        replaceRuntime: (value) => { model.replaceRuntime(value) },
      } })
      control.start()
      try {
        await vi.waitFor(() => { expect(observed).toEqual(updates) })
        expect(observed.map(task => task?.status)).toEqual(['in_progress', 'in_review', 'in_progress', settled.status])
        expect(model.getSnapshot().tasks[0]?.allowedManualStatuses).toBe(settled.allowedManualStatuses)
        expect(failed).not.toHaveBeenCalled()
      } finally { await control.dispose() }
      expect(wire.signals.every(signal => signal.aborted)).toBe(true)
    },
  )

  it('installs the real Client service, applies every increment, and drains its stream on disposal', async () => {
    const row = task()
    const next = { ...runtime, settings: { ...runtime.settings, enabled: false } }
    const wire = streamRemote([{ frames: [
      { type: 'baseline', value: baseline([]) }, { type: 'upsert', task: row },
      { type: 'runtime', value: next }, { type: 'remove', taskId: row.id, revision: 2 },
    ], hold: true }])
    const ctx = new Context()
    ctx.provide('remote', wire.client)
    try {
      apply(ctx)
      await vi.waitFor(() => { expect(ctx.taskboard.list.getSnapshot().runtime).toBe(next) })
      await vi.waitFor(() => { expect(ctx.taskboard.list.getSnapshot().tasks).toEqual([]) })
      expect(ctx.taskboard).toBeInstanceOf(TaskboardClientController)
      expect(ctx.taskboard.list.getSnapshot().phase).toBe('ready')
    } finally { await ctx.fiber.dispose() }
    expect(wire.signals[0]?.aborted).toBe(true)
  })

  it.each(['carrier', 'ended'] as const)('replaces stale state after an accepted generation is %s', async (ending) => {
    const row = task()
    const fresh = task({ revision: 2, title: 'Fresh baseline' })
    const wire = streamRemote([
      { frames: [{ type: 'baseline', value: baseline([row]) }],
        ...(ending === 'carrier' ? { error: new RemoteStreamCarrierError('Connection lost') } : {}) },
      { frames: [{ type: 'baseline', value: baseline([fresh]) }], hold: true },
    ])
    const model = new ClientTaskboardModel(wire.client.taskboard)
    const carrierFailed = vi.fn(() => { model.handleCarrierFailure() })
    const failed = vi.fn()
    const stream = createTaskboardStateStream(wire.client, { accept: model, carrierFailed, failed })
    try {
      stream.start()
      await vi.waitFor(() => { expect(model.getSnapshot().tasks).toEqual([fresh]) })
      expect(carrierFailed).toHaveBeenCalledOnce()
      expect(failed).not.toHaveBeenCalled()
      expect(model.getSnapshot().state).toBe('idle')
    } finally { await stream.dispose() }
    expect(wire.signals.every(signal => signal.aborted)).toBe(true)
  })

  it.each([
    { frames: [], message: 'ended before its opening snapshot' },
    { frames: [{ type: 'runtime', value: runtime }], message: 'update before its opening snapshot' },
    { frames: [{ type: 'baseline', value: baseline([]) }, { type: 'baseline', value: baseline([]) }],
      message: 'more than one opening snapshot' },
  ] satisfies Array<{ frames: TaskboardFollowFrame[]; message: string }>)('reports malformed ordering: $message', async ({ frames, message }) => {
    const wire = streamRemote([{ frames }])
    const model = new ClientTaskboardModel(wire.client.taskboard)
    const failed = vi.fn((error: unknown) => { model.handleStreamFailure(error) })
    const stream = createTaskboardStateStream(wire.client, { accept: model, failed })
    try {
      stream.start()
      await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
      expect(model.getSnapshot().error?.message).toContain(message)
      expect(model.getSnapshot().state).toBe('error')
    } finally { await stream.dispose() }
  })

  it('publishes terminal and recovering failures through the installed service', async () => {
    const wire = streamRemote([
      { frames: [{ type: 'baseline', value: baseline([task()]) }], error: new RemoteStreamCarrierError('Lost carrier') },
      { frames: [], error: new Error('Protocol rejected') },
    ])
    const ctx = new Context()
    ctx.provide('remote', wire.client)
    try {
      apply(ctx)
      await vi.waitFor(() => { expect(ctx.taskboard.list.getSnapshot().state).toBe('error') })
      expect(ctx.taskboard.list.getSnapshot()).toMatchObject({
        tasks: [task()], runtime, error: { message: 'Protocol rejected' },
      })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('ClientTaskboardModel', () => {
  it('leaves runtime unknown until a Host baseline and keeps snapshot identity stable between changes', async () => {
    const model = new ClientTaskboardModel(remote())
    expect(model.getSnapshot()).toMatchObject({ phase: 'pending', runtime: undefined })
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    const listener = vi.fn()
    const dispose = model.subscribe(listener)
    model.replaceBaseline(baseline([task()]))
    model.upsertTask(task({ revision: 2 }))
    const snapshot = model.getSnapshot()
    expect(snapshot.runtime).toBe(runtime)
    expect(snapshot.phase).toBe('ready')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    expect(model.getSnapshot()).toBe(snapshot)
    dispose()
    model.upsertTask(task({ revision: 3 }))
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('retains tasks and settings during carrier recovery and replaces runtime from ordered increments and baselines', () => {
    const model = new ClientTaskboardModel(remote())
    const row = task()
    model.replaceBaseline(baseline([row]))
    const updated = { ...runtime, settings: { ...runtime.settings, enabled: false } }
    model.replaceRuntime(updated)
    const current = model.getSnapshot()
    model.replaceRuntime(updated)
    expect(model.getSnapshot()).toBe(current)
    model.handleCarrierFailure()
    expect(model.getSnapshot()).toMatchObject({ runtime: updated, tasks: [row], state: 'loading', phase: 'ready' })
    model.replaceBaseline(baseline([]))
    expect(model.getSnapshot()).toMatchObject({ runtime, tasks: [], state: 'idle' })
  })

  it('does not overwrite an ordered runtime increment with a delayed settings response', async () => {
    const wire = remote()
    const delayed = Promise.withResolvers<RemoteResult<TaskboardRuntimeState>>()
    wire.updateSettings.mockReturnValue(delayed.promise)
    const model = new ClientTaskboardModel(wire)
    model.replaceBaseline(baseline([]))
    const update = model.updateSettings({ patch: { enabled: false } })
    const newer = { ...runtime, settings: { ...runtime.settings, enabled: false, preventIdleSleep: true } }
    model.replaceRuntime(newer)
    delayed.resolve({ ok: true, value: { ...runtime, settings: { ...runtime.settings, enabled: false } } })
    await update
    expect(model.getSnapshot().runtime).toBe(newer)
  })

  it('sorts all five planning statuses and rank, ordinal, identity tie-breakers', () => {
    const model = new ClientTaskboardModel(remote())
    model.replaceBaseline(baseline([
      task({ id: id('done'), status: 'done' }), task({ id: id('review'), status: 'in_review' }),
      task({ id: id('later'), rank: 100 }), task({ id: id('progress'), status: 'in_progress' }),
      task({ id: id('backlog'), status: 'backlog' }), task(),
    ]))
    expect(model.getSnapshot().tasks.map(row => row.id)).toEqual(['backlog', 't1', 'later', 'progress', 'review', 'done'])
    model.upsertTask(task({ id: id('later'), status: 'backlog', revision: 2, rank: -100 }))
    expect(model.getSnapshot().tasks[0]?.id).toBe('later')
  })

  it.each(['create', 'update', 'move', 'archive', 'connect', 'disconnect', 'duplicate', 'restore', 'confirmPermissions'] as const)(
    'installs a committed %s echo but never rolls back a newer stream revision', async (operation) => {
      const wire = remote()
      const delayed = Promise.withResolvers<RemoteResult<TaskboardTaskValue>>()
      wire[operation].mockReturnValue(delayed.promise)
      const model = new ClientTaskboardModel(wire)
      const row = task()
      model.replaceBaseline(baseline([row]))
      const request = {
        taskId: row.id, expectedRevision: 1, workspaceId: row.workspaceId, title: row.title, status: 'in_review' as const,
        patch: { prompt: 'Run this' }, connection,
      }
      const pending = model[operation](request)
      const newer = task({ revision: 3, status: 'in_review' })
      model.upsertTask(newer)
      delayed.resolve(ok(task({ revision: 2 })))
      await pending
      model.replaceBaseline(baseline([row]))
      expect(model.getSnapshot().tasks).toEqual([newer])
      expect(wire[operation]).toHaveBeenCalledExactlyOnceWith(request)
    },
  )

  it('treats baseline membership as authoritative without discarding newer retained row revisions', () => {
    const model = new ClientTaskboardModel(remote())
    model.upsertTask(task({ revision: 5 }))
    model.replaceBaseline(baseline([task()]))
    expect(model.getSnapshot().tasks[0]?.revision).toBe(5)
    model.replaceBaseline(baseline([]))
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('keeps archive and deletion receipts authoritative against delayed echoes and baselines', async () => {
    const wire = remote()
    const model = new ClientTaskboardModel(wire)
    const initial = task()
    const archived = task({ archivedAt: '2026-01-02', revision: 3 })
    wire.archive.mockResolvedValue(ok(archived))
    model.replaceBaseline(baseline([initial]))
    await model.archive({ taskId: initial.id, expectedRevision: 1 })
    model.upsertTask(task({ revision: 2 }))
    model.replaceBaseline(baseline([initial]))
    expect(model.getSnapshot().tasks).toEqual([archived])
    wire.delete.mockResolvedValue({ ok: true, value: { taskId: initial.id, revision: Number.MAX_SAFE_INTEGER } })
    await model.delete({ taskId: initial.id, expectedRevision: 3 })
    model.upsertTask(task({ revision: 4 }))
    model.replaceBaseline(baseline([archived]))
    expect(model.getSnapshot().tasks).toEqual([])
  })

  it('ignores obsolete removals and retires only the matching or newer revision', () => {
    const model = new ClientTaskboardModel(remote())
    model.replaceBaseline(baseline([task({ revision: 4 })]))
    model.removeTask(id('t1'), 3)
    expect(model.getSnapshot().tasks).toHaveLength(1)
    model.removeTask(id('t1'), 4)
    expect(model.getSnapshot().tasks).toEqual([])
    model.upsertTask(task({ revision: 5 }))
    expect(model.getSnapshot().tasks[0]?.revision).toBe(5)
  })

  it('installs the Host admission status without manufacturing connections or issuing a separate move', async () => {
    const wire = remote()
    const row = task({ connection, executionSettings: { kind: 'copilot' }, status: 'in_review' })
    const executionId = 'execution' as TaskExecutionId
    const requestId = 'request' as TaskRunRequestId
    const admitted = task({ ...row, revision: 2, status: 'in_progress', executions: [{
      id: executionId, requestId, status: 'pending', trigger: 'manual', requestedAt: '2026-01-01',
      workspaceId: row.workspaceId, prompt: 'Saved', executionSettings: row.executionSettings, connection, createsConnection: false,
    }] })
    wire.run.mockResolvedValue({ ok: true, value: { task: admitted, executionId } })
    const model = new ClientTaskboardModel(wire)
    model.replaceBaseline(baseline([row]))
    await model.run({ taskId: row.id, expectedRevision: row.revision, requestId })
    expect(model.getSnapshot().tasks[0]).toMatchObject({
      connection, status: 'in_progress', allowedManualStatuses: admitted.allowedManualStatuses, executions: [{ status: 'pending' }],
    })
    expect(wire.create).not.toHaveBeenCalled()
    expect(wire.connect).not.toHaveBeenCalled()
    expect(wire.move).not.toHaveBeenCalled()
  })

  it.each(['remote', 'rejected'] as const)('preserves failed mutations and retries only after explicit %s recovery', async (kind) => {
    const wire = remote()
    const failure = new RemoteError('taskboard/execution-error', 'The connected Session is missing', { taskId: id('t1'), code: 'session-missing' })
    if (kind === 'remote') wire.run.mockResolvedValueOnce({ ok: false, error: failure })
    else wire.run.mockRejectedValueOnce(failure)
    const row = task()
    const request = { taskId: row.id, expectedRevision: row.revision, requestId: 'request' as TaskRunRequestId }
    wire.run.mockResolvedValueOnce({ ok: true, value: { task: row, executionId: 'run' } })
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire)
      const controller = new TaskboardClientController(ctx, model)
      model.replaceBaseline(baseline([row]))
      const before = model.getSnapshot()
      const operation = controller.run(request)
      await expect(operation).rejects.toThrow('connected Session is missing')
      if (kind === 'remote') await expect(operation).rejects.toMatchObject({ failure, operation: 'run' })
      expect(model.getSnapshot()).toBe(before)
      expect(wire.run).toHaveBeenCalledOnce()
      await controller.run(request)
      expect(wire.run).toHaveBeenCalledTimes(2)
      expect(wire.run.mock.calls[1]?.[0]).toBe(request)
    } finally { await ctx.fiber.dispose() }
  })

  it('forwards discovery, options and historical terminal navigation without changing the snapshot', async () => {
    const wire = remote()
    const value = { sessions: [{ sessionId: connection.sessionId, status: 'idle' }], truncated: true }
    const catalog = { presets: [], permissions: [], models: [], timeZone: 'UTC', copilotAvailable: false }
    wire.listAgencyCopilotSessions.mockResolvedValue({ ok: true, value })
    wire.executionOptions.mockResolvedValue({ ok: true, value: catalog })
    wire.agencyCopilotCapability.mockResolvedValue({ ok: true, value: { launch: true } })
    wire.openAgencyCopilot.mockResolvedValue({ ok: true, value: { outcome: 'resume-accepted' } })
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire)
      const controller = new TaskboardClientController(ctx, model)
      model.replaceBaseline(baseline([task()]))
      const before = model.getSnapshot()
      await expect(controller.listAgencyCopilotSessions(task().workspaceId)).resolves.toBe(value)
      await expect(controller.executionOptions()).resolves.toBe(catalog)
      await expect(controller.agencyCopilotCapability()).resolves.toBe(true)
      await expect(controller.openAgencyCopilot(id('t1'), 'history' as TaskExecutionId)).resolves.toBe('resume-accepted')
      expect(wire.openAgencyCopilot).toHaveBeenCalledWith({ taskId: id('t1'), executionId: 'history' })
      expect(model.getSnapshot()).toBe(before)
      expect(wire.run).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

  it('surfaces model-provider catalog failures rather than returning an empty successful option list', async () => {
    const wire = remote()
    const failure = new RemoteError('taskboard/execution-error', 'Provider catalog unavailable', { code: 'model-catalog-failed' })
    wire.executionOptions.mockResolvedValue({ ok: false, error: failure })
    const ctx = new Context()
    try {
      const model = new ClientTaskboardModel(wire)
      const controller = new TaskboardClientController(ctx, model)
      const before = model.getSnapshot()
      await expect(controller.executionOptions()).rejects.toMatchObject({ operation: 'execution options', failure })
      expect(wire.executionOptions).toHaveBeenCalledOnce()
      expect(model.getSnapshot()).toBe(before)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['echo', 'baseline', 'disconnect', 'archive', 'remove'] as const)('prunes Agency observations after %s and ignores stale inspection replies', async (arrival) => {
    const wire = remote()
    const delayed = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    const linked = task({ connection, executionSettings: { kind: 'copilot' } })
    const observation = { taskId: linked.id, sessionId: connection.sessionId, status: 'idle' as const }
    wire.inspectAgencyCopilot.mockResolvedValueOnce({ ok: true, value: { observations: [observation] } })
      .mockReturnValueOnce(delayed.promise)
    const model = new ClientTaskboardModel(wire)
    model.replaceBaseline(baseline([linked]))
    await model.inspectAgencyCopilot({ taskIds: [linked.id] })
    expect(model.getSnapshot().agencyByTask[linked.id]).toEqual(observation)
    const pending = model.inspectAgencyCopilot({ taskIds: [linked.id] })
    const changed = task({ revision: 2 })
    switch (arrival) {
      case 'echo': model.upsertTask(changed); break
      case 'baseline': model.replaceBaseline(baseline([changed])); break
      case 'disconnect':
        wire.disconnect.mockResolvedValue(ok(changed))
        await model.disconnect({ taskId: linked.id, expectedRevision: 1 })
        break
      case 'archive': model.upsertTask({ ...linked, revision: 2, archivedAt: '2026-01-02' }); break
      case 'remove': model.removeTask(linked.id, Number.MAX_SAFE_INTEGER); break
    }
    delayed.resolve({ ok: true, value: { observations: [observation] } })
    await pending
    expect(model.getSnapshot().agencyByTask).toEqual({})
  })

  it('applies newest Agency inspection per task and preserves the last observation on failure', async () => {
    const wire = remote()
    const first = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    const second = Promise.withResolvers<RemoteResult<TaskboardInspectAgencyCopilotValue>>()
    wire.inspectAgencyCopilot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const model = new ClientTaskboardModel(wire)
    model.replaceBaseline(baseline([task({ connection, executionSettings: { kind: 'copilot' } })]))
    const a = model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    const b = model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    second.resolve({ ok: true, value: { observations: [{ taskId: id('t1'), sessionId: connection.sessionId, status: 'in_use' }] } })
    await b
    first.resolve({ ok: true, value: { observations: [{ taskId: id('t1'), sessionId: connection.sessionId, status: 'idle' }] } })
    await a
    expect(model.getSnapshot().agencyByTask[id('t1')]?.status).toBe('in_use')
    const failure = new RemoteError('taskboard/agency-unavailable', 'Offline', {})
    wire.inspectAgencyCopilot.mockResolvedValueOnce({ ok: false, error: failure })
    await model.inspectAgencyCopilot({ taskIds: [id('t1')] })
    expect(model.getSnapshot()).toMatchObject({ agencyState: 'error', agencyError: failure, agencyByTask: { t1: { status: 'in_use' } } })
    wire.inspectAgencyCopilot.mockRejectedValueOnce(new TypeError('Fetch failed'))
    await expect(model.inspectAgencyCopilot({ taskIds: [id('t1')] })).rejects.toThrow('Fetch failed')
    expect(model.getSnapshot().agencyError?.message).toBe('Fetch failed')
  })

  it('retains structured terminal stream errors and normalizes unknown failures', () => {
    const model = new ClientTaskboardModel(remote())
    const error = new RemoteError('taskboard/revision-conflict', 'Conflict', { taskId: id('t1'), expectedRevision: 1, actualRevision: 2 })
    model.handleStreamFailure(error)
    expect(model.getSnapshot().error).toBe(error)
    expect(remoteErrorOf(model.getSnapshot().error)?.details).toEqual(error.details)
    model.handleStreamFailure('Broken stream')
    expect(model.getSnapshot()).toMatchObject({ state: 'error', error: { code: 'gateway/internal', message: 'Broken stream' } })
  })

  it.each(['create', 'update', 'move', 'connect', 'disconnect', 'restore', 'duplicate', 'confirmPermissions'] as const)(
    'the %s service preserves full error details and returns committed tasks', async (operation) => {
      const wire = remote()
      const failure = new RemoteError('taskboard/bad-request', 'Invalid input', {})
      wire[operation].mockResolvedValueOnce({ ok: false, error: failure }).mockResolvedValueOnce(ok(task({ revision: 2 })))
      const ctx = new Context()
      try {
        const controller = new TaskboardClientController(ctx, new ClientTaskboardModel(wire))
        const request = { taskId: id('t1'), expectedRevision: 1, workspaceId: task().workspaceId, title: 'Task',
          status: 'todo' as const, patch: { prompt: 'Prompt' }, connection }
        const pending = controller[operation](request)
        await expect(pending).rejects.toBeInstanceOf(TaskboardCommandError)
        await expect(pending).rejects.toMatchObject({ failure, operation: operation === 'confirmPermissions' ? 'confirm permissions' : operation })
        await expect(controller[operation](request)).resolves.toMatchObject({ revision: 2 })
      } finally { await ctx.fiber.dispose() }
    },
  )

  it.each(['archive', 'delete', 'agencyCopilotCapability', 'listAgencyCopilotSessions', 'openAgencyCopilot', 'inspectAgencyCopilot', 'updateSettings'] as const)(
    'preserves %s failure details, then installs or returns only the explicit retry result', async (operation) => {
      const wire = remote()
      const row = task({ connection, executionSettings: { kind: 'copilot' } })
      const failure = new RemoteError('taskboard/execution-error', 'Host operation rejected', { code: 'fixture-failed' })
      const archived = { ...row, revision: 2, archivedAt: '2026-01-02' }
      const values = {
        archive: { task: archived }, delete: { taskId: row.id, revision: 2 },
        agencyCopilotCapability: { launch: false }, listAgencyCopilotSessions: { sessions: [], truncated: false },
        openAgencyCopilot: { outcome: 'already-running' }, inspectAgencyCopilot: { observations: [] }, updateSettings: runtime,
      }
      wire[operation].mockResolvedValueOnce({ ok: false, error: failure })
        .mockResolvedValueOnce({ ok: true, value: values[operation] })
      const model = new ClientTaskboardModel(wire)
      model.replaceBaseline(baseline([row]))
      const ctx = new Context()
      const controller = new TaskboardClientController(ctx, model)
      const command = () => {
        switch (operation) {
          case 'archive': return controller.archive(row.id, row.revision)
          case 'delete': return controller.delete(row.id, row.revision)
          case 'agencyCopilotCapability': return controller.agencyCopilotCapability()
          case 'listAgencyCopilotSessions': return controller.listAgencyCopilotSessions(row.workspaceId)
          case 'openAgencyCopilot': return controller.openAgencyCopilot(row.id)
          case 'inspectAgencyCopilot': return controller.inspectAgencyCopilot([row.id])
          case 'updateSettings': return controller.updateSettings({ patch: { enabled: false } })
        }
      }
      try {
        await expect(command()).rejects.toMatchObject({ failure })
        expect(model.getSnapshot().tasks).toEqual([row])
        const value = await command()
        expect(wire[operation]).toHaveBeenCalledTimes(2)
        if (operation === 'archive') expect(model.getSnapshot().tasks).toEqual([archived])
        if (operation === 'delete') expect(model.getSnapshot().tasks).toEqual([])
        if (operation === 'agencyCopilotCapability') expect(value).toBe(false)
        if (operation === 'openAgencyCopilot') {
          expect(value).toBe('already-running')
          expect(wire.openAgencyCopilot).toHaveBeenLastCalledWith({ taskId: row.id })
        }
        if (operation === 'updateSettings') expect(value).toBe(runtime)
      } finally { await ctx.fiber.dispose() }
    },
  )

  it('orders equal ranks by ordinal then identity, and ignores replayed or absent removals', () => {
    const model = new ClientTaskboardModel(remote())
    const rows = [task({ id: id('b'), ordinal: 2 }), task({ id: id('a'), ordinal: 2 }), task({ id: id('first'), ordinal: 1 })]
    model.replaceBaseline(baseline(rows))
    expect(model.getSnapshot().tasks.map(row => row.id)).toEqual(['first', 'a', 'b'])
    model.removeTask(id('missing'), 3)
    const before = model.getSnapshot()
    model.removeTask(id('missing'), 2)
    expect(model.getSnapshot()).toBe(before)
    model.upsertTask(task({ id: id('missing'), revision: 4 }))
    model.removeTask(id('missing'), 5)
    const removed = model.getSnapshot()
    model.removeTask(id('missing'), 5)
    expect(model.getSnapshot()).toBe(removed)
    model.replaceBaseline(baseline([task({ id: id('missing'), revision: 6 })]))
    expect(model.getSnapshot().tasks[0]?.revision).toBe(6)
  })

  it('keeps same-conversation observations but rejects replies for replaced, archived, or absent tasks', async () => {
    const wire = remote()
    const model = new ClientTaskboardModel(wire)
    const row = task({ connection, executionSettings: { kind: 'copilot' } })
    const observation = { taskId: row.id, sessionId: connection.sessionId, status: 'idle' }
    model.replaceBaseline(baseline([row]))
    wire.inspectAgencyCopilot.mockResolvedValue({ ok: true, value: { observations: [observation] } })
    await model.inspectAgencyCopilot({ taskIds: [row.id, row.id] })
    expect(wire.inspectAgencyCopilot).toHaveBeenLastCalledWith({ taskIds: [row.id] })
    model.upsertTask({ ...row, revision: 2, title: 'Planning edit' })
    model.replaceBaseline(baseline([{ ...row, revision: 2 }]))
    expect(model.getSnapshot().agencyByTask[row.id]).toEqual(observation)
    const replacement = { ...row, revision: 3, connection: { ...connection, sessionId: 'replacement' as AgencyCopilotSessionId } }
    model.upsertTask(replacement)
    expect(model.getSnapshot().agencyByTask).toEqual({})
    await model.inspectAgencyCopilot({ taskIds: [row.id] })
    expect(model.getSnapshot().agencyByTask).toEqual({})
    model.replaceBaseline(baseline([{ ...replacement, archivedAt: '2026-01-02' }]))
    await model.inspectAgencyCopilot({ taskIds: [row.id] })
    model.replaceBaseline(baseline([]))
    await model.inspectAgencyCopilot({ taskIds: [row.id] })
    expect(model.getSnapshot().agencyByTask).toEqual({})
  })
})
