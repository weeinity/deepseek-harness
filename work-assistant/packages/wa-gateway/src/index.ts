/** Trusted connector dispatch, one-time approvals, and a monotonic tool guard. */
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
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

/** All registered actions are audited before dispatch; writes always ask. */
export default class ActionGateway extends Service {
  static inject = ['tools', 'approval', 'credentials', 'storageDomain']
  static Config: Schema<Config> = Schema.object({
    ownerId: Schema.string().required(),
  })

  private readonly ownerId: OwnerId
  private readonly admitted = new Map<string, ToolDefinition>()
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
      const owned = this.admitted.get(exec.name)
      return owned !== undefined && this.ctx.tools.get(exec.name, exec.agent) === owned
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
    const signal = AbortSignal.any([exec.signal, this.shutdown.signal])
    signal.throwIfAborted()
    const sessionId = exec.agent.session.id
    if (policy.externalContent === true) this.exposed.add(sessionId)
    const id = brandString<ActionId>(randomUUID())
    const timestamp = new Date().toISOString()
    await this.audit().put(id, {
      id, ownerId: this.ownerId, sessionId, callId: exec.callId,
      tool: tool.name, connector: policy.connector, method: policy.method, kind: policy.kind,
      argsSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
      tainted: this.exposed.has(sessionId),
      decision: policy.kind === 'write' ? 'ask' : 'allow',
      status: 'pending', startedAt: timestamp, updatedAt: timestamp,
    })

    if (policy.kind === 'write') {
      let outcome: Awaited<ReturnType<Context['approval']['request']>>
      try {
        outcome = await this.ctx.approval.request({
          agent: exec.agent, toolName: tool.name, callId: exec.callId, signal,
          reason: policy.approvalReason ?? 'Approve this personal-assistant write once',
        })
      } catch (error) {
        await this.finish(id, 'failed', 'deny')
        throw error
      }
      if (outcome !== 'allowed-once') {
        await this.finish(id, 'denied', 'deny')
        throw new ActionDenied(`Assistant write was not approved (${outcome})`)
      }
    }
    await this.finish(id, 'running', 'allow')
    if (signal.aborted) {
      await this.finish(id, 'interrupted', 'deny')
      signal.throwIfAborted()
    }
    let value: unknown
    try {
      value = await tool.execute(args, { ...exec, signal })
    } catch (error) {
      await this.finish(id, signal.aborted ? 'interrupted' : 'failed', 'allow')
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
}
