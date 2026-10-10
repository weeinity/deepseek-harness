/** Copilot dispatch receipts, conservative recovery, permissions, and owned SDK teardown. */
import { randomUUID } from 'node:crypto'
import { lstat, realpath, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AgencyCopilotSessionId, TaskExecutionId, TaskRunRequestId, TaskExecution } from '@deepseek-ai/dsh-taskboard/types'
import { CopilotClient, RuntimeConnection, ToolSet, type CopilotClientOptions, type PermissionRequest, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CopilotTaskExecutionAdapter,
  type CopilotTaskExecutionClient,
} from '../src/runtime/copilot.ts'
import { AgencyCopilotHost, type AgencyCopilotScan } from '../src/agency.ts'

vi.mock('../src/agency.ts', () => ({ AgencyCopilotHost: vi.fn() }))

type EventOf<K extends SessionEvent['type']> = Extract<SessionEvent, { type: K }>
const signal = new AbortController().signal
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  try {
    const results = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
    const errors: unknown[] = []
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Copilot fixtures did not release their resources')
  } finally { vi.restoreAllMocks() }
})

function event<K extends SessionEvent['type']>(type: K, data: EventOf<K>['data'], agentId?: string): EventOf<K> {
  return {
    id: randomUUID(), parentId: null, timestamp: '2026-09-09T00:00:00Z', type, data,
    ephemeral: type === 'session.idle', ...(agentId === undefined ? {} : { agentId }),
  } as EventOf<K>
}

async function fixture(permission?: 'read-only' | 'workspace-write' | 'full-access') {
  const root = await mkdtemp(join(process.cwd(), '.taskboard-copilot-unit-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const path = await realpathNormalize(workspace)
  const workspaceId = 'workspace' as WorkspaceId
  const sessionId = randomUUID() as AgencyCopilotSessionId
  let execution: TaskExecution = {
    id: randomUUID() as TaskExecutionId, requestId: randomUUID() as TaskRunRequestId,
    requestedAt: '2026-09-09T00:00:00Z', trigger: 'manual', status: 'pending',
    connection: { kind: 'copilot', sessionId }, createsConnection: true,
    workspaceId, prompt: 'Run the fixture task',
    executionSettings: { kind: 'copilot', model: 'fixture-model', ...(permission === undefined ? {} : { permission }) },
  }
  let options: SessionConfig = {}
  const recorded: SessionEvent[] = []
  const activity = vi.fn(async () => ({ hasActiveWork: false, abortable: false }))
  const snapshot = vi.fn(async () => ({
    alreadyInUse: false, isRemote: false, workingDirectory: path,
    currentMode: 'interactive' as 'interactive' | 'plan' | 'autopilot',
  }))
  const page = (): Awaited<ReturnType<CopilotClient['rpc']['sessions']['readPersistedEvents']>> =>
    ({ events: [...recorded], cursor: 'next', cursorStatus: 'ok', hasMore: false })
  const read = vi.fn(async () => page())
  const persisted = vi.fn(async () => page())
  const tail = vi.fn(async () => ({ cursor: 'before-send' }))
  const permissions = {
    setMode: vi.fn(async () => ({ success: true, mode: 'manual' as const })),
    resetSessionApprovals: vi.fn(async () => ({ success: true })),
    configure: vi.fn(async () => ({ success: true })),
  }
  const send = vi.fn(async () => 'message-1')
  const session = {
    sessionId, send, rpc: {
      metadata: { activity, snapshot }, eventLog: { tail, read }, permissions,
      options: { update: vi.fn(async () => undefined) },
    },
  }
  const start = vi.fn(async (): Promise<void> => undefined)
  const stop = vi.fn(async (): Promise<Error[]> => [])
  const createSession = vi.fn(async (config: SessionConfig) => { options = config; return session })
  const resumeSession = vi.fn(async (_id: string, config: SessionConfig) => { options = config; return session })
  const client: CopilotTaskExecutionClient = {
    start, stop, createSession, resumeSession, rpc: { sessions: { readPersistedEvents: persisted } },
  }
  const inspect = vi.fn(async (): Promise<AgencyCopilotScan> => ({ sessions: new Map(), complete: true }))
  const environment = vi.fn(() => ({ COPILOT_HOME: join(root, 'copilot') }))
  const fileSystem = {
    realpath: vi.fn((path: string) => realpath(path)),
    lstat: vi.fn((path: string) => lstat(path)),
  }
  // The process substitute implements only the public SDK operations owned by this provider.
  const factory = vi.fn((_options: CopilotClientOptions) => client)
  const context = new Context()
  context.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { path } : undefined,
  } as never)
  const adapter = new CopilotTaskExecutionAdapter(
    context,
    { operationTimeoutMs: 1_000, recoveryPageSize: 50, recoveryMaxPages: 2 },
    { agency: { inspect, copilotSdkEnvironment: environment }, createClient: factory, fileSystem },
  )
  let shutdownFailureExpected = false
  cleanups.push(async () => {
    try {
      try { await adapter.dispose() }
      catch (error: unknown) {
        if (!shutdownFailureExpected) throw error
        expect(error).toMatchObject({ code: 'copilot/shutdown-failed' })
      }
    }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
  })
  function emit(value: SessionEvent): void {
    if (value.ephemeral !== true) recorded.push(value)
    options.onEvent?.(value)
  }
  function consumed(messageId = 'message-1', turnId = 'turn-1'): void {
    emit(event('user.message', { content: 'unrelated display text', messageId, turnId }))
  }
  function finished(turnId = 'turn-1'): void {
    emit(event('assistant.turn_end', { turnId }))
    emit(event('session.idle', {}))
  }
  async function prepare(): Promise<void> {
    await adapter.create(execution, signal)
    execution = { ...execution, receipt: await adapter.prepare(execution, signal) }
  }
  async function submit(): Promise<void> {
    await prepare()
    execution = { ...execution, receipt: await adapter.submit(execution, signal) }
  }
  function existing(): void {
    execution = { ...execution, createsConnection: false }
    inspect.mockResolvedValue({
      complete: true, sessions: new Map([[sessionId, { sessionId, status: 'idle', folder: path }]]),
    })
  }
  return {
    root, path, workspaceId, sessionId, adapter, activity, snapshot, permissions, recorded,
    read, persisted, tail, send, session, start, stop, createSession, resumeSession,
    inspect, environment, factory, fileSystem, context, client, emit, consumed, finished, prepare, submit, existing,
    expectShutdownFailure: () => { shutdownFailureExpected = true },
    get options() { return options },
    get execution() { return execution },
    set execution(value: TaskExecution) { execution = value },
  }
}

describe('native Copilot execution', () => {
  it('creates the reserved UUID without a prompt and sends once after saving its stable cursor', async () => {
    const f = await fixture()
    await f.prepare()
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/creation-forbidden' })
    expect(f.createSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.sessionId, model: 'fixture-model' }))
    expect(f.send).not.toHaveBeenCalled()
    expect(f.factory.mock.calls[0]?.[0].connection).toEqual(RuntimeConnection.forStdio())
    expect(f.factory.mock.calls[0]?.[0]).toMatchObject({
      mode: 'copilot-cli', useLoggedInUser: true,
    })
    expect(f.factory.mock.calls[0]?.[0].connection).toHaveProperty('path', undefined)
    expect(await f.adapter.prepare(f.execution, signal)).toEqual(f.execution.receipt)
    expect(f.tail).toHaveBeenCalledTimes(1)
    const receipt = await f.adapter.submit(f.execution, signal)
    expect(receipt).toEqual({ kind: 'copilot', afterCursor: 'before-send', messageId: 'message-1' })
    expect(await f.adapter.submit(f.execution, signal)).toEqual(receipt)
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ prompt: f.execution.prompt, mode: 'enqueue' })
  })

  it('resumes the exact established UUID without replacing its working directory', async () => {
    const f = await fixture()
    f.existing()
    await f.adapter.prepare(f.execution, signal)
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.resumeSession).toHaveBeenCalledWith(f.sessionId, expect.objectContaining({
      model: 'fixture-model', continuePendingWork: false,
    }))
    expect(f.resumeSession.mock.calls[0]?.[1]).not.toHaveProperty('workingDirectory')
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/creation-forbidden' })
  })

  it('does not recreate a conversation that disappears after discovery', async () => {
    const f = await fixture()
    f.existing()
    f.resumeSession.mockRejectedValueOnce(new Error('fixture session was deleted'))
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/sdk-failed' })
    expect(f.resumeSession).toHaveBeenCalledWith(f.sessionId, expect.any(Object))
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing', true, 'copilot/session-missing'],
    ['incomplete', false, 'copilot/discovery-incomplete'],
  ])('does not create an established conversation when discovery is %s', async (_name, complete, code) => {
    const f = await fixture()
    f.existing()
    f.inspect.mockResolvedValue({ sessions: new Map(), complete })
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it('rejects reserved identities that already exist', async () => {
    const f = await fixture()
    f.inspect.mockResolvedValue({ complete: true, sessions: new Map([[f.sessionId, { sessionId: f.sessionId, status: 'idle' }]]) })
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/creation-conflict' })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it.each(['busy', 'workspace', 'unknown-workspace'])('rejects %s connections before activating them', async (condition) => {
    const f = await fixture()
    f.existing()
    f.inspect.mockResolvedValue({
      complete: true, sessions: new Map([[f.sessionId, {
        sessionId: f.sessionId, status: condition === 'busy' ? 'in_use' : 'idle',
        ...(condition === 'unknown-workspace' ? {} : { folder: condition === 'workspace' ? f.root : f.path }),
      }]]),
    })
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({
      code: condition === 'busy' ? 'copilot/busy' : 'copilot/workspace-mismatch',
    })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it('rejects runtime ownership discovered after a stale Agency scan', async () => {
    const f = await fixture()
    f.existing()
    f.snapshot.mockResolvedValue({ alreadyInUse: true, isRemote: false, workingDirectory: f.path, currentMode: 'interactive' })
    const preparing = f.adapter.prepare(f.execution, signal)
    await expect(preparing).rejects.toMatchObject({ code: 'copilot/busy' })
    await expect(preparing).rejects.toThrow('Close that CLI, even if idle, before Run')
    expect(f.permissions.configure).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('requires an idle interactive owner to exit without changing the connected conversation', async () => {
    const f = await fixture()
    f.existing()
    const connection = f.execution.connection
    f.inspect.mockResolvedValue({
      complete: true, sessions: new Map([[f.sessionId, { sessionId: f.sessionId, status: 'in_use', folder: f.path }]]),
    })
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({
      code: 'copilot/busy',
      message: 'Another Copilot CLI owns this conversation. Close that CLI, even if idle, before Run; the Host cannot attach to or take over its process.',
    })
    expect(f.execution.connection).toBe(connection)
    expect(f.factory).not.toHaveBeenCalled()
    expect(f.resumeSession).not.toHaveBeenCalled()
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('rejects runtime activity before permission or prompt changes', async () => {
    const f = await fixture()
    f.activity.mockResolvedValue({ hasActiveWork: true, abortable: true })
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    expect(f.permissions.configure).not.toHaveBeenCalled()
  })

  it.each(['plan', 'autopilot'] as const)('does not silently run an established %s conversation', async (currentMode) => {
    const f = await fixture()
    f.existing()
    f.snapshot.mockResolvedValue({ alreadyInUse: false, isRemote: false, workingDirectory: f.path, currentMode })
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/session-mode-unsupported' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('catches busy state delivered during exact resume before its RPC response', async () => {
    const f = await fixture()
    f.existing()
    f.resumeSession.mockImplementation(async (_id, options) => {
      options.onEvent?.(event('session.resume', {
        eventCount: 1, resumeTime: '2026-09-09T00:00:00Z', sessionWasActive: true,
      }))
      return f.session
    })
    const preparing = f.adapter.prepare(f.execution, signal)
    await expect(preparing).rejects.toMatchObject({ code: 'copilot/busy' })
    await expect(preparing).rejects.toThrow('Close that CLI, even if idle, before Run')
    expect(f.permissions.configure).not.toHaveBeenCalled()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('reserves conversations before asynchronous process discovery', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<AgencyCopilotScan>()
    f.inspect.mockReturnValue(ready.promise)
    const opening = f.adapter.create(f.execution, signal)
    const another = { ...f.execution, id: randomUUID() as TaskExecutionId }
    await expect(f.adapter.create(another, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    ready.resolve({ sessions: new Map(), complete: true })
    await opening
    expect(f.start).toHaveBeenCalledOnce()
  })

  it('waits for root whole-session idle after the accepted message turn ends', async () => {
    const f = await fixture()
    await f.submit()
    f.emit(event('session.idle', {}))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'running' })
    f.consumed()
    f.emit(event('assistant.turn_end', { turnId: 'turn-1' }))
    f.emit(event('session.idle', {}, 'child'))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'running' })
    f.emit(event('session.idle', {}))
    f.activity.mockResolvedValueOnce({ hasActiveWork: true, abortable: true })
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'running' })
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'settled', outcome: 'succeeded' })
    expect(f.read).toHaveBeenCalledWith({ cursor: 'before-send', max: 50, includeEphemeral: false })
    expect(f.stop).not.toHaveBeenCalled()
    await f.adapter.release({ ...f.execution, status: 'succeeded' })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('correlates events delivered before the send acknowledgement', async () => {
    const f = await fixture()
    f.send.mockImplementation(async () => { f.consumed(); f.finished(); return 'message-1' })
    await f.submit()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
  })

  it('does not attribute another logical message by equal prompt text', async () => {
    const f = await fixture()
    await f.submit()
    f.emit(event('user.message', { content: f.execution.prompt, messageId: 'other', turnId: 'other-turn' }))
    f.finished('other-turn')
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: 'failed', error: { code: 'copilot/completion-unknown' },
    })
  })

  it('keeps live failures distinct from successful idle without retaining vendor diagnostics', async () => {
    const f = await fixture()
    await f.submit()
    f.emit(event('session.error', { errorType: 'query', message: 'vendor private diagnostic' }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: 'failed', error: { code: 'copilot/session-error', message: 'Copilot reported an execution error' },
    })
  })

  it.each(['error', 'abort'] as const)('retains a live %s that arrives during completion evidence reads', async (kind) => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    f.read.mockImplementationOnce(async () => {
      f.emit(kind === 'error'
        ? event('session.error', { errorType: 'query', message: 'fixture late error' })
        : event('abort', { reason: 'user_initiated' }))
      return { events: [...f.recorded], cursor: 'next', cursorStatus: 'ok', hasMore: false }
    })
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: kind === 'error' ? 'failed' : 'cancelled' })
  })

  it('releases the owned runtime when a live observation RPC fails', async () => {
    const f = await fixture()
    await f.submit()
    f.activity.mockRejectedValueOnce(new Error('fixture observation failure'))
    await expect(f.adapter.observe(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/sdk-failed' })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('does not turn abort followed by idle into success', async () => {
    const f = await fixture()
    await f.submit()
    f.emit(event('session.idle', { aborted: true }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'cancelled' })
  })

  it('does not resend an uncertain submission and releases its owned runtime', async () => {
    const f = await fixture()
    await f.prepare()
    f.send.mockRejectedValueOnce(new Error('private transport diagnostic'))
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/acceptance-unknown' })
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/acceptance-unknown' })
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.stop).toHaveBeenCalledOnce()
  })
})

describe('Copilot recovery', () => {
  it('never resumes or resends an attempt without an accepted message identity', async () => {
    const f = await fixture()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: 'failed', error: { code: 'copilot/acceptance-unknown' },
    })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it('reads exact persisted message evidence without activating the conversation', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    f.recorded.push(event('user.message', { content: 'fixture', messageId: 'message-1', turnId: 'turn-1' }))
    f.recorded.push(event('assistant.turn_end', { turnId: 'turn-1' }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: 'failed', error: { code: 'copilot/recovery-unknown' },
    })
    expect(f.persisted).toHaveBeenCalledWith({ sessionId: f.sessionId, cursor: 'saved', max: 50 })
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.resumeSession).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    await f.adapter.release(f.execution)
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('publishes recovered evidence before a later acknowledged cleanup failure', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    f.recorded.push(event('user.message', { content: 'fixture', messageId: 'message-1', turnId: 'turn-1' }))
    f.recorded.push(event('abort', { reason: 'user_initiated' }))
    f.stop.mockResolvedValue([new Error('fixture shutdown failure')])
    f.expectShutdownFailure()
    const terminal = await f.adapter.observe(f.execution, signal)
    expect(terminal).toMatchObject({ outcome: 'cancelled' })
    expect(await f.adapter.observe(f.execution, signal)).toEqual(terminal)
    expect(f.stop).not.toHaveBeenCalled()
    await expect(f.adapter.release(f.execution)).rejects.toMatchObject({ code: 'copilot/shutdown-failed' })
    expect(terminal).toMatchObject({ outcome: 'cancelled' })
  })

  it('joins cancelled recovery without retaining its SDK process', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    const reached = Promise.withResolvers<undefined>()
    const history = Promise.withResolvers<Awaited<ReturnType<typeof f.persisted>>>()
    f.persisted.mockImplementationOnce(() => { reached.resolve(undefined); return history.promise })
    const controller = new AbortController()
    const observing = f.adapter.observe(f.execution, controller.signal)
    await reached.promise
    controller.abort(new Error('fixture recovery cancellation'))
    await expect(observing).rejects.toThrow('fixture recovery cancellation')
    expect(f.stop).toHaveBeenCalledOnce()
    history.resolve({ events: [], cursor: 'next', cursorStatus: 'ok', hasMore: false })
    await f.adapter.release(f.execution)
  })

  it.each(['cursor-expired', 'history-limit', 'recovery-unavailable'])('fails closed for %s', async (code) => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    if (code === 'recovery-unavailable') f.persisted.mockRejectedValueOnce(new Error('private diagnostic'))
    else f.persisted.mockResolvedValue({
      events: [], cursor: 'next', hasMore: code === 'history-limit',
      cursorStatus: code === 'cursor-expired' ? 'expired' : 'ok',
    })
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'failed', error: { code: `copilot/${code}` } })
    expect(f.persisted.mock.calls.length).toBe(code === 'history-limit' ? 2 : 1)
  })

  it('does not overwrite an existing durable cursor', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved' } }
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/acceptance-unknown' })
    expect(f.factory).not.toHaveBeenCalled()
  })

  it.each(['error', 'abort'] as const)('recovers a correlated %s without interpreting turn-end as session-idle', async (kind) => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    f.recorded.push(event('user.message', { content: 'fixture', messageId: 'message-1', turnId: 'turn-1' }))
    f.recorded.push(kind === 'error'
      ? event('session.error', { errorType: 'query', message: 'private vendor diagnostic' })
      : event('abort', { reason: 'user_initiated' }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: kind === 'error' ? 'failed' : 'cancelled',
    })
    expect(f.resumeSession).not.toHaveBeenCalled()
  })
})

describe('Copilot permission policy', () => {
  it('resets inherited broad approvals before the first prompt', async () => {
    const f = await fixture()
    await f.prepare()
    expect(f.permissions.resetSessionApprovals).toHaveBeenCalledWith({ includeLocation: true })
    expect(f.permissions.configure).toHaveBeenCalledWith({
      approveAllToolPermissionRequests: false, approveAllReadPermissionRequests: false,
      paths: { unrestricted: false, additionalDirectories: [], includeTempDirectory: false, workspacePath: f.path },
      urls: { unrestricted: false, initialAllowed: [] },
    })
    expect(f.options.availableTools).toBeInstanceOf(ToolSet)
    expect((f.options.availableTools as ToolSet).toArray()).toEqual(['builtin:view', 'builtin:glob', 'builtin:grep'])
    expect(f.options).toMatchObject({ enableConfigDiscovery: false, enableFileHooks: false, excludedTools: ['ask_user'] })
  })

  it('refuses a runtime that cannot apply the policy', async () => {
    const f = await fixture()
    f.permissions.configure.mockResolvedValue({ success: false })
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/permission-policy-unavailable' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'workspace-write', 'full-access'] as const)('enforces %s read and write requests', async (permission) => {
    const f = await fixture(permission)
    await f.submit()
    const decide = f.options.onPermissionRequest!
    const context = { sessionId: f.sessionId }
    const inside = join(f.path, 'new', 'file')
    const read: PermissionRequest = { kind: 'read', path: inside, intention: 'fixture' }
    const write: PermissionRequest = { kind: 'write', fileName: inside, intention: 'fixture', diff: '', canOfferSessionApproval: false }
    expect(await decide(read, context)).toEqual({ kind: 'approve-once' })
    expect(await decide(write, context)).toEqual({ kind: permission === 'read-only' ? 'reject' : 'approve-once' })
    expect(await decide({ ...read, path: join(f.root, 'outside') }, context)).toEqual({
      kind: permission === 'full-access' ? 'approve-once' : 'reject',
    })
    expect(await decide({ ...read, requestSandboxBypass: true }, context)).toEqual({ kind: 'reject' })
  })

  it('rejects junction escapes and non-directory ancestors', async () => {
    const f = await fixture('workspace-write')
    const outside = join(f.root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(f.path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(f.path, 'file'), 'fixture')
    await f.submit()
    for (const candidate of [join(f.path, 'escape', 'new'), join(f.path, 'file', 'new')]) {
      expect(await f.options.onPermissionRequest!({
        kind: 'write', fileName: candidate, intention: 'fixture', diff: '', canOfferSessionApproval: false,
      }, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
    }
  })

  it('rejects dangling links rather than approving their lexical parents', async () => {
    const f = await fixture('workspace-write')
    const target = join(f.root, 'missing')
    await mkdir(target)
    await symlink(target, join(f.path, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    await rm(target, { recursive: true })
    await f.submit()
    expect(await f.options.onPermissionRequest!({
      kind: 'write', fileName: join(f.path, 'dangling', 'new'), intention: 'fixture', diff: '', canOfferSessionApproval: false,
    }, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
  })

  it('keeps managed approvals and questions explicitly unavailable even with full access', async () => {
    const f = await fixture('full-access')
    await f.submit()
    expect(await f.options.onPermissionRequest!({
      kind: 'read', path: f.path, intention: 'fixture', managedApprovalRequired: true,
    }, { sessionId: f.sessionId })).toEqual({ kind: 'user-not-available' })
    expect(await f.options.onElicitationRequest!({ sessionId: f.sessionId, message: 'fixture question' })).toEqual({ action: 'cancel' })
    f.emit(event('session.error', { errorType: 'query', message: 'fixture approval denial' }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({
      outcome: 'failed', error: { code: 'copilot/approval-required' },
    })
  })
})

describe('Copilot lifecycle', () => {
  it.each(['error', 'abort'] as const)('retains terminal %s without inspecting subsequent session changes', async (kind) => {
    const f = await fixture()
    await f.submit()
    f.emit(kind === 'error'
      ? event('session.error', { errorType: 'query', message: 'fixture error' })
      : event('abort', { reason: 'user_initiated' }))
    const terminal = await f.adapter.observe(f.execution, signal)
    expect(terminal).toMatchObject({ outcome: kind === 'error' ? 'failed' : 'cancelled' })
    const activityReads = f.activity.mock.calls.length
    f.emit(event('session.error', { errorType: 'query', message: 'later fixture error' }))
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toEqual(terminal)
    expect(f.activity).toHaveBeenCalledTimes(activityReads)
    expect(f.stop).not.toHaveBeenCalled()
    await f.adapter.release(f.execution)
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it.each(['read-failure', 'mismatched-evidence'] as const)('preserves published success across a concurrent %s', async (kind) => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    const reached = Promise.withResolvers<undefined>()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.read>>>()
    f.read.mockImplementationOnce(() => { reached.resolve(undefined); return pending.promise })
    const first = f.adapter.observe(f.execution, signal)
    await reached.promise
    const terminal = await f.adapter.observe(f.execution, signal)
    expect(terminal).toMatchObject({ outcome: 'succeeded' })
    if (kind === 'read-failure') pending.reject(new Error('fixture late read failure'))
    else pending.resolve({ events: [], cursor: 'next', cursorStatus: 'ok', hasMore: false })
    expect(await first).toEqual(terminal)
    expect(f.stop).not.toHaveBeenCalled()
    await f.adapter.release(f.execution)
  })

  it('retains recovered outcomes until release without a permanent completed-attempt cache', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    f.recorded.push(event('user.message', { content: 'fixture', messageId: 'message-1', turnId: 'turn-1' }))
    const recovered = await f.adapter.observe(f.execution, signal)
    expect(recovered).toMatchObject({ error: { code: 'copilot/recovery-unknown' } })
    f.recorded.push(event('session.error', { errorType: 'query', message: 'later fixture error' }))
    expect(await f.adapter.observe(f.execution, signal)).toEqual(recovered)
    expect(f.persisted).toHaveBeenCalledOnce()
    await f.adapter.release(f.execution)
    await f.adapter.release(f.execution)
    expect(f.stop).toHaveBeenCalledOnce()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ error: { code: 'copilot/session-error' } })
    expect(f.persisted).toHaveBeenCalledTimes(2)
    await f.adapter.release(f.execution)
  })

  it('keeps the conversation excluded until acknowledged SDK release completes', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
    const stopped = Promise.withResolvers<Error[]>()
    f.stop.mockReturnValue(stopped.promise)
    const releasing = f.adapter.release(f.execution)
    expect(f.adapter.release(f.execution)).toBe(releasing)
    const { receipt: _receipt, ...previous } = f.execution
    const next = {
      ...previous, id: randomUUID() as TaskExecutionId, requestId: randomUUID() as TaskRunRequestId, createsConnection: false,
    }
    await f.adapter.release(next)
    await expect(f.adapter.prepare(next, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    await expect(f.adapter.observe(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/release-in-progress' })
    stopped.resolve([])
    await releasing
    f.existing()
    await f.adapter.prepare(next, signal)
    expect(f.resumeSession).toHaveBeenCalledWith(f.sessionId, expect.any(Object))
  })

  it('joins pending cold observations without caching their result after acknowledged release', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: 'saved', messageId: 'message-1' } }
    const reached = Promise.withResolvers<undefined>()
    const history = Promise.withResolvers<Awaited<ReturnType<typeof f.persisted>>>()
    f.persisted.mockImplementationOnce(() => { reached.resolve(undefined); return history.promise })
    const observing = f.adapter.observe(f.execution, signal)
    await reached.promise
    let released = false
    const releasing = f.adapter.release(f.execution).then(() => { released = true })
    await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledOnce() })
    expect(released).toBe(false)
    await expect(f.adapter.observe(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/release-in-progress' })
    history.resolve({ events: [], cursor: 'next', cursorStatus: 'ok', hasMore: false })
    expect(await observing).toMatchObject({ error: { code: 'copilot/recovery-unknown' } })
    await releasing
    expect(released).toBe(true)
    await f.adapter.release(f.execution)
    expect(f.factory).toHaveBeenCalledOnce()
  })

  it('joins an opening SDK activation before acknowledging its resource release', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<undefined>()
    f.start.mockReturnValue(ready.promise)
    const opening = f.adapter.create(f.execution, signal)
    await vi.waitFor(() => { expect(f.start).toHaveBeenCalledOnce() })
    const releasing = f.adapter.release(f.execution)
    expect(f.stop).not.toHaveBeenCalled()
    ready.resolve(undefined)
    await Promise.all([opening, releasing])
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('joins acknowledged per-attempt cleanup during global disposal', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
    const stopped = Promise.withResolvers<Error[]>()
    f.stop.mockReturnValue(stopped.promise)
    const releasing = f.adapter.release(f.execution)
    let disposed = false
    const disposing = f.adapter.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledOnce() })
    expect(disposed).toBe(false)
    stopped.resolve([])
    await Promise.all([releasing, disposing])
    expect(disposed).toBe(true)
    await f.adapter.release(f.execution)
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('retains terminal success across a failed settlement write until acknowledged release', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    const first = await f.adapter.observe(f.execution, signal)
    expect(first).toMatchObject({ state: 'settled', outcome: 'succeeded', receipt: f.execution.receipt })
    const commit = vi.fn(async () => {})
    commit.mockRejectedValueOnce(new Error('injected settlement write failure'))
    await expect(commit()).rejects.toThrow('injected settlement write failure')
    expect(await f.adapter.observe(f.execution, signal)).toEqual(first)
    expect(f.stop).not.toHaveBeenCalled()
    await commit()
    await f.adapter.release({ ...f.execution, status: 'succeeded' })
    expect(f.stop).toHaveBeenCalledOnce()

    const { receipt: _receipt, ...previous } = f.execution
    f.execution = {
      ...previous, id: randomUUID() as TaskExecutionId, requestId: randomUUID() as TaskRunRequestId,
      status: 'pending', createsConnection: false,
    }
    f.existing()
    f.tail.mockResolvedValueOnce({ cursor: 'second-run' })
    f.send.mockResolvedValueOnce('message-2')
    f.execution = { ...f.execution, receipt: await f.adapter.prepare(f.execution, signal) }
    f.execution = { ...f.execution, receipt: await f.adapter.submit(f.execution, signal) }
    f.consumed('message-2', 'turn-2')
    f.finished('turn-2')
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
    expect(f.resumeSession).toHaveBeenCalledWith(f.sessionId, expect.any(Object))
    expect(f.createSession).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledTimes(2)
    await f.adapter.release({ ...f.execution, status: 'succeeded' })
    expect(f.stop).toHaveBeenCalledTimes(2)
  })

  it('constructs the maintained SDK client when no process substitutes are supplied', async () => {
    const f = await fixture()
    vi.mocked(AgencyCopilotHost).mockImplementation(function () {
      return { inspect: f.inspect, copilotSdkEnvironment: f.environment } as never
    })
    vi.spyOn(CopilotClient.prototype, 'start').mockRejectedValue(new Error('fixture startup failure'))
    const stop = vi.spyOn(CopilotClient.prototype, 'stop').mockResolvedValue([])
    const adapter = new CopilotTaskExecutionAdapter(f.context, {
      operationTimeoutMs: 1_000, recoveryPageSize: 50, recoveryMaxPages: 2,
    })
    try {
      await expect(adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/sdk-failed' })
      expect(stop).toHaveBeenCalledOnce()
    } finally { await adapter.dispose() }
  })

  it('waits for acceptance even when the native turn finishes before its RPC acknowledgement', async () => {
    const f = await fixture()
    await f.adapter.create(f.execution, signal)
    expect(await f.adapter.observe(f.execution, signal)).toEqual({ state: 'pending' })
    f.execution = { ...f.execution, receipt: await f.adapter.prepare(f.execution, signal) }
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'pending' })
    const accepted = Promise.withResolvers<string>()
    f.send.mockReturnValue(accepted.promise)
    const submitting = f.adapter.submit(f.execution, signal)
    await vi.waitFor(() => { expect(f.send).toHaveBeenCalledOnce() })
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ state: 'pending' })
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/acceptance-unknown' })
    accepted.resolve('message-1')
    f.execution = { ...f.execution, receipt: await submitting }
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
  })

  it('releases a prepared activation that becomes busy before submission', async () => {
    const f = await fixture()
    await f.prepare()
    f.activity.mockResolvedValue({ hasActiveWork: true, abortable: true })
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('releases failed cursor capture without submitting a prompt', async () => {
    const f = await fixture()
    await f.adapter.create(f.execution, signal)
    f.tail.mockRejectedValueOnce(new Error('fixture cursor failure'))
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/sdk-failed' })
    expect(f.stop).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
  })

  it('joins duplicate allocation requests instead of creating two clients', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<AgencyCopilotScan>()
    f.inspect.mockReturnValue(ready.promise)
    const first = f.adapter.create(f.execution, signal)
    const second = f.adapter.create(f.execution, signal)
    ready.resolve({ sessions: new Map(), complete: true })
    await Promise.all([first, second])
    expect(f.factory).toHaveBeenCalledOnce()
  })

  it('does not allocate an SDK client for an already-cancelled operation', async () => {
    const f = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(f.adapter.create(f.execution, controller.signal)).rejects.toBeDefined()
    expect(f.factory).not.toHaveBeenCalled()
  })

  it('joins a late SDK startup before stopping its child on cancellation', async () => {
    const f = await fixture()
    const ready = Promise.withResolvers<undefined>()
    f.start.mockReturnValue(ready.promise)
    const controller = new AbortController()
    const opening = f.adapter.create(f.execution, controller.signal)
    await vi.waitFor(() => { expect(f.start).toHaveBeenCalledOnce() })
    expect(await f.adapter.observe(f.execution, signal)).toEqual({ state: 'pending' })
    controller.abort()
    const closed = f.adapter.dispose()
    expect(f.stop).not.toHaveBeenCalled()
    ready.resolve(undefined)
    await expect(opening).rejects.toMatchObject({ code: 'copilot/operation-interrupted' })
    await closed
    expect(f.createSession).not.toHaveBeenCalled()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('shares shutdown completion and waits for SDK resource release', async () => {
    const f = await fixture()
    await f.submit()
    const stopped = Promise.withResolvers<Error[]>()
    f.stop.mockReturnValue(stopped.promise)
    const first = f.adapter.dispose()
    expect(f.adapter.dispose()).toBe(first)
    let done = false
    void first.then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    stopped.resolve([])
    await first
    expect(done).toBe(true)
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('cancels an observation without stopping the owned conversation', async () => {
    const f = await fixture()
    await f.submit()
    const observed = Promise.withResolvers<{ hasActiveWork: boolean; abortable: boolean }>()
    f.activity.mockReturnValueOnce(observed.promise)
    const controller = new AbortController()
    const pending = f.adapter.observe(f.execution, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'copilot/operation-interrupted' })
    expect(f.stop).not.toHaveBeenCalled()
    observed.resolve({ hasActiveWork: false, abortable: false })
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
  })

  it('joins an observation interrupted by adapter disposal', async () => {
    const f = await fixture()
    await f.submit()
    const observed = Promise.withResolvers<{ hasActiveWork: boolean; abortable: boolean }>()
    f.activity.mockReturnValueOnce(observed.promise)
    const observing = expect(f.adapter.observe(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/operation-interrupted' })
    const closed = f.adapter.dispose()
    await observing
    observed.resolve({ hasActiveWork: false, abortable: false })
    await closed
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('reports unconfirmed shutdown instead of hanging or claiming quiescence', async () => {
    const f = await fixture()
    await f.submit()
    vi.useFakeTimers()
    const stopped = Promise.withResolvers<Error[]>()
    f.stop.mockReturnValue(stopped.promise)
    f.expectShutdownFailure()
    const closing = expect(f.adapter.dispose()).rejects.toMatchObject({ code: 'copilot/shutdown-failed' })
    await vi.advanceTimersByTimeAsync(1_000)
    await closing
    stopped.resolve([])
    await Promise.resolve()
  })

  it('keeps ownership when the SDK reports shutdown errors', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.finished()
    f.stop.mockResolvedValue([new Error('fixture shutdown error')])
    f.expectShutdownFailure()
    const terminal = await f.adapter.observe(f.execution, signal)
    expect(terminal).toMatchObject({ outcome: 'succeeded' })
    const committed = { ...f.execution, status: 'succeeded' as const }
    await expect(f.adapter.release(committed)).rejects.toMatchObject({ code: 'copilot/shutdown-failed' })
    expect(committed.status).toBe('succeeded')
    const { receipt: _receipt, ...admitted } = f.execution
    await expect(f.adapter.create(admitted, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    await expect(f.adapter.dispose()).rejects.toMatchObject({ code: 'copilot/shutdown-failed' })
    f.emit(event('session.error', { message: 'late fixture event', errorType: 'query' }))
  })

  it('releases uncertain acceptance when the send operation deadline expires', async () => {
    const f = await fixture()
    await f.prepare()
    const response = Promise.withResolvers<string>()
    f.send.mockReturnValue(response.promise)
    const sending = expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/acceptance-unknown' })
    await sending
    response.resolve('late-message')
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.stop).toHaveBeenCalledOnce()
  })
})

describe('Copilot external state changes', () => {
  it('does not approve work before this Host has submitted its prompt', async () => {
    const f = await fixture()
    await f.prepare()
    expect(await f.options.onPermissionRequest!({
      kind: 'read', path: f.path, intention: 'fixture',
    }, { sessionId: f.sessionId })).toEqual({ kind: 'no-result' })
  })

  it('does not attribute pre-submission lifecycle events to the current prompt', async () => {
    const f = await fixture()
    await f.prepare()
    f.emit(event('session.start', {
      alreadyInUse: false, sessionId: f.sessionId, version: 1, producer: 'fixture',
      copilotVersion: 'fixture', startTime: '2026-09-09T00:00:00Z',
    }))
    f.emit(event('session.error', { errorType: 'query', message: 'pre-submission fixture event' }))
    f.emit(event('abort', { reason: 'user_initiated' }))
    f.finished('previous-turn')
    f.execution = { ...f.execution, receipt: await f.adapter.submit(f.execution, signal) }
    f.consumed()
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
  })

  it('observes a live root abort even without an idle event', async () => {
    const f = await fixture()
    await f.submit()
    f.emit(event('abort', { reason: 'user_initiated' }))
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects ownership acquired after preparation', async () => {
    const f = await fixture()
    await f.prepare()
    f.emit(event('session.resume', { alreadyInUse: true, eventCount: 1, resumeTime: '2026-09-09T00:00:00Z' }))
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/busy' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('handles cancellation that occurs while an SDK operation is being invoked', async () => {
    const f = await fixture()
    await f.prepare()
    const controller = new AbortController()
    f.activity.mockImplementationOnce(async () => {
      controller.abort()
      return { hasActiveWork: false, abortable: false }
    })
    await expect(f.adapter.submit(f.execution, controller.signal)).rejects.toMatchObject({ code: 'copilot/operation-interrupted' })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('joins permission callbacks before reporting successful disposal', async () => {
    const f = await fixture()
    await f.submit()
    const inspected = Promise.withResolvers<string>()
    f.fileSystem.realpath.mockReturnValueOnce(inspected.promise)
    const permission = f.options.onPermissionRequest!({
      kind: 'read', path: f.path, intention: 'fixture',
    }, { sessionId: f.sessionId })
    let disposed = false
    const closing = f.adapter.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(f.stop).toHaveBeenCalledOnce() })
    await setImmediate()
    expect(disposed).toBe(false)
    inspected.resolve(f.path)
    expect(await permission).toEqual({ kind: 'reject' })
    await closing
  })

  it.each([false, true])('does not let a competing submission close the winner (busy=%s)', async (busy) => {
    const f = await fixture()
    await f.prepare()
    f.activity.mockResolvedValueOnce({ hasActiveWork: false, abortable: false })
    f.activity.mockResolvedValueOnce({ hasActiveWork: busy, abortable: busy })
    const first = f.adapter.submit(f.execution, signal)
    const second = f.adapter.submit(f.execution, signal)
    await expect(second).rejects.toMatchObject({ code: busy ? 'copilot/busy' : 'copilot/acceptance-unknown' })
    await first
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('rejects disappeared discovery folders and incomplete first allocation scans', async () => {
    const f = await fixture()
    f.existing()
    f.inspect.mockResolvedValue({
      complete: true, sessions: new Map([[f.sessionId, { sessionId: f.sessionId, status: 'idle', folder: join(f.root, 'missing') }]]),
    })
    await expect(f.adapter.prepare(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/workspace-mismatch' })
    f.execution = { ...f.execution, createsConnection: true }
    f.inspect.mockResolvedValue({ complete: false, sessions: new Map() })
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/discovery-incomplete' })
  })

  it.each(['identity', 'workspace', 'remote'] as const)('rejects SDK %s disagreement with the reserved connection', async (kind) => {
    const f = await fixture()
    if (kind === 'identity') f.createSession.mockResolvedValue({ ...f.session, sessionId: randomUUID() as AgencyCopilotSessionId })
    else f.snapshot.mockResolvedValue({
      alreadyInUse: false, isRemote: kind === 'remote',
      workingDirectory: kind === 'workspace' ? f.root : f.path, currentMode: 'interactive',
    })

    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({
      code: kind === 'identity' ? 'copilot/identity-mismatch' : 'copilot/workspace-mismatch',
    })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('closes activation when its reported working directory disappears', async () => {
    const f = await fixture()
    f.snapshot.mockResolvedValue({
      alreadyInUse: false, isRemote: false, workingDirectory: join(f.root, 'missing'), currentMode: 'interactive',
    })
    await expect(f.adapter.create(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/activation-failed' })
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('rejects lost Workspaces, absent connections, and mismatched provider settings', async () => {
    const f = await fixture()
    await expect(f.adapter.create({ ...f.execution, workspaceId: 'missing' as WorkspaceId }, signal))
      .rejects.toMatchObject({ code: 'copilot/workspace-missing' })
    const { connection: _connection, ...unconnected } = f.execution
    await expect(f.adapter.create(unconnected, signal)).rejects.toMatchObject({ code: 'copilot/connection-missing' })
    await expect(f.adapter.create({ ...f.execution, executionSettings: { kind: 'dsh' } }, signal))
      .rejects.toMatchObject({ code: 'copilot/settings-mismatch' })
  })

  it('requires the saved receipt and preserves an omitted model selection', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, executionSettings: { kind: 'copilot' } }
    await f.adapter.create(f.execution, signal)
    expect(f.options).not.toHaveProperty('model')
    await expect(f.adapter.submit(f.execution, signal)).rejects.toMatchObject({ code: 'copilot/receipt-missing' })
  })

  it('ignores subagent errors and correlates a later durable page', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.emit(event('session.error', { errorType: 'query', message: 'child failure' }, 'child'))
    f.finished()
    f.read.mockResolvedValueOnce({
      events: [
        event('user.message', { content: 'child', messageId: 'message-1', turnId: 'child' }, 'child'),
        { ...event('assistant.turn_end', { turnId: 'turn-1' }), ephemeral: true },
      ],
      cursor: 'second-page', cursorStatus: 'ok', hasMore: true,
    })
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'succeeded' })
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('distinguishes a durable abort from live idle', async () => {
    const f = await fixture()
    await f.submit()
    f.consumed()
    f.recorded.push(event('abort', { reason: 'user_initiated' }))
    f.finished()
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ outcome: 'cancelled' })
  })

  it('recovers from the beginning only when the durable receipt explicitly uses that cursor', async () => {
    const f = await fixture()
    f.execution = { ...f.execution, receipt: { kind: 'copilot', afterCursor: null, messageId: 'message-1' } }
    expect(await f.adapter.observe(f.execution, signal)).toMatchObject({ error: { code: 'copilot/recovery-unknown' } })
    expect(f.persisted).toHaveBeenCalledWith({ sessionId: f.sessionId, max: 50 })
  })

  it('rejects filesystem inspection failures rather than broadening permissions', async () => {
    const f = await fixture()
    await f.submit()
    const read: PermissionRequest = { kind: 'read', path: join(f.path, 'file'), intention: 'fixture' }
    for (const error of [new Error('fixture filesystem failure'), Object.assign(new Error('fixture'), { code: 'EACCES' }), undefined]) {
      f.fileSystem.realpath.mockRejectedValueOnce(error)
      expect(await f.options.onPermissionRequest!(read, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
    }
    f.fileSystem.realpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    f.fileSystem.lstat.mockRejectedValueOnce(new Error('fixture stat failure'))
    expect(await f.options.onPermissionRequest!(read, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
    expect(await f.options.onPermissionRequest!({ ...read, path: '.' }, { sessionId: f.sessionId })).toEqual({ kind: 'approve-once' })
    await f.adapter.dispose()
    expect(await f.options.onPermissionRequest!(read, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
  })

  it('denies access when no filesystem ancestor remains resolvable', async () => {
    const f = await fixture()
    await f.submit()
    const missing = Object.assign(new Error('fixture missing volume'), { code: 'ENOENT' })
    f.fileSystem.realpath.mockRejectedValue(missing)
    f.fileSystem.lstat.mockRejectedValue(missing)
    expect(await f.options.onPermissionRequest!({
      kind: 'read', path: f.path, intention: 'fixture',
    }, { sessionId: f.sessionId })).toEqual({ kind: 'reject' })
  })

  it('checks each supported full-access permission kind and denies unsupported hooks', async () => {
    const f = await fixture('full-access')
    await f.submit()
    const requests: PermissionRequest[] = [
      {
        kind: 'shell', fullCommandText: 'echo fixture', intention: 'fixture', commands: [],
        canOfferSessionApproval: false, hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [],
      },
      { kind: 'url', url: 'https://example.invalid', intention: 'fixture' },
      { kind: 'mcp', readOnly: true, serverName: 'fixture', toolName: 'fixture', toolTitle: 'fixture' },
      { kind: 'custom-tool', toolName: 'fixture', toolDescription: 'fixture' },
      { kind: 'memory', fact: 'fixture' },
    ]
    for (const request of requests) {
      expect(await f.options.onPermissionRequest!(request, { sessionId: f.sessionId })).toEqual({ kind: 'approve-once' })
    }
    expect(await f.options.onPermissionRequest!({ kind: 'hook', toolName: 'fixture' }, { sessionId: f.sessionId }))
      .toEqual({ kind: 'reject' })
  })
})
