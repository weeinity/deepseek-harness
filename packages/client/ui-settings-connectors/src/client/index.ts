/** Connectors page registration and safe Remote operation adapters. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConnectorEntry, ConnectorsSectionInjected } from './contract.ts'
import { ConnectorsSection } from './ConnectorsSection.tsx'
import { ConnectorRequestError } from './request-error.ts'
import { ConnectorNotice, type ConnectorNoticeState } from './ConnectorNotice.tsx'
import { en, zh, type ConnectorsKey } from './locales.ts'

export type { ConnectorsSectionInjected, ConnectorsSectionProps } from './contract.ts'
export type { ConnectorsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP connector discovery and enablement copy. */
    'settings.connectors': ConnectorsKey
  }
}

/** Services needed by the settings contribution and its Host operations. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginManager']

/**
 * Register a lazy Connectors settings page.
 * @param ctx - Browser context providing Settings slots and connector Remotes.
 */
export function apply(ctx: Context): void {
  const namespace = 'settings.connectors'
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'ui-settings-connectors: dictionaries')
  const t = ctx.locale.bind(namespace)
  const notice = createSnapshotStore<ConnectorNoticeState | null>(null)
  let sequence = 0
  let disposed = false
  ctx.effect(() => () => { disposed = true; notice.set(null) }, 'ui-settings-connectors: notices')
  const report = (kind: ConnectorNoticeState['kind']) => {
    if (!disposed) notice.set({ kind, sequence: ++sequence })
  }
  const list: ConnectorsSectionInjected['list'] = async () => {
    const inventory = await ctx.remote.pluginInventory.list()
    if (!inventory.ok) throw new ConnectorRequestError(inventory.error.code)
    const writable = inventory.value.managementAvailable === true
    const managed = writable ? await ctx.remote.pluginManager.listPlugins() : undefined
    if (managed !== undefined && !managed.ok) throw new ConnectorRequestError(managed.error.code)
    const rows = managed?.ok ? managed.value : inventory.value.entries
    const entries: ConnectorEntry[] = rows.flatMap((row) => {
      if (row.connector === undefined) return []
      const blockedReason = !writable ? 'unsupported-context' : 'readOnlyReason' in row ? 'unsupported-target' : undefined
      return [{
        id: row.entryId, ...row.connector, enabled: row.enabled, fiberPhase: row.fiberPhase,
        canToggle: blockedReason === undefined,
        ...blockedReason === undefined ? {} : { blockedReason },
      }]
    })
    return { capability: writable ? 'live' : 'read-only', entries }
  }
  const operations: ConnectorsSectionInjected = {
    list,
    setEnabled: async ({ id, enabled }) => {
      try {
        const result = await ctx.remote.pluginManager.setPluginEnabled(id, enabled)
        if (!result.ok) throw new ConnectorRequestError(result.error.code)
        if (!result.value.changed && result.value.application !== 'applied') {
          throw new ConnectorRequestError('connectors/save-failed')
        }
        const snapshot = await list()
        const applied = result.value.application === 'applied'
        report(applied ? 'saved' : 'restartRequired')
        return { applied, snapshot }
      } catch (error) {
        report('saveFailed')
        throw error
      }
    },
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'connectors.notice', locale: namespace,
    inject: () => ({ hooks: { notice }, dismiss: () => { notice.set(null) } }),
  }, ConnectorNotice))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connectors',
    order: 14,
    label: () => t('title'),
    locale: namespace,
    inject: () => operations,
  }, ConnectorsSection))
}
