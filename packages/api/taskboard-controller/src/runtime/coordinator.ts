/** Durable dispatch, occurrence admission, and receipt reconciliation without browser ownership. */
import type { TaskboardOwnershipCapability, TaskboardService } from '@deepseek-ai/dsh-taskboard'
import { TaskRunRequestId, TaskboardExecutionError, TaskboardTaskNotFoundError } from '@deepseek-ai/dsh-taskboard'
import type {
  TaskConnection, TaskExecution, TaskExecutionId, TaskExecutionSettings, TaskId, TaskboardTask,
} from '@deepseek-ai/dsh-taskboard/types'
import type { TaskboardRunRequest, TaskboardRunValue } from '../types.ts'
import type { TaskboardSettings } from '../runtime-types.ts'
import type { TaskConversationAttention, TaskExecutionAdapter, TaskExecutionObservation } from './adapter.ts'

/** Resolved deployment timing; timers never provide execution authority themselves. */
export interface TaskboardCoordinatorConfig {
  readonly pollIntervalMs: number
  readonly schedulerIntervalMs: number
  readonly schedulerRecoveryGapMs: number
  readonly operationTimeoutMs: number
}

/** Application-owned capabilities supplied to the coordinator at construction. */
export interface TaskboardCoordinatorDependencies {
  readonly tasks: TaskboardService
  readonly adapters: Readonly<Record<TaskConnection['kind'], TaskExecutionAdapter>>
  readonly settings: () => TaskboardSettings
  /** Verify kernel-backed ownership before provisioning, submitting, or mutating Taskboard records. */
  readonly assertOwned: () => Promise<void>
  readonly advanceConversation: TaskboardOwnershipCapability['advanceConversation']
  readonly resolveSettings: (task: TaskboardTask) => Promise<TaskExecutionSettings>
  readonly allocateConnection: (settings: TaskExecutionSettings) => TaskConnection
  readonly nextOccurrence: (cron: string, timeZone: string, after: Date) => string
  readonly workspaceExists: (task: TaskboardTask) => boolean
  readonly changed: (scheduler: { readonly lastTickAt?: string; readonly error?: string }) => void
  readonly reportError: (error: unknown) => void
}

/** Instance-local time and timer ownership; deployment intervals remain in Config. */
export interface TaskboardCoordinatorClock {
  /** @returns the current scheduler instant. */
  now(): Date
  /**
   * Register a periodic callback.
   * @param callback - Callback whose asynchronous work the coordinator tracks.
   * @param intervalMs - Configured period.
   * @returns the synchronous timer disposer.
   */
  every(callback: () => void, intervalMs: number): () => void
}

const systemClock: TaskboardCoordinatorClock = {
  now: () => new Date(),
  every: (callback, intervalMs) => {
    const timer = setInterval(callback, intervalMs)
    return () => { clearInterval(timer) }
  },
}

class EnablementChanged extends TaskboardExecutionError {
  constructor() {
    super('execution-state', 'Taskboard enablement changed during the operation')
  }
}

/** Coordinates one Host's attempts; every mutation rechecks process ownership. */
export class TaskboardCoordinator {
  private readonly lifetime = new AbortController()
  private enablement = new AbortController()
  private readonly launches = new Map<TaskExecutionId, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly sessionOwners = new Map<string, TaskExecutionId>()
  private readonly reservations = new Set<string>()
  private readonly admissions = new Map<TaskId, { count: number }>()
  private readonly attention = new Map<TaskId, { readonly connection: string; readonly monitor: TaskConversationAttention }>()
  /** Failed cursor writes retain an exact skip obligation, never a catch-up admission. */
  private readonly missedOccurrences = new Map<TaskId, string>()
  private readonly timers: Array<() => void> = []
  private polling: Promise<void> | undefined
  private ticking: Promise<void> | undefined
  private lastTick: number | undefined
  private disposal: Promise<void> | undefined
  private startCalled = false
  private ready = false
  private enabled: boolean

  /**
   * @param config - Validated timing and deadline policy.
   * @param dependencies - Durable domain, providers, and Host configuration.
   * @param clock - Instance-local time and timer registration.
   */
  constructor(
    private readonly config: TaskboardCoordinatorConfig,
    private readonly dependencies: TaskboardCoordinatorDependencies,
    private readonly clock: TaskboardCoordinatorClock = systemClock,
  ) {
    this.enabled = dependencies.settings().enabled
  }

  /**
   * Reconcile surviving attempts and skip missed occurrences before starting timers.
   * Startup failure closes providers; no saved prompt is resubmitted.
   * @returns resolution after initial reconciliation.
   */
  start(): Promise<void> {
    if (this.startCalled) return Promise.reject(new Error('Taskboard coordinator is already started'))
    this.startCalled = true
    return this.track(async () => {
      await this.guard(this.lifetime.signal)
      await this.poll()
      await this.tick()
      this.lifetime.signal.throwIfAborted()
      this.timers.push(this.clock.every(() => { void this.poll().catch(this.dependencies.reportError) }, this.config.pollIntervalMs))
      this.timers.push(this.clock.every(() => { void this.tick().catch(this.dependencies.reportError) }, this.config.schedulerIntervalMs))
      this.ready = true
    }).catch(async (error: unknown) => {
      try {
        await this.dispose()
      } catch (cleanup: unknown) {
        throw new AggregateError([error, cleanup], 'Taskboard startup and cleanup failed')
      }
      throw error
    })
  }

  /**
   * Admit a stable manual request and await dispatch acknowledgement, not model completion.
   * Replays use durable request receipts before inspecting capabilities or changed task choices.
   * @param request - Task revision and caller-owned deduplication identity.
   * @param signal - Cancellation before durable admission; accepted work is not caller-owned.
   * @returns the current task and original execution identity, even when displayed history was pruned.
   */
  run(request: TaskboardRunRequest, signal: AbortSignal): Promise<TaskboardRunValue> {
    return this.track(async () => {
      this.lifetime.signal.throwIfAborted()
      if (!this.ready) throw new Error('Taskboard execution is not initialized')
      signal.throwIfAborted()
      const replay = this.dependencies.tasks.getRunRequest(request)
      if (replay !== undefined) return this.acknowledged(request.taskId, replay.executionId)
      this.settingsChanged()
      const enabledSignal = this.enablement.signal
      const active = this.operationSignal(signal, enabledSignal)
      const current = this.requireTask(request.taskId)
      let release = current.connection === undefined ? undefined : this.reserve(current.connection)
      let executionId: TaskExecutionId
      const finishAdmission = this.enterAdmission(current.id)
      try {
        await this.guard(active, true)
        const settings = await this.dependencies.resolveSettings(current)
        await this.guard(active, true)
        const existing = this.dependencies.tasks.getRunRequest(request)
        if (existing !== undefined) return await this.acknowledged(request.taskId, existing.executionId)
        const connection = current.connection ?? this.dependencies.allocateConnection(settings)
        release ??= this.reserve(connection)
        if (current.connection !== undefined) {
          await this.dependencies.adapters[connection.kind].validateConnection(connection, current.workspaceId, active)
        }
        await this.guard(active, true)
        this.assertAvailable(connection)
        const opened = await this.dependencies.tasks.beginExecution({
          ...request, trigger: 'manual', executionSettings: settings,
          ...(current.connection === undefined ? { proposedConnection: connection } : {}),
        }, active)
        this.lifetime.signal.throwIfAborted()
        executionId = opened.executionId
        if (!opened.replayed) {
          void this.launch(current.id, executionId, enabledSignal)
        }
      } finally {
        finishAdmission()
        release?.()
      }
      return this.acknowledged(request.taskId, executionId)
    })
  }

  /** Only enabled transitions invalidate pending dispatch and establish a new misfire-recovery point. */
  settingsChanged(): void {
    const enabled = this.dependencies.settings().enabled
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.lastTick = undefined
    this.enablement.abort(new EnablementChanged())
    this.enablement = new AbortController()
  }

  /** Forget borrowed monitors as soon as their task is disconnected, archived, deleted, or starts a run. */
  tasksChanged(): void {
    for (const [id, tracked] of this.attention) {
      const task = this.dependencies.tasks.get(id)
      if (task?.connection === undefined || task.archivedAt !== undefined || task.executions.some(isOpen)
        || connectionKey(task.connection) !== tracked.connection) this.attention.delete(id)
    }
  }

  /**
   * Reconcile saved receipts without submitting input; concurrent polls share one pass.
   * @returns completion of the current observation and durable settlement pass.
   */
  poll(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.polling ??= this.track(() => this.pollOnce()).finally(() => { this.polling = undefined })
    return this.polling
  }

  /**
   * Admit due occurrences and durably skip missed or busy ones.
   * @returns completion of the shared scheduler pass; dispatch remains asynchronous.
   */
  tick(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.resolve()
    this.ticking ??= this.track(() => this.tickOnce()).finally(() => { this.ticking = undefined })
    return this.ticking
  }

  /**
   * Stop new work and drain callbacks and provider resources without deleting conversations.
   * @returns the shared shutdown-completion promise.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.close()
    return this.disposal
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    this.operations.add(pending)
    void pending.then(() => { this.operations.delete(pending) }, () => { this.operations.delete(pending) })
    return pending
  }

  private async acknowledged(taskId: TaskId, executionId: TaskExecutionId): Promise<TaskboardRunValue> {
    await this.launches.get(executionId)
    return { task: this.requireTask(taskId), executionId }
  }

  private async close(): Promise<void> {
    this.ready = false
    this.lifetime.abort(new Error('Taskboard coordinator stopped'))
    for (const stop of this.timers.splice(0)) stop()
    // Provider disposal may release an observe/submit operation that shutdown must drain.
    const providers = Object.values(this.dependencies.adapters).map(adapter => Promise.resolve().then(() => adapter.dispose()))
    const results = await Promise.allSettled([...this.operations, ...providers])
    this.sessionOwners.clear()
    this.reservations.clear()
    this.missedOccurrences.clear()
    this.attention.clear()
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status !== 'rejected') continue
      const reason: unknown = result.reason
      if (reason !== this.lifetime.signal.reason && !(reason instanceof EnablementChanged)) failures.push(reason)
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Taskboard shutdown could not drain every operation')
  }

  private launch(taskId: TaskId, executionId: TaskExecutionId, enabledSignal: AbortSignal): Promise<void> {
    const operation = this.track(() => this.dispatch(taskId, executionId, enabledSignal))
    this.launches.set(executionId, operation)
    void operation.then(
      () => { this.launches.delete(executionId) },
      (error: unknown) => { this.launches.delete(executionId); this.dependencies.reportError(error) },
    )
    return operation
  }

  private async dispatch(taskId: TaskId, executionId: TaskExecutionId, enabledSignal: AbortSignal): Promise<void> {
    let execution = this.requireExecution(taskId, executionId)
    const connection = execution.connection
    /* v8 ignore next -- beginExecution atomically reserves the connection before dispatch. */
    if (connection === undefined) throw new Error('Admitted Taskboard execution has no reserved conversation')
    const adapter = this.dependencies.adapters[connection.kind]
    const signal = this.operationSignal(undefined, enabledSignal)
    let submitted = false
    try {
      this.assertAvailable(connection, executionId)
      this.sessionOwners.set(connectionKey(connection), executionId)
      await this.guard(signal, true)
      if (execution.createsConnection) {
        await adapter.create(execution, signal)
        await this.guard(signal, true)
      }
      const prepared = await adapter.prepare(execution, signal)
      await this.guard(signal, true)
      await this.dependencies.tasks.attachExecution({ taskId, executionId, connection, receipt: prepared })
      await this.guard(signal, true)
      execution = this.requireExecution(taskId, executionId)
      submitted = true
      const accepted = await adapter.submit(execution, signal)
      await this.guard(signal, true)
      await this.dependencies.tasks.advanceExecution({ taskId, executionId, receipt: accepted })
    } catch (error: unknown) {
      if (!this.isStopped()) {
        try {
          if (isOpen(this.requireExecution(taskId, executionId))) {
            if (submitted) await this.diagnose(taskId, executionId, 'dispatch-uncertain', error)
            else await this.fail(taskId, executionId, 'dispatch-failed', errorMessage(error))
          }
        } catch (diagnostic: unknown) {
          if (this.lifetime.signal.aborted) throw error
          throw new AggregateError([error, diagnostic], 'Dispatch failed and its diagnostic could not be committed')
        }
      }
      throw error
    } finally {
      const latest = this.dependencies.tasks.get(taskId)?.executions.find(item => item.id === executionId)
      if (latest === undefined || !isOpen(latest)) this.releaseOwner(connection, executionId)
    }
  }

  private async pollOnce(): Promise<void> {
    const pending = this.dependencies.tasks.list(undefined, true)
      .flatMap(task => task.executions.filter(isOpen).map(execution => ({ taskId: task.id, execution })))
      .sort((left, right) => left.execution.requestedAt.localeCompare(right.execution.requestedAt)
        || left.execution.id.localeCompare(right.execution.id))
    for (const { taskId, execution } of pending) {
      if (this.launches.has(execution.id) || this.admissions.has(taskId)) continue
      await this.guard(this.lifetime.signal)
      const current = this.requireExecution(taskId, execution.id)
      if (!isOpen(current)) continue
      if (current.connection === undefined || current.receipt === undefined) {
        await this.fail(taskId, current.id, 'dispatch-interrupted', 'Host stopped before a dispatch receipt was saved; no prompt was resent')
        continue
      }
      const key = connectionKey(current.connection)
      if (!this.sessionOwners.has(key)) this.sessionOwners.set(key, current.id)
      try {
        const observation = await this.dependencies.adapters[current.connection.kind].observe(current, this.operationSignal())
        await this.installObservation(taskId, current, current.connection, observation)
      } catch (error: unknown) {
        if (this.lifetime.signal.aborted) return
        this.dependencies.reportError(error)
        await this.diagnose(taskId, current.id, 'observation-failed', error)
      }
    }
    await this.pollAttention()
  }

  private async pollAttention(): Promise<void> {
    this.tasksChanged()
    for (const task of this.dependencies.tasks.list()) {
      const connection = task.connection
      if (connection === undefined || task.executions.some(isOpen) || this.admissions.has(task.id)) continue
      const key = connectionKey(connection)
      try {
        const fresh = this.dependencies.adapters[connection.kind].attention?.(connection, task.workspaceId)
        if (fresh !== undefined) this.attention.set(task.id, { connection: key, monitor: fresh })
        const tracked = this.attention.get(task.id)
        if (tracked === undefined) continue
        await this.guard(this.lifetime.signal)
        const observation = await tracked.monitor.observe(this.operationSignal())
        await this.guard(this.lifetime.signal)
        if (this.attention.get(task.id) !== tracked) continue
        const status = observation.state === 'settled' ? observation.outcome === 'succeeded' ? 'done' : 'in_review'
          : observation.state === 'waiting' ? 'in_review' : 'in_progress'
        const committed = await this.dependencies.advanceConversation(task, status)
        if (committed && observation.state === 'settled') this.attention.delete(task.id)
      } catch (error: unknown) {
        if (this.lifetime.signal.aborted) return
        this.dependencies.reportError(error)
      }
    }
  }

  private async installObservation(
    taskId: TaskId, execution: TaskExecution, connection: TaskConnection, observation: TaskExecutionObservation,
  ): Promise<void> {
    if (observation.receipt !== undefined && JSON.stringify(observation.receipt) !== JSON.stringify(execution.receipt)) {
      await this.guard(this.lifetime.signal)
      await this.dependencies.tasks.attachExecution({
        taskId, executionId: execution.id, connection, receipt: observation.receipt,
      })
    }
    if (observation.state === 'running' || observation.state === 'waiting') {
      await this.guard(this.lifetime.signal)
      await this.dependencies.tasks.advanceExecution({
        taskId, executionId: execution.id, waitingForInput: observation.state === 'waiting',
      })
    }
    if (observation.state !== 'settled') return
    await this.settle(taskId, execution, observation.outcome, observation.error)
  }

  private async tickOnce(): Promise<void> {
    this.settingsChanged()
    if (!this.enabled) return
    const enabledSignal = this.enablement.signal
    const active = this.operationSignal(undefined, enabledSignal)
    await this.guard(active, true)
    const now = this.clock.now()
    const instant = now.toISOString()
    const recovery = this.lastTick === undefined || now.getTime() < this.lastTick
      || now.getTime() - this.lastTick > this.config.schedulerRecoveryGapMs
    this.lastTick = now.getTime()
    const failures: string[] = []
    const tasks = this.dependencies.tasks.list()
    for (const [taskId, occurrence] of this.missedOccurrences) {
      const task = tasks.find(candidate => candidate.id === taskId)
      if (!task?.schedule?.enabled || occurrence !== JSON.stringify(task.schedule)) this.missedOccurrences.delete(taskId)
    }
    for (const task of tasks) {
      const schedule = task.schedule
      if (!schedule?.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > instant) continue
      let nextRunAt: string | undefined
      let rolling = false
      let release: (() => void) | undefined
      let finishAdmission: (() => void) | undefined
      try {
        nextRunAt = this.dependencies.nextOccurrence(schedule.cron, schedule.timeZone, now)
        const busy = task.executions.some(isOpen) || (task.connection !== undefined && this.busy(task.connection))
        if (recovery || this.missedOccurrences.has(task.id) || busy || !this.dependencies.workspaceExists(task)) {
          rolling = true
          this.missedOccurrences.set(task.id, JSON.stringify(schedule))
          await this.roll(task.id, schedule.nextRunAt, nextRunAt, instant, active)
          continue
        }
        finishAdmission = this.enterAdmission(task.id)
        if (task.connection !== undefined) release = this.reserve(task.connection)
        const settings = await this.dependencies.resolveSettings(task)
        await this.guard(active, true)
        const connection = task.connection ?? this.dependencies.allocateConnection(settings)
        release ??= this.reserve(connection)
        if (task.connection !== undefined) {
          await this.dependencies.adapters[connection.kind].validateConnection(connection, task.workspaceId, active)
        }
        await this.guard(active, true)
        this.assertAvailable(connection)
        const opened = await this.dependencies.tasks.beginExecution({
          taskId: task.id, requestId: TaskRunRequestId(`cron:${task.id}:${schedule.nextRunAt}`),
          trigger: 'schedule', scheduledAt: schedule.nextRunAt, nextRunAt, now: instant,
          executionSettings: settings,
          ...(task.connection === undefined ? { proposedConnection: connection } : {}),
        }, active)
        this.lifetime.signal.throwIfAborted()
        if (!opened.replayed) {
          void this.launch(task.id, opened.executionId, enabledSignal)
        }
      } catch (error: unknown) {
        if (this.lifetime.signal.aborted) return
        failures.push(errorMessage(error))
        this.dependencies.reportError(error)
        const current = this.dependencies.tasks.get(task.id)
        if (!rolling && nextRunAt !== undefined && current?.schedule?.enabled && current.schedule.nextRunAt === schedule.nextRunAt) {
          try {
            this.missedOccurrences.set(task.id, JSON.stringify(current.schedule))
            await this.roll(task.id, schedule.nextRunAt, nextRunAt, instant, active)
          } catch (rollError: unknown) {
            failures.push(errorMessage(rollError))
            this.dependencies.reportError(rollError)
          }
        }
      } finally {
        finishAdmission?.()
        release?.()
      }
    }
    this.dependencies.changed({ lastTickAt: instant, ...(failures.length === 0 ? {} : { error: failures.join('; ') }) })
  }

  private async roll(taskId: TaskId, scheduledAt: string, nextRunAt: string, now: string, signal: AbortSignal): Promise<void> {
    await this.guard(signal, true)
    await this.dependencies.tasks.rollForwardSchedule({ taskId, scheduledAt, nextRunAt, now })
    this.missedOccurrences.delete(taskId)
  }

  private busy(connection: TaskConnection): boolean {
    return this.reservations.has(connectionKey(connection)) || this.activeConnection(connection)
  }

  private activeConnection(connection: TaskConnection, exclude?: TaskExecutionId): boolean {
    const key = connectionKey(connection)
    const owner = this.sessionOwners.get(key)
    return (owner !== undefined && owner !== exclude)
      || this.dependencies.tasks.list(undefined, true).some(task =>
        task.executions.some(execution => execution.id !== exclude && isOpen(execution) && execution.connection !== undefined
          && connectionKey(execution.connection) === key))
  }

  private assertAvailable(connection: TaskConnection, exclude?: TaskExecutionId): void {
    if (this.activeConnection(connection, exclude)) {
      throw new TaskboardExecutionError('busy', 'Another task is using the connected conversation')
    }
  }

  private reserve(connection: TaskConnection): () => void {
    if (this.busy(connection)) throw new TaskboardExecutionError('busy', 'Another task is using the connected conversation')
    const key = connectionKey(connection)
    this.reservations.add(key)
    return () => { this.reservations.delete(key) }
  }

  private enterAdmission(taskId: TaskId): () => void {
    const admission = this.admissions.get(taskId) ?? { count: 0 }
    admission.count += 1
    this.admissions.set(taskId, admission)
    return () => {
      admission.count -= 1
      if (admission.count === 0) this.admissions.delete(taskId)
    }
  }

  private async diagnose(taskId: TaskId, executionId: TaskExecutionId, code: string, error: unknown): Promise<void> {
    await this.guard(this.lifetime.signal)
    await this.dependencies.tasks.recordExecutionError({ taskId, executionId, error: { code, message: errorMessage(error) } })
  }

  private async fail(taskId: TaskId, executionId: TaskExecutionId, code: string, message: string): Promise<void> {
    await this.settle(taskId, this.requireExecution(taskId, executionId), 'failed', { code, message })
  }

  private async settle(
    taskId: TaskId, execution: TaskExecution, status: 'succeeded' | 'failed' | 'cancelled', error?: TaskExecution['error'],
  ): Promise<void> {
    await this.guard(this.lifetime.signal)
    const task = await this.dependencies.tasks.settleExecution({
      taskId, executionId: execution.id, status, ...(error === undefined ? {} : { error }),
    })
    const acknowledged = task.executions.find(candidate => candidate.id === execution.id) ?? execution
    try {
      await this.dependencies.adapters[execution.executionSettings.kind].release?.(acknowledged)
    } catch (cleanup: unknown) {
      this.dependencies.reportError(cleanup)
    } finally {
      if (execution.connection !== undefined) this.releaseOwner(execution.connection, execution.id)
    }
  }

  private requireTask(taskId: TaskId): TaskboardTask {
    const task = this.dependencies.tasks.get(taskId)
    if (task === undefined) throw new TaskboardTaskNotFoundError(taskId)
    return task
  }

  private requireExecution(taskId: TaskId, executionId: TaskExecutionId): TaskExecution {
    const execution = this.requireTask(taskId).executions.find(candidate => candidate.id === executionId)
    if (execution === undefined) throw new Error(`Taskboard execution '${executionId}' is unavailable`)
    return execution
  }

  private releaseOwner(connection: TaskConnection, executionId: TaskExecutionId): void {
    const key = connectionKey(connection)
    if (this.sessionOwners.get(key) === executionId) this.sessionOwners.delete(key)
  }

  private operationSignal(caller?: AbortSignal, enabled?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.lifetime.signal, AbortSignal.timeout(this.config.operationTimeoutMs),
      ...(caller === undefined ? [] : [caller]), ...(enabled === undefined ? [] : [enabled]),
    ])
  }

  private isStopped(): boolean {
    return this.lifetime.signal.aborted
  }

  private async guard(signal: AbortSignal, enabled = false): Promise<void> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    await this.dependencies.assertOwned()
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (enabled && !this.dependencies.settings().enabled) throw new TaskboardExecutionError('execution-state', 'Taskboard is disabled')
  }
}

function connectionKey(connection: TaskConnection): string {
  return `${connection.kind}:${connection.sessionId}`
}

function isOpen(execution: TaskExecution): boolean {
  return execution.status === 'pending' || execution.status === 'running'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
