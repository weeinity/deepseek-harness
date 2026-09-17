/** Inputs for the Connectors settings page. */
import type { ConnectorEntry, ConnectorMutationReceipt, ConnectorSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Host operations supplied by the browser plugin's registration. */
export interface ConnectorsSectionInjected {
  /** Read configured global MCP entries and the revision fencing their updates. */
  list: () => Promise<ConnectorSnapshot>
  /** Persist an enablement change and report whether the Host applied it. */
  setEnabled: (request: {
    id: ConnectorEntry['id']
    enabled: boolean
    expectedRevision: ConnectorSnapshot['revision']
  }) => Promise<ConnectorMutationReceipt>
}

/** Settings slot, localized copy, and connector operations. */
export type ConnectorsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.connectors'>
  & InjectFace<ConnectorsSectionInjected>
