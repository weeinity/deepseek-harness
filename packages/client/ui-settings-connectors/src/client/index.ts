/** Connectors page registration and safe Remote operation adapters. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectorsSectionInjected } from './contract.ts'
import { ConnectorsSection } from './ConnectorsSection.tsx'
import { ConnectorRequestError } from './request-error.ts'
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
export const inject = ['slots', 'locale', 'remote', 'remote.connectors']

/**
 * Register a lazy Connectors settings page.
 * @param ctx - Browser context providing Settings slots and connector Remotes.
 */
export function apply(ctx: Context): void {
  const namespace = 'settings.connectors'
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'ui-settings-connectors: dictionaries')
  const t = ctx.locale.bind(namespace)
  const operations: ConnectorsSectionInjected = {
    list: async () => {
      const result = await ctx.remote.connectors.list()
      if (!result.ok) throw new ConnectorRequestError(result.error.code)
      return result.value
    },
    setEnabled: async (request) => {
      const result = await ctx.remote.connectors.setEnabled(request)
      if (!result.ok) throw new ConnectorRequestError(result.error.code)
      return result.value
    },
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connectors',
    order: 15,
    label: () => t('title'),
    locale: namespace,
    inject: () => operations,
  }, ConnectorsSection))
}
