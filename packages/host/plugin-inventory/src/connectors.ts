/** Redacted MCP inventory and loopback-only profile flag control. */
import type { Context } from '@deepseek-ai/cordis'
import type { ProfileConnectorSnapshot } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { FIBER_PHASE } from './fiber-phase.ts'
import type {
  ConnectorEntry, ConnectorMutationReceipt, ConnectorRevision, ConnectorSetEnabledRequest, ConnectorSnapshot, PluginEntryId,
} from './types.ts'

/** Host owner of the connectors Remote namespace; Connection supplies request authentication. */
export class ConnectorsGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'connectors')
  }

  private local(): boolean {
    return this.ctx.get('webServer')?.host === '127.0.0.1'
  }

  private project(snapshot: ProfileConnectorSnapshot): ConnectorSnapshot {
    const local = this.local()
    const entries: ConnectorEntry[] = snapshot.entries.map(({ entry, blockedReason }) => {
      const config: unknown = entry.options.config
      const fields = typeof config === 'object' && config !== null && !Array.isArray(config)
        ? config as Record<string, unknown> : {}
      const serverName = typeof fields.serverName === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(fields.serverName)
        ? fields.serverName : entry.id
      const transport = fields.transport === 'stdio' || fields.transport === 'streamable-http'
        ? fields.transport : null
      const reason = !local ? 'local-only' : blockedReason
      return {
        id: entry.id as PluginEntryId,
        serverName,
        transport,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
        canToggle: reason === undefined,
        ...reason === undefined ? {} : { blockedReason: reason },
      }
    })
    return { revision: snapshot.revision, capability: snapshot.live && local ? 'live' : 'read-only', entries }
  }

  /**
   * Enumerate global MCP entries without evaluating config or returning connection secrets.
   * @returns Safe metadata, effective enablement, and profile mutation capability.
   * @throws RemoteError when the profile's authored layers cannot be read.
   */
  @Remote('list')
  async list(): Promise<ConnectorSnapshot> {
    const control = this.ctx.get('profileConnectors')
    if (control === undefined) {
      return this.project({
        revision: '' as ConnectorRevision,
        live: false,
        entries: [...this.ctx.loader.entries()]
          .filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client' && !entry.options.group)
          .map(entry => ({ entry, blockedReason: 'unsupported-context' })),
      })
    }
    try {
      return this.project(await control.read())
    } catch {
      throw new RemoteError('connectors/rejected', 'Connector configuration cannot be read', {})
    }
  }

  /**
   * Persist one MCP flag only on a loopback-bound Web deployment.
   * @param request - Full entry identity, desired enablement, and the last observed revision.
   * @returns Persistence/application facts and observed Loader state, which may retain the previous flag on failure.
   * @throws RemoteError for nonlocal calls, unsupported targets, stale revisions, or persistence failure.
   */
  @Remote('setEnabled')
  async setEnabled(request: ConnectorSetEnabledRequest): Promise<ConnectorMutationReceipt> {
    if (!this.local()) throw new RemoteError('connectors/local-only', 'Connector changes require a loopback-only Web server', {})
    const control = this.ctx.get('profileConnectors')
    if (control === undefined) throw new RemoteError('connectors/rejected', 'This launch cannot change connector configuration', {})
    const result = await control.setEnabled(request.id, request.enabled, request.expectedRevision)
    switch (result.kind) {
      case 'conflict':
        throw new RemoteError('connectors/conflict', 'Connector configuration changed; reload before retrying', {})
      case 'rejected':
        throw new RemoteError('connectors/rejected', 'This connector cannot be changed in the current profile', {})
      case 'persist-failed':
        throw new RemoteError('connectors/persist-failed', 'Connector configuration could not be saved', {})
      case 'written':
        return {
          persisted: true,
          applied: result.applied,
          restartRequired: !result.applied,
          snapshot: this.project(result.snapshot),
        }
      /* v8 ignore next 2 -- The boot capability returns this closed union; unknown variants require a TypeScript violation. */
      default:
        return assertNever(result)
    }
  }
}
