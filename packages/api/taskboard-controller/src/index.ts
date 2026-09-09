/** Host Taskboard Remote owner: revision-checked commands and reconnect-safe state. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  AgencyCopilotSessionId, TaskboardInputError, TaskboardMoveInvalidError, TaskboardRevisionConflictError,
  TaskboardSessionInvalidError, TaskboardTaskArchivedError, TaskboardTaskNotFoundError,
  TaskboardWorkspaceNotFoundError,
} from '@deepseek-ai/dsh-taskboard'
import type { TaskboardDeleteValue } from '@deepseek-ai/dsh-taskboard/types'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  AgencyCopilotHost, AgencyCopilotLaunchError, AgencyCopilotUnavailableError,
} from './agency.ts'
import type { AgencyCopilotHostInternals } from './agency.ts'
import { TaskboardFeed } from './feed.ts'
import type {
  AgencyCopilotObservation, AgencyCopilotSessionOption, TaskboardAgencyCopilotCapabilityValue,
  TaskboardArchiveRequest, TaskboardClearAgencyCopilotRequest,
  TaskboardCreateRequest, TaskboardDeleteRequest, TaskboardFollowFrame, TaskboardInspectAgencyCopilotRequest,
  TaskboardInspectAgencyCopilotValue, TaskboardListRequest, TaskboardOpenAgencyCopilotRequest,
  TaskboardListAgencyCopilotSessionsRequest, TaskboardListAgencyCopilotSessionsValue,
  TaskboardOpenAgencyCopilotValue, TaskboardErrorDetailsMap, TaskboardListValue, TaskboardMoveRequest,
  TaskboardStartAgencyCopilotRequest, TaskboardStartAgencyCopilotValue, TaskboardTask, TaskboardTaskValue, TaskboardUpdateRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { /** Host Taskboard business API and Remote namespace owner. */ taskboardController: TaskboardController }
}

/** Deployment policy for native Agency Copilot terminal handoff. */
export interface Config {
  /**
   * Permit native Start/Open for a loopback-only Web deployment; Windows and non-SSH checks still apply.
   * Discovery and linking remain independent.
   */
  readonly agencyCopilotLaunch?: boolean
}

/** Testable Host process seams for Agency Copilot without launching a real terminal. */
export interface TaskboardControllerInternals { readonly agency?: AgencyCopilotHostInternals }

interface AgencyOpenAdmission {
  readonly promise: Promise<TaskboardOpenAgencyCopilotValue>
  settledAt?: number
}

const AGENCY_OPEN_COOLDOWN_MS = 30_000
const AGENCY_OPEN_TIMEOUT_MS = 20_000

/** Host service backing the generated `ctx.remote.taskboard` namespace. */
export class TaskboardController extends TypertRemoteService {
  static Config: Schema<Config> = Schema.object({ agencyCopilotLaunch: Schema.boolean().default(false) })
  static inject = ['typert', 'taskboard', 'workspaceRegistry']
  private readonly feed: TaskboardFeed
  private readonly agency: AgencyCopilotHost
  private readonly agencyCopilotLaunch: boolean
  private readonly agencyTaskTails = new Map<TaskboardStartAgencyCopilotRequest['taskId'], Promise<void>>()
  private readonly agencyOpenEvictions = new Set<ReturnType<typeof setTimeout>>()
  private readonly agencyOpens = new Map<string, AgencyOpenAdmission>()

  constructor(ctx: Context, config: Config = {}, internals: TaskboardControllerInternals = {}) {
    super(ctx, 'taskboardController', { namespace: 'taskboard' })
    this.feed = new TaskboardFeed(ctx)
    this.agencyCopilotLaunch = config.agencyCopilotLaunch ?? false
    this.agency = new AgencyCopilotHost(ctx, internals.agency)
    ctx.effect(() => () => {
      for (const timer of this.agencyOpenEvictions) clearTimeout(timer)
      this.agencyOpenEvictions.clear()
      this.agencyOpens.clear()
    }, 'taskboard-controller.agencyOpenCooldowns')
  }

  /** Return active and archived tasks belonging to registered Workspaces.
   * @param request - Optional Workspace filter.
   * @returns matching tasks; archived rows retain their status and archivedAt.
   */
  @Remote('list')
  list(request: TaskboardListRequest): Promise<TaskboardListValue> {
    return Promise.resolve(this.feed.baseline(request.workspaceId))
  }

  /** Create content and an optional existing Agency link in one durable write.
   * @param request - Initial task fields; selected Agency identities must be discoverable in the Workspace.
   * @param signal - Caller cancellation before the durable write begins.
   * @returns committed task; selection never launches Copilot or changes planning status.
   */
  @Remote('create')
  async create(
    request: TaskboardCreateRequest,
    signal?: AbortSignal,
  ): Promise<TaskboardTaskValue> {
    const cancellation = signal ?? new AbortController().signal
    try {
      cancellation.throwIfAborted()
      if (request.agencyCopilotSessionId !== undefined) {
        await this.assertAgencySelection(request.workspaceId, request.agencyCopilotSessionId, cancellation)
      }
      return { task: await this.ctx.taskboard.create(request, cancellation) }
    }
    catch (error) { throw mapFailure(error) }
  }

  /** Update task content or linkage with revision CAS.
   * @param request - Exact revision and field patch; only changed Agency identities require discovery.
   * @param signal - Caller cancellation before the durable write begins.
   * @returns content and links committed together without launching Copilot or changing planning status.
   */
  @Remote('update')
  async update(
    request: TaskboardUpdateRequest,
    signal?: AbortSignal,
  ): Promise<TaskboardTaskValue> {
    const cancellation = signal ?? new AbortController().signal
    cancellation.throwIfAborted()
    const release = await this.acquireAgencyTask(request.taskId, cancellation)
    try {
      const current = this.requireActiveTask(request.taskId)
      if (current.revision !== request.expectedRevision) {
        throw new TaskboardRevisionConflictError(current.id, request.expectedRevision, current.revision)
      }
      const selected = request.patch.agencyCopilotSessionId
      if (selected !== undefined && selected !== null && selected !== current.agencyCopilotSessionId) {
        await this.assertAgencySelection(current.workspaceId, selected, cancellation)
      }
      return { task: await this.ctx.taskboard.update(request, cancellation) }
    }
    catch (error) { throw mapFailure(error) }
    finally { release() }
  }

  /** Move a task with revision CAS.
   * @param request - Exact revision and destination.
   * @returns committed task.
   */
  @Remote('move')
  async move(request: TaskboardMoveRequest): Promise<TaskboardTaskValue> {
    try { return { task: await this.ctx.taskboard.move(request) } }
    catch (error) { throw mapFailure(error) }
  }

  /** Archive a task with revision CAS.
   * @param request - Exact revision archive request.
   * @returns committed archived task.
   */
  @Remote('archive')
  async archive(request: TaskboardArchiveRequest): Promise<TaskboardTaskValue> {
    const release = await this.acquireAgencyTask(request.taskId)
    try { return { task: await this.ctx.taskboard.archive(request.taskId, request.expectedRevision) } }
    catch (error) { throw mapFailure(error) }
    finally { release() }
  }

  /**
   * Delete an active or archived task, serialized with Agency operations, without changing linked Sessions or terminals.
   * @param request - Task identity and exact current revision; stale or missing tasks reject without retry.
   * @param signal - Cancellation before durable deletion begins; an in-flight deletion settles normally.
   * @returns the committed task removal and its authoritative tombstone revision.
   */
  @Remote('delete')
  async delete(request: TaskboardDeleteRequest, signal?: AbortSignal): Promise<TaskboardDeleteValue> {
    signal?.throwIfAborted()
    const release = await this.acquireAgencyTask(request.taskId, signal)
    try { return await this.ctx.taskboard.delete(request.taskId, request.expectedRevision, signal) }
    catch (error: unknown) { throw mapFailure(error) }
    finally { release() }
  }

  /**
   * Report whether this Host deployment permits native Agency Copilot launch.
   * @returns true only for a loopback-bound Web server outside SSH.
   */
  @Remote('agencyCopilotCapability')
  agencyCopilotCapability(): TaskboardAgencyCopilotCapabilityValue {
    return { launch: this.localAgencyLaunchAvailable() }
  }

  /**
   * Discover existing local Copilot sessions matching a registered Workspace's canonical folder.
   * @param request - Registered Workspace whose sessions are selectable.
   * @param signal - Caller cancellation for discovery and folder resolution.
   * @returns safe session metadata and bounded-scan truncation; discovery failures reject explicitly.
   */
  @Remote('listAgencyCopilotSessions')
  async listAgencyCopilotSessions(
    request: TaskboardListAgencyCopilotSessionsRequest,
    signal: AbortSignal,
  ): Promise<TaskboardListAgencyCopilotSessionsValue> {
    signal.throwIfAborted()
    const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
    if (workspace === undefined) throw mapFailure(new TaskboardWorkspaceNotFoundError(request.workspaceId))
    let scan
    try { scan = await this.agency.list(signal) }
    catch (error: unknown) {
      if (signal.aborted) throw error
      throw agencyFailure(error)
    }
    const sessions: AgencyCopilotSessionOption[] = []
    for (const row of scan.sessions.values()) {
      signal.throwIfAborted()
      if (await sameWorkspace(row.folder, workspace.path)) {
        sessions.push({
          sessionId: row.sessionId,
          status: row.status,
          ...(row.summary === undefined ? {} : { summary: row.summary }),
        })
      }
    }
    signal.throwIfAborted()
    return { sessions, truncated: !scan.complete }
  }

  private async assertAgencySelection(
    workspaceId: WorkspaceId,
    sessionId: NonNullable<TaskboardCreateRequest['agencyCopilotSessionId']>,
    signal: AbortSignal,
  ): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw mapFailure(new TaskboardWorkspaceNotFoundError(workspaceId))
    let scan
    try { scan = await this.agency.inspect([sessionId], signal) }
    catch (error: unknown) {
      if (signal.aborted) throw error
      throw agencyFailure(error)
    }
    signal.throwIfAborted()
    const observed = scan.sessions.get(sessionId)
    if (observed === undefined) {
      if (!scan.complete) throw failure('agency-unavailable', 'Agency Copilot session discovery is incomplete', {})
      throw failure('bad-request', 'Selected Agency Copilot session is not discoverable', {})
    }
    const matching = await sameWorkspace(observed.folder, workspace.path)
    signal.throwIfAborted()
    if (!matching) throw failure('bad-request', 'Selected Agency Copilot session does not match the task Workspace', {})
  }

  /**
   * Start a fresh local Agency Copilot terminal and persist its generated identity first.
   * @param request - Task identity and exact current revision.
   * @param signal - Caller cancellation before commit or terminal handoff acceptance.
   * @returns the committed linked task and accepted-launch receipt.
   */
  @Remote('startAgencyCopilot')
  async startAgencyCopilot(
    request: TaskboardStartAgencyCopilotRequest,
    signal: AbortSignal,
  ): Promise<TaskboardStartAgencyCopilotValue> {
    signal.throwIfAborted()
    this.assertLocalAgencyLaunch()
    const release = await this.acquireAgencyTask(request.taskId, signal)
    try {
      const current = this.requireActiveTask(request.taskId)
      if (current.revision !== request.expectedRevision) {
        throw mapFailure(new TaskboardRevisionConflictError(current.id, request.expectedRevision, current.revision))
      }
      if (current.agencyCopilotSessionId !== undefined) {
        throw failure('agency-already-linked', 'Task already has an Agency Copilot session', { taskId: current.id })
      }
      try { await this.agency.preflight(signal) }
      catch (error: unknown) { throw agencyFailure(error, current.id) }
      const sessionId = AgencyCopilotSessionId(randomUUID())
      let linked
      try {
        linked = await this.ctx.taskboard.setAgencyCopilotSession({
          taskId: current.id, expectedRevision: request.expectedRevision, agencyCopilotSessionId: sessionId,
        })
      } catch (error: unknown) {
        throw mapFailure(error)
      }
      const workspace = this.ctx.workspaceRegistry.get(linked.workspaceId)
      if (workspace === undefined) throw mapFailure(new TaskboardWorkspaceNotFoundError(linked.workspaceId))
      const launchSignal = AbortSignal.timeout(AGENCY_OPEN_TIMEOUT_MS)
      try {
        await this.agency.launchNew(workspace.path, sessionId, agencyTaskPrompt(linked), launchSignal)
      } catch (error: unknown) {
        if (launchSignal.aborted) {
          throw failure('agency-launch-failed', 'Agency Copilot terminal launch timed out', { taskId: linked.id })
        }
        throw agencyFailure(error, linked.id)
      }
      this.rememberAgencyOpen(sessionId, Promise.resolve({ outcome: 'launch-pending' }))
      return { task: await this.moveStartedTask(linked), launch: 'accepted' }
    } finally { release() }
  }

  /**
   * Clear one task's Agency Copilot identity without touching its terminal process.
   * @param request - Task identity and exact current revision.
   * @returns the committed task without an Agency Copilot link.
   */
  @Remote('clearAgencyCopilot')
  async clearAgencyCopilot(request: TaskboardClearAgencyCopilotRequest): Promise<TaskboardTaskValue> {
    const release = await this.acquireAgencyTask(request.taskId)
    try {
      return { task: await this.ctx.taskboard.setAgencyCopilotSession({
        taskId: request.taskId,
        expectedRevision: request.expectedRevision,
        agencyCopilotSessionId: null,
      }) }
    } catch (error: unknown) {
      throw mapFailure(error)
    } finally { release() }
  }

  /**
   * Open a linked Copilot identity: report active, resume idle, or retry an identity not yet materialized.
   * @param request - Task whose durable Copilot identity is addressed.
   * @param signal - Caller cancellation for status discovery and terminal handoff.
   * @returns whether Copilot was already running or a launch handoff was accepted.
   */
  @Remote('openAgencyCopilot')
  async openAgencyCopilot(
    request: TaskboardOpenAgencyCopilotRequest,
    signal: AbortSignal,
  ): Promise<TaskboardOpenAgencyCopilotValue> {
    signal.throwIfAborted()
    this.assertLocalAgencyLaunch()
    const task = this.requireActiveTask(request.taskId)
    const sessionId = task.agencyCopilotSessionId
    if (sessionId === undefined) {
      throw failure('agency-not-linked', 'Task has no Agency Copilot session', { taskId: task.id })
    }
    const pending = this.agencyOpens.get(sessionId)
    if (pending !== undefined) {
      if (pending.settledAt === undefined || Date.now() - pending.settledAt < AGENCY_OPEN_COOLDOWN_MS) {
        return waitForCaller(pending.promise, signal)
      }
      this.agencyOpens.delete(sessionId)
    }
    const opening = this.doOpenAgencyCopilot(task.id, sessionId, AbortSignal.timeout(AGENCY_OPEN_TIMEOUT_MS))
    this.rememberAgencyOpen(sessionId, opening)
    return waitForCaller(opening, signal)
  }

  private async doOpenAgencyCopilot(
    taskId: TaskboardStartAgencyCopilotRequest['taskId'],
    sessionId: NonNullable<ReturnType<TaskboardController['requireActiveTask']>['agencyCopilotSessionId']>,
    signal: AbortSignal,
  ): Promise<TaskboardOpenAgencyCopilotValue> {
    const release = await this.acquireAgencyTask(taskId, signal)
    try {
      const task = this.requireActiveTask(taskId)
      if (task.agencyCopilotSessionId !== sessionId) {
        throw failure('agency-not-linked', 'Task Agency Copilot link changed before status inspection', { taskId })
      }
      const workspace = this.ctx.workspaceRegistry.get(task.workspaceId)
      if (workspace === undefined) throw mapFailure(new TaskboardWorkspaceNotFoundError(task.workspaceId))
      let scan
      try { scan = await this.agency.inspect([sessionId], signal) }
      catch (error: unknown) {
        if (signal.aborted) throw failure('agency-unavailable', 'Agency Copilot open timed out', {})
        throw agencyFailure(error, task.id)
      }
      const latest = this.requireActiveTask(task.id)
      if (latest.agencyCopilotSessionId !== sessionId || latest.workspaceId !== task.workspaceId) {
        throw failure('agency-not-linked', 'Task Agency Copilot link changed during status inspection', { taskId: task.id })
      }
      const observed = scan.sessions.get(sessionId)
      if (observed !== undefined) {
        if (!(await sameWorkspace(observed.folder, workspace.path))) {
          throw failure('agency-workspace-mismatch', 'Agency Copilot session belongs to another Workspace', { taskId: task.id })
        }
        if (observed.status === 'in_use') return { outcome: 'already-running' }
        try { await this.agency.resume(workspace.path, sessionId, signal) }
        catch (error: unknown) {
          if (signal.aborted) throw failure('agency-unavailable', 'Agency Copilot open timed out', {})
          throw agencyFailure(error, task.id)
        }
        return { outcome: 'resume-accepted' }
      }
      if (!scan.complete) throw failure('agency-unavailable', 'Agency Copilot session state is incomplete', {})
      try { await this.agency.launchNew(workspace.path, sessionId, agencyTaskPrompt(latest), signal) }
      catch (error: unknown) {
        if (signal.aborted) throw failure('agency-unavailable', 'Agency Copilot open timed out', {})
        throw agencyFailure(error, task.id)
      }
      return { outcome: 'create-retry-accepted' }
    } finally { release() }
  }

  /**
   * Inspect current Agency status for linked tasks without launching or mutating them.
   * @param request - Bounded task identities whose linked Copilot status is requested.
   * @param signal - Caller cancellation for bounded Agency status discovery.
   * @returns transient observations for the currently linked requested tasks.
   */
  @Remote('inspectAgencyCopilot')
  async inspectAgencyCopilot(
    request: TaskboardInspectAgencyCopilotRequest,
    signal: AbortSignal,
  ): Promise<TaskboardInspectAgencyCopilotValue> {
    if (request.taskIds.length > 100) throw failure('bad-request', 'At most 100 Copilot tasks may be inspected', {})
    const tasks = request.taskIds.flatMap((taskId) => {
      const task = this.ctx.taskboard.get(taskId)
      return task !== undefined && task.archivedAt === undefined && task.agencyCopilotSessionId !== undefined
        ? [{ task, sessionId: task.agencyCopilotSessionId }]
        : []
    })
    const ids = [...new Set(tasks.map(({ sessionId }) => sessionId))]
    let scan
    try { scan = await this.agency.inspect(ids, signal) }
    catch (error: unknown) {
      if (signal.aborted) throw error
      throw agencyFailure(error)
    }
    const observations: AgencyCopilotObservation[] = []
    for (const { task, sessionId } of tasks) {
      const observed = scan.sessions.get(sessionId)
      let status: AgencyCopilotObservation['status']
      if (observed === undefined) status = scan.complete ? 'missing' : 'unknown'
      else {
        const workspace = this.ctx.workspaceRegistry.get(task.workspaceId)
        status = workspace !== undefined && await sameWorkspace(observed.folder, workspace.path)
          ? observed.status
          : 'workspace_mismatch'
      }
      observations.push({ taskId: task.id, sessionId, status })
    }
    return { observations }
  }

  private rememberAgencyOpen(
    sessionId: NonNullable<ReturnType<TaskboardController['requireActiveTask']>['agencyCopilotSessionId']>,
    promise: Promise<TaskboardOpenAgencyCopilotValue>,
  ): void {
    const admission: AgencyOpenAdmission = { promise }
    this.agencyOpens.set(sessionId, admission)
    void promise.then(
      () => {
        admission.settledAt = Date.now()
        const timer = setTimeout(() => {
          this.agencyOpenEvictions.delete(timer)
          if (this.agencyOpens.get(sessionId) === admission) this.agencyOpens.delete(sessionId)
        }, AGENCY_OPEN_COOLDOWN_MS)
        this.agencyOpenEvictions.add(timer)
      },
      () => { if (this.agencyOpens.get(sessionId) === admission) this.agencyOpens.delete(sessionId) },
    )
  }

  private async moveStartedTask(task: ReturnType<TaskboardController['requireActiveTask']>) {
    if (task.status === 'in_progress') return task
    try {
      return await this.ctx.taskboard.move({
        taskId: task.id, expectedRevision: task.revision, status: 'in_progress',
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Taskboard linked and launched Agency Copilot but could not move task "${task.id}" to In Progress: ${String(error)}`)
      return this.ctx.taskboard.get(task.id) ?? task
    }
  }

  private async acquireAgencyTask(
    taskId: TaskboardStartAgencyCopilotRequest['taskId'],
    signal?: AbortSignal,
  ): Promise<() => void> {
    const prior = this.agencyTaskTails.get(taskId) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    const tail = prior.then(() => gate.promise)
    this.agencyTaskTails.set(taskId, tail)
    await prior
    const release = (): void => {
      gate.resolve()
      void tail.then(() => {
        if (this.agencyTaskTails.get(taskId) === tail) this.agencyTaskTails.delete(taskId)
      })
    }
    try { signal?.throwIfAborted() }
    catch (error: unknown) { release(); throw error }
    return release
  }

  private localAgencyLaunchAvailable(): boolean {
    const launch = launchEnvironmentOf(this.ctx)
    const ssh = ['SSH_CONNECTION', 'SSH_TTY'].some(name =>
      (launch.getFrom(name, ['process'])?.value ?? '') !== '')
    return this.agencyCopilotLaunch && this.agency.nativeLaunchSupported() && !ssh
  }

  private assertLocalAgencyLaunch(): void {
    if (!this.localAgencyLaunchAvailable()) {
      throw failure('agency-local-only', 'Agency Copilot launch requires a loopback-only DSH Web server', {})
    }
  }

  private requireActiveTask(taskId: TaskboardStartAgencyCopilotRequest['taskId']) {
    const task = this.ctx.taskboard.get(taskId)
    if (task === undefined) throw mapFailure(new TaskboardTaskNotFoundError(taskId))
    if (task.archivedAt !== undefined) throw mapFailure(new TaskboardTaskArchivedError(taskId))
    return task
  }

  /** Stream active and archived tasks followed by ordered upserts and removals.
   * @param signal - Generation cancellation.
   * @returns a registered-Workspace baseline followed by task changes, including archive upserts.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame> { return this.feed.follow(signal) }
}

function agencyTaskPrompt(task: TaskboardTask): string {
  return task.description === '' ? task.title : `${task.title}\n\n${task.description}`
}

function mapFailure(error: unknown): TypertRemoteFailure {
  if (error instanceof TypertRemoteFailure) return error
  if (error instanceof TaskboardTaskNotFoundError) {
    return failure('task-not-found', error.message, { taskId: error.taskId })
  }
  if (error instanceof TaskboardWorkspaceNotFoundError) {
    return failure('workspace-not-found', error.message, { workspaceId: error.workspaceId })
  }
  if (error instanceof TaskboardRevisionConflictError) {
    return failure('revision-conflict', error.message, {
      taskId: error.taskId, expectedRevision: error.expected, actualRevision: error.actual,
    })
  }
  if (error instanceof TaskboardSessionInvalidError) {
    return failure('session-invalid', error.message, { workspaceId: error.workspaceId, sessionId: error.sessionId })
  }
  if (error instanceof TaskboardTaskArchivedError) {
    return failure('task-archived', error.message, { taskId: error.taskId })
  }
  if (error instanceof TaskboardMoveInvalidError) {
    return failure('move-invalid', error.message, { beforeTaskId: error.beforeTaskId })
  }
  if (error instanceof TaskboardInputError) return failure('bad-request', error.message, {})
  throw error
}

function failure<Code extends keyof TaskboardErrorDetailsMap>(
  code: Code,
  message: string,
  details: TaskboardErrorDetailsMap[Code],
): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message, details })
}


function errorOf(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : fallback)
}

function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      dispose()
      reject(errorOf(signal.reason, 'Taskboard Agency Copilot caller aborted'))
    }
    const dispose = (): void => { signal.removeEventListener('abort', aborted) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(
      (value) => { dispose(); resolve(value) },
      (error: unknown) => { dispose(); reject(errorOf(error, 'Taskboard Agency Copilot open failed')) },
    )
  })
}

function agencyFailure(error: unknown, taskId?: TaskboardStartAgencyCopilotRequest['taskId']): TypertRemoteFailure {
  if (error instanceof AgencyCopilotLaunchError && taskId !== undefined) {
    return failure('agency-launch-failed', error.message, { taskId })
  }
  if (error instanceof AgencyCopilotUnavailableError) return failure('agency-unavailable', error.message, {})
  throw error
}

async function sameWorkspace(folder: string | undefined, workspacePath: string): Promise<boolean> {
  if (folder === undefined) return false
  try { return await realpathNormalize(folder) === workspacePath }
  catch { return false }
}

export default TaskboardController
