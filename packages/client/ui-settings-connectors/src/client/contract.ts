/** Inputs for the Connectors settings page. */
import type { PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Display metadata and persistent control availability for one global MCP entry. */
export interface ConnectorEntry {
  id: PluginInfo['entryId']
  serverName: string
  transport: NonNullable<PluginInfo['connector']>['transport']
  enabled: boolean
  fiberPhase: PluginInfo['fiberPhase']
  canToggle: boolean
  blockedReason?: 'unsupported-context' | 'unsupported-target'
}

/** Last observed MCP entries in their configured order. */
export interface ConnectorSnapshot {
  capability: 'live' | 'read-only'
  entries: readonly ConnectorEntry[]
}

/** A persisted request and the independently observed application outcome. */
export interface ConnectorMutationReceipt {
  applied: boolean
  snapshot: ConnectorSnapshot
}

/** Host operations supplied by the browser plugin's registration. */
export interface ConnectorsSectionInjected {
  /** Read configured global MCP entries and available profile controls. */
  list: () => Promise<ConnectorSnapshot>
  /** Persist enablement and publish a global outcome notice; rejection leaves the displayed snapshot unchanged. */
  setEnabled: (request: {
    id: ConnectorEntry['id']
    enabled: boolean
  }) => Promise<ConnectorMutationReceipt>
}

/** Settings slot, localized copy, and connector operations. */
export type ConnectorsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.connectors'>
  & InjectFace<ConnectorsSectionInjected>
