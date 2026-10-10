import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { TaskRunRequestId } from '@deepseek-ai/dsh-taskboard'
import type { Config } from '../src/index.ts'
import { acquireTaskboardOwnership } from '../src/runtime/ownership.ts'
import { cleanupControllerHarness, controllerHarness, firstId, initialRuntime, page, roots, secondId } from './controller-harness.ts'
import { MemorySettings, memorySettingsOf } from './memory-settings.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Controller tests must not start external processes') }),
}))

vi.mock('../src/runtime/ownership.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/runtime/ownership.ts')>(),
  acquireTaskboardOwnership: vi.fn(async () => {
    let disposed = false
    return {
      get owned() { return !disposed },
      check: vi.fn(async () => !disposed),
      dispose: vi.fn(async () => { disposed = true }),
    }
  }),
}))

const directories: string[] = []
const releases: Array<() => void> = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try { await cleanupControllerHarness() }
  finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
    vi.clearAllMocks()
    vi.useRealTimers()
  }
})

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.execution-controller-'))
  directories.push(root)
  return root
}

function catalog(): ModelCatalog {
  return {
    default: { provider: 'fixture', model: 'first' },
    routableProviders: ['fixture', 'other', 'empty'],
    groups: [
      { id: 'fixture', name: 'Fixture provider', models: [
        { id: 'first', name: 'First model', description: 'Not part of the Taskboard picker' },
        { id: 'second', name: 'Second model' },
      ] },
      { id: 'other', name: 'Other provider', models: [{ id: 'third', name: 'Third model' }] },
      { id: 'empty', name: 'Empty catalog', models: [] },
    ],
    failures: [],
  }
}

async function services(ctx: Context): Promise<void> {
  await ctx.plugin(MemorySettings)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjections)
  ctx.provide('sessions', { list: () => [] } as never)
  ctx.provide('agents', { get: vi.fn() } as never)
  ctx.provide('systemPrompt', { section: vi.fn(() => vi.fn()) } as never)
  ctx.provide('sessionController', { modelCatalog: vi.fn(async () => catalog()) } as never)
  ctx.provide('agentPresets', { remoteExportList: vi.fn(async () => ({ presets: [], authorable: false })) } as never)
  ctx.provide('permissionPresets', { names: [] } as never)
}

describe('Taskboard saved execution management', () => {
  it('confirms saved choices, duplicates without authority or history, and restores with scheduling disabled', async () => {
    const b = await controllerHarness()
    const handover = {
      goal: 'Audit', progress: 'Inspected', next: 'Review', references: ['README.md'],
      frozenAt: '2026-09-09T00:00:00.000Z', source: { kind: 'copilot' as const, sessionId: firstId },
    }
    const task = await b.board.create({
      workspaceId: b.workspace.id, title: 'Saved task', prompt: 'Review the change', labels: ['review'], priority: 'high',
      executionSettings: { kind: 'copilot', permission: 'workspace-write' }, connection: { kind: 'copilot', sessionId: firstId },
      schedule: { enabled: true, cron: '0 9 * * *', timeZone: 'UTC' }, handover,
    })
    const { task: confirmed } = await b.controller.confirmPermissions({ taskId: task.id, expectedRevision: task.revision })
    expect(confirmed.permissionConfirmedAt).toEqual(expect.any(String))
    const { task: copy } = await b.controller.duplicate({
      taskId: confirmed.id, expectedRevision: confirmed.revision, title: 'Editable copy',
    }, new AbortController().signal)
    expect(copy).toMatchObject({
      title: 'Editable copy', prompt: task.prompt, handover, labels: task.labels, priority: task.priority,
      executions: [], schedule: { enabled: false, cron: '0 9 * * *', timeZone: 'UTC' },
    })
    expect(copy.id).not.toBe(task.id)
    expect(copy.connection).toBeUndefined()
    expect(copy.permissionConfirmedAt).toBeUndefined()
    expect(b.board.get(task.id)).toEqual(confirmed)
    const { task: archived } = await b.controller.archive({ taskId: task.id, expectedRevision: confirmed.revision })
    const { task: restored } = await b.controller.restore({ taskId: task.id, expectedRevision: archived.revision })
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.connection).toEqual(task.connection)
    expect(restored.schedule).toEqual({ enabled: false, cron: '0 9 * * *', timeZone: 'UTC' })
    expect(b.runtime.run).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
  })

  it.each(['restore', 'duplicate', 'confirmPermissions'] as const)('maps stale %s without mutating saved data', async (operation) => {
    const b = await controllerHarness()
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Current' })
    const current = operation === 'restore' ? await b.board.archive(task.id, task.revision)
      : await b.board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'New revision' } })
    await expect(b.controller[operation]({ taskId: task.id, expectedRevision: task.revision })).rejects.toMatchObject({
      code: 'taskboard/revision-conflict', details: {
        taskId: task.id, expectedRevision: task.revision, actualRevision: current.revision,
      },
    })
    expect(b.board.get(task.id)).toEqual(current)
    expect(b.board.list(undefined, true)).toEqual([current])
  })

  it('cancels duplication before creating a second task', async () => {
    const b = await controllerHarness()
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Source' })
    const cancellation = new AbortController()
    const reason = new Error('Copy cancelled')
    cancellation.abort(reason)
    await expect(b.controller.duplicate({ taskId: task.id, expectedRevision: task.revision }, cancellation.signal))
      .rejects.toBe(reason)
    expect(b.board.list()).toEqual([task])
  })

  it('rejects invalid scheduled creation before writing a task and retains the domain error code', async () => {
    const b = await controllerHarness()
    await expect(b.controller.create({
      workspaceId: b.workspace.id, title: 'Invalid schedule', schedule: { enabled: true, cron: 'not cron', timeZone: 'UTC' },
    })).rejects.toMatchObject({ code: 'taskboard/bad-request' })
    expect(b.board.list()).toEqual([])
  })

  it('preserves a native AbortSignal string reason when duplication is cancelled', async () => {
    const b = await controllerHarness()
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Source' })
    const cancellation = new AbortController()
    cancellation.abort('Copy cancelled')
    await expect(b.controller.duplicate({ taskId: task.id, expectedRevision: task.revision }, cancellation.signal))
      .rejects.toBe('Copy cancelled')
    expect(b.board.list()).toEqual([task])
  })

  it('rejects incompatible executor and connection choices without creating an orphan', async () => {
    const b = await controllerHarness()
    const result = b.controller.create({
      workspaceId: b.workspace.id, title: 'Incompatible executor',
      executionSettings: { kind: 'dsh' }, connection: { kind: 'copilot', sessionId: firstId },
    })
    await expect(result).rejects.toMatchObject({ code: 'taskboard/execution-error' })
    await expect(result).rejects.not.toHaveProperty('details.taskId')
    expect(b.board.list()).toEqual([])
  })
})

describe('Taskboard Host lifecycle and catalog', () => {
  it.each(['create', 'connect', 'listAgencyCopilotSessions', 'inspectAgencyCopilot'] as const)(
    'aborts and drains %s discovery on Controller-only disposal while the domain remains live',
    async (operation) => {
      const b = await controllerHarness({ activate: true, prepare: services })
      const fiber = b.controllerFiber
      if (fiber === undefined) throw new Error('Controller fiber was not activated')
      const task = await b.board.create({
        workspaceId: b.workspace.id, title: 'Existing task', executionSettings: { kind: 'copilot' },
        ...(operation === 'inspectAgencyCopilot' ? { connection: { kind: 'copilot' as const, sessionId: firstId } } : {}),
      })
      const saved = () => b.board.list(undefined, true).map(row => ({
        id: row.id, revision: row.revision, connection: row.connection,
      }))
      const before = saved()
      const entered = Promise.withResolvers<undefined>()
      const response = Promise.withResolvers<string>()
      const release = () => { response.resolve(page()) }
      releases.push(release)
      b.read.mockImplementation(async () => { entered.resolve(undefined); return response.promise })
      const caller = new AbortController()
      const request = operation === 'create'
        ? b.controller.create({
          workspaceId: b.workspace.id, title: 'Deferred creation',
          executionSettings: { kind: 'copilot' }, connection: { kind: 'copilot', sessionId: firstId },
        }, caller.signal)
        : operation === 'connect'
          ? b.controller.connect({
            taskId: task.id, expectedRevision: task.revision, connection: { kind: 'copilot', sessionId: firstId },
          }, caller.signal)
          : operation === 'listAgencyCopilotSessions'
            ? b.controller.listAgencyCopilotSessions({ workspaceId: b.workspace.id }, caller.signal)
            : b.controller.inspectAgencyCopilot({ taskIds: [task.id] }, caller.signal)
      const state: { outcome: 'pending' | 'fulfilled' | 'rejected'; error?: unknown } = { outcome: 'pending' }
      const completion = request.then(
        () => { state.outcome = 'fulfilled' },
        (error: unknown) => { state.outcome = 'rejected'; state.error = error },
      )
      try {
        await entered.promise
        const nativeSignal = b.spawn.mock.calls[0]?.[0].signal
        await fiber.dispose()
        const atDisposal = { nativeAborted: nativeSignal?.aborted, drained: state.outcome !== 'pending' }
        expect(b.ctx.get('taskboardController')).toBeUndefined()
        expect(caller.signal.aborted).toBe(false)
        expect(state.error).toBe(nativeSignal?.reason)
        expect(state.error).toMatchObject({ message: 'Taskboard Controller stopped' })
        release()
        await completion
        expect({ ...atDisposal, outcome: state.outcome, tasks: saved() }).toEqual({
          nativeAborted: true, drained: true, outcome: 'rejected', tasks: before,
        })
      } finally {
        release()
        await completion
      }
    },
  )

  it('drains a cancelled task-queue waiter without allowing its predecessor to write after Controller disposal', async () => {
    const b = await controllerHarness({ activate: true, prepare: services })
    const fiber = b.controllerFiber
    if (fiber === undefined) throw new Error('Controller fiber was not activated')
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Unconnected', executionSettings: { kind: 'copilot' } })
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<string>()
    const release = () => { response.resolve(page()) }
    releases.push(release)
    b.read.mockImplementation(async () => { entered.resolve(undefined); return response.promise })
    const active = b.controller.connect({
      taskId: task.id, expectedRevision: task.revision, connection: { kind: 'copilot', sessionId: firstId },
    }, new AbortController().signal)
    const state = { active: false, queued: false }
    const activeDone = active.then(() => { state.active = true }, () => { state.active = true })
    await entered.promise
    const cancellation = new AbortController()
    const queued = b.controller.connect({
      taskId: task.id, expectedRevision: task.revision + 1, connection: { kind: 'copilot', sessionId: secondId },
    }, cancellation.signal)
    const queuedDone = queued.then(() => { state.queued = true }, () => { state.queued = true })
    await Promise.resolve()
    cancellation.abort(new Error('Queued association cancelled'))
    try {
      await fiber.dispose()
      const drained = { ...state }
      release()
      await Promise.all([activeDone, queuedDone])
      expect({ drained, task: b.board.get(task.id), discoveries: b.read.mock.calls.length }).toEqual({
        drained: { active: true, queued: true }, task, discoveries: 1,
      })
    } finally {
      release()
      await Promise.all([activeDone, queuedDone])
    }
  })

  it('activates the actual Cordis Service lifecycle before accepting the controller', async () => {
    const b = await controllerHarness({ activate: true, prepare: services })
    expect(b.runtime.start).toHaveBeenCalledOnce()
    expect(b.runtime.lifecycle).toEqual(['subscribe'])
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    expect(b.runtime.dispose).toHaveBeenCalledOnce()
  })

  it('constructs the default runtime with private ownership and denies native Copilot before any external effect', async () => {
    const lockPath = join(await privateRoot(), 'lock')
    const b = await controllerHarness({
      activate: true, nativeRuntime: true, prepare: services,
      config: { lockPath, pollIntervalMs: 3_600_000, schedulerIntervalMs: 3_600_000, schedulerRecoveryGapMs: 3_600_000 },
    })
    expect(acquireTaskboardOwnership).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lockDirectory: lockPath }))
    const acquisition = vi.mocked(acquireTaskboardOwnership).mock.results[0]
    if (acquisition?.type !== 'return') throw new Error('Ownership was not acquired')
    const owner = await acquisition.value
    const { task } = await b.controller.create({
      workspaceId: b.workspace.id, title: 'Native launch disabled', executionSettings: { kind: 'copilot' },
    })
    await expect(b.controller.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('native-fence'),
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'taskboard/agency-local-only' })
    expect(b.board.get(task.id)?.executions).toEqual([])
    expect(b.runtime.start).not.toHaveBeenCalled()
    expect(b.spawn).not.toHaveBeenCalled()
    expect(vi.mocked(spawn).mock.calls.length).toBe(0)
    const settings = memorySettingsOf(b.ctx)
    await b.controller.updateSettings({ patch: { enabled: false } })
    expect(settings.doc.taskboard).toMatchObject({ enabled: false })
    const baseline = await b.controller.list({})
    expect(baseline.runtime).toMatchObject({ settings: { enabled: false }, power: { phase: 'disabled' } })
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    expect(owner.owned).toBe(false)
  })

  it('projects actual named, default, broken presets and permission names alongside provider model routes', async () => {
    const b = await controllerHarness({ launchEnabled: true, prepare: async (ctx) => {
      await ctx.plugin(MemorySettings)
      ctx.provide('sessions', { list: () => [] } as never)
      ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
      ctx.provide('approval', { config: { policy: 'ask' } } as never)
      await ctx.plugin(SessionProjections)
      await ctx.plugin(Loader)
      await ctx.plugin(AgentPresets, { default: 'named' })
      await ctx.agentPresets.register({ id: 'default', plugins: [] })
      await ctx.agentPresets.register({ id: 'named', name: 'Named agent', description: 'Not exposed in Taskboard', plugins: [] })
      await ctx.agentPresets.register({ id: 'broken', plugins: [{ name: '' }] })
      new PermissionPresets(ctx, new PermissionPresets.Config({
        defaultPreset: 'workspace-write',
        presets: {
          'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
          'read-only': { sandbox: 'read-only', approval: 'ask' },
        },
      }))
      ctx.provide('sessionController', { modelCatalog: vi.fn(async () => catalog()) } as never)
    } })
    const value = await b.controller.executionOptions()
    const broken = (await b.ctx.agentPresets.remoteExportList()).presets.find(preset => preset.id === 'broken')?.broken
    expect(broken).toEqual(expect.any(String))
    expect(value).toEqual({
      presets: [
        { id: 'broken', name: 'broken', isDefault: false, broken },
        { id: 'default', name: 'default', isDefault: false },
        { id: 'named', name: 'Named agent', isDefault: true },
      ],
      permissions: [{ name: 'workspace-write' }, { name: 'read-only' }],
      models: [
        { provider: 'fixture', model: 'first', name: 'First model' },
        { provider: 'fixture', model: 'second', name: 'Second model' },
        { provider: 'other', model: 'third', name: 'Third model' },
      ],
      timeZone: 'UTC', copilotAvailable: true,
    })
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it('reports every failed provider catalog rather than presenting a partial model list', async () => {
    const b = await controllerHarness({ prepare: services })
    const roster = vi.spyOn(b.ctx.agentPresets, 'remoteExportList')
    vi.spyOn(b.ctx.sessionController, 'modelCatalog').mockResolvedValue({
      ...catalog(), failures: [
        { id: 'first', name: 'First provider', message: 'Catalog unavailable' },
        { id: 'second', name: 'Second provider', message: 'Authorization failed' },
      ],
    })
    await expect(b.controller.executionOptions()).rejects.toMatchObject({
      code: 'taskboard/execution-error', details: { code: 'model-catalog-unavailable' },
      message: 'First provider: Catalog unavailable; Second provider: Authorization failed',
    })
    expect(roster).toHaveBeenCalledOnce()
  })

  it.each(['presets', 'models'] as const)('joins a blocked %s catalog after its sibling rejects and the Controller stops', async (blocked) => {
    const b = await controllerHarness({ activate: true, prepare: services })
    const fiber = b.controllerFiber
    if (fiber === undefined) throw new Error('Controller fiber was not activated')
    const task = await b.board.create({ workspaceId: b.workspace.id, title: 'Unchanged task' })
    const entered = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<undefined>()
    const runtimeStopped = Promise.withResolvers<undefined>()
    const release = () => { response.resolve(undefined) }
    releases.push(release)
    const state = { catalogSettled: false, disposed: false }
    const waitForRelease = async (): Promise<void> => {
      entered.resolve(undefined)
      await response.promise
      state.catalogSettled = true
    }
    const roster = vi.spyOn(b.ctx.agentPresets, 'remoteExportList')
    const models = vi.spyOn(b.ctx.sessionController, 'modelCatalog')
    const failure = new Error('Catalog lookup failed')
    if (blocked === 'presets') {
      roster.mockImplementation(async () => { await waitForRelease(); return { presets: [], authorable: false } })
      models.mockRejectedValueOnce(failure)
    } else {
      roster.mockRejectedValueOnce(failure)
      models.mockImplementation(async () => { await waitForRelease(); return catalog() })
    }
    b.runtime.dispose.mockImplementation(async () => { runtimeStopped.resolve(undefined) })
    const request = b.controller.executionOptions()
    const rejected = expect(request).rejects.toMatchObject({
      code: 'taskboard/execution-error', message: failure.message, details: { code: 'host-operation-failed' },
    })
    let stopping: Promise<void> | undefined
    try {
      await entered.promise
      await rejected
      expect(roster).toHaveBeenCalledOnce()
      expect(models).toHaveBeenCalledOnce()
      stopping = fiber.dispose().then(() => { state.disposed = true })
      await runtimeStopped.promise
      await setImmediate()
      expect(state).toEqual({ catalogSettled: false, disposed: false })
      release()
      await stopping
      expect(state).toEqual({ catalogSettled: true, disposed: true })
      expect(b.ctx.get('taskboardController')).toBeUndefined()
      expect(b.board.get(task.id)).toEqual(task)
      expect(b.runtime.run).not.toHaveBeenCalled()
      expect(b.runtime.dispose).toHaveBeenCalledOnce()
    } finally {
      release()
      if (stopping !== undefined) await stopping
    }
  })

  it('offers empty authoritative catalogs without inventing model or preset choices', async () => {
    const b = await controllerHarness({ prepare: services })
    vi.spyOn(b.ctx.sessionController, 'modelCatalog').mockResolvedValue({ ...catalog(), groups: [] })
    await expect(b.controller.executionOptions()).resolves.toMatchObject({
      presets: [], permissions: [], models: [], copilotAvailable: false,
    })
  })

  it('resolves an omitted timezone from the Host while retaining its published runtime observation', async () => {
    const b = await controllerHarness({ prepare: services, config: {} })
    await expect(b.controller.executionOptions()).resolves.toMatchObject({
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [], runtime: initialRuntime })
  })
})

describe('Taskboard deployment validation', () => {
  it.each([
    [{ lockPath: 'relative-lock' }, /lockPath must be absolute/],
    [{ timeZone: 'Not/A_Timezone' }, /Invalid time zone|Invalid timezone/],
    [{ schedulerIntervalMs: 200, schedulerRecoveryGapMs: 100 }, /schedulerRecoveryGapMs/],
    [{ agencyOpenCooldownMs: 1.5 }, /must be a safe integer/],
    [{ agencyOpenTimeoutMs: 0x80000000 }, /must not exceed 2147483647/],
    [{ powerMaxRetries: Number.MAX_SAFE_INTEGER + 1 }, /must be a safe integer/],
    [{ copilotRecoveryPageSize: 0 }, /greater than or equal|at least|>=|1/],
  ] satisfies Array<[Config, RegExp]>)('rejects invalid configuration before runtime or native activation (%#)', async (config, message) => {
    await expect(controllerHarness({ config })).rejects.toThrow(message)
    expect(acquireTaskboardOwnership).not.toHaveBeenCalled()
    expect(vi.mocked(spawn).mock.calls.length).toBe(0)
  })
})
