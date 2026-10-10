/** Host Taskboard commands, exclusive conversation linkage, and durable execution control. */
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-permission-presets'
import {
  TaskboardExecutionError, TaskboardInputError, TaskboardMoveInvalidError, TaskboardRevisionConflictError,
  TaskboardSessionInvalidError, TaskboardTaskArchivedError, TaskboardTaskNotFoundError,
  TaskboardWorkspaceNotFoundError,
} from '@deepseek-ai/dsh-taskboard'
import type {
  AgencyCopilotSessionId, TaskConnection, TaskExecutionId, TaskId, TaskboardDeleteValue, TaskboardTask,
} from '@deepseek-ai/dsh-taskboard/types'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { Remote, RemoteError, remoteErrorOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AgencyCopilotHost, AgencyCopilotLaunchError, AgencyCopilotUnavailableError } from './agency.ts'
import type { AgencyCopilotHostInternals } from './agency.ts'
import { TaskboardFeed } from './feed.ts'
import { createDshExecutionAdapter } from './runtime/dsh.ts'
import { CopilotTaskExecutionAdapter } from './runtime/copilot.ts'
import { TaskboardHostRuntime } from './runtime/index.ts'
import type { TaskboardHostConfig, TaskboardRuntimeHandle } from './runtime/index.ts'
import type { TaskboardRuntimeState } from './runtime-types.ts'
import type {
  AgencyCopilotObservation, AgencyCopilotSessionOption, TaskboardAgencyCopilotCapabilityValue,
  TaskboardArchiveRequest, TaskboardConfirmPermissionsRequest, TaskboardConnectRequest,
  TaskboardCreateRequest, TaskboardDeleteRequest, TaskboardDisconnectRequest, TaskboardDuplicateRequest,
  TaskboardExecutionOptionsValue, TaskboardFollowFrame, TaskboardInspectAgencyCopilotRequest,
  TaskboardInspectAgencyCopilotValue, TaskboardListAgencyCopilotSessionsRequest,
  TaskboardListAgencyCopilotSessionsValue, TaskboardListRequest, TaskboardListValue, TaskboardMoveRequest,
  TaskboardOpenAgencyCopilotRequest, TaskboardOpenAgencyCopilotValue, TaskboardRestoreRequest,
  TaskboardRunRequest, TaskboardRunValue, TaskboardTaskValue, TaskboardUpdateRequest,
  TaskboardUpdateSettingsRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Taskboard business API and Remote namespace owner. */
    taskboardController: TaskboardController
  }
}

/** Deployment policy for Taskboard execution, scheduling, and native integrations. */
export interface Config extends Partial<Omit<TaskboardHostConfig, 'enabled' | 'announceToAgent' | 'preventIdleSleep'>> {
  /** Admit manual runs and scheduled occurrences. */
  readonly enabled?: boolean
  /** Include the Taskboard usage section in subsequent model requests. */
  readonly announceToAgent?: boolean
  /** Request idle-sleep protection while work or armed schedules exist. */
  readonly preventIdleSleep?: boolean
  /** Permit local Copilot execution and terminal handoff in a loopback-only deployment. */
  readonly agencyCopilotLaunch?: boolean
  /** Suppress repeated terminal opens for this interval after an accepted handoff. */
  readonly agencyOpenCooldownMs?: number
  /** Deadline for native discovery and terminal handoff. */
  readonly agencyOpenTimeoutMs?: number
  /** Maximum persisted Copilot events read per recovery page. */
  readonly copilotRecoveryPageSize?: number
  /** Maximum pages read for one recovery observation. */
  readonly copilotRecoveryMaxPages?: number
}

interface ResolvedConfig extends TaskboardHostConfig {
  readonly agencyCopilotLaunch: boolean
  readonly agencyOpenCooldownMs: number
  readonly agencyOpenTimeoutMs: number
  readonly copilotRecoveryPageSize: number
  readonly copilotRecoveryMaxPages: number
}

interface CordisConfig extends Omit<ResolvedConfig, 'lockPath' | 'timeZone'> {
  readonly lockPath?: string
  readonly timeZone?: string
}

/** Native and runtime integrations replaceable by isolated Host tests. */
export interface TaskboardControllerInternals {
  readonly agency?: AgencyCopilotHostInternals
  readonly runtime?: TaskboardRuntimeHandle
  /** Profile entry identity supplied only when tests activate the controller without Loader metadata. */
  readonly settingsNamespace?: string
}

interface AgencyOpenAdmission {
  readonly promise: Promise<TaskboardOpenAgencyCopilotValue>
  settledAt?: number
}

/** Host owner of revision-checked planning and execution commands. */
export class TaskboardController extends TypertRemoteService {
  static Config: Schema<Config, CordisConfig> = Schema.object({
    agencyCopilotLaunch: Schema.boolean().default(false),
    agencyOpenCooldownMs: Schema.number().min(1).default(30_000),
    agencyOpenTimeoutMs: Schema.number().min(1).default(20_000),
    copilotRecoveryPageSize: Schema.number().min(1).default(100),
    copilotRecoveryMaxPages: Schema.number().min(1).default(100),
    enabled: Schema.boolean().default(true).volatile(),
    announceToAgent: Schema.boolean().default(false).volatile(),
    preventIdleSleep: Schema.boolean().default(false).volatile(),
    lockPath: Schema.string(),
    lockUpdateMs: Schema.number().min(1_000).default(10_000),
    lockMaxAcquireAttempts: Schema.number().min(1).default(3),
    timeZone: Schema.string(),
    pollIntervalMs: Schema.number().min(1).default(5_000),
    schedulerIntervalMs: Schema.number().min(1).default(30_000),
    schedulerRecoveryGapMs: Schema.number().min(1).default(45_000),
    operationTimeoutMs: Schema.number().min(1).default(20_000),
    powerReadinessTimeoutMs: Schema.number().min(1).default(10_000),
    powerShutdownTimeoutMs: Schema.number().min(1).default(3_000),
    powerKillTimeoutMs: Schema.number().min(1).default(3_000),
    powerRetryDelayMs: Schema.number().min(1).default(30_000),
    powerMaxRetries: Schema.number().min(0).default(3),
    powerMaxDiagnosticBytes: Schema.number().min(128).default(4_096),
    powerAssertionPollMs: Schema.number().min(1).default(250),
  })

  static inject = [
    'typert', 'taskboard', 'workspaceRegistry', 'sessionController', 'sessionPersistence',
    'sessions', 'sessionProjections', 'agents', 'agentPresets', 'permissionPresets',
    'settings', 'systemPrompt', 'llm',
  ]

  private readonly feed: TaskboardFeed
  private readonly agency: AgencyCopilotHost
  private readonly runtime: TaskboardRuntimeHandle
  private readonly config: ResolvedConfig
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly taskTails = new Map<TaskId, Promise<void>>()
  private readonly openEvictions = new Set<ReturnType<typeof setTimeout>>()
  private readonly opens = new Map<AgencyCopilotSessionId, AgencyOpenAdmission>()

  /**
   * @param ctx - Host context supplying the planning, Session, LLM, and settings services.
   * @param config - Deployment policy, resolved before any operation starts.
   * @param internals - Native integrations used by isolated Host tests.
   */
  constructor(ctx: Context, config: Config = {}, internals: TaskboardControllerInternals = {}) {
    super(ctx, 'taskboardController', { namespace: 'taskboard' })
    this.config = resolveConfig(config)
    this.agency = new AgencyCopilotHost(ctx, internals.agency)
    this.runtime = internals.runtime ?? new TaskboardHostRuntime(ctx, this.config, {
      dsh: createDshExecutionAdapter(ctx),
      copilot: new CopilotTaskExecutionAdapter(ctx, {
        operationTimeoutMs: this.config.operationTimeoutMs,
        recoveryPageSize: this.config.copilotRecoveryPageSize,
        recoveryMaxPages: this.config.copilotRecoveryMaxPages,
      }, { agency: this.agency }),
    }, () => { this.assertLocalAgencyLaunch() }, {
      ...(internals.settingsNamespace === undefined ? {} : { settingsNamespace: internals.settingsNamespace }),
    })
    this.feed = new TaskboardFeed(ctx, () => this.runtime.snapshot())
    ctx.effect(() => {
      const unwatch = this.runtime.subscribe((state) => { this.feed.runtimeChanged(state) })
      return async () => {
        this.lifetime.abort(new Error('Taskboard Controller stopped'))
        unwatch()
        for (const timer of this.openEvictions) clearTimeout(timer)
        this.openEvictions.clear()
        const [runtime] = await Promise.allSettled([
          Promise.resolve().then(() => this.runtime.dispose()),
          Promise.allSettled([...this.operations, ...[...this.opens.values()].map(open => open.promise)]),
        ])
        this.opens.clear()
        if (runtime.status === 'rejected') throw runtime.reason
      }
    }, 'taskboard-controller: runtime and terminal operations')
  }

  /** Acquire execution ownership and reconcile persisted attempts before activation. */
  protected async [Service.init](): Promise<void> { await this.runtime.start() }

  /**
   * Read active and archived tasks in registered Workspaces.
   * @param request - Optional Workspace filter.
   * @returns the current task and Host runtime baseline.
   */
  @Remote('list')
  list(request: TaskboardListRequest): Promise<TaskboardListValue> {
    return this.operate(() => Promise.resolve(this.feed.baseline(request.workspaceId)))
  }

  /**
   * Create a task and an optional validated existing connection atomically.
   * @param request - Saved task inputs; association never submits a prompt.
   * @param signal - Cancellation before the durable write.
   * @returns the committed task.
   */
  @Remote('create')
  async create(request: TaskboardCreateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue> {
    return this.operate(async (cancellation) => {
      if (request.connection !== undefined) {
        await this.assertSelection(request.workspaceId, request.connection, cancellation)
      }
      return { task: await this.ctx.taskboard.create(request, cancellation) }
    }, signal)
  }

  /**
   * Save planning and execution inputs without changing the current connection.
   * @param request - Exact revision and explicit field patch.
   * @param signal - Cancellation before the durable write.
   * @returns the committed task; open-attempt restrictions are enforced by the domain.
   */
  @Remote('update')
  async update(request: TaskboardUpdateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue> {
    return this.operate(async cancellation => ({
      task: await this.ctx.taskboard.update(request, cancellation),
    }), signal, request.taskId)
  }

  /**
   * Select one existing conversation, including resolution of preserved legacy choices.
   * @param request - Exact task revision and selected connection.
   * @param signal - Cancellation of discovery or pre-commit work.
   * @returns the committed task; neither provider is activated by association.
   */
  @Remote('connect')
  async connect(request: TaskboardConnectRequest, signal: AbortSignal): Promise<TaskboardTaskValue> {
    return this.operate(async (cancellation) => {
      const release = await this.acquireTask(request.taskId, cancellation)
      try {
        const task = this.requireTask(request.taskId)
        if (task.revision !== request.expectedRevision) {
          throw new TaskboardRevisionConflictError(task.id, request.expectedRevision, task.revision)
        }
        if (task.archivedAt !== undefined) throw new TaskboardTaskArchivedError(task.id)
        await this.assertSelection(task.workspaceId, request.connection, cancellation)
        return { task: await this.ctx.taskboard.connect(request, cancellation) }
      } finally {
        release()
      }
    }, signal, request.taskId)
  }

  /**
   * Remove the task connection without stopping or deleting the conversation.
   * @param request - Exact task revision.
   * @param signal - Cancellation before durability.
   * @returns the committed task; open attempts prevent disconnect.
   */
  @Remote('disconnect')
  async disconnect(request: TaskboardDisconnectRequest, signal?: AbortSignal): Promise<TaskboardTaskValue> {
    return this.operate(async (cancellation) => {
      const release = await this.acquireTask(request.taskId, cancellation)
      try { return { task: await this.ctx.taskboard.disconnect(request.taskId, request.expectedRevision, cancellation) } }
      finally { release() }
    }, signal, request.taskId)
  }

  /**
   * Admit one request and await prompt acknowledgement, not agent completion.
   * @param request - Exact task revision and stable manual retry identity.
   * @param signal - Caller cancellation only before durable admission.
   * @returns the durable execution identity and current task.
   */
  @Remote('run')
  async run(request: TaskboardRunRequest, signal: AbortSignal): Promise<TaskboardRunValue> {
    return this.operate(cancellation => this.runtime.run(request, cancellation), signal, request.taskId)
  }

  /**
   * Move a task between manual planning columns.
   * @param request - Exact task revision and destination.
   * @returns the committed task.
   */
  @Remote('move')
  async move(request: TaskboardMoveRequest): Promise<TaskboardTaskValue> {
    return this.operate(async () => ({ task: await this.ctx.taskboard.move(request) }), undefined, request.taskId)
  }

  /**
   * Archive a task and disable its schedule without changing its conversation.
   * @param request - Exact task revision.
   * @returns the committed archived task.
   */
  @Remote('archive')
  async archive(request: TaskboardArchiveRequest): Promise<TaskboardTaskValue> {
    return this.operate(async (cancellation) => {
      const release = await this.acquireTask(request.taskId, cancellation)
      try { return { task: await this.ctx.taskboard.archive(request.taskId, request.expectedRevision) } }
      finally { release() }
    }, undefined, request.taskId)
  }

  /**
   * Restore a task with its history retained and schedule disabled.
   * @param request - Exact archived revision.
   * @returns the restored task.
   */
  @Remote('restore')
  async restore(request: TaskboardRestoreRequest): Promise<TaskboardTaskValue> {
    return this.operate(async () => ({
      task: await this.ctx.taskboard.restore(request.taskId, request.expectedRevision),
    }), undefined, request.taskId)
  }

  /**
   * Copy saved task inputs without copying its connection, history, or permission confirmation.
   * @param request - Exact source revision and optional edited title.
   * @param signal - Cancellation before creation.
   * @returns the new task; the source is not archived implicitly.
   */
  @Remote('duplicate')
  async duplicate(request: TaskboardDuplicateRequest, signal?: AbortSignal): Promise<TaskboardTaskValue> {
    return this.operate(async cancellation => ({
      task: await this.ctx.taskboard.duplicate(request, cancellation),
    }), signal, request.taskId)
  }

  /**
   * Confirm the task's current explicit permission and handover choices.
   * @param request - Exact revision being confirmed.
   * @returns the committed confirmation; later relevant edits invalidate it.
   */
  @Remote('confirmPermissions')
  async confirmPermissions(request: TaskboardConfirmPermissionsRequest): Promise<TaskboardTaskValue> {
    return this.operate(async () => ({
      task: await this.ctx.taskboard.confirmPermissions(request.taskId, request.expectedRevision),
    }), undefined, request.taskId)
  }

  /**
   * Delete a task without deleting its provider conversations.
   * @param request - Exact task revision.
   * @param signal - Cancellation before the durable deletion.
   * @returns the committed removal tombstone; open attempts prevent deletion.
   */
  @Remote('delete')
  async delete(request: TaskboardDeleteRequest, signal?: AbortSignal): Promise<TaskboardDeleteValue> {
    return this.operate(async (cancellation) => {
      const release = await this.acquireTask(request.taskId, cancellation)
      try { return await this.ctx.taskboard.delete(request.taskId, request.expectedRevision, cancellation) }
      finally { release() }
    }, signal, request.taskId)
  }

  /**
   * List the current execution choices without activating a conversation.
   * @returns preset, permission, and model choices, with explicit catalog failures.
   */
  @Remote('executionOptions')
  async executionOptions(): Promise<TaskboardExecutionOptionsValue> {
    return this.operate(async (cancellation) => {
      const [roster, catalog] = await Promise.all([
        this.operate(() => this.ctx.agentPresets.remoteExportList()),
        this.operate(() => this.ctx.sessionController.modelCatalog()),
      ])
      cancellation.throwIfAborted()
      if (catalog.failures.length > 0) {
        throw new RemoteError(
          'taskboard/execution-error',
          catalog.failures.map(failure => `${failure.name}: ${failure.message}`).join('; '),
          { code: 'model-catalog-unavailable' },
        )
      }
      return {
        presets: roster.presets.map(preset => ({
          id: preset.id, name: preset.name ?? preset.id, isDefault: preset.isDefault,
          ...(preset.broken === undefined ? {} : { broken: preset.broken }),
        })),
        permissions: this.ctx.permissionPresets.names.map(name => ({ name })),
        models: catalog.groups.flatMap(group => group.models.map(model => ({
          provider: group.id, model: model.id, name: model.name,
        }))),
        timeZone: this.config.timeZone,
        copilotAvailable: this.localAgencyLaunchAvailable(),
      }
    })
  }

  /**
   * Persist Taskboard user switches through the ordinary settings service.
   * @param request - Explicit changes to enabled, announcement, or idle-sleep protection.
   * @returns the applied Host runtime observation.
   */
  @Remote('updateSettings')
  updateSettings(request: TaskboardUpdateSettingsRequest): Promise<TaskboardRuntimeState> {
    return this.operate(() => this.runtime.updateSettings(request.patch))
  }

  /**
   * Report deployment availability for native Copilot execution and navigation.
   * @returns the local execution and terminal-handoff capability.
   */
  @Remote('agencyCopilotCapability')
  agencyCopilotCapability(): TaskboardAgencyCopilotCapabilityValue {
    this.lifetime.signal.throwIfAborted()
    return { launch: this.localAgencyLaunchAvailable() }
  }

  /**
   * Discover local Copilot conversations without activating them.
   * @param request - Workspace whose canonical folder must match.
   * @param signal - Cancellation of bounded discovery.
   * @returns matching metadata and whether discovery was truncated.
   */
  @Remote('listAgencyCopilotSessions')
  async listAgencyCopilotSessions(
    request: TaskboardListAgencyCopilotSessionsRequest,
    signal: AbortSignal,
  ): Promise<TaskboardListAgencyCopilotSessionsValue> {
    return this.operate(async (cancellation) => {
      const workspace = this.ctx.workspaceRegistry.get(request.workspaceId)
      if (workspace === undefined) throw new TaskboardWorkspaceNotFoundError(request.workspaceId)
      let scan
      try { scan = await this.agency.list(cancellation) }
      catch (error: unknown) {
        cancellation.throwIfAborted()
        throw agencyFailure(error)
      }
      const sessions: AgencyCopilotSessionOption[] = []
      for (const row of scan.sessions.values()) {
        cancellation.throwIfAborted()
        if (await sameWorkspace(row.folder, workspace.path)) {
          sessions.push({
            sessionId: row.sessionId, status: row.status,
            ...(row.summary === undefined ? {} : { summary: row.summary }),
          })
        }
      }
      cancellation.throwIfAborted()
      return { sessions, truncated: !scan.complete }
    }, signal)
  }

  /**
   * Open a current or historical Copilot conversation without submitting a prompt.
   * @param request - Task and optional retained execution selecting the stored identity.
   * @param signal - Caller cancellation of the handoff wait.
   * @returns an existing-running or accepted-resume outcome; missing history is never recreated.
   */
  @Remote('openAgencyCopilot')
  async openAgencyCopilot(
    request: TaskboardOpenAgencyCopilotRequest,
    signal: AbortSignal,
  ): Promise<TaskboardOpenAgencyCopilotValue> {
    return this.operate(async (cancellation) => {
      this.assertLocalAgencyLaunch()
      const selected = this.copilotConnection(request.taskId, request.executionId)
      const pending = this.opens.get(selected.sessionId)
      if (pending !== undefined && (pending.settledAt === undefined
        || Date.now() - pending.settledAt < this.config.agencyOpenCooldownMs)) {
        return waitForCaller(pending.promise, cancellation)
      }
      const operation = this.openCopilot(request, selected.sessionId, AbortSignal.any([
        this.lifetime.signal, AbortSignal.timeout(this.config.agencyOpenTimeoutMs),
      ]))
      this.rememberOpen(selected.sessionId, operation)
      return waitForCaller(operation, cancellation)
    }, signal, request.taskId)
  }

  private async openCopilot(
    request: TaskboardOpenAgencyCopilotRequest,
    sessionId: AgencyCopilotSessionId,
    signal: AbortSignal,
  ): Promise<TaskboardOpenAgencyCopilotValue> {
    const release = await this.acquireTask(request.taskId, signal)
    try {
      const selected = this.copilotConnection(request.taskId, request.executionId)
      if (selected.sessionId !== sessionId) {
        throw new RemoteError('taskboard/agency-not-linked', 'Task Copilot connection changed before opening', { taskId: request.taskId })
      }
      const workspace = this.ctx.workspaceRegistry.get(selected.workspaceId)
      if (workspace === undefined) throw mapFailure(new TaskboardWorkspaceNotFoundError(selected.workspaceId))
      const task = this.requireTask(request.taskId)
      if (task.executions.some(execution => execution.connection?.kind === 'copilot'
        && execution.connection.sessionId === sessionId
        && (execution.status === 'pending' || execution.status === 'running'))) {
        return { outcome: 'already-running' }
      }
      let scan
      try { scan = await this.agency.inspect([sessionId], signal) }
      catch (error: unknown) { throw agencyFailure(error, task.id) }
      const latest = this.copilotConnection(request.taskId, request.executionId)
      if (latest.sessionId !== sessionId || latest.workspaceId !== selected.workspaceId) {
        throw new RemoteError('taskboard/agency-not-linked', 'Task Copilot connection changed during inspection', { taskId: task.id })
      }
      const observed = scan.sessions.get(sessionId)
      if (observed === undefined) {
        throw new RemoteError(
          scan.complete ? 'taskboard/bad-request' : 'taskboard/agency-unavailable',
          scan.complete ? 'The saved Copilot conversation is missing; it was not recreated' : 'Copilot session discovery is incomplete',
          {},
        )
      }
      if (!(await sameWorkspace(observed.folder, workspace.path))) {
        throw new RemoteError('taskboard/agency-workspace-mismatch', 'Copilot conversation belongs to another Workspace', { taskId: task.id })
      }
      if (observed.status === 'in_use') return { outcome: 'already-running' }
      try { await this.agency.resume(workspace.path, sessionId, signal) }
      catch (error: unknown) { throw agencyFailure(error, task.id) }
      return { outcome: 'resume-accepted' }
    } finally { release() }
  }

  /**
   * Inspect current Copilot connections without changing task planning or execution outcomes.
   * @param request - Bounded task identities.
   * @param signal - Cancellation of discovery.
   * @returns transient observations tied to their exact connection identities.
   */
  @Remote('inspectAgencyCopilot')
  async inspectAgencyCopilot(
    request: TaskboardInspectAgencyCopilotRequest,
    signal: AbortSignal,
  ): Promise<TaskboardInspectAgencyCopilotValue> {
    return this.operate(async (cancellation) => {
      if (request.taskIds.length > 100) throw new RemoteError('taskboard/bad-request', 'At most 100 Copilot tasks may be inspected', {})
      const tasks = request.taskIds.flatMap((taskId) => {
        const task = this.ctx.taskboard.get(taskId)
        return task?.archivedAt === undefined && task?.connection?.kind === 'copilot'
          ? [{ task, sessionId: task.connection.sessionId }]
          : []
      })
      const ids = [...new Set(tasks.map(({ sessionId }) => sessionId))]
      let scan
      try { scan = await this.agency.inspect(ids, cancellation) }
      catch (error: unknown) {
        cancellation.throwIfAborted()
        throw agencyFailure(error)
      }
      const observations: AgencyCopilotObservation[] = []
      for (const { task, sessionId } of tasks) {
        cancellation.throwIfAborted()
        const observed = scan.sessions.get(sessionId)
        let status: AgencyCopilotObservation['status']
        if (observed === undefined) status = scan.complete ? 'missing' : 'unknown'
        else {
          const workspace = this.ctx.workspaceRegistry.get(task.workspaceId)
          status = workspace !== undefined && await sameWorkspace(observed.folder, workspace.path)
            ? observed.status : 'workspace_mismatch'
        }
        observations.push({ taskId: task.id, sessionId, status })
      }
      cancellation.throwIfAborted()
      return { observations }
    }, signal)
  }

  private async assertSelection(workspaceId: WorkspaceId, connection: TaskConnection, signal: AbortSignal): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw new TaskboardWorkspaceNotFoundError(workspaceId)
    if (connection.kind === 'dsh') {
      if (!workspace.sessionIds.includes(connection.sessionId)
        || await this.ctx.sessionPersistence.stat(connection.sessionId) === undefined) {
        throw new TaskboardSessionInvalidError(workspaceId, connection.sessionId)
      }
      signal.throwIfAborted()
      return
    }
    let scan
    try { scan = await this.agency.inspect([connection.sessionId], signal) }
    catch (error: unknown) {
      signal.throwIfAborted()
      throw agencyFailure(error)
    }
    signal.throwIfAborted()
    const observed = scan.sessions.get(connection.sessionId)
    if (observed === undefined) {
      if (!scan.complete) throw new RemoteError('taskboard/agency-unavailable', 'Copilot discovery is incomplete', {})
      throw new RemoteError('taskboard/bad-request', 'Selected Copilot conversation is not discoverable', {})
    }
    if (!(await sameWorkspace(observed.folder, workspace.path))) {
      throw new RemoteError('taskboard/bad-request', 'Selected Copilot conversation does not match the task Workspace', {})
    }
    signal.throwIfAborted()
  }

  private copilotConnection(taskId: TaskId, executionId?: TaskExecutionId): {
    readonly sessionId: AgencyCopilotSessionId
    readonly workspaceId: WorkspaceId
  } {
    const task = this.requireTask(taskId)
    const execution = executionId === undefined ? undefined : task.executions.find(candidate => candidate.id === executionId)
    if (executionId !== undefined && execution === undefined) {
      throw mapFailure(new TaskboardExecutionError('execution-not-found', 'The requested execution is not retained'), taskId)
    }
    const connection = executionId === undefined ? task.connection : execution?.connection
    if (connection?.kind !== 'copilot') {
      throw new RemoteError('taskboard/agency-not-linked', 'The selected task or execution has no Copilot connection', { taskId })
    }
    return { sessionId: connection.sessionId, workspaceId: execution?.workspaceId ?? task.workspaceId }
  }

  private rememberOpen(sessionId: AgencyCopilotSessionId, promise: Promise<TaskboardOpenAgencyCopilotValue>): void {
    const admission: AgencyOpenAdmission = { promise }
    this.opens.set(sessionId, admission)
    void promise.then(
      () => {
        if (this.lifetime.signal.aborted) return
        admission.settledAt = Date.now()
        const timer = setTimeout(() => {
          this.openEvictions.delete(timer)
          if (this.opens.get(sessionId) === admission) this.opens.delete(sessionId)
        }, this.config.agencyOpenCooldownMs)
        this.openEvictions.add(timer)
      },
      () => { this.opens.delete(sessionId) },
    )
  }

  private async acquireTask(taskId: TaskId, signal?: AbortSignal): Promise<() => void> {
    this.lifetime.signal.throwIfAborted()
    const prior = this.taskTails.get(taskId) ?? Promise.resolve()
    const gate = Promise.withResolvers<undefined>()
    const tail = prior.then(() => gate.promise)
    this.taskTails.set(taskId, tail)
    await prior
    const release = (): void => {
      gate.resolve(undefined)
      void tail.then(() => { if (this.taskTails.get(taskId) === tail) this.taskTails.delete(taskId) })
    }
    try {
      this.lifetime.signal.throwIfAborted()
      signal?.throwIfAborted()
    } catch (error: unknown) { release(); throw error }
    return release
  }

  private operate<T>(
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    taskId?: TaskId,
  ): Promise<T> {
    const cancellation = signal === undefined
      ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, signal])
    const operation = Promise.resolve().then(async () => {
      cancellation.throwIfAborted()
      try { return await action(cancellation) }
      catch (error: unknown) {
        if (cancellation.aborted && error === cancellation.reason) throw error
        throw mapFailure(error, taskId)
      }
    })
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }

  private localAgencyLaunchAvailable(): boolean {
    const launch = launchEnvironmentOf(this.ctx)
    const ssh = ['SSH_CONNECTION', 'SSH_TTY'].some(name => (launch.getFrom(name, ['process'])?.value ?? '') !== '')
    return this.config.agencyCopilotLaunch && this.agency.nativeLaunchSupported() && !ssh
  }

  private assertLocalAgencyLaunch(): void {
    if (!this.localAgencyLaunchAvailable()) {
      throw new RemoteError('taskboard/agency-local-only', 'Copilot execution requires a loopback-only DSH Web server', {})
    }
  }

  private requireTask(taskId: TaskId): TaskboardTask {
    const task = this.ctx.taskboard.get(taskId)
    if (task === undefined) throw mapFailure(new TaskboardTaskNotFoundError(taskId))
    return task
  }

  /**
   * Follow tasks and runtime observations from a complete reconnect baseline.
   * @param signal - Follow generation cancellation.
   * @returns ordered task, removal, and Host runtime frames.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame> {
    return this.feed.follow(AbortSignal.any([this.lifetime.signal, signal]))
  }
}

function isCordisConfig(input: Config | CordisConfig): input is CordisConfig {
  const enabled: unknown = input.enabled
  return typeof enabled === 'object' && enabled !== null
    && 'get' in enabled && typeof enabled.get === 'function'
}

function resolveConfig(input: Config | CordisConfig): ResolvedConfig {
  const parsed = isCordisConfig(input) ? input : new TaskboardController.Config(input)
  const lockPath = parsed.lockPath ?? dshHomePath('locks', 'taskboard')
  const timeZone = parsed.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!isAbsolute(lockPath)) throw new Error('Taskboard lockPath must be absolute')
  new Intl.DateTimeFormat('en', { timeZone }).format()
  // Schemastery has supplied every scalar default; the environment-derived fields are resolved per instance.
  const resolved: ResolvedConfig = { ...parsed, lockPath, timeZone }
  if (resolved.schedulerRecoveryGapMs < resolved.schedulerIntervalMs) {
    throw new Error('Taskboard schedulerRecoveryGapMs must be at least schedulerIntervalMs')
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Taskboard ${name} must be a safe integer`)
    if (name.endsWith('Ms') && typeof value === 'number' && value > 0x7fffffff) {
      throw new Error(`Taskboard ${name} must not exceed 2147483647 milliseconds`)
    }
  }
  return resolved
}

function mapFailure(error: unknown, taskId?: TaskId): Error {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return remote
  if (error instanceof TaskboardExecutionError) {
    return new RemoteError('taskboard/execution-error', error.message, {
      code: error.code, ...(taskId === undefined ? {} : { taskId }),
    })
  }
  if (error instanceof TaskboardTaskNotFoundError) return new RemoteError('taskboard/task-not-found', error.message, { taskId: error.taskId })
  if (error instanceof TaskboardWorkspaceNotFoundError) {
    return new RemoteError('taskboard/workspace-not-found', error.message, { workspaceId: error.workspaceId })
  }
  if (error instanceof TaskboardRevisionConflictError) {
    return new RemoteError('taskboard/revision-conflict', error.message, {
      taskId: error.taskId, expectedRevision: error.expected, actualRevision: error.actual,
    })
  }
  if (error instanceof TaskboardSessionInvalidError) {
    return new RemoteError('taskboard/session-invalid', error.message, { workspaceId: error.workspaceId, sessionId: error.sessionId })
  }
  if (error instanceof TaskboardTaskArchivedError) return new RemoteError('taskboard/task-archived', error.message, { taskId: error.taskId })
  if (error instanceof TaskboardMoveInvalidError) return new RemoteError('taskboard/move-invalid', error.message, { beforeTaskId: error.beforeTaskId })
  if (error instanceof TaskboardInputError) return new RemoteError('taskboard/bad-request', error.message, {})
  if (error instanceof Error) return new RemoteError('taskboard/execution-error', error.message, {
    code: 'code' in error && typeof error.code === 'string' ? error.code : 'host-operation-failed',
    ...(taskId === undefined ? {} : { taskId }),
  })
  throw error
}

function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Taskboard caller aborted'))
    }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function agencyFailure(error: unknown, taskId?: TaskId): Error {
  if (error instanceof AgencyCopilotLaunchError && taskId !== undefined) {
    return new RemoteError('taskboard/agency-launch-failed', error.message, { taskId })
  }
  if (error instanceof AgencyCopilotUnavailableError) return new RemoteError('taskboard/agency-unavailable', error.message, {})
  throw error
}

async function sameWorkspace(folder: string | undefined, workspacePath: string): Promise<boolean> {
  if (folder === undefined) return false
  try { return await realpathNormalize(folder) === workspacePath }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
    throw error
  }
}

export default TaskboardController
