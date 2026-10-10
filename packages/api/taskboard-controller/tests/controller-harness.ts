/** Real planning/domain fixtures with isolated execution and native process adapters. */
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import TaskboardService, { AgencyCopilotSessionId } from '@deepseek-ai/dsh-taskboard'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskboardController, { type Config } from '../src/index.ts'
import type { TaskboardRuntimeState } from '../src/runtime-types.ts'
import type { TaskboardRuntimeHandle } from '../src/runtime/index.ts'

export const firstId = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
export const secondId = AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80')
export const nativeId = SessionId('native')
export const roots: Context[] = []
const backends: MemoryStorageBackend[] = []
const signals: AbortController[] = []
const subprocesses = new Set<Promise<unknown>>()

export function page(sessionId = firstId, folder = process.cwd(), status: 'idle' | 'in_use' = 'idle'): string {
  return JSON.stringify({ sessions: [{ session_id: sessionId, folder, status, summary: 'Inspect the logs' }] })
}

function immutableRuntime(state: TaskboardRuntimeState): TaskboardRuntimeState {
  return Object.freeze({
    ...state,
    settings: Object.freeze({ ...state.settings }),
    power: Object.freeze({ ...state.power }),
    scheduler: Object.freeze({ ...state.scheduler }),
  })
}

export const initialRuntime = immutableRuntime({
  settings: { enabled: true, announceToAgent: false, preventIdleSleep: false },
  timeZone: 'UTC',
  power: { phase: 'disabled', platform: 'fixture', runningSessions: 0, enabledSchedules: 0, sessionStateKnown: true },
  scheduler: {},
})

export function runtimeStub() {
  let state = immutableRuntime(initialRuntime)
  const listeners = new Set<(state: TaskboardRuntimeState) => void>()
  const lifecycle: string[] = []
  const unsubscribe = vi.fn((listener: (state: TaskboardRuntimeState) => void) => {
    lifecycle.push('unsubscribe')
    listeners.delete(listener)
  })
  const runtime = {
    snapshot: () => state,
    subscribe: vi.fn<TaskboardRuntimeHandle['subscribe']>((listener) => {
      lifecycle.push('subscribe')
      listeners.add(listener)
      return () => { unsubscribe(listener) }
    }),
    start: vi.fn<TaskboardRuntimeHandle['start']>(async () => {}),
    run: vi.fn<TaskboardRuntimeHandle['run']>(async () => { throw new Error('Unexpected Taskboard runtime.run') }),
    updateSettings: vi.fn<TaskboardRuntimeHandle['updateSettings']>(async () => { throw new Error('Unexpected Taskboard runtime.updateSettings') }),
    dispose: vi.fn<TaskboardRuntimeHandle['dispose']>(async () => {
      lifecycle.push('dispose')
      listeners.clear()
    }),
  } satisfies TaskboardRuntimeHandle
  return {
    ...runtime, listeners, lifecycle, unsubscribe,
    emit: (next: TaskboardRuntimeState) => {
      state = immutableRuntime(next)
      for (const listener of listeners) listener(state)
    },
  }
}

export async function cleanupControllerHarness(): Promise<void> {
  for (const signal of signals.splice(0)) signal.abort(new Error('Fixture disposed'))
  await Promise.allSettled(subprocesses)
  const disposed = await Promise.allSettled(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  const closed = await Promise.allSettled(backends.splice(0).map(backend => backend.close()))
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const result of [...disposed, ...closed]) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Controller fixture disposal failed')
}

export async function controllerHarness(options: {
  pool?: MemoryMediaPool
  launchEnabled?: boolean
  platform?: NodeJS.Platform
  environment?: Record<string, string>
  projectEnvironment?: Record<string, string>
  config?: Config
  prepare?: (ctx: Context) => Promise<void>
  activate?: boolean
  nativeRuntime?: boolean
} = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  backends.push(backend)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { PATH: 'C:\\FixtureTools', USERPROFILE: 'C:\\FixtureUser', ...options.environment } },
    ...(options.projectEnvironment === undefined ? [] : [{
      source: 'project-env' as const, path: 'Q:\\fixture\\.env', values: options.projectEnvironment,
    }]),
  ]))
  const persisted = new Map<SessionId, SessionPersistenceSnapshot>([[nativeId, {
    header: { version: SESSION_FORMAT_VERSION, id: nativeId, createdAt: 0, cwd: process.cwd(), isSeeded: false },
    revision: SessionPersistenceRevision('fixture'),
  }]])
  const persistence = {
    list: vi.fn(async () => [...persisted.values()]),
    stat: vi.fn(async (id: SessionId) => persisted.get(id)),
    create: vi.fn(async () => { throw new Error('Association must not create a Session') }),
    open: vi.fn(async () => { throw new Error('Association must not open a Session body') }),
  }
  ctx.provide('sessionPersistence', persistence as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TaskboardService)
  const workspace = await ctx.workspaceRegistry.create(process.cwd())
  const read = vi.fn(async () => page())
  const lifetime = new AbortController()
  signals.push(lifetime)
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    let output = ''
    const termination = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, termination.signal, ...(spec.signal === undefined ? [] : [spec.signal])])
    const aborted = Promise.withResolvers<never>()
    const abort = (): void => { aborted.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const done = Promise.race([read(), aborted.promise]).then((text) => {
      output = text
      return { exitCode: 0, signal: null }
    }).finally(() => {
      signal.removeEventListener('abort', abort)
      subprocesses.delete(done)
    })
    subprocesses.add(done)
    return {
      stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: output, nextOffset: output.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done,
      terminate: () => { termination.abort(new Error('Fixture subprocess terminated')) },
      waitForExit: () => done.then(() => true, () => true),
    }
  })
  const resolveExecutable = vi.fn(async (command: string) =>
    command === 'agency.exe' ? 'C:\\Agency\\agency.exe' : 'C:\\WindowsApps\\wt.exe')
  ctx.provide('subprocess', { resolveExecutable, spawn } as never)
  const dispose = (): void => {}
  ctx.provide('typert', { lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose } } as never)
  const controls = { launchError: undefined as Error | undefined }
  const launch = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn(() => child)
    queueMicrotask(() => {
      if (controls.launchError !== undefined) child.emit('error', controls.launchError)
      else child.emit('spawn')
    })
    return child
  })
  const runtime = runtimeStub()
  await options.prepare?.(ctx)
  const config = {
    agencyCopilotLaunch: options.launchEnabled ?? false,
    ...(options.config ?? { timeZone: 'UTC' }),
  }
  const internals = {
    ...(options.nativeRuntime === true ? {} : { runtime }),
    agency: { platform: options.platform ?? 'win32', spawnBroker: launch },
    settingsNamespace: 'taskboard',
  }
  let controller: TaskboardController
  let controllerFiber: Fiber | undefined
  if (options.activate === true) {
    class ActivatedController extends TaskboardController {
      constructor(context: Context, value: Config) {
        const settings = context.get('settings') as { bind?: (ns: string, config: Record<string, unknown>) => void } | undefined
        settings?.bind?.('taskboard', value as Record<string, unknown>)
        super(context, value, internals)
      }
    }
    controllerFiber = ctx.plugin(ActivatedController, config)
    await controllerFiber.await()
    controller = ctx.taskboardController
  } else controller = new TaskboardController(ctx, config, internals)
  const follow = () => {
    const signal = new AbortController()
    signals.push(signal)
    return controller.follow(signal.signal)[Symbol.asyncIterator]()
  }
  return {
    ctx, pool, facility, board: ctx.taskboard, workspace, read, spawn, launch, controller,
    runtime, follow, persisted, persistence, controls, resolveExecutable, controllerFiber,
  }
}
