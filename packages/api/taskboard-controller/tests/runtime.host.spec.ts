import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { TaskRunRequestId } from '@deepseek-ai/dsh-taskboard'
import type { Session } from '@deepseek-ai/dsh-session'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { cleanup, copilot, dsh, harness, request } from '../../../workspace/taskboard/tests/harness.ts'
import type { TaskExecutionAdapter } from '../src/runtime/adapter.ts'
import { TaskboardHostRuntime } from '../src/runtime/index.ts'
import type { TaskboardHostConfig } from '../src/runtime/index.ts'
import type { TaskboardOwnership, TaskboardOwnershipOptions } from '../src/runtime/ownership.ts'
import type { TaskboardPowerHost } from '../src/runtime/power.ts'
import type { TaskboardCoordinatorClock } from '../src/runtime/coordinator.ts'
import { MemorySettings, memorySettingsOf, type SettingsDocument } from './memory-settings.ts'

const runtimes: TaskboardHostRuntime[] = []
const releases: Array<() => void> = []
const directories: string[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  const stopped = await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.dispose()))
  try {
    await cleanup()
  } finally {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true, maxRetries: 5 })))
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
  const failures = stopped.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'Runtime fixture cleanup failed')
})

const config = {
  lockPath: 'fixture-lock-directory', lockUpdateMs: 10_000, lockMaxAcquireAttempts: 3,
  timeZone: 'UTC', pollIntervalMs: 5_000, schedulerIntervalMs: 30_000,
  schedulerRecoveryGapMs: 45_000, operationTimeoutMs: 20_000,
  powerReadinessTimeoutMs: 1_000, powerShutdownTimeoutMs: 1_000, powerKillTimeoutMs: 1_000,
  powerRetryDelayMs: 1_000, powerMaxRetries: 0, powerMaxDiagnosticBytes: 256, powerAssertionPollMs: 100,
}

function adapter() {
  return {
    validateConnection: vi.fn<TaskExecutionAdapter['validateConnection']>(async () => {}),
    create: vi.fn<TaskExecutionAdapter['create']>(async () => {}),
    prepare: vi.fn<TaskExecutionAdapter['prepare']>(async () => ({ kind: 'dsh', afterSequence: 0 })),
    submit: vi.fn<TaskExecutionAdapter['submit']>(async () => ({ kind: 'dsh', afterSequence: 0, messageId: 'message' })),
    observe: vi.fn<TaskExecutionAdapter['observe']>(async () => ({ state: 'running' })),
    dispose: vi.fn<TaskExecutionAdapter['dispose']>(async () => {}),
  } satisfies TaskExecutionAdapter
}

function controlledClock() {
  const now = new Date()
  const callbacks = new Map<number, () => void>()
  const clock: TaskboardCoordinatorClock = {
    now: () => now,
    every: (callback, interval) => { callbacks.set(interval, callback); return () => { callbacks.delete(interval) } },
  }
  return { clock, callbacks }
}

async function fixture(options: {
  backend?: MemoryStorageBackend
  settings?: SettingsDocument
  overrides?: Partial<Omit<TaskboardHostConfig, 'enabled' | 'announceToAgent' | 'preventIdleSleep'>> & {
    enabled?: boolean
    announceToAgent?: boolean
    preventIdleSleep?: boolean
  }
  acquire?: (options: TaskboardOwnershipOptions) => Promise<TaskboardOwnership>
  nativeOwnership?: boolean
  clock?: TaskboardCoordinatorClock
} = {}) {
  const b = await harness(options.backend === undefined ? {} : { backend: options.backend, pool: options.backend.pool })
  await b.ctx.plugin(MemorySettings, { doc: options.settings ?? {} })
  await b.ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  const settings = memorySettingsOf(b.ctx)
  const sessions: Session[] = []
  const active = new Set<Session>()
  const listSessions = vi.fn(() => sessions)
  b.ctx.provide('sessions', { list: listSessions } as never)
  b.ctx.provide('agents', {
    get: (id: Session['id']) => {
      const session = sessions.find(candidate => candidate.id === id)
      return session === undefined ? undefined : { session, status: active.has(session) ? 'running' : 'idle' }
    },
  } as never)
  const owned = {
    owned: true,
    check: vi.fn(async () => owned.owned),
    dispose: vi.fn(async () => { owned.owned = false }),
  }
  let ownershipOptions: TaskboardOwnershipOptions | undefined
  const acquire = vi.fn(async (input: TaskboardOwnershipOptions) => {
    ownershipOptions = input
    return options.acquire === undefined ? owned : options.acquire(input)
  })
  const powerHost: TaskboardPowerHost = {
    platform: 'fixture-os', parentPid: 1, environment: {},
    spawn: vi.fn(() => { throw new Error('Runtime fixture must never launch a native inhibitor') }),
    terminate: vi.fn(() => { throw new Error('Runtime fixture owns no native child') }),
    schedule: vi.fn(() => { throw new Error('Unsupported fixture platform must not schedule native work') }),
  }
  const dshAdapter = adapter()
  const copilotAdapter = adapter()
  const copilotAllowed = vi.fn(() => {})
  const setting = (key: 'enabled' | 'announceToAgent' | 'preventIdleSleep', fallback: boolean) => ({
    get: () => (settings.doc.taskboard?.[key] as boolean | undefined) ?? fallback,
  })
  const overrides = options.overrides ?? {}
  const runtimeConfig: TaskboardHostConfig = {
    ...config,
    ...overrides,
    enabled: setting('enabled', overrides.enabled ?? true),
    announceToAgent: setting('announceToAgent', overrides.announceToAgent ?? false),
    preventIdleSleep: setting('preventIdleSleep', overrides.preventIdleSleep ?? false),
  }
  const runtime = new TaskboardHostRuntime(
    b.ctx, runtimeConfig, { dsh: dshAdapter, copilot: copilotAdapter },
    copilotAllowed, {
      ...(options.nativeOwnership === true ? {} : { acquireOwnership: acquire }),
      powerHost,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      settingsNamespace: 'taskboard',
    },
  )
  runtimes.push(runtime)
  return {
    ...b, runtime, settings, owned, acquire, dshAdapter, copilotAdapter, copilotAllowed, powerHost,
    sessions, active, listSessions, ownershipOptions: () => ownershipOptions,
  }
}

function holdAnnouncementDisposal(b: Awaited<ReturnType<typeof fixture>>, failure?: Error) {
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  releases.push(() => { resume.resolve(undefined) })
  const original = b.ctx.effect.bind(b.ctx)
  let registrations = 0
  const order: string[] = []
  vi.spyOn(b.ctx, 'effect').mockImplementation((execute, label) => {
    if (label !== 'taskboard: agent announcement') return original(execute, label)
    registrations += 1
    return original(async () => {
      const dispose = original(execute, label)
      return async () => {
        entered.resolve(undefined)
        await resume.promise
        await dispose()
        order.push('announcement-stopped')
        if (failure !== undefined) throw failure
      }
    }, label)
  })
  return {
    entered: entered.promise, release: () => { resume.resolve(undefined) },
    registrations: () => registrations, order,
  }
}

describe('Taskboard Host lifecycle and settings', () => {
  it('constructs inactive and shares startup ownership without submitting work', async () => {
    const b = await fixture()
    expect(b.acquire).not.toHaveBeenCalled()
    expect(b.runtime.snapshot()).toMatchObject({
      settings: { enabled: true, announceToAgent: false, preventIdleSleep: false },
      timeZone: 'UTC', power: { phase: 'disabled' },
    })
    const first = b.runtime.start()
    expect(b.runtime.start()).toBe(first)
    await first
    expect(b.acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      lockDirectory: config.lockPath, updateMs: config.lockUpdateMs, maxAcquireAttempts: config.lockMaxAcquireAttempts,
    }))
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
    expect(b.copilotAdapter.submit).not.toHaveBeenCalled()
  })

  it('acquires ownership and refreshes durable records before activation or callback-driven reads', async () => {
    const { clock, callbacks } = controlledClock()
    const b = await fixture({ clock })
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Cached title' })
    const records = b.pool.media.get('taskboard')!.tables.get('tasks')!
    records.set(task.id, { ...records.get(task.id) as object, title: 'Fresh durable title' })
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    releases.push(() => { resume.resolve(undefined) })
    const open = b.facility.open.bind(b.facility)
    vi.spyOn(b.facility, 'open').mockImplementation(async (spec) => {
      entered.resolve(undefined)
      await resume.promise
      return open(spec)
    })
    const list = vi.spyOn(b.board, 'list')
    const warning = vi.spyOn(b.ctx.logger, 'warn')
    const starting = b.runtime.start()
    await Promise.race([
      entered.promise,
      starting.then(() => { throw new Error('Runtime activated without refreshing its domain') }),
    ])
    expect(b.acquire).toHaveBeenCalledOnce()
    expect(b.owned.check).toHaveBeenCalled()
    expect(callbacks.size).toBe(0)
    expect(list).not.toHaveBeenCalled()
    const session = { id: dsh.sessionId } as Session
    b.sessions.push(session)
    b.active.add(session)
    b.settings.pushExternal({ taskboard: { enabled: true, announceToAgent: true, preventIdleSleep: true } })
    agentEvents(b.ctx, b.ctx.agents.get(session.id)!).emit('agent/status', { status: 'running' })
    await Promise.resolve()
    expect(list).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    expect(b.runtime.snapshot().power.phase).toBe('disabled')
    expect((await b.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'taskboard')).toBe(false)
    resume.resolve(undefined)
    await starting
    expect(b.board.get(task.id)?.title).toBe('Fresh durable title')
    expect(callbacks.size).toBe(2)
    expect(b.runtime.snapshot()).toMatchObject({
      settings: { enabled: true, announceToAgent: true, preventIdleSleep: true },
      power: { phase: 'unsupported', runningSessions: 1 },
    })
    expect((await b.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'taskboard')).toBe(true)
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('keeps activation and domain-reading callbacks inactive when durable refresh fails', async () => {
    const { clock, callbacks } = controlledClock()
    const b = await fixture({ clock })
    vi.spyOn(b.facility, 'open').mockRejectedValueOnce(new Error('Durable reopen failed'))
    const list = vi.spyOn(b.board, 'list')
    await expect(b.runtime.start()).rejects.toThrow('Durable reopen failed')
    expect(b.runtime.snapshot().error).toBe('Durable reopen failed')
    b.settings.pushExternal({ taskboard: { announceToAgent: true, preventIdleSleep: true } })
    const session = { id: dsh.sessionId } as Session
    b.sessions.push(session)
    b.active.add(session)
    agentEvents(b.ctx, b.ctx.agents.get(session.id)!).emit('agent/status', { status: 'running' })
    await Promise.resolve()
    expect(list).not.toHaveBeenCalled()
    expect(callbacks.size).toBe(0)
    expect(b.dshAdapter.observe).not.toHaveBeenCalled()
    await b.runtime.dispose()
    expect(b.owned.dispose).toHaveBeenCalledOnce()
  })

  it('closes a fresh domain and releases ownership when shutdown overlaps reopening', async () => {
    const b = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    releases.push(() => { resume.resolve(undefined) })
    const open = b.facility.open.bind(b.facility)
    const order: string[] = []
    vi.spyOn(b.facility, 'open').mockImplementation(async (spec) => {
      entered.resolve(undefined)
      await resume.promise
      const fresh = await open(spec)
      const close = fresh.close.bind(fresh)
      vi.spyOn(fresh, 'close').mockImplementation(async () => { await close(); order.push('domain-closed') })
      return fresh
    })
    b.owned.dispose.mockImplementation(async () => { order.push('owner-released'); b.owned.owned = false })
    const starting = b.runtime.start()
    const rejected = expect(starting).rejects.toThrow('Taskboard Host stopped')
    await entered.promise
    const stopping = b.runtime.dispose()
    await vi.waitFor(() => { expect(b.dshAdapter.dispose).toHaveBeenCalledOnce() })
    expect(b.owned.dispose).not.toHaveBeenCalled()
    resume.resolve(undefined)
    await rejected
    await stopping
    expect(order).toEqual(['domain-closed', 'owner-released'])
    expect(b.dshAdapter.observe).not.toHaveBeenCalled()
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('rejects planning writes through the domain after Runtime ownership is lost', async () => {
    const b = await fixture()
    await b.runtime.start()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Retained task' })
    b.owned.owned = false
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    await expect(b.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Unauthorized edit' },
    })).rejects.toMatchObject({ code: 'ownership-lost' })
    expect(b.board.get(task.id)).toEqual(task)
    expect(write).not.toHaveBeenCalled()
    expect(b.owned.check).toHaveBeenCalled()
  })

  it.each([false, true])('holds the kernel owner until an in-flight planning write settles (failure=%s)', async (failWrite) => {
    const backend = new MemoryStorageBackend()
    const open = backend.kv.open.bind(backend.kv)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    releases.push(() => { resume.resolve(undefined) })
    const order: string[] = []
    let delay = false
    vi.spyOn(backend.kv, 'open').mockImplementation(async (descriptor) => {
      const unit = await open(descriptor)
      const put = unit.putRecord.bind(unit)
      vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
        if (!delay) return put(table, key, value)
        delay = false
        entered.resolve(undefined)
        await resume.promise
        try { await put(table, key, value) }
        finally { order.push('write-settled') }
      })
      return unit
    })
    const b = await fixture({ backend, clock: controlledClock().clock })
    await b.runtime.start()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Before write' })
    b.owned.dispose.mockImplementation(async () => { order.push('owner-released'); b.owned.owned = false })
    delay = true
    if (failWrite) b.pool.failNextWrites = 1
    const writing = b.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'After write' },
    })
    const written = Promise.allSettled([writing])
    await entered.promise
    const stopping = b.runtime.dispose()
    const late = expect(b.board.create({ workspaceId: b.workspaceId, title: 'After shutdown' }))
      .rejects.toMatchObject({ code: 'ownership-lost' })
    await vi.waitFor(() => { expect(b.dshAdapter.dispose).toHaveBeenCalledOnce() })
    expect(b.owned.dispose).not.toHaveBeenCalled()
    resume.resolve(undefined)
    expect(await written).toMatchObject([{ status: failWrite ? 'rejected' : 'fulfilled' }])
    await stopping
    await late
    expect(order).toEqual(['write-settled', 'owner-released'])
    expect(b.board.get(task.id)?.title).toBe(failWrite ? 'Before write' : 'After write')
    expect(b.board.list()).toHaveLength(1)
  })

  it('disposes an inactive runtime once without acquiring execution ownership', async () => {
    const b = await fixture()
    const first = b.runtime.dispose()
    expect(b.runtime.dispose()).toBe(first)
    await first
    expect(b.acquire).not.toHaveBeenCalled()
    expect(b.owned.dispose).not.toHaveBeenCalled()
    expect(b.dshAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('persists user switches, honors an existing user layer, and keeps disabled settings writable', async () => {
    const b = await fixture({ settings: { taskboard: { enabled: false, announceToAgent: true } } })
    await b.runtime.start()
    expect(b.runtime.snapshot().settings).toEqual({
      enabled: false, announceToAgent: true, preventIdleSleep: false,
    })
    const next = await b.runtime.updateSettings({ enabled: true, preventIdleSleep: true })
    expect(next.settings).toEqual({ enabled: true, announceToAgent: true, preventIdleSleep: true })
    expect(b.settings.doc.taskboard).toEqual({ enabled: true, announceToAgent: true, preventIdleSleep: true })
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Review', connection: dsh })
    await b.runtime.updateSettings({ enabled: false })
    await expect(b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('disabled'),
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'execution-state', message: 'Taskboard is disabled' })
    expect(b.board.get(task.id)?.executions).toEqual([])
  })

  it('keeps the last committed settings when the provider rejects a write', async () => {
    const b = await fixture()
    await b.runtime.start()
    const state = b.runtime.snapshot()
    b.settings.writableFlag = false
    await expect(b.runtime.updateSettings({ announceToAgent: true })).rejects.toThrow()
    expect(b.runtime.snapshot()).toBe(state)
    expect(b.settings.persisted).toEqual([])
  })

  it('adds and removes the actual system-prompt contribution and disposes its registration', async () => {
    const b = await fixture()
    await b.runtime.start()
    const text = async () => (await b.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'taskboard')?.text
    expect(await text()).toBeUndefined()
    await b.runtime.updateSettings({ announceToAgent: true })
    expect(await text()).toBe(
      'Taskboard keeps saved task definitions, connected conversations, and execution history. '
      + 'A task has one current DSH or Copilot conversation. Repeated runs continue that conversation. '
      + 'New tasks start in Todo. Run moves a task to In Progress; waiting for user input, failure, or cancellation moves it to In Review. '
      + 'Resumed work returns to In Progress, and successful execution moves the task to Done. '
      + 'Active tasks can be moved manually to any column without running them. '
      + 'Supplied handover context and references do not grant additional permissions.',
    )
    await b.runtime.updateSettings({ preventIdleSleep: true })
    expect((await b.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'taskboard')).toHaveLength(1)
    await b.runtime.updateSettings({ enabled: false })
    expect(await text()).toBeUndefined()
    await b.runtime.updateSettings({ enabled: true })
    expect(await text()).toBeDefined()
    await b.runtime.dispose()
    expect(await text()).toBeUndefined()
  })

  it('joins asynchronous announcement teardown before releasing the kernel owner', async () => {
    const b = await fixture()
    const announcement = holdAnnouncementDisposal(b)
    await b.runtime.start()
    await b.runtime.updateSettings({ announceToAgent: true })
    b.owned.dispose.mockImplementation(async () => {
      announcement.order.push('owner-released')
      b.owned.owned = false
    })
    const stopping = b.runtime.dispose()
    await announcement.entered
    await vi.waitFor(() => { expect(b.dshAdapter.dispose).toHaveBeenCalledOnce() })
    expect(b.owned.dispose).not.toHaveBeenCalled()
    announcement.release()
    await stopping
    expect(announcement.order).toEqual(['announcement-stopped', 'owner-released'])
  })

  it('serializes announcement disable and reenable through pending effect disposal', async () => {
    const b = await fixture()
    const announcement = holdAnnouncementDisposal(b)
    await b.runtime.start()
    await b.runtime.updateSettings({ announceToAgent: true })
    const disabled = b.runtime.updateSettings({ announceToAgent: false })
    const finished = vi.fn()
    void disabled.then(finished, finished)
    await announcement.entered
    const enabled = b.runtime.updateSettings({ announceToAgent: true })
    await vi.waitFor(() => { expect(b.settings.doc.taskboard).toMatchObject({ announceToAgent: true }) })
    expect(announcement.registrations()).toBe(1)
    expect(finished).not.toHaveBeenCalled()
    announcement.release()
    await disabled
    await enabled
    expect(announcement.registrations()).toBe(2)
    expect((await b.ctx.systemPrompt.assemble()).sections.filter(section => section.name === 'taskboard')).toHaveLength(1)
  })

  it('drains announcement updates during shutdown without registering a queued replacement', async () => {
    const b = await fixture()
    const announcement = holdAnnouncementDisposal(b)
    await b.runtime.start()
    await b.runtime.updateSettings({ announceToAgent: true })
    const disabled = b.runtime.updateSettings({ announceToAgent: false })
    await announcement.entered
    const enabled = b.runtime.updateSettings({ announceToAgent: true })
    await vi.waitFor(() => { expect(b.settings.doc.taskboard).toMatchObject({ announceToAgent: true }) })
    const stopping = b.runtime.dispose()
    await vi.waitFor(() => { expect(b.dshAdapter.dispose).toHaveBeenCalledOnce() })
    expect(b.owned.dispose).not.toHaveBeenCalled()
    announcement.release()
    await Promise.all([disabled, enabled, stopping])
    expect(announcement.registrations()).toBe(1)
    expect((await b.ctx.systemPrompt.assemble()).sections.some(section => section.name === 'taskboard')).toBe(false)
    expect(b.owned.dispose).toHaveBeenCalledOnce()
  })

  it('surfaces asynchronous announcement failure and retains ownership after rejected cleanup', async () => {
    const b = await fixture()
    const failure = new Error('Announcement teardown failed')
    const announcement = holdAnnouncementDisposal(b, failure)
    await b.runtime.start()
    await b.runtime.updateSettings({ announceToAgent: true })
    const disabled = b.runtime.updateSettings({ announceToAgent: false })
    const rejected = expect(disabled).rejects.toBe(failure)
    await announcement.entered
    announcement.release()
    await rejected
    expect(b.runtime.snapshot().error).toBe('Announcement teardown failed')
    const outcome = await Promise.allSettled([b.runtime.dispose()])
    runtimes.splice(runtimes.indexOf(b.runtime), 1)
    expect(outcome).toMatchObject([{ status: 'rejected', reason: { message: 'Taskboard Host cleanup failed', errors: [failure] } }])
    expect(b.dshAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.owned.dispose).not.toHaveBeenCalled()
    expect(b.owned.owned).toBe(true)
  })

  it('reports combined Session and schedule demand without activating a real inhibitor', async () => {
    const b = await fixture({ overrides: { preventIdleSleep: true } })
    await b.board.create({
      workspaceId: b.workspaceId, title: 'Scheduled', schedule: { enabled: true, cron: '0 * * * *', timeZone: 'UTC' },
    })
    const session = { id: dsh.sessionId } as Session
    b.sessions.push(session)
    b.active.add(session)
    await b.runtime.start()
    expect(b.runtime.snapshot().power).toMatchObject({
      phase: 'unsupported', runningSessions: 1, enabledSchedules: 1, sessionStateKnown: true,
    })
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
    await b.runtime.updateSettings({ preventIdleSleep: false })
    expect(b.runtime.snapshot().power.phase).toBe('disabled')
  })

  it('updates demand from actual Agent status events and ignores unrelated domain notifications', async () => {
    const b = await fixture({ overrides: { preventIdleSleep: true }, clock: controlledClock().clock })
    const session = { id: SessionId('independent-session') } as Session
    b.sessions.push(session)
    await b.runtime.start()
    expect(b.runtime.snapshot().power).toMatchObject({ phase: 'idle', runningSessions: 0 })
    b.active.add(session)
    const agent = b.ctx.agents.get(session.id)!
    agentEvents(b.ctx, agent).emit('agent/status', { status: 'running' })
    expect(b.runtime.snapshot().power).toMatchObject({ phase: 'unsupported', runningSessions: 1 })
    b.listSessions.mockClear()
    const current = b.runtime.snapshot()
    b.ctx.emit('domain/changed', {
      domain: 'workspace', table: 'workspaces', key: b.workspaceId, operation: 'put', value: { title: 'Renamed Workspace' },
    })
    expect(b.listSessions).not.toHaveBeenCalled()
    expect(b.runtime.snapshot()).toBe(current)
    b.active.delete(session)
    agentEvents(b.ctx, agent).emit('agent/status', { status: 'idle' })
    expect(b.runtime.snapshot().power).toMatchObject({ phase: 'idle', runningSessions: 0 })
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('counts each live conversation once across Agent state and pending, running, and settled receipts', async () => {
    const b = await fixture({ overrides: { preventIdleSleep: true }, clock: controlledClock().clock })
    const session = { id: dsh.sessionId } as Session
    b.sessions.push(session)
    b.active.add(session)
    await b.runtime.start()
    const local = await b.board.create({ workspaceId: b.workspaceId, title: 'DSH work', connection: dsh })
    const localAttempt = await b.board.beginExecution(request(local, 'local'))
    expect(b.runtime.snapshot().power.runningSessions).toBe(1)
    await b.board.attachExecution({
      taskId: local.id, executionId: localAttempt.executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 },
    })
    await b.board.advanceExecution({ taskId: local.id, executionId: localAttempt.executionId })
    expect(b.runtime.snapshot().power.runningSessions).toBe(1)
    const external = await b.board.create({
      workspaceId: b.workspaceId, title: 'Copilot work', executionSettings: { kind: 'copilot' }, connection: copilot,
    })
    const externalAttempt = await b.board.beginExecution(request(external, 'external'))
    expect(b.runtime.snapshot().power.runningSessions).toBe(2)
    await b.board.attachExecution({
      taskId: external.id, executionId: externalAttempt.executionId, connection: copilot,
      receipt: { kind: 'copilot', afterCursor: null },
    })
    await b.board.advanceExecution({ taskId: external.id, executionId: externalAttempt.executionId })
    expect(b.runtime.snapshot().power.runningSessions).toBe(2)
    b.active.delete(session)
    agentEvents(b.ctx, b.ctx.agents.get(session.id)!).emit('agent/status', { status: 'idle' })
    expect(b.runtime.snapshot().power.runningSessions).toBe(2)
    await b.board.settleExecution({ taskId: local.id, executionId: localAttempt.executionId, status: 'succeeded' })
    expect(b.runtime.snapshot().power.runningSessions).toBe(1)
    await b.board.settleExecution({ taskId: external.id, executionId: externalAttempt.executionId, status: 'succeeded' })
    expect(b.runtime.snapshot().power).toMatchObject({ phase: 'idle', runningSessions: 0 })
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
    expect(b.copilotAdapter.submit).not.toHaveBeenCalled()
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('validates the live kernel owner before admitting a manual run', async () => {
    const b = await fixture()
    await b.runtime.start()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Run', connection: dsh })
    b.owned.owned = false
    await expect(b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('lost'),
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'ownership-lost' })
    expect(b.owned.check).toHaveBeenCalled()
    expect(b.board.get(task.id)?.executions).toEqual([])
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
  })

  it('rechecks Host lifetime when an in-flight ownership check reports success during shutdown', async () => {
    const b = await fixture()
    await b.runtime.start()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Run', connection: dsh })
    const entered = Promise.withResolvers<undefined>()
    const checked = Promise.withResolvers<boolean>()
    releases.push(() => { checked.resolve(true) })
    b.owned.check.mockImplementationOnce(async () => { entered.resolve(undefined); return checked.promise })
    const running = b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('closing'),
    }, new AbortController().signal)
    const rejected = expect(running).rejects.toThrow('Taskboard Host stopped')
    await entered.promise
    const stopping = b.runtime.dispose()
    checked.resolve(true)
    await rejected
    await stopping
    expect(b.board.get(task.id)?.executions).toEqual([])
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
  })

  it('publishes ownership compromise and rejects later work', async () => {
    const b = await fixture()
    const updates = vi.fn()
    b.runtime.subscribe(updates)
    await b.runtime.start()
    b.ownershipOptions()!.onCompromised(new Error('Ownership file replaced'))
    expect(b.runtime.snapshot().error).toBe('Ownership file replaced')
    expect(updates).toHaveBeenLastCalledWith(expect.objectContaining({ error: 'Ownership file replaced' }))
    await expect(b.runtime.updateSettings({ enabled: true })).rejects.toThrow('Ownership file replaced')
    await b.runtime.dispose()
    expect(b.dshAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.owned.dispose).toHaveBeenCalledOnce()
  })

  it('retains ownership failure without subscribers and ignores settings observed after revocation', async () => {
    const b = await fixture()
    await b.runtime.start()
    b.ownershipOptions()!.onCompromised(new Error('Ownership file replaced'))
    expect(b.runtime.snapshot().error).toBe('Ownership file replaced')
    const revoked = b.runtime.snapshot()
    b.settings.pushExternal({ taskboard: { enabled: true, announceToAgent: true, preventIdleSleep: true } })
    expect(b.runtime.snapshot()).toBe(revoked)
    expect((await b.ctx.systemPrompt.assemble()).sections.find(section => section.name === 'taskboard')).toBeUndefined()
    expect(b.powerHost.spawn).not.toHaveBeenCalled()
  })

  it('publishes callback diagnostics that native code reports without an Error object', async () => {
    const b = await fixture()
    await b.runtime.start()
    const changed = vi.fn()
    b.runtime.subscribe(changed)
    b.ownershipOptions()!.onCallbackError('Native monitor callback failed')
    expect(b.runtime.snapshot().error).toBe('Native monitor callback failed')
    expect(changed).toHaveBeenCalledOnce()
    const reported = b.runtime.snapshot()
    b.ownershipOptions()!.onCallbackError('Native monitor callback failed')
    expect(b.runtime.snapshot()).toBe(reported)
    expect(changed).toHaveBeenCalledOnce()
  })

  it.each(['owner', 'provider'] as const)('reports %s cleanup failure without yielding an unconfirmed execution owner', async (failure) => {
    const b = await fixture()
    await b.runtime.start()
    const order: string[] = []
    const error = new Error(`${failure} cleanup failed`)
    vi.mocked(b.dshAdapter.dispose).mockImplementation(async () => {
      order.push('dsh-closed')
      if (failure === 'provider') throw error
    })
    vi.mocked(b.copilotAdapter.dispose).mockImplementation(async () => { order.push('copilot-closed') })
    b.owned.dispose.mockImplementation(async () => {
      order.push('owner-closed')
      b.owned.owned = false
      if (failure === 'owner') throw error
    })
    const outcome = await Promise.allSettled([b.runtime.dispose()])
    runtimes.splice(runtimes.indexOf(b.runtime), 1)
    expect(outcome).toMatchObject([{ status: 'rejected', reason: { message: 'Taskboard Host cleanup failed' } }])
    expect(order).toEqual(failure === 'owner' ? ['dsh-closed', 'copilot-closed', 'owner-closed'] : ['dsh-closed', 'copilot-closed'])
    expect(b.dshAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.owned.dispose).toHaveBeenCalledTimes(failure === 'owner' ? 1 : 0)
    expect(b.owned.owned).toBe(failure === 'provider')
    const reason = outcome[0].status === 'rejected' ? outcome[0].reason as AggregateError : undefined
    expect(reason).toBeInstanceOf(AggregateError)
    expect(reason?.errors).toEqual(failure === 'owner' ? [error] : [expect.objectContaining({ errors: [error] })])
  })

  it('reports provider cleanup failure after revocation without releasing the kernel owner', async () => {
    const b = await fixture()
    await b.runtime.start()
    const reported = Promise.withResolvers<undefined>()
    b.runtime.subscribe((state) => {
      if (state.error === 'Taskboard shutdown could not drain every operation') reported.resolve(undefined)
    })
    vi.mocked(b.dshAdapter.dispose).mockRejectedValue(new Error('Provider connection close failed'))
    b.ownershipOptions()!.onCompromised(new Error('Ownership file replaced'))
    await reported.promise
    const outcome = await Promise.allSettled([b.runtime.dispose()])
    runtimes.splice(runtimes.indexOf(b.runtime), 1)
    expect(outcome).toMatchObject([{ status: 'rejected', reason: { message: 'Taskboard Host cleanup failed' } }])
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.owned.dispose).not.toHaveBeenCalled()
    expect(b.owned.owned).toBe(true)
  })

  it('contains observer failures without losing other subscribers or committed settings', async () => {
    const b = await fixture()
    await b.runtime.start()
    const healthy = vi.fn()
    const unwatch = b.runtime.subscribe(() => { throw new Error('Observer failed') })
    b.runtime.subscribe(healthy)
    const warning = vi.spyOn(b.ctx.logger, 'warn')
    await b.runtime.updateSettings({ announceToAgent: true })
    expect(warning).toHaveBeenCalledWith('Taskboard observer failed: Error: Observer failed')
    expect(healthy).toHaveBeenCalledWith(b.runtime.snapshot())
    unwatch()
    healthy.mockClear()
    await b.runtime.dispose()
    b.settings.pushExternal({ taskboard: { announceToAgent: false } })
    expect(healthy).not.toHaveBeenCalled()
  })

  it('releases an ownership acquisition that completes after disposal begins', async () => {
    const entered = Promise.withResolvers<undefined>()
    const complete = Promise.withResolvers<TaskboardOwnership>()
    const owner = { owned: true, check: vi.fn(async () => true), dispose: vi.fn(async () => {}) }
    releases.push(() => { complete.resolve(owner) })
    const b = await fixture({ acquire: async () => { entered.resolve(undefined); return complete.promise } })
    const start = b.runtime.start()
    const rejected = expect(start).rejects.toThrow('Taskboard Host stopped')
    await entered.promise
    const stop = b.runtime.dispose()
    complete.resolve(owner)
    await rejected
    await stop
    expect(owner.dispose).toHaveBeenCalledOnce()
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
  })

  it('reports startup failure and drains inactive providers on disposal', async () => {
    const b = await fixture({ acquire: async () => { throw new Error('Another Host owns execution') } })
    await expect(b.runtime.start()).rejects.toThrow('Another Host owns execution')
    expect(b.runtime.snapshot().error).toBe('Another Host owns execution')
    await b.runtime.dispose()
    expect(b.dshAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.copilotAdapter.dispose).toHaveBeenCalledOnce()
    expect(b.owned.dispose).not.toHaveBeenCalled()
  })

  it('preserves omitted DSH pins and starts the task when dispatching saved work', async () => {
    const b = await fixture()
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Inspect', prompt: 'Describe the change', status: 'in_review', connection: dsh,
    })
    const result = await b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('inherit'),
    }, new AbortController().signal)
    expect(result.task.status).toBe('in_progress')
    expect(b.dshAdapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      connection: dsh, executionSettings: { kind: 'dsh' }, prompt: 'Describe the change',
    }), expect.any(AbortSignal))
    expect(b.copilotAllowed).not.toHaveBeenCalled()
  })

  it.each(['dsh', 'copilot'] as const)('allocates a fresh %s conversation and persists its identity before provider creation', async (kind) => {
    const b = await fixture()
    const provider = kind === 'dsh' ? b.dshAdapter : b.copilotAdapter
    let observedDuringCreation: ReturnType<typeof b.board.get>
    vi.mocked(provider.create).mockImplementation(async (execution) => {
      observedDuringCreation = b.board.list().find(candidate => candidate.executions.some(attempt => attempt.id === execution.id))
      if (execution.connection?.kind === 'dsh') {
        const workspace = b.workspaces.get(execution.workspaceId)!
        b.workspaces.set(b.workspaceId, {
          ...workspace, sessionIds: [...workspace.sessionIds, execution.connection.sessionId],
        })
      }
    })
    if (kind === 'copilot') {
      vi.mocked(provider.prepare).mockResolvedValue({ kind: 'copilot', afterCursor: null })
      vi.mocked(provider.submit).mockResolvedValue({ kind: 'copilot', afterCursor: null, messageId: 'created-message' })
    }
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'New conversation', executionSettings: { kind } })
    const result = await b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId(`allocate-${kind}`),
    }, new AbortController().signal)
    expect(observedDuringCreation).toMatchObject({
      connection: result.task.connection,
      executions: [{ id: result.executionId, status: 'pending', createsConnection: true, connection: result.task.connection }],
    })
    expect(result.task.connection?.kind).toBe(kind)
    expect(result.task.connection?.sessionId).toMatch(kind === 'dsh' ? /^session-[0-9a-f-]{36}$/ : /^[0-9a-f-]{36}$/)
    expect(result.task.connection?.sessionId).not.toBe(dsh.sessionId)
    expect(result.task.connection?.sessionId).not.toBe(copilot.sessionId)
    expect(provider.create).toHaveBeenCalledOnce()
    expect(provider.validateConnection).not.toHaveBeenCalled()
    expect(provider.submit).toHaveBeenCalledOnce()
    expect(result.task.executions[0]?.status).toBe('running')
    const another = await b.board.create({ workspaceId: b.workspaceId, title: 'Another conversation', executionSettings: { kind } })
    const next = await b.runtime.run({
      taskId: another.id, expectedRevision: another.revision, requestId: TaskRunRequestId(`allocate-another-${kind}`),
    }, new AbortController().signal)
    expect(next.task.connection?.sessionId).not.toBe(result.task.connection?.sessionId)
    expect(provider.create).toHaveBeenCalledTimes(2)
    expect(next.task.executions[0]?.status).toBe('running')
  })

  it('resolves omitted Copilot permissions to read-only without pinning the task choices', async () => {
    const b = await fixture()
    vi.mocked(b.copilotAdapter.prepare).mockResolvedValue({ kind: 'copilot', afterCursor: null })
    vi.mocked(b.copilotAdapter.submit).mockResolvedValue({ kind: 'copilot', afterCursor: null, messageId: 'copilot-message' })
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Inspect', executionSettings: { kind: 'copilot' }, connection: copilot,
    })
    const result = await b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('copilot-default'),
    }, new AbortController().signal)
    expect(b.copilotAllowed).toHaveBeenCalled()
    expect(result.task.executionSettings).toEqual({ kind: 'copilot' })
    expect(result.task.executions[0]?.executionSettings).toEqual({ kind: 'copilot', permission: 'read-only' })
  })

  it('does not admit Copilot work when the deployment fence rejects it', async () => {
    const b = await fixture()
    b.copilotAllowed.mockImplementation(() => { throw new Error('Native execution unavailable') })
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Inspect', executionSettings: { kind: 'copilot' }, connection: copilot,
    })
    await expect(b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('copilot-disabled'),
    }, new AbortController().signal)).rejects.toThrow('Native execution unavailable')
    expect(b.board.get(task.id)?.executions).toEqual([])
    expect(b.copilotAdapter.submit).not.toHaveBeenCalled()
  })

  it('keeps a due occurrence eligible when only announcement and power settings change', async () => {
    let now = new Date()
    const callbacks = new Map<number, () => void>()
    const clock: TaskboardCoordinatorClock = {
      now: () => now,
      every: (callback, interval) => { callbacks.set(interval, callback); return () => { callbacks.delete(interval) } },
    }
    const b = await fixture({ clock })
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Scheduled', connection: dsh,
      schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' },
    })
    const due = task.schedule!.nextRunAt!
    now = new Date(Date.parse(due) - 1_000)
    await b.runtime.start()
    await b.runtime.updateSettings({ announceToAgent: true, preventIdleSleep: true })
    const changed = Promise.withResolvers<undefined>()
    b.ctx.on('domain/changed', (event) => {
      if (event.domain === 'taskboard' && b.board.get(task.id)?.schedule?.nextRunAt !== due) changed.resolve(undefined)
    })
    now = new Date(due)
    callbacks.get(config.schedulerIntervalMs)!()
    await changed.promise
    expect(b.board.get(task.id)?.executions).toHaveLength(1)
    expect(b.runtime.snapshot().scheduler.lastTickAt).toBeDefined()
    await b.runtime.dispose()
    expect(callbacks.size).toBe(0)
  })

  it('synchronizes enablement before initial reconciliation without losing the first due occurrence', async () => {
    let now = new Date()
    const callbacks = new Map<number, () => void>()
    const clock: TaskboardCoordinatorClock = {
      now: () => now,
      every: (callback, interval) => { callbacks.set(interval, callback); return () => { callbacks.delete(interval) } },
    }
    const b = await fixture({ clock, overrides: { enabled: false } })
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Initially enabled schedule', connection: dsh,
      schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' },
    })
    const due = task.schedule!.nextRunAt!
    now = new Date(Date.parse(due) - 1_000)
    b.settings.pushExternal({ taskboard: { enabled: true } })
    await b.runtime.start()
    const changed = Promise.withResolvers<undefined>()
    b.ctx.on('domain/changed', (event) => {
      if (event.domain === 'taskboard' && b.board.get(task.id)?.schedule?.nextRunAt !== due) changed.resolve(undefined)
    })
    now = new Date(due)
    callbacks.get(config.schedulerIntervalMs)!()
    await changed.promise
    expect(b.board.get(task.id)?.executions).toHaveLength(1)
    await b.runtime.dispose()
    expect(callbacks.size).toBe(0)
  })

  it('invalidates a pending dispatch even when a settings event publishes before the watcher runs', async () => {
    const b = await fixture({ clock: controlledClock().clock })
    await b.runtime.start()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Pending dispatch', connection: dsh })
    const entered = Promise.withResolvers<AbortSignal>()
    const resume = Promise.withResolvers<undefined>()
    releases.push(() => { resume.resolve(undefined) })
    vi.mocked(b.dshAdapter.prepare).mockImplementation(async (_execution, signal) => {
      entered.resolve(signal)
      await resume.promise
      return { kind: 'dsh', afterSequence: 0 }
    })
    b.ctx.on('loader/volatile-update', () => {
      b.ownershipOptions()!.onCallbackError('External settings observation')
    })
    const running = b.runtime.run({
      taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId('enabled-transition'),
    }, new AbortController().signal)
    const settled = Promise.allSettled([running])
    const signal = await entered.promise
    b.settings.pushExternal({ taskboard: { enabled: false } })
    await vi.waitFor(() => { expect(b.runtime.snapshot().settings.enabled).toBe(false) })
    await vi.waitFor(() => { expect(signal.aborted).toBe(true) })
    b.settings.pushExternal({ taskboard: { enabled: true } })
    resume.resolve(undefined)
    expect(await settled).toMatchObject([{
      status: 'rejected', reason: { message: 'Taskboard enablement changed during the operation' },
    }])
    expect(b.dshAdapter.submit).not.toHaveBeenCalled()
    expect(b.board.get(task.id)?.executions[0]?.status).toBe('failed')
  })

  it('unblocks startup observation by disposing providers before waiting for startup completion', async () => {
    const b = await fixture()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Recover', connection: dsh })
    const opened = await b.board.beginExecution(request(task))
    await b.board.attachExecution({
      taskId: task.id, executionId: opened.executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 },
    })
    const entered = Promise.withResolvers<undefined>()
    const released = Promise.withResolvers<undefined>()
    releases.push(() => { released.resolve(undefined) })
    const order: string[] = []
    vi.mocked(b.dshAdapter.observe).mockImplementation(async () => {
      entered.resolve(undefined)
      await released.promise
      order.push('observation-ended')
      return { state: 'running' }
    })
    vi.mocked(b.dshAdapter.dispose).mockImplementation(async () => { order.push('provider-disposed'); released.resolve(undefined) })
    b.owned.dispose.mockImplementation(async () => { order.push('owner-released') })
    const starting = b.runtime.start()
    const rejected = expect(starting).rejects.toThrow(/stopped/)
    await entered.promise
    await b.runtime.dispose()
    await rejected
    expect(order).toEqual(['provider-disposed', 'observation-ended', 'owner-released'])
    expect(b.board.get(task.id)?.executions[0]?.status).toBe('pending')
  })

  it('acquires and releases the native kernel owner only inside a private temporary root', async () => {
    const root = await mkdtemp(join(process.cwd(), '.taskboard-runtime-'))
    directories.push(root)
    const b = await fixture({ nativeOwnership: true, overrides: { lockPath: root } })
    await b.runtime.start()
    expect(b.acquire).not.toHaveBeenCalled()
    await b.runtime.dispose()
    const successor = await fixture({ nativeOwnership: true, overrides: { lockPath: root } })
    await successor.runtime.start()
    expect(successor.runtime.snapshot().error).toBeUndefined()
  })
})
