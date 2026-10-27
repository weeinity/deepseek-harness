/**
 * Host-owned Dashboard conversations. Native Agents, inbox events, JSONL history,
 * and projected streaming remain authoritative; the private domain owns only identity and receipts.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Agent, AgentHandle, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition, ToolExecution, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { GenerateOptions, LlmCallConfig, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { captureQuestion, captureRequest, captureScope, DASHBOARD_CHAT_PERSONA, DASHBOARD_ATTENTION_PERSONA, DashboardChatError, hashTuple,
  type CapturedQuestion } from './capture.ts'
import { dashboardChatDomain } from './domain.ts'
import { acquireOwnership, type DashboardChatOwnership } from './ownership.ts'
import type {
  DashboardChatConfig, DashboardChatReceipt, DashboardChatReconciliation, DashboardChatScope,
  DashboardChatSubmission, DashboardQuestionId, DashboardScopeId,
} from './types.ts'
import * as presetPolicy from './preset-policy.ts'
import { allowsAttentionExecution, authorizeDashboardAgent, dashboardPersona, DASHBOARD_CHAT_BUILTIN, DASHBOARD_CHAT_PRESET } from './preset-policy.ts'
import { attentionTool, ATTENTION_TOOL_NAME } from './attention-tool.ts'
import { attentionProposalSchema, type AttentionProposal, type AttentionToolInput } from '../../shared/attention.ts'

export type {
  DashboardChatConfig, DashboardChatReceipt, DashboardChatReconciliation, DashboardChatScope, DashboardChatSubmission,
} from './types.ts'
export { DashboardChatError } from './capture.ts'
export { DASHBOARD_CHAT_PRESET } from './preset-policy.ts'

const dashboardChatPreset: PresetDefinition = {
  id: DASHBOARD_CHAT_PRESET,
  name: 'Dashboard page only',
  description: 'Reserved for Dashboard-owned conversations. Use the Dashboard page; creating ordinary chats with this preset is disabled.',
  plugins: [{ id: DASHBOARD_CHAT_BUILTIN, name: `cordis:${DASHBOARD_CHAT_BUILTIN}` }],
}

/**
 * Register the Dashboard-only composition after publishing its private Loader builtin.
 * @param ctx Host context owning the preset registry and Loader builtins.
 * @returns Resolution after the preset is available to Dashboard sessions.
 */
export async function registerDashboardChatPreset(ctx: Context): Promise<void> {
  if (ctx.loader.builtins[DASHBOARD_CHAT_BUILTIN] !== undefined) {
    throw new DashboardChatError('DUPLICATE_OWNER', 'Dashboard chat already registered its private preset policy.')
  }
  ctx.loader.builtins[DASHBOARD_CHAT_BUILTIN] = presetPolicy
  ctx.effect(() => {
    const remove = (): void => {
      if (ctx.loader.builtins[DASHBOARD_CHAT_BUILTIN] === presetPolicy) delete ctx.loader.builtins[DASHBOARD_CHAT_BUILTIN]
    }
    return remove
  }, 'dashboardChat.presetBuiltin()')
  const unregister = await ctx.agentPresets.register(dashboardChatPreset)
  ctx.effect(() => unregister, 'dashboardChat.preset()')
}

interface ActiveQuestion {
  readonly capture: CapturedQuestion
  readonly selection: LlmCallConfig
  /** The monotonic guard binds registry tokens before execute wrappers may fuse their signals. */
  readonly nativeTokens: Set<ToolExecutionToken>
  turn?: number
  signal?: AbortSignal
  proposalToken?: ToolExecutionToken
}

/**
 * One single-user Host's Dashboard writer. Keep this owner mounted for the full
 * Host lifetime; its guards are execution policy, not Session-read confidentiality.
 */
export class DashboardChatSessions {
  /** Resolves after writer ownership, working-directory creation/canonicalization, and mapping validation.
   * On rejection, dispose() remains the completion signal for dependent cleanup and lock release.
   */
  readonly ready: Promise<void>
  private domain: Domain<typeof dashboardChatDomain> | undefined
  private ownership: DashboardChatOwnership | undefined
  private workingDirectory: string | undefined
  private readonly handles = new Map<string, AgentHandle>()
  private readonly opens = new Map<string, Promise<AgentHandle>>()
  private readonly admissions = new Map<string, Promise<unknown>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly drains = new Set<Promise<void>>()
  private readonly prepared = new WeakSet<Agent>()
  private readonly attentionDefinitions = new WeakMap<Agent, ToolDefinition>()
  private readonly active = new Map<SessionId, ActiveQuestion>()
  private readonly listeners: (() => void)[] = []
  private readonly stopping = new AbortController()
  private state: 'active' | 'closing' | 'closed' = 'active'
  private failure: DashboardChatError | undefined
  private disposal: Promise<void> | undefined
  private readonly config: DashboardChatConfig

  /** @param ctx - injected native Host services.
   * @param config Explicit deployment limits and optional proposal-only Personal capability.
   */
  constructor(private readonly ctx: Context, config: DashboardChatConfig) {
    this.config = Object.freeze({ ...config })
    if (!isAbsolute(config.lockDirectory) || !isAbsolute(config.workingDirectory)
      || [config.maxQuestionBytes, config.maxContextBytes, config.maxOutputTokens]
        .some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new DashboardChatError('INVALID_CONFIG', 'Dashboard chat requires absolute lock and working directories and positive integer limits.')
    }
    this.installPolicy()
    this.ready = this.initialize()
    // Failed readiness must settle before dependent teardown can await its own ownership preflight.
    void this.ready.catch(() => this.dispose()).catch(() => {
      // ready and dispose retain initialization and cleanup failures for their callers.
    })
    ctx.effect(() => () => this.dispose(), 'dashboardChat.sessions()')
  }

  /**
   * Return the exact native Session ID for a canonical source, creating it once.
   * Native default model options are read without model lookup or generation.
   * Missing or mismatched persisted cwd rejects with SESSION_CONFLICT; existing
   * headers are never rewritten or adopted under a different working directory.
   * @param scope - Personal Work or one canonical ADO source; filters are not identity.
   * @returns durable source-to-Session mapping, independent of active Client selection.
   */
  open(scope: DashboardChatScope): Promise<{ sessionId: SessionId }> {
    const captured = captureScope(scope)
    return this.track(async () => ({ sessionId: (await this.handle(captured)).agent.id }))
  }

  /**
   * Read durable admission before checking question limits or retrieving a snapshot.
   * Waits for earlier admissions in this source, but never opens a Session or calls
   * a model. Unknown identifiers return undefined; conflicts and interrupted claims
   * reject with REQUEST_CONFLICT and REQUEST_UNCERTAIN respectively.
   * The Host must single-flight the complete send transaction by original request
   * identity, including preprocessing before submit().
   * @param input - canonical source, request ID, and Host-computed original wire fingerprint.
   * @returns accepted receipt, or undefined when no request has been claimed.
   */
  reconcile(input: DashboardChatReconciliation): Promise<DashboardChatReceipt | undefined> {
    const captured = captureRequest(input)
    return this.track(() => this.serialize(captured.scopeId, async () => {
      await this.checkOwner()
      return this.acceptedReceipt(captured, hashTuple([captured.scopeId, captured.requestId]))
    }))
  }

  /**
   * Durably queue one captured question; this acknowledgement is not model completion.
   * Matching retries return the same receipt. Conflicting IDs, busy sources, and
   * interrupted claims fail explicitly; claimed work is never automatically replayed.
   * New questions validate the configured native default route and request controls
   * before claiming their identifier; no alternate provider or model is substituted.
   * @param input - Host-approved question and exact displayed snapshot.
   * @returns the native Session ID and caller's payload-bound request identifier.
   */
  submit(input: DashboardChatSubmission): Promise<DashboardChatReceipt> {
    const capture = captureQuestion(input, this.config)
    return this.track(() => this.serialize(capture.scope.id, () => this.admit(capture)))
  }

  /** Verify the shared writer for dependent persistence without admitting new chat work.
   * Remains available during dependent teardown; the dependent writer must stop its own intake.
   * @returns Readiness and held ownership, rejecting after failure or once lock release begins.
   */
  async checkOwnership(): Promise<void> {
    await this.ready
    if (this.failure !== undefined) throw this.failure
    const ownership = this.ownership
    if (ownership === undefined) throw new DashboardChatError('CLOSED', 'Dashboard chat writer ownership is released.')
    await ownership.check()
    if (this.ownership !== ownership) throw new DashboardChatError('CLOSED', 'Dashboard chat writer ownership is released.')
  }

  /**
   * Stop intake, drain owned handles and dependent writers, then release the shared lock.
   * Client read-lease disposal must not call this.
   * @returns Quiescent teardown, preserving native, dependency, or lock-release failure.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.state = 'closing'
    this.stopping.abort()
    this.disposal = this.close()
    return this.disposal
  }

  private async initialize(): Promise<void> {
    try {
      this.ownership = await acquireOwnership(this.config.lockDirectory)
      try {
        await mkdir(this.config.workingDirectory, { recursive: true, mode: 0o700 })
        this.workingDirectory = await realpath(this.config.workingDirectory)
      } catch {
        throw new DashboardChatError('WORKING_DIRECTORY_UNAVAILABLE',
          'Dashboard working directory cannot be created or resolved. Configure an accessible dedicated directory.')
      }
      try {
        const preset = await this.ctx.agentPresets.resolve(DASHBOARD_CHAT_PRESET)
        if (preset.broken !== undefined) throw new Error('Dashboard preset is not mountable')
      } catch {
        throw new DashboardChatError('PRESET_UNAVAILABLE', 'Register the Dashboard analysis preset before enabling chat.')
      }
      this.domain = await this.ctx.storageDomain.open(dashboardChatDomain)
      const identities = new Set<string>()
      for (const [key, row] of this.domain.table('scopes').entries()) {
        if (key !== hashTuple([row.scopeId]) || identities.has(row.sessionId)) {
          throw new DashboardChatError('CORRUPT_MAPPING', 'Dashboard scope mapping contains conflicting identities.')
        }
        identities.add(row.sessionId)
      }
      for (const [key, row] of this.domain.table('requests').entries()) {
        if (key !== hashTuple([row.scopeId, row.requestId])
          || this.domain.table('scopes').get(hashTuple([row.scopeId]))?.sessionId !== row.sessionId) {
          throw new DashboardChatError('CORRUPT_MAPPING', 'Dashboard request receipt does not belong to its source.')
        }
      }
    } catch (error) {
      this.failure = error instanceof DashboardChatError
        ? error
        : new DashboardChatError('STORAGE_UNAVAILABLE', 'Dashboard chat storage or exclusive writer ownership is unavailable.')
      throw this.failure
    }
  }

  private assertActive(): void {
    if (this.failure !== undefined) throw this.failure
    if (this.state !== 'active') throw new DashboardChatError('CLOSED', 'Dashboard chat is closing.')
  }

  private async checkOwner(): Promise<void> {
    await this.ready
    this.assertActive()
    await this.ownership!.check()
    this.assertActive()
  }

  private track<T>(run: () => Promise<T>): Promise<T> {
    this.assertActive()
    const operation = run()
    this.operations.add(operation)
    void operation.then(
      () => { this.operations.delete(operation) },
      () => { this.operations.delete(operation) },
    )
    return operation
  }

  private async serialize<T>(scopeId: DashboardScopeId, run: () => Promise<T>): Promise<T> {
    const prior = this.admissions.get(scopeId) ?? Promise.resolve()
    const admission = prior.then(run, run)
    this.admissions.set(scopeId, admission)
    try {
      return await admission
    } finally {
      if (this.admissions.get(scopeId) === admission) this.admissions.delete(scopeId)
    }
  }

  private acceptedReceipt(
    input: Pick<DashboardChatReconciliation, 'requestId' | 'requestFingerprint'>,
    requestKey: string,
    digest?: string,
  ): DashboardChatReceipt | undefined {
    const previous = this.domain!.table('requests').get(requestKey)
    if (previous === undefined) return undefined
    if (previous.requestFingerprint !== input.requestFingerprint
      || (digest !== undefined && previous.digest !== digest)) {
      throw new DashboardChatError('REQUEST_CONFLICT', 'Dashboard request identifier was already used with different content.')
    }
    if (previous.state === 'claimed') {
      throw new DashboardChatError('REQUEST_UNCERTAIN', 'Dashboard question admission was interrupted; inspect history before submitting a new question.')
    }
    return { sessionId: SessionId(previous.sessionId), requestId: input.requestId }
  }

  private async handle(scope: DashboardChatScope): Promise<AgentHandle> {
    await this.checkOwner()
    const found = this.handles.get(scope.id)
    if (found !== undefined) {
      return found
    }
    let opening = this.opens.get(scope.id)
    if (opening === undefined) {
      opening = this.openHandle(scope)
      this.opens.set(scope.id, opening)
    }
    try {
      return await opening
    } finally {
      if (this.opens.get(scope.id) === opening) this.opens.delete(scope.id)
    }
  }

  private async openHandle(scope: DashboardChatScope): Promise<AgentHandle> {
    const scopes = this.domain!.table('scopes')
    const scopeKey = hashTuple([scope.id])
    let row = scopes.get(scopeKey)
    if (row === undefined) {
      row = { scopeId: scope.id, sessionId: `dashboard-${randomUUID()}`, state: 'reserved' }
      await scopes.put(scopeKey, row)
    }
    const sessionId = SessionId(row.sessionId)
    if (this.ctx.agents.get(sessionId) !== undefined || this.ctx.sessions.get(sessionId) !== undefined) {
      throw new DashboardChatError('SESSION_OWNED', 'Dashboard Session is already attached to another owner.')
    }
    const existing = await this.ctx.sessionPersistence.stat(sessionId)
    if (existing === undefined && row.state === 'ready') {
      throw new DashboardChatError('SESSION_MISSING', 'Dashboard history is missing; refusing to replace its identity.')
    }
    const cwd = this.workingDirectory!
    if (existing !== undefined && existing.header.cwd !== cwd) {
      throw new DashboardChatError('SESSION_CONFLICT',
        'Dashboard history requires its original canonical working directory; histories without cwd cannot be adopted or rewritten.')
    }
    if (existing !== undefined && (existing.header.parentSession !== undefined || existing.header.origin !== undefined
      || existing.header.isSeeded || existing.header.agentPreset !== DASHBOARD_CHAT_PRESET)) {
      throw new DashboardChatError('SESSION_CONFLICT', 'Dashboard mapping points to an incompatible Session.')
    }
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      this.prepared.add(agent)
      if (existing !== undefined) agent.inbox.clear()
      const personal = scope.id === 'personal' && this.config.proposeAttention !== undefined
      agentCtx.effect(() => authorizeDashboardAgent(agent,
        personal ? {
          allows: exec => this.allowsProposal(agent, exec),
          persona: () => this.proposalSchemas(agent).length === 0 ? DASHBOARD_CHAT_PERSONA : DASHBOARD_ATTENTION_PERSONA,
        } : undefined), 'dashboardChat.authorizedAgent()')
      await this.ctx.agentPresets.mount(agentCtx, DASHBOARD_CHAT_PRESET)
      if (personal) {
        const definition = attentionTool((input, exec) => this.proposeAttention(agent, input, exec))
        agentCtx.effect(() => {
          this.attentionDefinitions.set(agent, definition)
          const remove = agentCtx.tools.register(definition, {
            when: context => context.agent === agent && this.proposalSchemas(agent).length === 1,
          })
          return () => { this.attentionDefinitions.delete(agent); remove() }
        }, 'dashboardChat.attentionTool()')
        agentCtx.effect(() => agentCtx.tools.guard(exec => {
          if (!this.allowsProposal(agent, exec)) return 'Attention proposals require the active approved Personal question.'
          this.active.get(agent.id)!.nativeTokens.add(exec.token)
          return undefined
        }), 'dashboardChat.attentionExecution()')
      }
    }
    const agentOptions = {
      ...this.ctx.agentDefaultModel.currentSelection(),
      maxTokens: this.config.maxOutputTokens,
    }
    const handle = existing === undefined
      ? await this.ctx.agents.create({
        sessionId, setup, agentOptions, signal: this.stopping.signal, meta: { cwd, agentPreset: DASHBOARD_CHAT_PRESET },
      })
      : await this.ctx.agents.resume({ resumeSessionId: sessionId, setup, agentOptions, signal: this.stopping.signal })
    try {
      this.assertActive()
      await this.ctx.sessions.flush(handle.agent.session)
      await scopes.put(scopeKey, { ...row, state: 'ready' })
      this.handles.set(scope.id, handle)
      return handle
    } catch (error) {
      await handle.dispose()
      throw error
    }
  }

  private async admit(capture: CapturedQuestion): Promise<DashboardChatReceipt> {
    const handle = await this.handle(capture.scope)
    const agent = handle.agent
    const requests = this.domain!.table('requests')
    const previous = this.acceptedReceipt(capture, capture.requestKey, capture.digest)
    if (previous !== undefined) return previous
    if (this.active.has(agent.id) || agent.status !== 'idle') {
      throw new DashboardChatError('BUSY', 'This Dashboard conversation already has a question in progress.')
    }
    let selection: LlmCallConfig
    try {
      selection = await this.ctx.llm.resolveCallConfig({
        ...this.ctx.agentDefaultModel.currentSelection(),
        maxTokens: this.config.maxOutputTokens,
      }, this.stopping.signal)
    } catch {
      throw new DashboardChatError('MODEL_UNAVAILABLE', 'The configured Dashboard model route is unavailable.')
    }
    await this.checkOwner()
    const row = {
      scopeId: capture.scope.id, sessionId: agent.id, requestId: capture.requestId,
      requestFingerprint: capture.requestFingerprint, digest: capture.digest, state: 'claimed' as const,
    }
    await requests.put(capture.requestKey, row)
    const active: ActiveQuestion = { capture, selection, nativeTokens: new Set() }
    this.active.set(agent.id, active)
    try {
      agent.followup(capture.envelope)
      const drain = this.drainQuestion(agent, active)
      this.drains.add(drain)
      void drain.finally(() => { this.drains.delete(drain) })
      await this.ctx.sessions.flush(agent.session)
      await requests.put(capture.requestKey, { ...row, state: 'queued' })
      return { sessionId: agent.id, requestId: capture.requestId }
    } catch {
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      this.active.delete(agent.id)
      throw new DashboardChatError('ADMISSION_FAILED', 'Dashboard question admission failed; its request identifier will not be replayed.')
    }
  }

  private async drainQuestion(agent: Agent, active: ActiveQuestion): Promise<void> {
    try {
      await agent.whenIdle()
      await this.ctx.sessions.flush(agent.session)
    } catch {
      this.failure = new DashboardChatError('CHECKPOINT_FAILED', 'Dashboard history could not be checkpointed.')
    } finally {
      if (this.active.get(agent.id) === active) this.active.delete(agent.id)
    }
  }

  private owns(id: string): boolean {
    const agent = this.ctx.agents.get(SessionId(id))
    return id.startsWith('dashboard-')
      || (agent !== undefined && this.ctx.agentPresets.composedPreset(agent.ctx) === DASHBOARD_CHAT_PRESET)
      || this.ctx.sessions.get(SessionId(id))?.header.agentPreset === DASHBOARD_CHAT_PRESET
  }

  private proposalSchemas(agent: Agent): ToolSchema[] {
    const active = this.active.get(agent.id)
    const definition = this.attentionDefinitions.get(agent)
    if (definition === undefined || active?.capture.scope.id !== 'personal'
      || active.capture.attentionGrant === undefined || active.capture.attentionGrant.items.length === 0
      || this.state !== 'active' || active.signal?.aborted === true
      || this.ctx.tools.get(ATTENTION_TOOL_NAME, agent) !== definition) return []
    return [{ name: definition.name, description: definition.description, parameters: definition.parameters }]
  }

  private allowsProposal(agent: Agent, exec: Readonly<ToolExecution>): boolean {
    const active = this.active.get(agent.id)
    if (exec.agent !== agent || this.ctx.agents.get(agent.id) !== agent
      || this.ctx.agents.currentInitiator() !== agent || this.state !== 'active' || this.failure !== undefined
      || this.stopping.signal.aborted || exec.signal.aborted || active?.signal?.aborted !== false
      || (exec.signal !== active.signal && !active.nativeTokens.has(exec.token))
      || active.turn === undefined || agent.status !== 'running'
      || exec.name !== ATTENTION_TOOL_NAME || exec.parent !== undefined || exec.rootCallId !== exec.callId
      || this.proposalSchemas(agent).length !== 1
      || (active.proposalToken !== undefined && active.proposalToken !== exec.token)) return false
    const calls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call'
      && event.data.turn === active.turn && event.data.step === 1 && event.data.callId === exec.callId)
    const call = calls[0]
    if (calls.length !== 1 || call?.type !== 'tool/call' || call.data.name !== ATTENTION_TOOL_NAME) return false
    try {
      return JSON.stringify(JSON.parse(call.data.arguments)) === JSON.stringify(exec.arguments)
    } catch {
      // Invalid native JSON reaches defineTool as text and must remain a logged tool failure.
      return call.data.arguments === exec.arguments
    }
  }

  private async proposeAttention(agent: Agent, input: AttentionToolInput, exec: ToolRunContext): Promise<AttentionProposal> {
    if (!allowsAttentionExecution(exec) || !this.active.get(agent.id)?.nativeTokens.has(exec.token)) {
      throw new DashboardChatError('ATTENTION_DENIED', 'Attention proposals require the active approved Personal question.')
    }
    const active = this.active.get(agent.id)!
    const grant = active.capture.attentionGrant!
    const item = grant.items.find(entry => entry.key === input.itemKey)
    if (item === undefined || item.itemId === null || item.ambiguous
      || (item.effective.mode !== 'visible' && input.intent.kind !== 'restore')) {
      throw new DashboardChatError('ATTENTION_DENIED', 'This operation requires an eligible item in the captured Personal evidence.')
    }
    if (active.proposalToken !== undefined) {
      throw new DashboardChatError('ATTENTION_DENIED', 'Only one attention proposal may be submitted per question.')
    }
    // Reserve before ownership/storage awaits; sibling calls cannot stage a second proposal.
    active.proposalToken = exec.token
    await this.checkOwnership()
    if (!allowsAttentionExecution(exec)) {
      throw new DashboardChatError('ATTENTION_DENIED', 'Attention proposal authorization ended before persistence.')
    }
    const signal = AbortSignal.any([exec.signal, this.stopping.signal])
    const proposal = attentionProposalSchema.parse(await this.config.proposeAttention!({
      sessionId: agent.id, questionId: active.capture.requestId, callId: exec.callId,
      evidenceDigest: active.capture.digest, grant, input,
    }, signal))
    signal.throwIfAborted()
    if (!allowsAttentionExecution(exec)) {
      throw new DashboardChatError('ATTENTION_DENIED', 'Attention proposal authorization ended before completion.')
    }
    if (proposal.sessionId !== agent.id
      || proposal.questionId !== active.capture.requestId || proposal.target.key !== item.key
      || proposal.target.title !== item.title || proposal.target.url !== item.url
      || proposal.target.fingerprint !== item.fingerprint || proposal.expectedRevision !== item.revision
      || JSON.stringify(proposal.intent) !== JSON.stringify(input.intent)) {
      throw new DashboardChatError('ATTENTION_RECEIPT', 'Attention storage returned a proposal for different captured evidence or intent.')
    }
    return proposal
  }

  private installPolicy(): void {
    const ctx = this.ctx
    this.listeners.push(ctx.on('agent/created', ({ agent }) => {
      if (this.owns(agent.id) && !this.prepared.has(agent)) {
        throw new DashboardChatError('PRIVATE_SESSION', 'Dashboard Sessions can only be activated by the Dashboard Host.')
      }
    }, { prepend: true }))
    this.listeners.push(ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next): Promise<PreStepDecision> => {
      if (!this.owns(agent.id)) return next()
      await this.checkOwner()
      const active = this.active.get(agent.id)
      if (active === undefined || active.turn !== undefined || step !== 1 || messages.length !== 1
        || JSON.stringify(messages[0]) !== JSON.stringify(active.capture.envelope)) {
        return { kind: 'reject' }
      }
      active.turn = turn
      active.signal = signal
      return { kind: 'enter', messages: [active.capture.question, active.capture.context] }
    }, { prepend: true }))
    this.listeners.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      if (context.agent === undefined || !this.owns(context.agent.id)) return assembly
      const selection = this.active.get(context.agent.id)?.selection
      return {
        sections: [{ name: 'dashboard:analysis', text: dashboardPersona(context.agent) }],
        contexts: [],
        variables: { ...assembly.variables, provider: selection?.provider, model: selection?.model },
      }
    }, { prepend: true }))
    this.listeners.push(ctx.on('agent/request', async ({ agent, turn, step }, next) => {
      if (!this.owns(agent.id)) return next()
      await this.checkOwner()
      const active = this.active.get(agent.id)
      if (active?.turn !== turn || step !== 1) {
        throw new DashboardChatError('PRIVATE_INPUT', 'Dashboard model requests require an approved question.')
      }
      return { ...active.selection }
    }, { prepend: true }))
    this.listeners.push(ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.agent === undefined || !this.owns(exec.agent.id)) return next()
      if (allowsAttentionExecution(exec)) return next()
      return { kind: 'deny', reason: 'Dashboard conversations provide analysis only; tools are disabled.' }
    }, { prepend: true }))
    this.listeners.push(ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === undefined || !this.owns(exec.agent.id)) return next()
      if (allowsAttentionExecution(exec)) return next()
      throw new DashboardChatError('TOOLS_DISABLED', 'Dashboard conversations cannot execute tools.')
    }, { prepend: true }))
    this.listeners.push(ctx.on('llm/stream', (options, next) => {
      if (options.sessionId === undefined || !this.owns(options.sessionId)) return next()
      return this.checkpointRequest(options, next)
    }, { prepend: true }))
  }

  private async *checkpointRequest(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    await this.checkOwner()
    const session = options.sessionId === undefined ? undefined : this.ctx.sessions.get(options.sessionId)
    const active = session === undefined ? undefined : this.active.get(session.id)
    const agent = session === undefined ? undefined : this.ctx.agents.get(session.id)
    const tools = agent === undefined ? [] : this.proposalSchemas(agent)
    if (session === undefined || active?.turn === undefined || !isAgentLoopRequest(options) || options.system !== undefined
      || JSON.stringify(options.tools ?? []) !== JSON.stringify(tools)
      || JSON.stringify(options.messages) !== JSON.stringify(session.deriveMessages())
      || options.messages.at(-2)?.id !== active.capture.question.id
      || options.messages.at(-1)?.id !== active.capture.context.id) {
      throw new DashboardChatError('PRIVATE_INPUT', 'Dashboard model request does not match its approved logged evidence.')
    }

    await this.ctx.sessions.flush(session)
    yield* next()
  }

  private async close(): Promise<void> {
    await Promise.allSettled([this.ready, ...this.operations])
    const handles = [...this.handles.values()]
    const cancellations = await Promise.allSettled(handles.map(async handle => { handle.agent.cancel({ kind: 'disposed' }) }))
    // Admission checkpoints still need their Session writer after the native turn becomes idle.
    await Promise.allSettled([...this.drains])
    const outcomes = await Promise.allSettled(handles.map(handle => handle.dispose()))
    this.handles.clear()
    this.active.clear()
    const resources = await Promise.allSettled([this.domain?.close()])
    const dependencies = await Promise.allSettled([
      Promise.resolve().then(() => this.config.beforeReleaseOwnership?.()),
    ])
    const ownership = this.ownership
    this.ownership = undefined
    let release: PromiseSettledResult<void>[]
    try {
      release = await Promise.allSettled([ownership?.dispose()])
    } finally {
      for (const dispose of this.listeners) dispose()
      this.state = 'closed'
    }
    const failed = [...cancellations, ...outcomes, ...resources, ...dependencies, ...release]
      .find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
