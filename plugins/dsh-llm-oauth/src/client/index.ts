/**
 * Browser half: Settings → OAuth / 订阅 (standalone nav section).
 *
 * Declared via package.json `dsh.client`. Auth (enable / login / logout) is
 * done with buttons on this page — no need to type `/oauth` in chat.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OauthSection, type OauthSectionInjected } from './OauthSection.tsx'
import { en, zh, type OauthSettingsKey } from './locales.ts'

export type { OauthSectionInjected, OauthSectionProps } from './OauthSection.tsx'
export type { OauthSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.oauth': OauthSettingsKey
  }
}

const NS = 'settings.oauth'

/** Required client services. */
export const inject = ['slots', 'locale']

/**
 * Register a standalone OAuth settings section next to Models / Plugins.
 * @param ctx - browser Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-llm-oauth: dictionaries')

  const t = ctx.locale.bind(NS) as OauthSectionInjected['t']
  const injected = (): OauthSectionInjected => ({ t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'oauth',
    // After Models (10), before Plugins (15).
    order: 12,
    label: () => t('nav'),
    inject: injected,
  }, OauthSection))
}
