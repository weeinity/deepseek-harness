/** Native Copilot SDK execution; Agency retains discovery and interactive conversation handoff. */
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskConnection, TaskExecution, TaskExecutionReceipt } from '@deepseek-ai/dsh-taskboard/types'
import {
  CopilotClient, RuntimeConnection, ToolSet,
  type CopilotClientOptions, type CopilotSession, type PermissionRequest,
  type PermissionRequestResult, type SessionConfig, type SessionEvent,
} from '@github/copilot-sdk'
import { AgencyCopilotHost } from '../agency.ts'
import type { TaskExecutionAdapter, TaskExecutionObservation } from './adapter.ts'

type Connection = Extract<TaskConnection, { kind: 'copilot' }>
type Receipt = Extract<TaskExecutionReceipt, { kind: 'copilot' }>
type AcceptedReceipt = Receipt & { readonly messageId: string }
type TerminalObservation = Extract<TaskExecutionObservation, { state: 'settled' }>
type Failure = { readonly code: string; readonly message: string }
type Agency = Pick<AgencyCopilotHost, 'inspect' | 'copilotSdkEnvironment'>
type Page = Awaited<ReturnType<CopilotClient['rpc']['sessions']['readPersistedEvents']>>
const conversationOwnershipMessage = 'Another Copilot CLI owns this conversation. Close that CLI, even if idle, before Run; the Host cannot attach to or take over its process.'

interface FileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{
    isDirectory(): boolean
    isSymbolicLink(): boolean
  }>
}

/** Host-configured SDK deadlines and bounded durable-event reads. */
export interface CopilotTaskExecutionConfig {
  readonly operationTimeoutMs: number
  readonly recoveryPageSize: number
  readonly recoveryMaxPages: number
}

/** Session operations owned by one Taskboard execution. */
export interface CopilotTaskExecutionSession {
  readonly sessionId: string
  readonly send: CopilotSession['send']
  readonly rpc: {
    readonly metadata: {
      activity(): Promise<{ readonly hasActiveWork: boolean }>
      snapshot(): Promise<{
        readonly alreadyInUse: boolean
        readonly isRemote: boolean
        readonly workingDirectory: string
        readonly currentMode: 'interactive' | 'plan' | 'autopilot'
      }>
    }
    readonly eventLog: Pick<CopilotSession['rpc']['eventLog'], 'tail' | 'read'>
    readonly permissions: Pick<CopilotSession['rpc']['permissions'], 'resetSessionApprovals' | 'configure'>
    readonly options: {
      update(
        options: Parameters<CopilotSession['rpc']['options']['update']>[0],
      ): Promise<unknown>
    }
  }
}

/** SDK operations owned by one Taskboard execution. */
export interface CopilotTaskExecutionClient {
  readonly start: CopilotClient['start']
  readonly stop: CopilotClient['stop']
  readonly createSession: (config: SessionConfig) => Promise<CopilotTaskExecutionSession>
  readonly resumeSession: (sessionId: string, config: SessionConfig) => Promise<CopilotTaskExecutionSession>
  readonly rpc: {
    readonly sessions: Pick<CopilotClient['rpc']['sessions'], 'readPersistedEvents'>
  }
}

/** External-process substitutes used by focused provider tests. */
export interface CopilotTaskExecutionInternals {
  readonly agency?: Agency
  readonly createClient?: (options: CopilotClientOptions) => CopilotTaskExecutionClient
  readonly fileSystem?: FileSystem
}

interface TurnEvidence {
  turnId?: string
  ended: boolean
  aborted: boolean
  failure?: Failure
}

interface AttemptEvidence {
  readonly observations: Set<Promise<TaskExecutionObservation>>
  acknowledged: boolean
  terminal?: TerminalObservation
  releasing?: Promise<void>
}

interface OwnedClient {
  readonly client: CopilotTaskExecutionClient
  readonly executionId: TaskExecution['id']
  startup?: Promise<void>
  release?: Promise<void>
}

interface Activation {
  readonly owned: OwnedClient
  readonly lifetime: AbortController
  readonly callbacks: Set<Promise<PermissionRequestResult>>
  readonly executionId: TaskExecution['id']
  receipt?: Receipt
  sending: boolean
  closing: boolean
  idle: boolean
  lastEndedTurn?: string
  idleAfterTurn?: string
  aborted: boolean
  failure?: Failure
}

interface ReadyActivation extends Activation {
  readonly session: CopilotTaskExecutionSession
}

/** Credential-free provider error suitable for durable execution failure records. */
export class CopilotTaskExecutionError extends Error {
  override readonly name = 'CopilotTaskExecutionError'
  /**
   * @param code - Stable provider failure category.
   * @param message - Diagnostic that contains no vendor output.
   */
  constructor(readonly code: string, message: string) { super(message) }
}

/** Uses the Host's stored Copilot/gh login for exact-conversation attempts; never retries uncertain input. */
export class CopilotTaskExecutionAdapter implements TaskExecutionAdapter {
  private readonly agency: Agency
  private readonly createClient: (options: CopilotClientOptions) => CopilotTaskExecutionClient
  private readonly fileSystem: FileSystem
  private readonly activations = new Map<TaskExecution['id'], ReadyActivation>()
  private readonly openings = new Map<TaskExecution['id'], Promise<ReadyActivation>>()
  private readonly reservations = new Map<string, TaskExecution['id']>()
  private readonly clients = new Set<OwnedClient>()
  private readonly attempts = new Map<TaskExecution['id'], AttemptEvidence>()
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - Host Workspace registry and local subprocess service.
   * @param config - Operation deadlines and durable history limits.
   * @param internals - SDK and Agency process substitutes.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: CopilotTaskExecutionConfig,
    internals: CopilotTaskExecutionInternals = {},
  ) {
    this.agency = internals.agency ?? new AgencyCopilotHost(ctx)
    this.createClient = internals.createClient ?? (options => new CopilotClient(options))
    this.fileSystem = internals.fileSystem ?? { realpath, lstat }
  }

  async validateConnection(connection: TaskConnection, workspaceId: WorkspaceId, signal: AbortSignal): Promise<void> {
    this.check(signal)
    const selected = connectionOf(connection)
    const workspace = this.workspace(workspaceId)
    const scan = await this.operation(() => this.agency.inspect([selected.sessionId], signal), signal)
    this.check(signal)
    const found = scan.sessions.get(selected.sessionId)
    if (found === undefined) {
      throw problem(scan.complete ? 'session-missing' : 'discovery-incomplete',
        scan.complete ? 'The connected Copilot conversation is missing' : 'Copilot session discovery is incomplete')
    }
    let matching = false
    if (found.folder !== undefined) {
      try { matching = await this.track(realpathNormalize(found.folder)) === workspace }
      catch { matching = false }
    }
    this.check(signal)
    if (!matching) throw problem('workspace-mismatch', 'The connected Copilot conversation belongs to another Workspace')
    if (found.status === 'in_use') throw problem('busy', conversationOwnershipMessage)
  }

  async create(execution: TaskExecution, signal: AbortSignal): Promise<void> {
    if (!execution.createsConnection || execution.receipt !== undefined) {
      throw problem('creation-forbidden', 'An established Copilot conversation cannot be recreated')
    }
    await this.activate(execution, true, signal)
  }

  async prepare(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionReceipt> {
    this.check(signal)
    const existing = this.activations.get(execution.id)
    if (existing?.receipt !== undefined) return existing.receipt
    if (execution.receipt !== undefined) {
      throw problem('acceptance-unknown', 'The saved Copilot submission cursor cannot be replaced during recovery')
    }
    const activation = await this.activate(execution, false, signal)
    try {
      await this.requireIdle(activation, signal)
      const tail = await this.operation(() => activation.session.rpc.eventLog.tail(), signal)
      activation.receipt ??= { kind: 'copilot', afterCursor: tail.cursor }
      return activation.receipt
    } catch (error: unknown) {
      await this.close(activation)
      throw error
    }
  }

  async submit(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionReceipt> {
    this.check(signal)
    const receipt = receiptOf(execution.receipt)
    const activation = this.activations.get(execution.id)
    if (activation === undefined || activation.receipt?.afterCursor !== receipt.afterCursor) {
      throw problem('acceptance-unknown', 'Copilot submission requires the Host activation that captured its saved cursor')
    }
    if (activation.receipt.messageId !== undefined) return activation.receipt
    if (activation.sending || receipt.messageId !== undefined) throw acceptanceUnknown()
    try { await this.requireIdle(activation, signal) }
    catch (error: unknown) {
      if (!isSending(activation)) await this.close(activation)
      throw error
    }
    beginSubmission(activation)
    try {
      const messageId = await this.operation(() => activation.session.send({
        prompt: execution.prompt, mode: 'enqueue',
      }), signal)
      activation.receipt = { ...receipt, messageId }
      return activation.receipt
    } catch {
      activation.failure = failure('acceptance-unknown', 'Copilot prompt acceptance is uncertain; the prompt was not resent')
      await this.close(activation)
      throw acceptanceUnknown()
    }
  }

  async observe(execution: TaskExecution, signal: AbortSignal): Promise<TaskExecutionObservation> {
    this.check(signal)
    const evidence = this.attemptEvidence(execution.id)
    if (evidence.terminal !== undefined) return evidence.terminal
    if (evidence.acknowledged) throw problem('release-in-progress', 'Copilot execution resources are being released')
    const observing = this.inspectExecution(execution, signal, evidence).then((result) => {
      this.check(signal)
      if (evidence.terminal !== undefined) return evidence.terminal
      if (result.state === 'settled' && !evidence.acknowledged) evidence.terminal = result
      return result
    }).finally(() => { evidence.observations.delete(observing) })
    evidence.observations.add(observing)
    return observing
  }

  private async inspectExecution(
    execution: TaskExecution, signal: AbortSignal, evidence: AttemptEvidence,
  ): Promise<TaskExecutionObservation> {
    if (this.openings.has(execution.id)) return { state: 'pending' }
    const activation = this.activations.get(execution.id)
    if (activation === undefined) return this.recover(execution, signal)
    const receipt = activation.receipt
    if (receipt === undefined) return { state: 'pending' }
    if (!activation.sending || !isAccepted(receipt)) return { state: 'pending', receipt }
    try { return await this.observeLive(activation, receipt, signal) }
    catch (error: unknown) {
      if (!signal.aborted && !this.lifetime.signal.aborted) {
        if (evidence.terminal !== undefined) return evidence.terminal
        await this.close(activation)
      }
      throw error
    }
  }

  private async observeLive(
    activation: ReadyActivation, receipt: AcceptedReceipt, signal: AbortSignal,
  ): Promise<TaskExecutionObservation> {
    const activity = await this.operation(() => activation.session.rpc.metadata.activity(), signal)
    if (activity.hasActiveWork) return { state: 'running', receipt }
    if (activation.failure !== undefined) return terminalOutcome('failed', receipt, activation.failure)
    if (activation.aborted) return terminalOutcome('cancelled', receipt)
    if (!activation.idle || activation.idleAfterTurn === undefined) return { state: 'running', receipt }
    const evidence = await this.readEvidence(receipt, params =>
      this.operation(() => activation.session.rpc.eventLog.read({ ...params, includeEphemeral: false }), signal))
    return this.settleEvidence(activation, receipt, evidence)
  }

  private settleEvidence(
    activation: ReadyActivation, receipt: AcceptedReceipt, evidence: TurnEvidence,
  ): TerminalObservation {
    const error = activation.failure ?? evidence.failure ?? (!evidence.ended || evidence.turnId !== activation.idleAfterTurn
      ? failure('completion-unknown', 'Copilot became idle without a correlated completed turn') : undefined)
    return terminalOutcome(error !== undefined ? 'failed'
      : activation.aborted || evidence.aborted ? 'cancelled' : 'succeeded', receipt, error)
  }

  release(execution: TaskExecution): Promise<void> {
    const evidence = this.attemptEvidence(execution.id)
    evidence.acknowledged = true
    delete evidence.terminal
    evidence.releasing ??= this.releaseAttempt(execution.id, evidence)
    return evidence.releasing
  }

  private async releaseAttempt(executionId: TaskExecution['id'], evidence: AttemptEvidence): Promise<void> {
    const opening = this.openings.get(executionId)
    if (opening !== undefined) await this.shutdownDeadline(Promise.allSettled([opening]))
    const activation = this.activations.get(executionId)
    const resources = activation === undefined ? [] : [this.close(activation)]
    for (const owned of this.clients) {
      if (owned.executionId === executionId && owned !== activation?.owned) resources.push(this.closeClient(owned))
    }
    const released = await Promise.allSettled(resources)
    await this.shutdownDeadline(Promise.allSettled([...evidence.observations]))
    if (released.some(result => result.status === 'rejected')) {
      throw problem('shutdown-failed', 'Copilot SDK shutdown did not confirm resource release')
    }
    this.releaseReservations(executionId)
    this.attempts.delete(executionId)
  }

  private attemptEvidence(executionId: TaskExecution['id']): AttemptEvidence {
    let evidence = this.attempts.get(executionId)
    if (evidence === undefined) {
      evidence = { observations: new Set(), acknowledged: false }
      this.attempts.set(executionId, evidence)
    }
    return evidence
  }

  private releaseReservations(executionId: TaskExecution['id']): void {
    for (const [connection, owner] of this.reservations) {
      if (owner === executionId) this.reservations.delete(connection)
    }
  }

  dispose(): Promise<void> {
    this.disposal ??= this.releaseAll()
    return this.disposal
  }

  private async releaseAll(): Promise<void> {
    this.lifetime.abort(problem('disposed', 'Copilot execution adapter was disposed'))
    for (const evidence of this.attempts.values()) evidence.acknowledged = true
    for (const activation of this.activations.values()) activation.closing = true
    const released = await Promise.allSettled([...this.clients].map(client => this.closeClient(client)))
    const observations = [...this.attempts.values()].flatMap(evidence => [
      ...evidence.observations, ...(evidence.releasing === undefined ? [] : [evidence.releasing]),
    ])
    await this.shutdownDeadline(Promise.allSettled([...this.operations, ...this.openings.values(), ...observations]))
    if (released.some(result => result.status === 'rejected')) {
      throw problem('shutdown-failed', 'Copilot SDK shutdown did not confirm resource release')
    }
    this.attempts.clear()
    this.activations.clear()
    this.reservations.clear()
  }

  private check(signal: AbortSignal): void {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
  }

  private workspace(workspaceId: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) throw problem('workspace-missing', 'The task Workspace is unavailable')
    return workspace.path
  }

  private newClient(executionId: TaskExecution['id'], workspace: string, signal: AbortSignal): OwnedClient {
    this.check(signal)
    const client = this.createClient({
      connection: RuntimeConnection.forStdio(),
      mode: 'copilot-cli',
      useLoggedInUser: true,
      workingDirectory: workspace,
      env: this.agency.copilotSdkEnvironment(),
      logLevel: 'none',
    })
    const owned: OwnedClient = { client, executionId }
    this.clients.add(owned)
    return owned
  }

  private activate(execution: TaskExecution, create: boolean, signal: AbortSignal): Promise<ReadyActivation> {
    this.check(signal)
    const connection = connectionOf(execution.connection)
    const opening = this.openings.get(execution.id)
    if (opening !== undefined) return this.operation(() => opening, signal)
    const existing = this.activations.get(execution.id)
    if (existing !== undefined) {
      if (existing.closing) throw problem('busy', 'The Copilot activation is shutting down')
      return Promise.resolve(existing)
    }
    if (this.reservations.has(connection.sessionId)) throw problem('busy', 'This Host already owns the Copilot conversation')
    this.reservations.set(connection.sessionId, execution.id)
    const pending = this.open(execution, create, signal).finally(() => {
      this.openings.delete(execution.id)
      if (![...this.clients].some(client => client.executionId === execution.id)
        && !this.attempts.has(execution.id)) this.releaseReservations(execution.id)
    })
    this.openings.set(execution.id, pending)
    return pending
  }

  private async open(execution: TaskExecution, create: boolean, signal: AbortSignal): Promise<ReadyActivation> {
    const connection = connectionOf(execution.connection)
    const workspace = this.workspace(execution.workspaceId)
    if (create) {
      const scan = await this.operation(() => this.agency.inspect([connection.sessionId], signal), signal)
      if (scan.sessions.has(connection.sessionId)) throw problem('creation-conflict', 'The reserved Copilot conversation already exists')
      if (!scan.complete) throw problem('discovery-incomplete', 'Copilot session discovery is incomplete')
    } else await this.validateConnection(connection, execution.workspaceId, signal)
    const owned = this.newClient(execution.id, workspace, signal)
    const { client } = owned
    const activation: Activation = {
      owned, lifetime: new AbortController(), callbacks: new Set(),
      executionId: execution.id, sending: false, closing: false, idle: false, aborted: false,
    }
    try {
      this.check(signal)
      const startup = client.start()
      owned.startup = startup
      await this.operation(() => startup, signal)
      const options = sessionOptions(execution, workspace, activation,
        AbortSignal.any([this.lifetime.signal, activation.lifetime.signal]), (work) => {
          const tracked = this.track(work).finally(() => { activation.callbacks.delete(tracked) })
          activation.callbacks.add(tracked)
          return tracked
        }, this.fileSystem)
      const resumeOptions = { ...options, continuePendingWork: false }
      delete resumeOptions.workingDirectory
      const session = await this.operation(() => create
        ? client.createSession({ ...options, sessionId: connection.sessionId })
        : client.resumeSession(connection.sessionId, resumeOptions), signal)
      const ready = Object.assign(activation, { session })
      this.activations.set(execution.id, ready)
      if (session.sessionId !== connection.sessionId) {
        throw problem('identity-mismatch', 'Copilot returned a different conversation identity')
      }
      if (activation.failure !== undefined) throw problem(activation.failure.code, activation.failure.message)
      const metadata = await this.operation(() => session.rpc.metadata.snapshot(), signal)
      this.check(signal)
      if (metadata.alreadyInUse) throw problem('busy', conversationOwnershipMessage)
      if (metadata.currentMode !== 'interactive') {
        throw problem('session-mode-unsupported', 'Switch the Copilot conversation to interactive mode before a Host run')
      }
      if (metadata.isRemote || await this.track(realpathNormalize(metadata.workingDirectory)) !== workspace) {
        throw problem('workspace-mismatch', 'The connected Copilot conversation belongs to another Workspace')
      }
      await this.requireIdle(ready, signal)
      await this.configurePermissions(ready, workspace, signal)
      return ready
    } catch (error: unknown) {
      await this.close(activation)
      if (error instanceof CopilotTaskExecutionError) throw error
      throw problem('activation-failed', 'The connected Copilot conversation could not be activated')
    }
  }

  private async configurePermissions(activation: ReadyActivation, workspace: string, signal: AbortSignal): Promise<void> {
    this.check(signal)
    const rpc = activation.session.rpc
    await this.operation(() => rpc.options.update({ installedPlugins: [] }), signal)
    const permissions = rpc.permissions
    const approvals = await this.operation(() => permissions.resetSessionApprovals({ includeLocation: true }), signal)
    const configured = await this.operation(() => permissions.configure({
      approveAllToolPermissionRequests: false,
      approveAllReadPermissionRequests: false,
      paths: { unrestricted: false, additionalDirectories: [], includeTempDirectory: false, workspacePath: workspace },
      urls: { unrestricted: false, initialAllowed: [] },
    }), signal)
    if (!approvals.success || !configured.success) {
      throw problem('permission-policy-unavailable', 'Copilot could not apply the task permission policy')
    }
  }

  private async requireIdle(activation: ReadyActivation, signal: AbortSignal): Promise<void> {
    if (activation.failure !== undefined) throw problem(activation.failure.code, activation.failure.message)
    const activity = await this.operation(() => activation.session.rpc.metadata.activity(), signal)
    if (activity.hasActiveWork) throw problem('busy', 'The connected Copilot conversation is already processing work')
  }

  private async recover(execution: TaskExecution, signal: AbortSignal): Promise<TerminalObservation> {
    const receipt = execution.receipt
    if (receipt?.kind !== 'copilot' || !isAccepted(receipt)) {
      return failed('acceptance-unknown', 'Copilot prompt acceptance cannot be recovered; the prompt was not resent')
    }
    const connection = connectionOf(execution.connection)
    const owned = this.newClient(execution.id, this.workspace(execution.workspaceId), signal)
    const { client } = owned
    try {
      this.check(signal)
      const startup = client.start()
      owned.startup = startup
      await this.operation(() => startup, signal)
      const evidence = await this.readEvidence(receipt, params =>
        this.operation(() => client.rpc.sessions.readPersistedEvents({ ...params, sessionId: connection.sessionId }), signal))
      if (evidence.failure !== undefined) return { state: 'settled', outcome: 'failed', receipt, error: evidence.failure }
      if (evidence.aborted && evidence.turnId !== undefined) return { state: 'settled', outcome: 'cancelled', receipt }
      return failed('recovery-unknown', evidence.ended
        ? 'The Copilot turn ended, but its whole-session idle observation was not persisted'
        : 'Copilot completion could not be recovered; the prompt was not resent', receipt)
    } catch {
      if (signal.aborted || this.lifetime.signal.aborted) {
        await this.closeClient(owned)
        this.check(signal)
      }
      return failed('recovery-unavailable', 'Copilot execution history is unavailable; the prompt was not resent', receipt)
    }
  }

  private async readEvidence(
    receipt: AcceptedReceipt,
    read: (params: { cursor?: string; max: number }) => Promise<Page>,
  ): Promise<TurnEvidence> {
    let cursor = receipt.afterCursor ?? undefined
    const evidence: TurnEvidence = { ended: false, aborted: false }
    for (let page = 0; page < this.config.recoveryMaxPages; page += 1) {
      const result = await read({ ...(cursor === undefined ? {} : { cursor }), max: this.config.recoveryPageSize })
      if (result.cursorStatus !== 'ok') return { ...evidence, failure: failure('cursor-expired', 'Copilot history no longer contains the execution cursor') }
      for (const event of result.events) {
        if (event.agentId !== undefined || event.ephemeral === true) continue
        if (event.type === 'user.message' && event.data.messageId === receipt.messageId && event.data.turnId !== undefined) {
          evidence.turnId = event.data.turnId
        }
        if (evidence.turnId === undefined) continue
        if (event.type === 'abort') evidence.aborted = true
        if (event.type === 'session.error') evidence.failure = failure('session-error', 'Copilot reported an execution error')
        if (event.type === 'assistant.turn_end' && event.data.turnId === evidence.turnId) {
          evidence.ended = true
          return evidence
        }
      }
      if (!result.hasMore) return evidence
      cursor = result.cursor
    }
    return { ...evidence, failure: failure('history-limit', 'Copilot completion evidence exceeds the configured history limit') }
  }

  private async close(activation: Activation): Promise<void> {
    activation.closing = true
    activation.lifetime.abort()
    await this.closeClient(activation.owned)
    await this.shutdownDeadline(Promise.allSettled([...activation.callbacks]))
    this.activations.delete(activation.executionId)
    if (!this.attempts.has(activation.executionId)) this.releaseReservations(activation.executionId)
  }

  private closeClient(owned: OwnedClient): Promise<void> {
    owned.release ??= (async () => {
      // SDK stop does not join a concurrent start; shutdown must also own a late-starting child.
      await owned.startup?.catch(() => undefined)
      const errors = await owned.client.stop()
      if (errors.length > 0) throw problem('shutdown-failed', 'Copilot SDK shutdown did not confirm resource release')
      this.clients.delete(owned)
    })()
    return this.shutdownDeadline(owned.release)
  }

  private shutdownDeadline<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(problem('shutdown-failed', 'Copilot SDK shutdown did not confirm resource release'))
      }, this.config.operationTimeoutMs)
      void work.then((value) => { clearTimeout(timer); resolve(value) }, () => {
        clearTimeout(timer)
        reject(problem('shutdown-failed', 'Copilot SDK shutdown did not confirm resource release'))
      })
    })
  }

  private operation<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
    this.check(signal)
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.operationTimeoutMs)])
    const tracked = this.track(new Promise<T>((resolve) => { resolve(start()) }))
    return new Promise<T>((resolve, reject) => {
      const aborted = (): void => { reject(problem('operation-interrupted', 'Copilot SDK operation was interrupted')) }
      if (combined.aborted) aborted()
      else combined.addEventListener('abort', aborted, { once: true })
      void tracked.then(
        (value) => { combined.removeEventListener('abort', aborted); resolve(value) },
        () => { combined.removeEventListener('abort', aborted); reject(problem('sdk-failed', 'Copilot SDK operation failed')) },
      )
    })
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const tracked = work.finally(() => { this.operations.delete(tracked) })
    this.operations.add(tracked)
    return tracked
  }
}

function sessionOptions(
  execution: TaskExecution, workspace: string, activation: Activation,
  signal: AbortSignal,
  track: (work: Promise<PermissionRequestResult>) => Promise<PermissionRequestResult>,
  fileSystem: FileSystem,
): SessionConfig {
  const settings = execution.executionSettings
  if (settings.kind !== 'copilot') throw problem('settings-mismatch', 'Copilot requires Copilot execution settings')
  const permission = settings.permission ?? 'read-only'
  return {
    workingDirectory: workspace,
    ...(settings.model === undefined ? {} : { model: settings.model }),
    onEvent: (event) => { observeEvent(activation, event) },
    enableConfigDiscovery: false,
    enableFileHooks: false,
    enableExperimentalMode: false,
    requestExtensions: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    enableOnDemandInstructionDiscovery: false,
    skipCustomInstructions: true,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    memory: { enabled: false },
    customAgentsLocalOnly: true,
    manageScheduleEnabled: false,
    includedBuiltinSkills: [],
    availableTools: new ToolSet().addBuiltIn(permission === 'full-access' ? ['*']
      : permission === 'read-only' ? ['view', 'glob', 'grep'] : ['view', 'glob', 'grep', 'edit', 'create']),
    excludedTools: ['ask_user'],
    onPermissionRequest: (request) => {
      if (activation.closing || signal.aborted) return { kind: 'reject' }
      if (!activation.sending) return { kind: 'no-result' }
      if (request.managedApprovalRequired === true) {
        activation.failure = interactionRequired()
        return { kind: 'user-not-available' }
      }
      return track(decidePermission(request, workspace, permission, signal, fileSystem))
    },
    onElicitationRequest: () => { activation.failure = interactionRequired(); return { action: 'cancel' } },
  }
}

async function decidePermission(
  request: PermissionRequest, workspace: string, permission: 'read-only' | 'workspace-write' | 'full-access',
  signal: AbortSignal,
  fileSystem: FileSystem,
): Promise<PermissionRequestResult> {
  if ('requestSandboxBypass' in request && request.requestSandboxBypass) return { kind: 'reject' }
  if (permission === 'full-access') {
    switch (request.kind) {
      case 'read': case 'write': case 'shell': case 'url': case 'mcp': case 'custom-tool': case 'memory':
        return { kind: 'approve-once' }
      default:
        // Hook and extension approvals are unavailable in Host runs.
        return { kind: 'reject' }
    }
  }
  const path = request.kind === 'read' ? request.path
    : request.kind === 'write' && permission === 'workspace-write' ? request.fileName : undefined
  if (path === undefined) return { kind: 'reject' }
  const candidate = isAbsolute(path) ? path : resolve(workspace, path)
  let current = candidate
  for (;;) {
    try {
      const existing = await fileSystem.realpath(current)
      if (current !== candidate && !(await fileSystem.lstat(existing)).isDirectory()) return { kind: 'reject' }
      signal.throwIfAborted()
      const suffix = relative(workspace, resolve(existing, relative(current, candidate)))
      return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
        ? { kind: 'approve-once' } : { kind: 'reject' }
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return { kind: 'reject' }
      try {
        if ((await fileSystem.lstat(current)).isSymbolicLink()) return { kind: 'reject' }
      } catch (missing: unknown) {
        if (!(missing instanceof Error) || !('code' in missing) || missing.code !== 'ENOENT') return { kind: 'reject' }
      }
      const parent = dirname(current)
      if (parent === current) return { kind: 'reject' }
      current = parent
    }
  }
}

function observeEvent(activation: Activation, event: SessionEvent): void {
  if (activation.closing || event.agentId !== undefined) return
  switch (event.type) {
    case 'session.start':
    case 'session.resume':
      if (event.data.alreadyInUse === true || (event.type === 'session.resume' && event.data.sessionWasActive === true)) {
        activation.failure = failure('busy', conversationOwnershipMessage)
      }
      return
    case 'session.error':
      if (activation.sending) activation.failure ??= failure('session-error', 'Copilot reported an execution error')
      return
    case 'abort':
      if (activation.sending) activation.aborted = true
      return
    case 'assistant.turn_end':
      if (activation.sending) activation.lastEndedTurn = event.data.turnId
      return
    case 'session.idle':
      if (activation.sending && event.data.mode !== 'autopilot') {
        activation.idle = true
        if (activation.lastEndedTurn !== undefined) activation.idleAfterTurn = activation.lastEndedTurn
        activation.aborted ||= event.data.aborted === true
      }
      return
    default:
      return
  }
}

function connectionOf(connection: TaskConnection | undefined): Connection {
  if (connection?.kind !== 'copilot') throw problem('connection-missing', 'The attempt requires its connected Copilot conversation')
  return connection
}
function receiptOf(receipt: TaskExecutionReceipt | undefined): Receipt {
  if (receipt?.kind !== 'copilot') throw problem('receipt-missing', 'The attempt requires its persisted Copilot submission cursor')
  return receipt
}
function isAccepted(receipt: Receipt): receipt is AcceptedReceipt { return receipt.messageId !== undefined }
function failure(code: string, message: string): Failure { return { code: 'copilot/' + code, message } }
function problem(code: string, message: string): CopilotTaskExecutionError {
  return new CopilotTaskExecutionError(code.startsWith('copilot/') ? code : 'copilot/' + code, message)
}
function acceptanceUnknown(): CopilotTaskExecutionError {
  return problem('acceptance-unknown', 'Copilot prompt acceptance is uncertain; the prompt was not resent')
}
function interactionRequired(): Failure {
  return failure('approval-required', 'Copilot requires interactive approval or user input')
}
function isSending(activation: Activation): boolean { return activation.sending }
function beginSubmission(activation: Activation): void {
  if (activation.sending) throw acceptanceUnknown()
  activation.sending = true
}
function terminalOutcome(
  outcome: TerminalObservation['outcome'], receipt?: Receipt, error?: Failure,
): TerminalObservation {
  return { state: 'settled', outcome, ...(receipt === undefined ? {} : { receipt }), ...(error === undefined ? {} : { error }) }
}
function failed(code: string, message: string, receipt?: Receipt): TerminalObservation {
  return terminalOutcome('failed', receipt, failure(code, message))
}
