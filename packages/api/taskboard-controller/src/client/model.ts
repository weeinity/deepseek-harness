/** React-free Client Taskboard model over unary mutations and a snapshot stream. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-api-taskboard-controller/remote'
import type { TaskboardDeleteValue, TaskboardTask, TaskId } from '@deepseek-ai/dsh-taskboard/types'
import type { RemoteFailure, RemoteResult, TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgencyCopilotObservation, TaskboardAgencyCopilotCapabilityValue, TaskboardArchiveRequest, TaskboardBaseline,
  TaskboardConnectRequest, TaskboardConfirmPermissionsRequest, TaskboardDisconnectRequest, TaskboardDuplicateRequest,
  TaskboardCreateRequest, TaskboardDeleteRequest, TaskboardInspectAgencyCopilotRequest, TaskboardInspectAgencyCopilotValue,
  TaskboardListAgencyCopilotSessionsRequest, TaskboardListAgencyCopilotSessionsValue,
  TaskboardMoveRequest, TaskboardOpenAgencyCopilotRequest, TaskboardOpenAgencyCopilotValue,
  TaskboardExecutionOptionsValue, TaskboardRestoreRequest, TaskboardRunRequest, TaskboardRunValue, TaskboardRuntimeState,
  TaskboardTaskValue, TaskboardUpdateRequest, TaskboardUpdateSettingsRequest,
} from '../types.ts'

/** Complete generated Taskboard Remote namespace. */
export type TaskboardRemote = TypertClientRemote['taskboard']
/** Monotone task-list arrival lifecycle. */
export type TaskboardListPhase = 'pending' | 'ready'

/** Immutable Client Taskboard state. */
export interface TaskboardSnapshot {
  /** Active and archived tasks; archivedAt distinguishes read-only archive rows. */
  readonly tasks: readonly TaskboardTask[]
  readonly state: 'idle' | 'loading' | 'error'
  readonly phase: TaskboardListPhase
  readonly error: RemoteFailure | null
  /** Undefined until a Host baseline arrives; never inferred from browser defaults. */
  readonly runtime: TaskboardRuntimeState | undefined
  /** Transient Agency status keyed by task; absent means not inspected yet. */
  readonly agencyByTask: Readonly<Partial<Record<TaskId, AgencyCopilotObservation>>>
  readonly agencyState: 'idle' | 'loading' | 'error'
  readonly agencyError: RemoteFailure | null
}

/** State operations emitted by a decoded Taskboard follow generation. */
export interface TaskboardFollowSink {
  replaceBaseline(value: TaskboardBaseline): void
  upsertTask(task: TaskboardTask): void
  removeTask(taskId: TaskId, revision: number): void
  replaceRuntime(value: TaskboardRuntimeState): void
}

/** Owns Client Taskboard projection, unary echoes, and subscriptions. */
export class ClientTaskboardModel implements TaskboardFollowSink {
  private tasks: readonly TaskboardTask[] = []
  private state: TaskboardSnapshot['state'] = 'loading'
  private phase: TaskboardListPhase = 'pending'
  private error: RemoteFailure | null = null
  private runtime: TaskboardRuntimeState | undefined
  private readonly agencyObservations = new Map<TaskId, AgencyCopilotObservation>()
  private readonly agencyRequestTokens = new Map<TaskId, number>()
  private agencyState: TaskboardSnapshot['agencyState'] = 'idle'
  private agencyError: RemoteFailure | null = null
  private agencyRequestGeneration = 0
  private agencyPendingRequests = 0
  private readonly listeners = new Set<() => void>()
  private readonly removedRevisions = new Map<TaskId, number>()
  private snapshotCache: TaskboardSnapshot
  private snapshotDirty = false
  private notificationScheduled = false

  /** @param remote - Generated Taskboard Remote namespace. */
  constructor(private readonly remote: TaskboardRemote) { this.snapshotCache = this.buildSnapshot() }

  /** Forward create and install its echo.
   * @param request - Validated create request.
   * @returns generated Remote result.
   */
  async create(request: TaskboardCreateRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.create(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Forward update and install its echo.
   * @param request - Revision-checked update request.
   * @returns generated Remote result.
   */
  async update(request: TaskboardUpdateRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.update(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Forward move and install its echo.
   * @param request - Revision-checked move request.
   * @returns generated Remote result.
   */
  async move(request: TaskboardMoveRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.move(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Forward archive and retain its committed archived row.
   * @param request - Revision-checked archive request.
   * @returns generated Remote result.
   */
  async archive(request: TaskboardArchiveRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.archive(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /**
   * Delete one task and install its tombstone only after a successful Remote result.
   * @param request - Exact task revision to delete without retrying.
   * @returns generated Remote removal receipt or failure.
   */
  async delete(request: TaskboardDeleteRequest): Promise<RemoteResult<TaskboardDeleteValue>> {
    const result = await this.remote.delete(request)
    if (result.ok) this.removeTask(result.value.taskId, result.value.revision)
    return result
  }

  /** Read the Host's native Agency Copilot launch capability.
   * @returns generated Remote capability result.
   */
  agencyCopilotCapability(): Promise<RemoteResult<TaskboardAgencyCopilotCapabilityValue>> {
    return this.remote.agencyCopilotCapability()
  }

  /**
   * Discover existing local Copilot sessions without changing the task snapshot.
   * @param request - Workspace whose matching local sessions are requested.
   * @returns generated Remote discovery result, including incomplete-scan status.
   */
  listAgencyCopilotSessions(
    request: TaskboardListAgencyCopilotSessionsRequest,
  ): Promise<RemoteResult<TaskboardListAgencyCopilotSessionsValue>> {
    return this.remote.listAgencyCopilotSessions(request)
  }

  /**
   * Dispatch work and install the Host's acknowledged task and attempt.
   * @param request - Exact saved revision and stable retry identity.
   * @returns generated dispatch acknowledgement, not model completion.
   */
  async run(request: TaskboardRunRequest): Promise<RemoteResult<TaskboardRunValue>> {
    const result = await this.remote.run(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /**
   * Associate an existing conversation without submitting work.
   * @param request - Revision-checked connection selection.
   * @returns committed task result.
   */
  async connect(request: TaskboardConnectRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.connect(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Disconnect the current conversation.
   * @param request - Exact saved revision.
   * @returns committed task result.
   */
  async disconnect(request: TaskboardDisconnectRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.disconnect(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Restore an archived task.
   * @param request - Exact archived revision.
   * @returns committed task result with its schedule disabled.
   */
  async restore(request: TaskboardRestoreRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.restore(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Duplicate saved task fields.
   * @param request - Exact source revision.
   * @returns independent committed task result.
   */
  async duplicate(request: TaskboardDuplicateRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.duplicate(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Confirm saved permission and handover inputs.
   * @param request - Exact saved revision.
   * @returns committed task result.
   */
  async confirmPermissions(request: TaskboardConfirmPermissionsRequest): Promise<RemoteResult<TaskboardTaskValue>> {
    const result = await this.remote.confirmPermissions(request)
    if (result.ok) this.upsertTask(result.value.task)
    return result
  }

  /** Load authoritative presets, permissions, models, and execution availability.
   * @returns Host option catalog.
   */
  executionOptions(): Promise<RemoteResult<TaskboardExecutionOptionsValue>> { return this.remote.executionOptions() }

  /** Persist switches; follow frames supply ordered runtime state.
   * @param request - Explicit setting changes.
   * @returns committed Host runtime state.
   */
  updateSettings(request: TaskboardUpdateSettingsRequest): Promise<RemoteResult<TaskboardRuntimeState>> {
    return this.remote.updateSettings(request)
  }

  /**
   * Best-effort open/resume handoff for a linked Agency Copilot identity.
   * @param request - Task whose durable external identity is addressed.
   * @returns generated Remote result describing the handoff outcome.
   */
  openAgencyCopilot(request: TaskboardOpenAgencyCopilotRequest): Promise<RemoteResult<TaskboardOpenAgencyCopilotValue>> {
    return this.remote.openAgencyCopilot(request)
  }

  /**
   * Refresh transient Agency observations without affecting durable Taskboard state.
   * @param request - Linked task identities to inspect.
   * @returns generated Remote result carrying transient observations.
   */
  async inspectAgencyCopilot(
    request: TaskboardInspectAgencyCopilotRequest,
  ): Promise<RemoteResult<TaskboardInspectAgencyCopilotValue>> {
    const generation = ++this.agencyRequestGeneration
    const taskIds = [...new Set(request.taskIds)]
    for (const taskId of taskIds) this.agencyRequestTokens.set(taskId, generation)
    this.agencyPendingRequests += 1
    this.agencyState = 'loading'
    this.agencyError = null
    this.invalidate()
    let result: RemoteResult<TaskboardInspectAgencyCopilotValue>
    try {
      result = await this.remote.inspectAgencyCopilot({ taskIds })
    } catch (error: unknown) {
      this.settleAgencyRequest(taskIds, generation, failureOf(error))
      throw error
    }
    if (!result.ok) {
      this.settleAgencyRequest(taskIds, generation, result.error)
      return result
    }
    for (const taskId of taskIds) {
      if (this.agencyRequestTokens.get(taskId) === generation) this.agencyObservations.delete(taskId)
    }
    for (const observation of result.value.observations) {
      if (this.agencyRequestTokens.get(observation.taskId) !== generation) continue
      const task = this.tasks.find(candidate => candidate.id === observation.taskId)
      if (task?.archivedAt === undefined && task?.connection?.kind === 'copilot'
        && task.connection.sessionId === observation.sessionId) {
        this.agencyObservations.set(observation.taskId, observation)
      }
    }
    this.settleAgencyRequest(taskIds, generation, null)
    return result
  }

  /** Replace membership from a complete baseline without rolling back known task revisions.
   * @param baseline - Complete active and archived task set; absent rows are removed.
   */
  replaceBaseline(baseline: TaskboardBaseline): void {
    const incoming = baseline.tasks.filter((task) => {
      const removed = this.removedRevisions.get(task.id)
      if (removed === undefined || task.revision > removed) return true
      return false
    })
    const byId = new Map(incoming.map(task => [task.id, task]))
    for (const task of this.tasks) {
      const baselineTask = byId.get(task.id)
      if (baselineTask !== undefined && task.revision > baselineTask.revision) byId.set(task.id, task)
    }
    this.tasks = [...byId.values()].sort(compareTasks)
    this.runtime = baseline.runtime
    this.pruneAgencyObservations()
    this.state = 'idle'
    this.phase = 'ready'
    this.error = null
    this.invalidate()
  }

  /** Merge a task unless a newer removal exists.
   * @param task - Complete revisioned task.
   */
  upsertTask(task: TaskboardTask): void {
    const removed = this.removedRevisions.get(task.id)
    if (removed !== undefined && removed >= task.revision) return
    if (removed !== undefined) this.removedRevisions.delete(task.id)
    const index = this.tasks.findIndex(candidate => candidate.id === task.id)
    const current = this.tasks[index]
    if (current !== undefined && current.revision > task.revision) return
    this.tasks = (index === -1
      ? [...this.tasks, task]
      : this.tasks.map((candidate, position) => position === index ? task : candidate))
      .sort(compareTasks)
    const observation = this.agencyObservations.get(task.id)
    if (observation !== undefined
      && (task.archivedAt !== undefined || task.connection?.kind !== 'copilot'
        || observation.sessionId !== task.connection.sessionId)) {
      this.agencyObservations.delete(task.id)
    }
    this.invalidate()
  }

  /** Replace ordered Host runtime observations.
   * @param value - Complete settings, scheduler, and power state.
   */
  replaceRuntime(value: TaskboardRuntimeState): void {
    if (this.runtime === value) return
    this.runtime = value
    this.invalidate()
  }

  /** Retire a task at an authoritative revision.
   * @param taskId - Retired identity.
   * @param revision - Removal revision.
   */
  removeTask(taskId: TaskId, revision: number): void {
    const prior = this.removedRevisions.get(taskId)
    if (prior === undefined || revision > prior) this.removedRevisions.set(taskId, revision)
    const current = this.tasks.find(task => task.id === taskId)
    if (current !== undefined && current.revision > revision) return
    const tasks = this.tasks.filter(task => task.id !== taskId)
    if (tasks.length === this.tasks.length) return
    this.tasks = tasks
    this.agencyObservations.delete(taskId)
    this.invalidate()
  }

  /** Keep stale state visible while transport reconnects. */
  handleCarrierFailure(): void {
    this.state = 'loading'
    this.error = null
    this.invalidate()
  }

  /** Publish terminal stream failure.
   * @param error - Stream or protocol failure.
   */
  handleStreamFailure(error: unknown): void {
    this.state = 'error'
    this.error = failureOf(error)
    this.invalidate()
  }

  /** Subscribe to snapshot invalidation.
   * @param listener - Invalidation callback.
   * @returns unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Read current state.
   * @returns identity-stable snapshot.
   */
  getSnapshot(): TaskboardSnapshot {
    this.refreshSnapshot()
    return this.snapshotCache
  }

  private buildSnapshot(): TaskboardSnapshot {
    return {
      tasks: this.tasks, state: this.state, phase: this.phase, error: this.error, runtime: this.runtime,
      agencyByTask: Object.fromEntries(this.agencyObservations),
      agencyState: this.agencyState, agencyError: this.agencyError,
    }
  }

  private pruneAgencyObservations(): void {
    const live = new Map(this.tasks
      .filter(task => task.archivedAt === undefined)
      .map(task => [task.id, task.connection?.kind === 'copilot' ? task.connection.sessionId : undefined]))
    for (const [taskId, observation] of this.agencyObservations) {
      if (live.get(taskId) !== observation.sessionId) this.agencyObservations.delete(taskId)
    }
  }

  private settleAgencyRequest(taskIds: readonly TaskId[], generation: number, error: RemoteFailure | null): void {
    let relevant = false
    for (const taskId of taskIds) {
      if (this.agencyRequestTokens.get(taskId) !== generation) continue
      relevant = true
      this.agencyRequestTokens.delete(taskId)
    }
    this.agencyPendingRequests -= 1
    if (relevant) this.agencyError = error
    this.agencyState = this.agencyPendingRequests > 0 ? 'loading' : this.agencyError === null ? 'idle' : 'error'
    this.invalidate()
  }

  private invalidate(): void {
    this.snapshotDirty = true
    if (this.notificationScheduled) return
    this.notificationScheduled = true
    queueMicrotask(() => {
      this.notificationScheduled = false
      this.refreshSnapshot()
      notifySubscribers(this.listeners, '[taskboard-controller]')
    })
  }

  private refreshSnapshot(): void {
    if (!this.snapshotDirty) return
    this.snapshotDirty = false
    this.snapshotCache = this.buildSnapshot()
  }
}

const STATUS_ORDER = ['backlog', 'todo', 'in_progress', 'in_review', 'done'] as const

function compareTasks(left: TaskboardTask, right: TaskboardTask): number {
  return STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status)
    || left.rank - right.rank
    || left.ordinal - right.ordinal
    || String(left.id).localeCompare(String(right.id))
}

function failureOf(error: unknown): RemoteFailure {
  return remoteErrorOf(error)
    ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}, { cause: error })
}
