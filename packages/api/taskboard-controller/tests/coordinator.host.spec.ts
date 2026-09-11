import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import TaskboardService, {
  AgencyCopilotSessionId, createTaskboardOwnershipCapability, currentTaskRecord, nextTaskScheduleRun, TaskRunRequestId,
} from '@deepseek-ai/dsh-taskboard'
import type {
  TaskConnection, TaskExecution, TaskExecutionReceipt, TaskboardTask, TaskboardCreateInput,
} from '@deepseek-ai/dsh-taskboard/types'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type { TaskboardRunRequest } from '../src/types.ts'
import type { TaskboardSettings } from '../src/runtime-types.ts'
import type { TaskConversationObservation, TaskExecutionAdapter, TaskExecutionObservation } from '../src/runtime/adapter.ts'
import {
  TaskboardCoordinator,
  type TaskboardCoordinatorClock,
  type TaskboardCoordinatorDependencies,
} from '../src/runtime/coordinator.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  try {
    await drain(cleanups.splice(0).reverse())
  } finally {
    vi.restoreAllMocks()
  }
})

async function drain(callbacks: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const failures: unknown[] = []
  for (const cleanup of callbacks) {
    try {
      await cleanup()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Fixture cleanup failed')
}

function deferred() {
  const value = Promise.withResolvers<undefined>()
  cleanups.push(async () => { value.resolve(undefined) })
  return { promise: value.promise, resolve: () => { value.resolve(undefined) } }
}

class Clock implements TaskboardCoordinatorClock {
  instant = new Date()
  readonly timers = new Map<number, { callback: () => void; intervalMs: number }>()
  private next = 0
  now(): Date { return new Date(this.instant) }
  every(callback: () => void, intervalMs: number): () => void {
    const id = this.next++
    this.timers.set(id, { callback, intervalMs })
    return () => { this.timers.delete(id) }
  }
  set(value: string): void { this.instant = new Date(value) }
  fire(intervalMs: number): void {
    for (const timer of this.timers.values()) if (timer.intervalMs === intervalMs) timer.callback()
  }
}

function receipt(execution: TaskExecution, messageId?: string): TaskExecutionReceipt {
  return execution.executionSettings.kind === 'dsh'
    ? { kind: 'dsh', afterSequence: 0, ...(messageId === undefined ? {} : { messageId }) }
    : { kind: 'copilot', afterCursor: null, ...(messageId === undefined ? {} : { messageId }) }
}

async function harness(options: { history?: number; start?: boolean; systemClock?: boolean } = {}) {
  const directory = await mkdtemp(join(process.cwd(), '.taskboard-coordinator-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  const pool = new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  cleanups.push(() => backend.close())
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  ctx.storage.backend.register('fixture', backend)
  const facility = new DomainFacility(ctx, { backend: 'fixture', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceJsonl, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  const workspace = await ctx.workspaceRegistry.create(directory)
  const provisionSession = async (id: SessionId) => {
    if (ctx.sessions.get(id) === undefined) ctx.sessions.create(id, { meta: { cwd: directory } })
    await workspace.attachSession(id)
  }
  await ctx.plugin(TaskboardService, { executionHistoryLimit: options.history ?? 20 })
  const clock = new Clock()
  const observations = new Map<TaskExecution['id'], TaskExecutionObservation>()
  const external = {
    attention: vi.fn<NonNullable<TaskExecutionAdapter['attention']>>(() => undefined),
    validateConnection: vi.fn<TaskExecutionAdapter['validateConnection']>(async () => {}),
    create: vi.fn<TaskExecutionAdapter['create']>(async (execution) => {
      if (execution.connection?.kind === 'dsh') await provisionSession(execution.connection.sessionId)
    }),
    prepare: vi.fn<TaskExecutionAdapter['prepare']>(async execution => receipt(execution)),
    submit: vi.fn<TaskExecutionAdapter['submit']>(async execution => receipt(execution, `message:${execution.id}`)),
    observe: vi.fn<TaskExecutionAdapter['observe']>(async execution => observations.get(execution.id) ?? { state: 'running' }),
    dispose: vi.fn<TaskExecutionAdapter['dispose']>(async () => {}),
  }
  const copilotRelease = vi.fn<NonNullable<TaskExecutionAdapter['release']>>(async (execution) => {
    observations.delete(execution.id)
  })
  const copilotDispose = vi.fn<TaskExecutionAdapter['dispose']>(async () => { observations.clear() })
  const copilot: TaskExecutionAdapter = { ...external, release: copilotRelease, dispose: copilotDispose }
  const settings: TaskboardSettings & { enabled: boolean; announceToAgent: boolean; preventIdleSleep: boolean } = {
    enabled: true, announceToAgent: false, preventIdleSleep: false,
  }
  const ownership = { held: true, error: new Error('ownership lost') }
  const authority = createTaskboardOwnershipCapability(ctx.taskboard, async () => {
    if (!ownership.held) throw ownership.error
  })
  await authority.refresh()
  const errors: unknown[] = []
  let allocated = 0
  const dependencies: TaskboardCoordinatorDependencies = {
    tasks: ctx.taskboard, adapters: { dsh: external, copilot }, settings: () => settings,
    assertOwned: vi.fn(async () => { if (!ownership.held) throw ownership.error }),
    advanceConversation: vi.fn(authority.advanceConversation),
    resolveSettings: vi.fn<TaskboardCoordinatorDependencies['resolveSettings']>(async task => task.executionSettings),
    allocateConnection: vi.fn<TaskboardCoordinatorDependencies['allocateConnection']>(selection => selection.kind === 'dsh'
      ? { kind: 'dsh', sessionId: SessionId(`allocated-${++allocated}`) }
      : { kind: 'copilot', sessionId: AgencyCopilotSessionId(randomUUID()) }),
    nextOccurrence: (cron, timeZone, after) => nextTaskScheduleRun({ cron, timeZone }, after.toISOString()),
    workspaceExists: task => ctx.workspaceRegistry.get(task.workspaceId) !== undefined,
    changed: vi.fn(),
    reportError: vi.fn((error) => { errors.push(error) }),
  }
  const coordinator = new TaskboardCoordinator({
    pollIntervalMs: 100, schedulerIntervalMs: 200, schedulerRecoveryGapMs: 120_000, operationTimeoutMs: 60_000,
  }, dependencies, options.systemClock ? undefined : clock)
  ctx.on('domain/changed', (change) => {
    if (change.domain === 'taskboard') coordinator.tasksChanged()
  })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await coordinator.dispose()
  }
  cleanups.push(close)
  const create = (input: Partial<TaskboardCreateInput> = {}) => ctx.taskboard.create({
    workspaceId: workspace.id, title: 'Task', ...input,
  })
  if (options.start !== false) await coordinator.start()
  return { ctx, board: ctx.taskboard, workspace, pool, facility, clock, external, observations, dependencies,
    coordinator, create, close, settings, ownership, errors, copilotDispose, copilotRelease, provisionSession }
}

function request(task: TaskboardTask, id = 'manual'): TaskboardRunRequest {
  return { taskId: task.id, expectedRevision: task.revision, requestId: TaskRunRequestId(id) }
}

async function connected(test: Awaited<ReturnType<typeof harness>>) {
  const connection: TaskConnection = { kind: 'dsh', sessionId: SessionId('connected') }
  await test.provisionSession(connection.sessionId)
  return connection
}

async function pending(
  test: Awaited<ReturnType<typeof harness>>, task: TaskboardTask, stage: 'none' | 'prepared' | 'running' = 'prepared',
) {
  const connection = task.connection ?? await connected(test)
  const opened = await test.board.beginExecution({
    ...request(task), trigger: 'manual', executionSettings: task.executionSettings, proposedConnection: connection,
  })
  let latest = opened.task
  if (stage !== 'none') {
    const execution = latest.executions[0]!
    latest = await test.board.attachExecution({
      taskId: task.id, executionId: opened.executionId, connection, receipt: receipt(execution),
    })
  }
  if (stage === 'running') latest = await test.board.advanceExecution({ taskId: task.id, executionId: opened.executionId })
  return { ...opened, task: latest, execution: latest.executions[0]! }
}

async function seedRecord(
  test: Awaited<ReturnType<typeof harness>>,
  taskId: TaskboardTask['id'],
  change: (record: ReturnType<typeof currentTaskRecord.parse>) => unknown,
) {
  const table = test.facility.get('taskboard')!.table('tasks')
  await table.put(taskId, change(currentTaskRecord.parse(table.get(taskId))))
}

describe('linked conversation attention', () => {
  it.each(['never run', 'already completed'] as const)(
    'moves a %s task through human input and exact chat completion without changing attempts',
    async (history) => {
      const test = await harness()
      const task = await test.create({ connection: await connected(test) })
      if (history === 'already completed') {
        const run = await test.coordinator.run(request(task), new AbortController().signal)
        test.observations.set(run.executionId, { state: 'settled', outcome: 'succeeded' })
        await test.coordinator.poll()
      }
      const before = test.board.get(task.id)!
      let observation: TaskConversationObservation = { state: 'waiting' }
      const observe = vi.fn(async () => observation)
      test.external.attention.mockImplementation(connection => connection.sessionId === task.connection!.sessionId
        && observation.state === 'waiting' ? { observe } : undefined)
      test.settings.enabled = false
      const unlinked = await test.create({ title: 'No conversation' })
      const archived = await test.create({ title: 'Archived', connection: task.connection! })
      await test.board.archive(archived.id, archived.revision)
      const archivedBefore = test.board.get(archived.id)
      await test.coordinator.poll()
      const waiting = test.board.get(task.id)!
      expect(waiting).toMatchObject({ status: 'in_review', connection: before.connection, executions: before.executions })
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toEqual(waiting)
      observation = { state: 'running' }
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toMatchObject({ status: 'in_progress', executions: before.executions })
      observation = { state: 'settled', outcome: 'succeeded' }
      await test.coordinator.poll()
      const completed = test.board.get(task.id)!
      expect(completed).toMatchObject({ status: 'done', executions: before.executions })
      const manual = await test.board.move({ taskId: task.id, expectedRevision: completed.revision, status: 'backlog' })
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toEqual(manual)
      expect(test.board.get(unlinked.id)).toEqual(unlinked)
      expect(test.board.get(archived.id)).toEqual(archivedBefore)
      expect(test.external.submit).toHaveBeenCalledTimes(history === 'already completed' ? 1 : 0)
      expect(test.errors).toEqual([])
    },
  )

  it.each(['failed', 'cancelled'] as const)('leaves a manually continued %s chat in review', async (outcome) => {
    const test = await harness()
    const task = await test.create({ connection: await connected(test) })
    let observation: TaskConversationObservation = { state: 'waiting' }
    const observe = vi.fn(async () => observation)
    test.external.attention.mockReturnValueOnce({ observe })
    await test.coordinator.poll()
    observation = { state: 'settled', outcome }
    await test.coordinator.poll()
    const final = test.board.get(task.id)!
    expect(final).toMatchObject({ status: 'in_review', executions: [] })
    await test.coordinator.poll()
    expect(observe).toHaveBeenCalledTimes(2)
    expect(test.board.get(task.id)).toEqual(final)
  })

  it('retains monitoring across read and write failures until the column is committed', async () => {
    const test = await harness()
    const task = await test.create({ connection: await connected(test) })
    let observation: TaskConversationObservation = { state: 'waiting' }
    const observe = vi.fn(async () => observation).mockRejectedValueOnce(new Error('question inspection failed'))
    test.external.attention.mockReturnValueOnce({ observe })
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(task)
    test.pool.failNextWrites = 1
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(task)
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.status).toBe('in_review')
    observation = { state: 'settled', outcome: 'succeeded' }
    test.pool.failNextWrites = 1
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.status).toBe('in_review')
    await test.coordinator.poll()
    const final = test.board.get(task.id)!
    expect(final).toMatchObject({ status: 'done', executions: [] })
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(final)
    expect(test.errors.map(error => (error as Error).message)).toEqual([
      'question inspection failed', 'injected write failure', 'injected write failure',
    ])
  })

  it.each(['disconnect-reconnect', 'archive', 'delete', 'run'] as const)(
    'discards an in-flight chat observation across %s',
    async (change) => {
      const test = await harness()
      const task = await test.create({ connection: await connected(test) })
      const entered = deferred()
      const release = deferred()
      const observe = vi.fn(async () => {
        entered.resolve()
        await release.promise
        return { state: 'settled', outcome: 'succeeded' } as const
      })
      test.external.attention.mockReturnValueOnce({ observe })
      const polling = test.coordinator.poll()
      try {
        await entered.promise
        if (change === 'disconnect-reconnect') {
          const disconnected = await test.board.disconnect(task.id, task.revision)
          await test.board.connect({ taskId: task.id, expectedRevision: disconnected.revision, connection: task.connection! })
        } else if (change === 'archive') {
          await test.board.archive(task.id, task.revision)
        } else if (change === 'delete') {
          await test.board.delete(task.id, task.revision)
        } else {
          await test.coordinator.run(request(task), new AbortController().signal)
        }
        const changed = test.board.get(task.id)
        release.resolve()
        await polling
        await test.coordinator.poll()
        expect(test.board.get(task.id)).toEqual(changed)
        expect(test.dependencies.advanceConversation).not.toHaveBeenCalled()
        expect(observe).toHaveBeenCalledOnce()
      } finally {
        release.resolve()
        await polling
      }
    },
  )

  it('does not apply an observation after losing ownership', async () => {
    const test = await harness()
    const task = await test.create({ connection: await connected(test) })
    const observe = vi.fn(async () => {
      test.ownership.held = false
      return { state: 'waiting' } as const
    })
    test.external.attention.mockReturnValueOnce({ observe })
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(task)
    expect(test.dependencies.advanceConversation).not.toHaveBeenCalled()
    expect(test.errors).toEqual([test.ownership.error])
  })

  it('drains borrowed inspection during shutdown without publishing its result', async () => {
    const test = await harness()
    const task = await test.create({ connection: await connected(test) })
    const entered = deferred()
    const release = deferred()
    test.external.attention.mockReturnValueOnce({
      observe: async (signal) => {
        entered.resolve()
        await release.promise
        signal.throwIfAborted()
        return { state: 'waiting' }
      },
    })
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    const polling = test.coordinator.poll()
    await entered.promise
    await test.close()
    await polling
    expect(test.board.get(task.id)).toEqual(task)
    expect(test.dependencies.advanceConversation).not.toHaveBeenCalled()
    expect(test.errors).toEqual([])
  })

  it('retains a chat monitor while an uncommitted Run admission is rejected', async () => {
    const test = await harness()
    const task = await test.create({ connection: await connected(test) })
    let observation: TaskConversationObservation = { state: 'waiting' }
    const observe = vi.fn(async () => observation)
    test.external.attention.mockReturnValueOnce({ observe })
    await test.coordinator.poll()
    const waiting = test.board.get(task.id)!
    const entered = deferred()
    const release = deferred()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('run settings unavailable')
    })
    const running = test.coordinator.run(request(waiting), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow('run settings unavailable')
    try {
      await entered.promise
      observation = { state: 'running' }
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toEqual(waiting)
      release.resolve()
      await rejected
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toMatchObject({ status: 'in_progress', executions: [] })
      observation = { state: 'settled', outcome: 'succeeded' }
      await test.coordinator.poll()
      expect(test.board.get(task.id)).toMatchObject({ status: 'done', executions: [] })
    } finally {
      release.resolve()
      await rejected
    }
  })
})

describe('Taskboard coordinator admission', () => {
  it('rejects an uninitialized runtime and a deleted task before allocating a conversation', async () => {
    const test = await harness({ start: false })
    const task = await test.create()
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('not initialized')
    await test.coordinator.start()
    await test.board.delete(task.id, task.revision)
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('not found')
    expect(test.dependencies.allocateConnection).not.toHaveBeenCalled()
  })

  it('deduplicates simultaneous retries before provisioning either proposed identity twice', async () => {
    const test = await harness()
    const task = await test.create()
    const results = await Promise.all([
      test.coordinator.run(request(task), new AbortController().signal),
      test.coordinator.run(request(task), new AbortController().signal),
    ])
    expect(results[0]?.executionId).toBe(results[1]?.executionId)
    expect(test.board.get(task.id)?.executions).toHaveLength(1)
    expect(test.external.create).toHaveBeenCalledOnce()
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it.each(['create', 'submit'] as const)('waits for an existing %s acknowledgement before resolving durable replay', async (stage) => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    if (stage === 'create') {
      test.external.create.mockImplementationOnce(async (execution) => {
        entered.resolve()
        await release.promise
        await test.provisionSession((execution.connection as Extract<TaskConnection, { kind: 'dsh' }>).sessionId)
      })
    } else {
      test.external.submit.mockImplementationOnce(async (execution) => {
        entered.resolve()
        await release.promise
        return receipt(execution, 'accepted')
      })
    }
    const original = test.coordinator.run(request(task), new AbortController().signal)
    await entered.promise
    const acknowledged = vi.fn()
    const retry = test.coordinator.run(request(task), new AbortController().signal).then((value) => {
      acknowledged()
      return value
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(acknowledged).not.toHaveBeenCalled()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('pending')
    release.resolve()
    const [first, replay] = await Promise.all([original, retry])
    expect(replay).toEqual(first)
    expect(replay.task.executions[0]?.status).toBe('running')
    expect(test.external.create).toHaveBeenCalledOnce()
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('joins a local dispatch discovered after option resolution and returns its fresh task', async () => {
    const test = await harness()
    const task = await test.create()
    const resolving = deferred()
    const resolved = deferred()
    const creating = deferred()
    const created = deferred()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      resolving.resolve()
      await resolved.promise
      return current.executionSettings
    })
    test.external.create.mockImplementationOnce(async (execution) => {
      creating.resolve()
      await created.promise
      await test.provisionSession((execution.connection as Extract<TaskConnection, { kind: 'dsh' }>).sessionId)
    })
    const acknowledged = vi.fn()
    const original = test.coordinator.run(request(task), new AbortController().signal).then((value) => {
      acknowledged()
      return value
    })
    await resolving.promise
    const retry = test.coordinator.run(request(task), new AbortController().signal)
    await creating.promise
    resolved.resolve()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(acknowledged).not.toHaveBeenCalled()
    created.resolve()
    const [first, replay] = await Promise.all([original, retry])
    expect(first).toEqual(replay)
    expect(first.task.executions[0]?.status).toBe('running')
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('propagates the existing dispatch rejection to its concurrent durable replay', async () => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    const error = new Error('provisioning unavailable')
    test.external.create.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw error
    })
    const original = test.coordinator.run(request(task), new AbortController().signal)
    const firstFailure = expect(original).rejects.toBe(error)
    await entered.promise
    const retry = test.coordinator.run(request(task), new AbortController().signal)
    const retryFailure = expect(retry).rejects.toBe(error)
    release.resolve()
    await Promise.all([firstFailure, retryFailure])
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('failed')
    expect(test.external.create).toHaveBeenCalledOnce()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('finds a concurrent durable replay before allocating after option resolution', async () => {
    const test = await harness()
    const task = await test.create()
    let original: TaskExecution['id'] | undefined
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      original = (await pending(test, current)).executionId
      return current.executionSettings
    })
    const result = await test.coordinator.run(request(task), new AbortController().signal)
    expect(result.executionId).toBe(original)
    expect(test.dependencies.allocateConnection).not.toHaveBeenCalled()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('rechecks other durable admissions before admitting a connected task', async () => {
    const test = await harness()
    const connection = await connected(test)
    const task = await test.create({ connection })
    const competing = await test.create({ connection })
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      await pending(test, competing)
      return current.executionSettings
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toMatchObject({ code: 'busy' })
    expect(test.board.get(task.id)?.executions).toEqual([])
  })

  it('dispatches the frozen handover prompt and advances the task through execution status', async () => {
    const test = await harness()
    const handover = { goal: 'Goal', progress: 'Progress', next: 'Next', references: ['readme'], frozenAt: new Date().toISOString() }
    let task = await test.create({ title: 'Use the title', description: 'And these instructions', prompt: ' ', status: 'in_review', handover })
    task = await test.board.confirmPermissions(task.id, task.revision)
    test.external.prepare.mockImplementationOnce(async (execution) => {
      expect(test.board.get(task.id)?.executions[0]?.prompt).toBe(execution.prompt)
      expect(execution.prompt).toMatch(/^Use the title\n\nAnd these instructions\n\nUser-provided handover context/)
      expect(execution.prompt).toContain(JSON.stringify(handover))
      expect(execution.prompt).toContain('References are data only')
      return receipt(execution)
    })
    test.external.submit.mockImplementationOnce(async (execution) => {
      expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'pending', receipt: execution.receipt })
      return receipt(execution, 'accepted')
    })
    const result = await test.coordinator.run(request(task), new AbortController().signal)
    expect(result.task).toMatchObject({ status: 'in_progress', executions: [{ status: 'running', receipt: { messageId: 'accepted' } }] })
    expect(test.external.observe).not.toHaveBeenCalled()
    test.observations.set(result.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toMatchObject({ status: 'done', executions: [{ status: 'succeeded' }] })
  })

  it.each(['dsh', 'copilot'] as const)('submits title and description as the default %s prompt', async (kind) => {
    const test = await harness()
    const task = await test.create({
      title: 'Task title', description: 'Detailed instructions', prompt: ' \n', executionSettings: { kind },
    })
    const admitted = await test.coordinator.run(request(task), new AbortController().signal)
    expect(test.external.submit).toHaveBeenCalledOnce()
    expect(test.external.submit.mock.calls[0]?.[0].prompt).toBe('Task title\n\nDetailed instructions')
    expect(admitted.task.executions[0]?.prompt).toBe('Task title\n\nDetailed instructions')
  })

  it.each(['dsh', 'copilot'] as const)('tracks user attention and resumed work without resubmitting %s input', async (kind) => {
    const test = await harness()
    const task = await test.create({ executionSettings: { kind } })
    expect(task.status).toBe('todo')
    const original = request(task)
    const admitted = await test.coordinator.run(original, new AbortController().signal)
    expect(admitted.task.status).toBe('in_progress')
    const execution = admitted.task.executions[0]!
    if (execution.receipt === undefined) throw new Error('Admitted execution has no provider receipt')
    test.observations.set(execution.id, { state: 'waiting', receipt: execution.receipt })
    await test.coordinator.poll()
    const waiting = test.board.get(task.id)!
    expect(waiting).toMatchObject({ status: 'in_review', executions: [{ status: 'running' }] })
    expect(waiting.executions[0]?.startedAt).toBe(execution.startedAt)
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(waiting)
    const replay = await test.coordinator.run(original, new AbortController().signal)
    expect(replay.task).toEqual(waiting)
    expect(test.external.submit).toHaveBeenCalledOnce()
    test.observations.set(execution.id, { state: 'running' })
    await test.coordinator.poll()
    const resumed = test.board.get(task.id)!
    expect(resumed.status).toBe('in_progress')
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toEqual(resumed)
    test.observations.set(execution.id, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toMatchObject({ status: 'done', executions: [{ status: 'succeeded' }] })
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('replays a pruned attempt before consulting changed choices, capabilities, or enabled state', async () => {
    const test = await harness({ history: 1 })
    const original = request(await test.create(), 'first')
    const first = await test.coordinator.run(original, new AbortController().signal)
    test.observations.set(first.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    const second = await test.coordinator.run(request(test.board.get(original.taskId)!, 'second'), new AbortController().signal)
    test.observations.set(second.executionId, { state: 'settled', outcome: 'cancelled' })
    await test.coordinator.poll()
    let current = test.board.get(original.taskId)!
    current = await test.board.update({
      taskId: current.id, expectedRevision: current.revision,       patch: { title: 'Edited', executionSettings: { kind: 'dsh', model: { provider: 'changed', model: 'different' } } },
    })
    expect(current.executions).toHaveLength(1)
    test.settings.enabled = false
    vi.mocked(test.dependencies.resolveSettings).mockRejectedValue(new Error('capability removed'))
    await expect(test.coordinator.run(original, new AbortController().signal)).resolves.toEqual({
      task: current, executionId: first.executionId,
    })
    expect(test.dependencies.allocateConnection).toHaveBeenCalledOnce()
    expect(test.external.create).toHaveBeenCalledOnce()
    expect(test.external.submit).toHaveBeenCalledTimes(2)
    await expect(test.coordinator.run({ ...original, expectedRevision: original.expectedRevision + 1 }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'request-conflict' })
  })

  it.each(['cas', 'durability'] as const)('does not dispatch after %s admission rejection', async (failure) => {
    const test = await harness()
    const task = await test.create()
    if (failure === 'durability') test.pool.failNextWrites = 1
    else await test.board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Edited' } })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow()
    expect(test.board.get(task.id)?.executions).toEqual([])
    expect(test.external.create).not.toHaveBeenCalled()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('honors caller cancellation before admission but not after the durable attempt exists', async () => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    const controller = new AbortController()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      entered.resolve(); await release.promise; return current.executionSettings
    })
    const running = test.coordinator.run(request(task), controller.signal)
    const rejected = expect(running).rejects.toThrow('caller cancelled')
    await entered.promise
    controller.abort(new Error('caller cancelled'))
    release.resolve()
    await rejected
    expect(test.board.get(task.id)?.executions).toEqual([])
    const after = new AbortController()
    test.external.prepare.mockImplementationOnce(async (execution, signal) => {
      after.abort(new Error('transport disconnected'))
      expect(signal.aborted).toBe(false)
      return receipt(execution)
    })
    await expect(test.coordinator.run(request(task), after.signal)).resolves.toMatchObject({
      task: { executions: [{ status: 'running' }] },
    })
  })

  it.each(['disabled', 'ownership'] as const)('fences %s while settings resolution is awaiting', async (failure) => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      entered.resolve(); await release.promise; return current.executionSettings
    })
    const running = test.coordinator.run(request(task), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow()
    await entered.promise
    if (failure === 'disabled') { test.settings.enabled = false; test.coordinator.settingsChanged() }
    else test.ownership.held = false
    release.resolve()
    await rejected
    expect(test.board.get(task.id)?.executions).toEqual([])
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'ownership'] as const)('never submits after %s during preparation', async (failure) => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      entered.resolve(); await release.promise; return receipt(execution)
    })
    const running = test.coordinator.run(request(task), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow()
    await entered.promise
    if (failure === 'disabled') { test.settings.enabled = false; test.coordinator.settingsChanged() }
    else test.ownership.held = false
    release.resolve()
    await rejected
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe(failure === 'disabled' ? 'failed' : 'pending')
  })

  it('does not submit when committing preparation fails', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      test.pool.failNextWrites = 1
      return receipt(execution)
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('injected write failure')
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'failed', error: { code: 'dispatch-failed' } })
  })

  it('preserves an independently settled outcome when preparation subsequently fails', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      await test.board.settleExecution({
        taskId: task.id, executionId: execution.id, status: 'failed', error: { code: 'original', message: 'Recorded failure' },
      })
      throw new Error('late preparation failure')
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('late preparation failure')
    expect(test.board.get(task.id)?.executions[0]?.error).toEqual({ code: 'original', message: 'Recorded failure' })
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('refuses a pruned in-flight attempt without reconstructing or resending it', async () => {
    const test = await harness({ history: 1 })
    const task = await test.create()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      const settled = await test.board.settleExecution({ taskId: task.id, executionId: execution.id, status: 'failed' })
      const other = await test.board.beginExecution({
        ...request(settled, 'other'), trigger: 'manual', executionSettings: settled.executionSettings,
      })
      await test.board.settleExecution({ taskId: task.id, executionId: other.executionId, status: 'failed' })
      throw new Error('old preparation failed')
    })
    const failure: unknown = await test.coordinator.run(request(task), new AbortController().signal)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('Expected both dispatch and missing-history errors')
    const messages = (failure.errors as unknown[]).map(String)
    expect(messages[0]).toBe('Error: old preparation failed')
    expect(messages[1]).toContain('unavailable')
    expect(test.board.get(task.id)?.executions).toHaveLength(1)
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('records non-Error provider rejections without misreporting successful dispatch', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.prepare.mockRejectedValueOnce('provider rejected')
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toBe('provider rejected')
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({
      status: 'failed', error: { code: 'dispatch-failed', message: 'provider rejected' },
    })
  })

  it.each(['disabled', 'ownership'] as const)('checks %s after the preparation receipt commits', async (failure) => {
    const test = await harness()
    const task = await test.create()
    test.ctx.on('domain/changed', (change) => {
      if (change.domain !== 'taskboard') return
      const execution = test.board.get(task.id)?.executions[0]
      if (execution?.status !== 'pending' || execution.receipt === undefined) return
      if (failure === 'disabled') {
        test.settings.enabled = false
        test.coordinator.settingsChanged()
      } else test.ownership.held = false
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow()
    const execution = test.board.get(task.id)?.executions[0]
    expect(execution?.receipt).toEqual({ kind: 'dsh', afterSequence: 0 })
    expect(execution?.status).toBe(failure === 'disabled' ? 'failed' : 'pending')
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('submits the admitted prompt when planning text changes during preparation', async () => {
    const test = await harness()
    const task = await test.create({ title: 'Original prompt' })
    test.external.prepare.mockImplementationOnce(async (execution) => {
      const current = test.board.get(task.id)!
      await test.board.update({ taskId: task.id, expectedRevision: current.revision, patch: { title: 'New planning title' } })
      return receipt(execution)
    })
    const result = await test.coordinator.run(request(task), new AbortController().signal)
    expect(result.task.title).toBe('New planning title')
    expect(test.external.submit.mock.calls[0]?.[0].prompt).toBe('Original prompt')
  })

  it('retains the enablement fence across a disable and re-enable while preparing', async () => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      entered.resolve()
      await release.promise
      return receipt(execution)
    })
    const running = test.coordinator.run(request(task), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow('enablement changed')
    await entered.promise
    test.settings.enabled = false
    test.coordinator.settingsChanged()
    test.settings.enabled = true
    test.coordinator.settingsChanged()
    release.resolve()
    await rejected
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('failed')
  })

  it('checks ownership again after provisioning and before preparing', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.create.mockImplementationOnce(async (execution) => {
      if (execution.connection?.kind === 'dsh') await test.provisionSession(execution.connection.sessionId)
      test.ownership.held = false
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow()
    expect(test.external.prepare).not.toHaveBeenCalled()
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('pending')
  })

  it('does not advance accepted work when its acknowledgement cannot be persisted', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.submit.mockImplementationOnce(async (execution) => {
      test.pool.failNextWrites = 1
      return receipt(execution, 'durably-accepted')
    })
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('injected write failure')
    const execution = test.board.get(task.id)!.executions[0]!
    expect(execution).toMatchObject({ status: 'pending', error: { code: 'dispatch-uncertain' } })
    test.observations.set(execution.id, { state: 'running', receipt: receipt(execution, 'durably-accepted') })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({
      status: 'running', receipt: { messageId: 'durably-accepted' },
    })
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('persists uncertain submission diagnostics until exact observation supplies the outcome', async () => {
    const test = await harness()
    const task = await test.create()
    test.external.submit.mockRejectedValueOnce(new Error('acknowledgement lost'))
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('acknowledgement lost')
    let execution = test.board.get(task.id)!.executions[0]!
    expect(execution).toMatchObject({ status: 'pending', error: { code: 'dispatch-uncertain', message: 'acknowledgement lost' } })
    test.observations.set(execution.id, { state: 'pending', receipt: receipt(execution, 'found') })
    await test.coordinator.poll()
    execution = test.board.get(task.id)!.executions[0]!
    expect(execution).toMatchObject({ status: 'pending', receipt: { messageId: 'found' }, error: { code: 'dispatch-uncertain' } })
    expect(execution.startedAt).toBeUndefined()
    test.observations.set(execution.id, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'succeeded' })
    expect(test.board.get(task.id)?.executions[0]?.error).toBeUndefined()
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('excludes cross-task admissions during an awaiting preparation without queueing', async () => {
    const test = await harness()
    const connection = await connected(test)
    const first = await test.create({ connection })
    const second = await test.create({ connection })
    const entered = deferred()
    const release = deferred()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      entered.resolve(); await release.promise; return receipt(execution)
    })
    const running = test.coordinator.run(request(first), new AbortController().signal)
    await entered.promise
    await expect(test.coordinator.run(request(second), new AbortController().signal)).rejects.toMatchObject({ code: 'busy' })
    expect(test.board.get(second.id)?.executions).toEqual([])
    release.resolve()
    await running
  })

  it.each(['dsh', 'copilot'] as const)('rejects externally busy %s connections before admitting work', async (kind) => {
    const test = await harness()
    const connection: TaskConnection = kind === 'dsh' ? await connected(test)
      : { kind: 'copilot', sessionId: AgencyCopilotSessionId(randomUUID()) }
    const task = await test.create({ connection, executionSettings: { kind } })
    test.external.validateConnection.mockRejectedValueOnce(new Error('external conversation busy'))
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('external conversation busy')
    expect(test.board.get(task.id)?.executions).toEqual([])
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('does not mistake an admission publication callback for interrupted startup work', async () => {
    const test = await harness()
    const task = await test.create()
    const polls: Promise<void>[] = []
    test.ctx.on('domain/changed', (change) => {
      if (change.domain === 'taskboard') polls.push(test.coordinator.poll())
    })
    await test.coordinator.run(request(task), new AbortController().signal)
    await Promise.all(polls)
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('running')
    expect(test.external.submit).toHaveBeenCalledOnce()
  })
})

describe('Taskboard coordinator recovery and shutdown', () => {
  it('disposes remaining fixture resources after an earlier cleanup failure', async () => {
    const closed: string[] = []
    await expect(drain([
      async () => { closed.push('coordinator'); throw new Error('close failed') },
      async () => { closed.push('context') },
      async () => { closed.push('directory') },
    ])).rejects.toThrow('Fixture cleanup failed')
    expect(closed).toEqual(['coordinator', 'context', 'directory'])
  })

  it('coalesces timer-driven observation with explicit polls', async () => {
    const test = await harness()
    const opened = await pending(test, await test.create())
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'succeeded' })
    test.clock.fire(100)
    const first = test.coordinator.poll()
    expect(test.coordinator.poll()).toBe(first)
    await first
    expect(test.board.get(opened.task.id)?.executions[0]?.status).toBe('succeeded')
    expect(test.external.observe).toHaveBeenCalledOnce()
  })

  it('does not observe a snapshot that another operation settled while ownership was checked', async () => {
    const test = await harness()
    const opened = await pending(test, await test.create())
    vi.mocked(test.dependencies.assertOwned).mockImplementationOnce(async () => {
      await test.board.settleExecution({ taskId: opened.task.id, executionId: opened.executionId, status: 'cancelled' })
    })
    await test.coordinator.poll()
    expect(test.external.observe).not.toHaveBeenCalled()
    expect(test.board.get(opened.task.id)?.executions[0]?.status).toBe('cancelled')
  })

  it('ignores unrelated incomplete connection records during admission and later fails them explicitly', async () => {
    const test = await harness()
    const old = await pending(test, await test.create(), 'none')
    await seedRecord(test, old.task.id, record => ({
      ...record, connection: undefined,
      executions: record.executions.map(execution => ({ ...execution, connection: undefined, createsConnection: false })),
    }))
    const task = await test.create()
    await test.coordinator.run(request(task), new AbortController().signal)
    await test.coordinator.poll()
    expect(test.board.get(old.task.id)?.executions[0]).toMatchObject({
      status: 'failed', error: { code: 'dispatch-interrupted' },
    })
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('fails receipt-less startup attempts without creating or resending', async () => {
    const test = await harness({ start: false })
    const task = await test.create()
    await pending(test, task, 'none')
    await test.coordinator.start()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'failed', error: { code: 'dispatch-interrupted' } })
    expect(test.external.create).not.toHaveBeenCalled()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it.each(['succeeded', 'failed', 'cancelled'] as const)('recovers exact %s outcomes without running pending receipt enrichment', async (outcome) => {
    const test = await harness({ start: false })
    const task = await test.create({ status: 'in_review' })
    const opened = await pending(test, task)
    test.observations.set(opened.executionId, {
      state: 'settled', outcome, receipt: receipt(opened.execution, 'historical'),
      ...(outcome === 'failed' ? { error: { code: 'model-error', message: 'Provider error' } } : {}),
    })
    await test.coordinator.start()
    expect(test.board.get(task.id)).toMatchObject({
      status: outcome === 'succeeded' ? 'done' : 'in_review',
      executions: [{ status: outcome, receipt: { messageId: 'historical' } }],
    })
    expect(test.board.get(task.id)?.executions[0]?.startedAt).toBeUndefined()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('records observation failures as diagnostics and later installs a genuine cancellation', async () => {
    const test = await harness({ start: false })
    const task = await test.create()
    const opened = await pending(test, task, 'running')
    test.external.observe.mockRejectedValueOnce(new Error('history unavailable'))
    await test.coordinator.start()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'running', error: { code: 'observation-failed' } })
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'cancelled' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'cancelled' })
    expect(test.board.get(task.id)?.executions[0]?.error).toBeUndefined()
  })

  it('does not commit an observed result after ownership is lost during the read', async () => {
    const test = await harness()
    const task = await test.create()
    const opened = await pending(test, task)
    const entered = deferred()
    const release = deferred()
    test.external.observe.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return { state: 'settled', outcome: 'succeeded' }
    })
    const polling = test.coordinator.poll()
    const rejected = expect(polling).rejects.toThrow('ownership lost')
    await entered.promise
    test.ownership.held = false
    release.resolve()
    await rejected
    expect(test.board.get(task.id)?.executions[0]).toEqual(opened.execution)
  })

  it('continues outcome reconciliation while new executions are disabled', async () => {
    const test = await harness()
    const task = await test.create()
    const result = await test.coordinator.run(request(task), new AbortController().signal)
    test.settings.enabled = false
    test.coordinator.settingsChanged()
    test.observations.set(result.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('succeeded')
    await expect(test.coordinator.run(request(test.board.get(task.id)!, 'new'), new AbortController().signal))
      .rejects.toThrow('disabled')
  })

  it('blocks new work using an already-recovered conversation, then releases it after settlement', async () => {
    const test = await harness({ start: false })
    const connection = await connected(test)
    const first = await test.create({ connection })
    const second = await test.create({ connection })
    const opened = await pending(test, first)
    await test.coordinator.start()
    await expect(test.coordinator.run(request(second), new AbortController().signal)).rejects.toMatchObject({ code: 'busy' })
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    await expect(test.coordinator.run(request(second), new AbortController().signal)).resolves.toMatchObject({
      task: { executions: [{ status: 'running' }] },
    })
  })

  it('reconciles overlapping saved receipts independently rather than inventing a busy failure', async () => {
    const test = await harness({ start: false })
    const connection = await connected(test)
    const first = await pending(test, await test.create({ connection }))
    const second = await pending(test, await test.create({ connection }))
    await seedRecord(test, first.task.id, record => ({
      ...record, executions: record.executions.map(execution => ({ ...execution, requestedAt: second.execution.requestedAt })),
    }))
    test.observations.set(first.executionId, { state: 'settled', outcome: 'failed', error: { code: 'original', message: 'Original' } })
    test.observations.set(second.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.start()
    expect(test.board.get(first.task.id)?.executions[0]?.status).toBe('failed')
    expect(test.board.get(second.task.id)?.executions[0]?.status).toBe('succeeded')
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('starts provider disposal before awaiting an observation released only by disposal', async () => {
    const test = await harness()
    const task = await test.create()
    await pending(test, task)
    const entered = deferred()
    const release = deferred()
    test.external.observe.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'running' } })
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    const polling = test.coordinator.poll()
    await entered.promise
    await test.close()
    await polling
    expect(test.clock.timers.size).toBe(0)
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('pending')
    expect(test.external.dispose).toHaveBeenCalledOnce()
  })

  it('drains disabled in-flight work without reporting normal cancellation as a shutdown failure', async () => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      entered.resolve()
      await release.promise
      return receipt(execution)
    })
    const running = test.coordinator.run(request(task), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow('enablement changed')
    await entered.promise
    test.settings.enabled = false
    test.coordinator.settingsChanged()
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    await test.close()
    await rejected
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('preserves the dispatch failure when shutdown interrupts its diagnostic write guard', async () => {
    const test = await harness()
    const task = await test.create()
    const entered = deferred()
    const release = deferred()
    let diagnosing = false
    vi.mocked(test.dependencies.assertOwned).mockImplementation(async () => {
      if (diagnosing) { entered.resolve(); await release.promise }
    })
    test.external.prepare.mockImplementationOnce(async () => {
      diagnosing = true
      throw new Error('preparation failed before shutdown')
    })
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    const running = test.coordinator.run(request(task), new AbortController().signal)
    const rejected = expect(running).rejects.toThrow('preparation failed before shutdown')
    await entered.promise
    await expect(test.close()).rejects.toThrow('could not drain')
    await rejected
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.copilotDispose).toHaveBeenCalledOnce()
  })

  it('does not install timers when shutdown races initial recovery', async () => {
    const test = await harness({ start: false })
    await pending(test, await test.create())
    const entered = deferred()
    const release = deferred()
    test.external.observe.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return { state: 'running' } })
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    const startup = test.coordinator.start()
    const rejected = expect(startup).rejects.toThrow('stopped')
    await entered.promise
    await test.close()
    await rejected
    expect(test.clock.timers.size).toBe(0)
  })

  it('closes providers after startup ownership failure and refuses later execution', async () => {
    const test = await harness({ start: false })
    const task = await test.create()
    test.ownership.held = false
    await expect(test.coordinator.start()).rejects.toThrow('ownership lost')
    expect(test.external.dispose).toHaveBeenCalledOnce()
    expect(test.clock.timers.size).toBe(0)
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('stopped')
    await expect(test.coordinator.start()).rejects.toThrow('already started')
  })

  it('clears an already registered timer if registering its sibling fails', async () => {
    const test = await harness({ start: false })
    const every = test.clock.every.bind(test.clock)
    vi.spyOn(test.clock, 'every').mockImplementationOnce(every).mockImplementationOnce(() => {
      throw new Error('timer registration failed')
    })
    await expect(test.coordinator.start()).rejects.toThrow('timer registration failed')
    expect(test.clock.timers.size).toBe(0)
    expect(test.external.dispose).toHaveBeenCalledOnce()
  })

  it('preserves startup and cleanup errors when both fail', async () => {
    const test = await harness({ start: false })
    test.ownership.held = false
    test.external.dispose.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(test.coordinator.start()).rejects.toThrow('startup and cleanup failed')
    await expect(test.close()).rejects.toThrow('could not drain')
    expect(test.copilotDispose).toHaveBeenCalledOnce()
  })

  it('drains both providers even when one disposal fails', async () => {
    const test = await harness()
    test.external.dispose.mockRejectedValueOnce(new Error('provider close failed'))
    await expect(test.close()).rejects.toThrow('could not drain')
    expect(test.copilotDispose).toHaveBeenCalledOnce()
    await test.coordinator.poll()
    await test.coordinator.tick()
  })

  it('owns and clears real periodic timers in the default clock implementation', async () => {
    const test = await harness({ systemClock: true })
    await test.close()
    expect(test.external.dispose).toHaveBeenCalledOnce()
  })
})

describe('Taskboard durable settlement acknowledgement', () => {
  it('retains exact terminal evidence across a failed settlement write, then releases before same-conversation Run Again', async () => {
    const test = await harness()
    const task = await test.create({ status: 'in_review', executionSettings: { kind: 'copilot' } })
    const first = await test.coordinator.run(request(task, 'first'), new AbortController().signal)
    const execution = first.task.executions[0]!
    const terminal: TaskExecutionObservation = {
      state: 'settled', outcome: 'succeeded', receipt: execution.receipt!,
    }
    test.observations.set(execution.id, terminal)
    test.copilotRelease.mockImplementation(async (acknowledged) => {
      const committed = test.board.get(task.id)?.executions.find(candidate => candidate.id === acknowledged.id)
      expect(committed?.status).toBe('succeeded')
      expect(acknowledged).toEqual(committed)
      test.observations.delete(acknowledged.id)
    })
    test.pool.failNextWrites = 1
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({
      status: 'running', error: { code: 'observation-failed', message: 'injected write failure' },
    })
    expect(test.copilotRelease).not.toHaveBeenCalled()
    expect(test.observations.get(execution.id)).toEqual(terminal)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(test.dependencies.adapters.copilot.observe(execution, new AbortController().signal))
        .resolves.toEqual(terminal)
    }
    await test.coordinator.poll()
    expect(test.board.get(task.id)).toMatchObject({ status: 'done', executions: [{ status: 'succeeded' }] })
    expect(test.board.get(task.id)?.executions[0]?.error).toBeUndefined()
    expect(test.copilotRelease).toHaveBeenCalledOnce()
    expect(test.observations.has(execution.id)).toBe(false)
    expect(test.copilotDispose).not.toHaveBeenCalled()
    const second = await test.coordinator.run(request(test.board.get(task.id)!, 'again'), new AbortController().signal)
    expect(second.task.connection).toEqual(first.task.connection)
    expect(second.executionId).not.toBe(first.executionId)
    expect(test.external.create).toHaveBeenCalledOnce()
    expect(test.external.submit).toHaveBeenCalledTimes(2)
    const next = second.task.executions.find(candidate => candidate.id === second.executionId)!
    test.observations.set(next.id, { state: 'settled', outcome: 'succeeded', receipt: next.receipt! })
    await test.coordinator.poll()
    expect(test.copilotRelease).toHaveBeenCalledTimes(2)
    expect(test.observations.size).toBe(0)
  })

  it('reports release failure without changing the committed outcome or retrying terminal observation', async () => {
    const test = await harness()
    const task = await test.create({ executionSettings: { kind: 'copilot' } })
    const opened = await test.coordinator.run(request(task), new AbortController().signal)
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'succeeded' })
    const cleanup = new Error('SDK release failed')
    test.copilotRelease.mockRejectedValueOnce(cleanup)
    await expect(test.coordinator.poll()).resolves.toBeUndefined()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'succeeded' })
    expect(test.board.get(task.id)?.executions[0]?.error).toBeUndefined()
    expect(test.errors).toEqual([cleanup])
    await test.coordinator.poll()
    expect(test.external.observe).toHaveBeenCalledOnce()
    expect(test.copilotRelease).toHaveBeenCalledOnce()
    await test.close()
    expect(test.observations.size).toBe(0)
  })

  it('holds conversation exclusion until post-commit provider release reaches quiescence', async () => {
    const test = await harness()
    const task = await test.create({ executionSettings: { kind: 'copilot' } })
    const opened = await test.coordinator.run(request(task), new AbortController().signal)
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'succeeded' })
    const entered = deferred()
    const release = deferred()
    test.copilotRelease.mockImplementationOnce(async (execution) => {
      entered.resolve()
      await release.promise
      test.observations.delete(execution.id)
    })
    const polling = test.coordinator.poll()
    await entered.promise
    const settled = test.board.get(task.id)!
    expect(settled.executions[0]?.status).toBe('succeeded')
    await expect(test.coordinator.run(request(settled, 'again'), new AbortController().signal))
      .rejects.toMatchObject({ code: 'busy' })
    release.resolve()
    await polling
    await expect(test.coordinator.run(request(settled, 'again'), new AbortController().signal))
      .resolves.toMatchObject({ task: { connection: opened.task.connection } })
  })

  it('drains an in-flight release concurrently with global provider disposal', async () => {
    const test = await harness()
    const task = await test.create({ executionSettings: { kind: 'copilot' } })
    const opened = await test.coordinator.run(request(task), new AbortController().signal)
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'succeeded' })
    const entered = deferred()
    const release = deferred()
    let released = false
    test.copilotRelease.mockImplementationOnce(async (execution) => {
      entered.resolve()
      await release.promise
      test.observations.delete(execution.id)
      released = true
    })
    test.copilotDispose.mockImplementationOnce(async () => { release.resolve() })
    const polling = test.coordinator.poll()
    await entered.promise
    await test.close()
    await polling
    expect(released).toBe(true)
    expect(test.observations.size).toBe(0)
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('succeeded')
  })

  it('retains evidence through pending and running receipt enrichment until an actual failure commits', async () => {
    const test = await harness({ start: false })
    const connection: TaskConnection = { kind: 'copilot', sessionId: AgencyCopilotSessionId(randomUUID()) }
    const task = await test.create({ connection, executionSettings: { kind: 'copilot' } })
    const opened = await pending(test, task)
    const accepted = receipt(opened.execution, 'accepted')
    test.observations.set(opened.executionId, { state: 'pending', receipt: accepted })
    await test.coordinator.start()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'pending', receipt: accepted })
    expect(test.copilotRelease).not.toHaveBeenCalled()
    test.observations.set(opened.executionId, { state: 'running', receipt: accepted })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('running')
    expect(test.copilotRelease).not.toHaveBeenCalled()
    const error = { code: 'provider-failed', message: 'Actual execution failure' }
    test.observations.set(opened.executionId, { state: 'settled', outcome: 'failed', receipt: accepted, error })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ status: 'failed', error })
    expect(test.copilotRelease).toHaveBeenCalledOnce()
  })

  it('releases provider preparation resources after a known pre-submission failure commits', async () => {
    const test = await harness()
    const task = await test.create({ executionSettings: { kind: 'copilot' } })
    test.external.prepare.mockRejectedValueOnce(new Error('preparation failed'))
    await expect(test.coordinator.run(request(task), new AbortController().signal)).rejects.toThrow('preparation failed')
    expect(test.copilotRelease).toHaveBeenCalledOnce()
    expect(test.copilotRelease.mock.calls[0]?.[0]).toMatchObject({ status: 'failed', error: { code: 'dispatch-failed' } })
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('acknowledges cold recovery even when no local provider attachment exists', async () => {
    const test = await harness({ start: false })
    const connection: TaskConnection = { kind: 'copilot', sessionId: AgencyCopilotSessionId(randomUUID()) }
    const task = await test.create({ connection, executionSettings: { kind: 'copilot' } })
    await pending(test, task)
    test.external.observe.mockResolvedValueOnce({ state: 'settled', outcome: 'cancelled' })
    await test.coordinator.start()
    expect(test.board.get(task.id)?.executions[0]?.status).toBe('cancelled')
    expect(test.copilotRelease).toHaveBeenCalledOnce()
    expect(test.copilotRelease.mock.calls[0]?.[0].connection).toEqual(connection)
    expect(test.external.create).not.toHaveBeenCalled()
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('acknowledges durable settlement even when imported history ordering prunes its displayed attempt', async () => {
    const test = await harness({ history: 1 })
    const task = await test.create({ executionSettings: { kind: 'copilot' } })
    const first = await test.coordinator.run(request(task, 'first'), new AbortController().signal)
    test.observations.set(first.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    const again = request(test.board.get(task.id)!, 'again')
    const second = await test.coordinator.run(again, new AbortController().signal)
    await seedRecord(test, task.id, record => ({ ...record, executions: [...record.executions].reverse() }))
    test.observations.set(second.executionId, { state: 'settled', outcome: 'succeeded' })
    await test.coordinator.poll()
    expect(test.board.get(task.id)?.executions.some(execution => execution.id === second.executionId)).toBe(false)
    expect(test.board.getRunRequest(again)?.executionId).toBe(second.executionId)
    expect(test.copilotRelease.mock.calls.map(call => call[0].id)).toEqual([first.executionId, second.executionId])
    expect(test.observations.size).toBe(0)
  })
})

describe('Taskboard coordinator cron', () => {
  async function scheduled(options: { start?: boolean; cron?: string; timeZone?: string } = {}) {
    const test = await harness({ start: false })
    const task = await test.create({
      schedule: { enabled: true, cron: options.cron ?? '* * * * *', timeZone: options.timeZone ?? 'UTC' },
    })
    const due = task.schedule!.nextRunAt!
    test.clock.set(new Date(Date.parse(due) - 1_000).toISOString())
    if (options.start !== false) await test.coordinator.start()
    return { ...test, task, due }
  }

  it('skips startup misfires, then admits one occurrence without waiting for its dispatch', async () => {
    const test = await scheduled({ start: false })
    test.clock.set(new Date(Date.parse(test.due) + 5 * 60_000).toISOString())
    await test.coordinator.start()
    let task = test.board.get(test.task.id)!
    expect(task.executions).toEqual([])
    expect(task.schedule?.nextRunAt).not.toBe(test.due)
    const due = task.schedule!.nextRunAt!
    const entered = deferred()
    const release = deferred()
    test.external.prepare.mockImplementationOnce(async (execution) => {
      entered.resolve()
      await release.promise
      return receipt(execution)
    })
    test.clock.set(due)
    await test.coordinator.tick()
    await entered.promise
    task = test.board.get(task.id)!
    expect(task.executions).toHaveLength(1)
    expect(task.executions[0]).toMatchObject({ trigger: 'schedule', scheduledAt: due, status: 'pending' })
    await test.coordinator.tick()
    expect(test.board.get(task.id)?.executions).toHaveLength(1)
    release.resolve()
  })

  it.each(['long-gap', 'backward-clock'] as const)('skips a due occurrence after %s', async (reason) => {
    const test = await harness()
    if (reason === 'backward-clock') {
      test.clock.set(new Date(test.clock.now().getTime() + 10 * 60_000).toISOString())
      await test.coordinator.tick()
    }
    const task = await test.create({ schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' } })
    const due = task.schedule!.nextRunAt!
    test.clock.set(reason === 'long-gap' ? new Date(Date.parse(due) + 10 * 60_000).toISOString() : due)
    await test.coordinator.tick()
    expect(test.board.get(task.id)?.executions).toEqual([])
    expect(test.board.get(task.id)?.schedule?.nextRunAt).not.toBe(due)
  })

  it('calculates the next occurrence in the saved timezone', async () => {
    const test = await scheduled({ cron: '0 9 * * *', timeZone: 'Asia/Tokyo' })
    test.clock.set(test.due)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt)
      .toBe(new Date(Date.parse(test.due) + 24 * 60 * 60_000).toISOString())
  })

  it('skips a busy task and another task sharing the same saved conversation', async () => {
    const test = await harness({ start: false })
    const connection = await connected(test)
    const input = { connection, schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' } }
    const first = await test.create(input)
    const second = await test.create(input)
    const opened = await pending(test, first)
    test.observations.set(opened.executionId, { state: 'running' })
    test.clock.set(new Date(Date.parse(first.schedule!.nextRunAt!) - 1_000).toISOString())
    await test.coordinator.start()
    test.clock.set(first.schedule!.nextRunAt!)
    await test.coordinator.tick()
    expect(test.board.get(first.id)?.executions).toHaveLength(1)
    expect(test.board.get(second.id)?.executions).toEqual([])
    expect(test.board.get(second.id)?.schedule?.nextRunAt).not.toBe(second.schedule?.nextRunAt)
  })

  it('admits only one of two newly due tasks sharing an idle conversation', async () => {
    const test = await harness({ start: false })
    const connection = await connected(test)
    const input = { connection, schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' } }
    const first = await test.create(input)
    const second = await test.create(input)
    test.clock.set(new Date(Date.parse(first.schedule!.nextRunAt!) - 1_000).toISOString())
    await test.coordinator.start()
    test.clock.set(first.schedule!.nextRunAt!)
    await test.coordinator.tick()
    expect(test.board.get(first.id)?.executions).toHaveLength(1)
    expect(test.board.get(second.id)?.executions).toEqual([])
    expect(test.board.get(second.id)?.schedule?.nextRunAt).not.toBe(second.schedule?.nextRunAt)
  })

  it('uses the committed connection when a scheduled task changes conversations during resolution', async () => {
    const test = await harness({ start: false })
    const busyConnection = await connected(test)
    const owner = await pending(test, await test.create({ connection: busyConnection }))
    const oldConnection: TaskConnection = { kind: 'dsh', sessionId: SessionId('old-connection') }
    await test.provisionSession(oldConnection.sessionId)
    const task = await test.create({
      connection: oldConnection, schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' },
    })
    const due = task.schedule!.nextRunAt!
    test.clock.set(new Date(Date.parse(due) - 1_000).toISOString())
    await test.coordinator.start()
    const rejected = deferred()
    vi.mocked(test.dependencies.reportError).mockImplementation((error) => { test.errors.push(error); rejected.resolve() })
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (current) => {
      const disconnected = await test.board.disconnect(current.id, current.revision)
      await test.board.connect({ taskId: current.id, expectedRevision: disconnected.revision, connection: busyConnection })
      return current.executionSettings
    })
    test.clock.set(due)
    await test.coordinator.tick()
    await rejected.promise
    expect(test.board.get(task.id)?.executions[0]).toMatchObject({ connection: busyConnection, status: 'failed' })
    expect(test.board.get(owner.task.id)?.executions[0]?.status).toBe('running')
    expect(test.external.submit).not.toHaveBeenCalled()
    const independent = await test.create({ connection: oldConnection })
    await test.coordinator.run(request(independent), new AbortController().signal)
    expect(test.external.submit).toHaveBeenCalledOnce()
  })

  it('does not re-dispatch a cron occurrence admitted while options were resolving', async () => {
    const test = await scheduled()
    let executionId: TaskExecution['id'] | undefined
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (task) => {
      const connection = await connected(test)
      const opened = await test.board.beginExecution({
        taskId: task.id, requestId: TaskRunRequestId(`cron:${task.id}:${test.due}`),
        trigger: 'schedule', scheduledAt: test.due, now: test.due,
        nextRunAt: nextTaskScheduleRun(task.schedule!, test.due),
        executionSettings: task.executionSettings, proposedConnection: connection,
      })
      executionId = opened.executionId
      return task.executionSettings
    })
    test.clock.set(test.due)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions[0]?.id).toBe(executionId)
    expect(test.external.submit).not.toHaveBeenCalled()
    expect(test.external.create).not.toHaveBeenCalled()
  })

  it('drains scheduler resolution on shutdown without admitting its due occurrence', async () => {
    const test = await scheduled()
    const entered = deferred()
    const release = deferred()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (task) => {
      entered.resolve()
      await release.promise
      return task.executionSettings
    })
    test.external.dispose.mockImplementationOnce(async () => { release.resolve() })
    test.clock.set(test.due)
    const ticking = test.coordinator.tick()
    await entered.promise
    await test.close()
    await ticking
    expect(test.board.get(test.task.id)?.executions).toEqual([])
  })

  it('skips a Workspace that disappeared without admitting its due task', async () => {
    const test = await scheduled()
    await test.ctx.workspaceRegistry.delete(test.workspace.id)
    test.clock.set(test.due)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(test.due)
  })

  it('reports a failed skip without retrying the same write in that tick', async () => {
    const test = await scheduled({ start: false })
    test.clock.set(test.due)
    test.pool.failNextWrites = 2
    await test.coordinator.start()
    expect(test.errors).toHaveLength(1)
    expect(test.pool.failNextWrites).toBe(1)
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).toBe(test.due)
    test.clock.set(new Date(Date.parse(test.due) + 1_000).toISOString())
    await test.coordinator.tick()
    expect(test.errors).toHaveLength(2)
    expect(test.pool.failNextWrites).toBe(0)
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).toBe(test.due)
    test.clock.set(new Date(Date.parse(test.due) + 2_000).toISOString())
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(test.due)
  })

  it.each(['startup', 'long-gap', 'backward-clock'] as const)(
    'retries the exact failed %s skip without suppressing unrelated on-time work',
    async (reason) => {
      const test = await scheduled({ start: reason !== 'startup' })
      if (reason === 'backward-clock') {
        test.clock.set(new Date(Date.parse(test.due) + 10 * 60_000).toISOString())
        await test.coordinator.tick()
        await seedRecord(test, test.task.id, record => ({ ...record, schedule: { ...record.schedule, nextRunAt: test.due } }))
      }
      const before = test.board.get(test.task.id)!
      const missed = before.schedule!.nextRunAt!
      const instant = new Date(Date.parse(missed) + (reason === 'backward-clock' ? 0 : 5 * 60_000)).toISOString()
      test.clock.set(instant)
      test.pool.failNextWrites = 1
      if (reason === 'startup') await test.coordinator.start()
      else await test.coordinator.tick()
      expect(test.pool.failNextWrites).toBe(0)
      expect(test.board.get(before.id)?.executions).toEqual([])
      expect(test.board.get(before.id)?.schedule?.nextRunAt).toBe(missed)
      const onTime = await test.create({ schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' } })
      const nextTick = new Date(Date.parse(instant) + 1_000).toISOString()
      await seedRecord(test, onTime.id, record => ({ ...record, schedule: { ...record.schedule, nextRunAt: nextTick } }))
      test.clock.set(nextTick)
      await test.coordinator.tick()
      expect(test.board.get(before.id)?.executions).toEqual([])
      expect(test.board.get(before.id)?.schedule?.nextRunAt).not.toBe(missed)
      expect(test.board.get(onTime.id)?.executions).toMatchObject([{ trigger: 'schedule', scheduledAt: nextTick }])
    },
  )

  it.each(['changed', 'disabled', 'deleted'] as const)('forgets a failed skip when its schedule is %s', async (change) => {
    const test = await scheduled({ start: false })
    test.clock.set(test.due)
    test.pool.failNextWrites = 1
    await test.coordinator.start()
    const task = test.board.get(test.task.id)!
    if (change === 'deleted') {
      await test.board.delete(task.id, task.revision)
    } else {
      await seedRecord(test, task.id, record => ({
        ...record, schedule: {
          ...record.schedule, enabled: change !== 'disabled', cron: '*/2 * * * *',
        },
      }))
    }
    test.clock.set(new Date(Date.parse(test.due) + 1_000).toISOString())
    await test.coordinator.tick()
    expect(test.board.get(task.id)?.executions.length ?? 0).toBe(change === 'changed' ? 1 : 0)
  })

  it('rolls past external validation errors and publishes a second roll-forward failure', async () => {
    const test = await scheduled()
    vi.mocked(test.dependencies.resolveSettings).mockRejectedValueOnce(new Error('provider unavailable'))
    test.pool.failNextWrites = 1
    test.clock.set(test.due)
    await expect(test.coordinator.tick()).resolves.toBeUndefined()
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    expect(test.dependencies.changed).toHaveBeenLastCalledWith({
      lastTickAt: test.due, error: 'provider unavailable; injected write failure',
    })
    expect(test.errors).toHaveLength(2)
    test.clock.set(new Date(Date.parse(test.due) + 1_000).toISOString())
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(test.due)
  })

  it('rolls forward once after an admission error without dispatching', async () => {
    const test = await scheduled()
    test.pool.failNextWrites = 1
    test.clock.set(test.due)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(test.due)
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('resets recovery only when enabled changes, not for unrelated settings', async () => {
    const test = await scheduled()
    test.settings.announceToAgent = true
    test.coordinator.settingsChanged()
    test.clock.set(test.due)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toHaveLength(1)
    test.settings.enabled = false
    test.coordinator.settingsChanged()
    const next = test.board.get(test.task.id)!.schedule!.nextRunAt!
    test.clock.set(next)
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).toBe(next)
    test.settings.enabled = true
    test.coordinator.settingsChanged()
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.executions).toHaveLength(1)
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(next)
  })

  it('does not admit a scheduled run after enablement changes during option resolution', async () => {
    const test = await scheduled()
    const entered = deferred()
    const release = deferred()
    vi.mocked(test.dependencies.resolveSettings).mockImplementationOnce(async (task) => {
      entered.resolve()
      await release.promise
      return task.executionSettings
    })
    test.clock.set(test.due)
    const ticking = test.coordinator.tick()
    await entered.promise
    test.settings.enabled = false
    test.coordinator.settingsChanged()
    test.settings.enabled = true
    test.coordinator.settingsChanged()
    release.resolve()
    await ticking
    expect(test.board.get(test.task.id)?.executions).toEqual([])
    await test.coordinator.tick()
    expect(test.board.get(test.task.id)?.schedule?.nextRunAt).not.toBe(test.due)
    expect(test.external.submit).not.toHaveBeenCalled()
  })

  it('observes a scheduled launch rejection without an unhandled promise', async () => {
    const test = await scheduled()
    const rejected = deferred()
    test.external.prepare.mockImplementationOnce(async () => { throw new Error('scheduled prepare failed') })
    test.external.create.mockImplementationOnce(async (execution) => {
      await test.provisionSession((execution.connection as Extract<TaskConnection, { kind: 'dsh' }>).sessionId)
    })
    vi.mocked(test.dependencies.reportError).mockImplementation((error) => { test.errors.push(error); rejected.resolve() })
    test.clock.set(test.due)
    test.clock.fire(200)
    await test.coordinator.tick()
    await rejected.promise
    expect(test.errors.some(error => error instanceof Error && error.message === 'scheduled prepare failed')).toBe(true)
    expect(test.board.get(test.task.id)?.executions[0]?.status).toBe('failed')
  })
})
