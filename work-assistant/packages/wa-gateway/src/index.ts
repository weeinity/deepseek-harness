/** Trusted connector dispatch, UI interaction admission, and a monotonic tool guard. */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { auditDomain, type ActionId, type AuditRecord, type OwnerId } from './audit.ts'

export type { AuditRecord, OwnerId } from './audit.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workAssistGateway: ActionGateway
  }
}

/** Deployment-owned identity; no request may override it. */
export interface Config {
  ownerId: string
}

/** Connector-owned classification, not fields in a model tool request. */
export interface ActionPolicy {
  connector: string
  method: string
  kind: 'read' | 'write'
  /** Conservatively marks the Session as exposed before attempting the read. */
  externalContent?: boolean
  /** Human-readable scope of a one-time write approval. */
  approvalReason?: string
}

/** An action cannot execute without a required one-time grant. */
export class ActionDenied extends Error {
  override name = 'ActionDenied'
}

interface ToolInputSnapshot {
  readonly json: string
  readonly value: unknown
}

interface WriteApprovalInvalidation {
  readonly signal: AbortSignal
  readonly dispose: () => void
}

type ToolAgent = NonNullable<ToolRunContext['agent']>
type AgentWithContext = ToolAgent & { readonly ctx?: Context }

function freezeJsonValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJsonValue(child)
    Object.freeze(value)
  }
  return value
}

function snapshotToolInput(args: unknown): ToolInputSnapshot {
  const json = JSON.stringify(args)
  if (json === undefined) throw new TypeError('Assistant action arguments must be JSON-serializable values')
  return { json, value: freezeJsonValue(JSON.parse(json)) }
}

function isDirectHumanMessage(message: UserMessage): boolean {
  return message.source.kind === 'user'
}

/** All registered actions are audited before dispatch; writes always ask. */
export default class ActionGateway extends Service {
  static inject = ['tools', 'approval', 'credentials', 'storageDomain']
  static Config: Schema<Config> = Schema.object({
    ownerId: Schema.string().required(),
  })

  private readonly ownerId: OwnerId
  private readonly admitted = new Map<string, ToolDefinition>()
  private readonly admittedInteractions = new Set<ToolDefinition>()
  private readonly exposed = new Set<AuditRecord['sessionId']>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly shutdown = new AbortController()
  private domain: Domain<typeof auditDomain> | undefined

  /**
   * @param ctx - DSH services in the dedicated personal profile.
   * @param config - Validated deployment identity.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workAssistGateway')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(config.ownerId)) {
      throw new TypeError('wa-gateway.ownerId must be a nonempty identifier of at most 80 characters')
    }
    this.ownerId = brandString<OwnerId>(config.ownerId)
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(auditDomain)
    this.domain = domain
    this.ctx.effect(() => async () => {
      this.shutdown.abort(new Error('Personal-assistant gateway is unloading'))
      await Promise.allSettled([...this.pending])
      await domain.close()
    }, 'workassist.gateway.close')

    for (const [id, record] of domain.table('audit').entries()) {
      if (record.tainted) this.exposed.add(record.sessionId)
      if (record.status === 'pending' || record.status === 'running') {
        await domain.table('audit').update(id, current => ({
          ...current, status: 'interrupted', updatedAt: new Date().toISOString(),
        }))
      }
    }
    this.ctx.tools.guard(exec => {
      const current = this.ctx.tools.get(exec.name, exec.agent)
      const owned = this.admitted.get(exec.name)
      const admittedConnector = owned !== undefined && current === owned
      const admittedInteraction = current !== undefined && this.admittedInteractions.has(current)
      return admittedConnector || admittedInteraction
        ? undefined
        : 'This tool is not admitted by the personal-assistant gateway'
    })
  }

  /**
   * Register one connector tool and its fixed policy; unloading its owner revokes it.
   * @param owner - The connector's plugin context.
   * @param tool - Tool definition with validated inputs and canonical output.
   * @param policy - Trusted connector/action classification.
   * @returns Idempotent registration disposer.
   */
  register(owner: Context, tool: ToolDefinition, policy: ActionPolicy): () => void {
    this.shutdown.signal.throwIfAborted()
    if (this.admitted.has(tool.name)) throw new Error(`Duplicate assistant action: ${tool.name}`)
    const classification = { ...policy }
    return owner.effect(() => {
      const wrapped: ToolDefinition = {
        ...tool,
        execute: (args, exec) => {
          this.shutdown.signal.throwIfAborted()
          const operation = this.execute(tool, classification, args, exec)
          this.pending.add(operation)
          void operation.then(
            () => { this.pending.delete(operation) },
            () => { this.pending.delete(operation) },
          )
          return operation
        },
      }

      const unregister = owner.tools.register(wrapped)
      this.admitted.set(tool.name, wrapped)
      return () => {
        this.admitted.delete(tool.name)
        unregister()
      }
    }, `workassist.action.${tool.name}`)
  }

  /**
   * Admit the exact scoped `ask_user_question` definition installed for one agent.
   *
   * This admission only lets the normal DSH user-question tool pass the gateway's monotonic guard.
   * It does not route through connector audit, request connector approval, or grant permission for any write.
   *
   * @param owner - The agent-scoped plugin context that owns the interaction tool.
   * @param definition - The current definition returned by `ctx.tools.get('ask_user_question', scopeOf(owner))`.
   * @returns Exact disposer that revokes this definition's guard admission.
   */
  admitUserQuestionTool(owner: Context, definition: ToolDefinition): () => void {
    this.shutdown.signal.throwIfAborted()
    if (definition.name !== 'ask_user_question') {
      throw new Error('Only ask_user_question can be admitted as a personal-assistant interaction')
    }
    return owner.effect(() => {
      if (this.admittedInteractions.has(definition)) {
        throw new Error('Duplicate personal-assistant interaction admission')
      }
      this.admittedInteractions.add(definition)
      return () => { this.admittedInteractions.delete(definition) }
    }, 'workassist.interaction.ask_user_question')
  }

  /**
   * Resolve a secret only inside a trusted connector's operation.
   * @param ref - Deployment-provided credential reference, never a tool argument.
   * @returns Current credential value; missing credentials fail explicitly.
   */
  async credential(ref: CredentialRef): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) throw new Error('The configured assistant credential is missing')
    return resolved.value
  }

  /**
   * Inspect action metadata without exposing argument bodies or provider responses.
   * @returns Snapshot of the durable audit records.
   */
  records(): readonly AuditRecord[] {
    return [...this.audit().entries()].map(([, record]) => structuredClone(record))
  }

  private audit() {
    if (this.domain === undefined) throw new Error('Personal-assistant audit storage is not ready')
    return this.domain.table('audit')
  }

  private async execute(tool: ToolDefinition, policy: ActionPolicy, args: unknown, exec: ToolRunContext): Promise<unknown> {
    if (exec.agent === undefined) throw new ActionDenied('Assistant actions require a Session-owned agent')
    const input = snapshotToolInput(args)
    const operationSignal = AbortSignal.any([exec.signal, this.shutdown.signal])
    const invalidation = policy.kind === 'write' ? this.watchWriteApprovalInvalidation(exec.agent) : undefined
    const approvalSignal = invalidation === undefined
      ? operationSignal
      : AbortSignal.any([operationSignal, invalidation.signal])
    const sessionId = exec.agent.session.id
    if (policy.externalContent === true) this.exposed.add(sessionId)
    const id = brandString<ActionId>(randomUUID())
    const timestamp = new Date().toISOString()
    try {
      operationSignal.throwIfAborted()
      await this.audit().put(id, {
        id, ownerId: this.ownerId, sessionId, callId: exec.callId,
        tool: tool.name, connector: policy.connector, method: policy.method, kind: policy.kind,
        argsSha256: createHash('sha256').update(input.json).digest('hex'),
        tainted: this.exposed.has(sessionId),
        decision: policy.kind === 'write' ? 'ask' : 'allow',
        status: 'pending', startedAt: timestamp, updatedAt: timestamp,
      })

      await this.denyStaleWrite(id, invalidation)
      if (policy.kind === 'write') {
        let outcome: Awaited<ReturnType<Context['approval']['request']>>
        try {
          outcome = await this.ctx.approval.request({
            agent: exec.agent, toolName: tool.name, callId: exec.callId, signal: approvalSignal,
            reason: policy.approvalReason ?? 'Approve this personal-assistant write once',
          })
        } catch (error) {
          await this.denyStaleWrite(id, invalidation)
          await this.finish(id, 'failed', 'deny')
          throw error
        }
        await this.denyStaleWrite(id, invalidation)
        if (outcome !== 'allowed-once') {
          await this.finish(id, 'denied', 'deny')
          throw new ActionDenied(`Assistant write was not approved (${outcome})`)
        }
      }
      await this.finish(id, 'running', 'allow')
      if (operationSignal.aborted) {
        await this.finish(id, 'interrupted', 'deny')
        operationSignal.throwIfAborted()
      }
      const staleReason = this.staleWriteReason(invalidation)
      if (staleReason !== undefined) {
        await this.finish(id, 'denied', 'deny')
        throw staleReason
      }
    } finally {
      invalidation?.dispose()
    }

    let value: unknown
    try {
      value = await tool.execute(input.value, { ...exec, signal: operationSignal })
    } catch (error) {
      await this.finish(id, operationSignal.aborted ? 'interrupted' : 'failed', 'allow')
      throw error
    }
    await this.finish(id, 'succeeded', 'allow')
    return value
  }

  private async finish(id: ActionId, status: AuditRecord['status'], decision: AuditRecord['decision']): Promise<void> {
    await this.audit().update(id, current => ({
      ...current, status, decision, updatedAt: new Date().toISOString(),
    }))
  }

  private staleWriteReason(invalidation: WriteApprovalInvalidation | undefined): unknown | undefined {
    if (invalidation === undefined || !invalidation.signal.aborted) return undefined
    return invalidation.signal.reason ?? new ActionDenied('Assistant write approval was invalidated by newer user input')
  }

  private async denyStaleWrite(id: ActionId, invalidation: WriteApprovalInvalidation | undefined): Promise<void> {
    const reason = this.staleWriteReason(invalidation)
    if (reason === undefined) return
    await this.finish(id, 'denied', 'deny')
    throw reason
  }

  private watchWriteApprovalInvalidation(agent: ToolAgent): WriteApprovalInvalidation {
    const controller = new AbortController()
    const owner = (agent as AgentWithContext).ctx ?? this.ctx
    const dispose = owner.on('agent/inbox/inserted', ({ agent: insertedAgent, message }) => {
      if (insertedAgent !== agent || !isDirectHumanMessage(message)) return
      controller.abort(new ActionDenied('Assistant write approval was invalidated by newer user input'))
    })
    return { signal: controller.signal, dispose: () => { dispose() } }
  }
}
