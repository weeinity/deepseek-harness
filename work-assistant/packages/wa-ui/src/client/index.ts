/** Client assembly for the personal-assistant panel and optional acknowledgement replies. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { AssistantPanel, type AssistantPanelInjected, type RightbarPresentation } from './AssistantPanel.tsx'
import panelCss from './AssistantPanel.module.css?inline'
import { AssistantBrandMark, AssistantToggle, type AssistantToggleInjected } from './AssistantToggle.tsx'
import { AssistantSessionBridge, type AssistantSessionBridgeInjected } from './AssistantSessionBridge.tsx'
import toggleCss from './AssistantToggle.module.css?inline'
import { en, NS, zh } from './locales.ts'
import { createAssistantPanelStore } from './store.ts'
import { installPluginStyles } from './styles.ts'
import { NOCTURNE_TOKENS } from './theme.ts'
import { createAssistantSessionViewSource } from './sessionView.ts'
import { createBriefingSource } from './briefing.ts'
import { ReceiptBadge, type ReceiptBadgeInjected } from './ReceiptBadge.tsx'
import receiptCss from './ReceiptBadge.module.css?inline'
import { CLIENT_CONFIG_KEY, resolveClientConfig } from '../config.ts'

const PACKAGE_ID = '@deepseek-ai/dsh-wa-ui'
const REPLACEMENT_PRIORITY = -100
const CLOSED_PRESENTATION: RightbarPresentation = Object.freeze({
  shown: false,
  track: false,
  fullscreen: false,
})
const INITIAL_PRESENTATION: RightbarPresentation = Object.freeze({
  shown: true,
  track: true,
  fullscreen: false,
})

/** Services used while registering the personal-assistant UI. */
export const inject = ['slots', 'locale', 'layout', 'connection', 'uiWorkspace', 'theme', 'chatReactions']

/**
 * Register assistant presentation using the matching Host's public boot configuration.
 * @param ctx - Browser context owning the UI contributions.
 */
export function apply(ctx: Context): void {
  const boot: unknown = Reflect.get(globalThis, CLIENT_CONFIG_KEY)
  if (boot === undefined) throw new Error('wa-ui: public display configuration is missing; load the matching Host bundle')
  const { maxActivities, defaultTab, receipt, inboxRefreshIntervalMs, inboxRequestTimeoutMs } = resolveClientConfig(boot)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'wa-ui: dictionaries')
  ctx.effect(() => installPluginStyles(PACKAGE_ID, [
    { id: 'AssistantPanel.module.css', css: panelCss },
    { id: 'AssistantToggle.module.css', css: toggleCss },
    { id: 'ReceiptBadge.module.css', css: receiptCss },
  ]), 'wa-ui: styles')
  ctx.effect(() => (ctx.theme as ThemeRuntime).overrideTokens('wa-nocturne', NOCTURNE_TOKENS), 'wa-ui: nocturne theme tokens')
  if (receipt !== null && receipt.style !== 'off') {
    ctx.effect(() => ctx.chatReactions.register({
      presetIds: receipt.presetIds,
      emoji: '\u{1f44d}',
    }), 'wa-ui: optional acknowledgement replies')
  }

  ctx.effect(() => {
    const store = createAssistantPanelStore(defaultTab)
    const sessionViewSource = createAssistantSessionViewSource()
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new Error('wa-ui: connection service missing')
    const briefing = createBriefingSource(inboxRefreshIntervalMs, inboxRequestTimeoutMs)
    const unsubscribeConnection = connection.state.subscribe(() => {
      if (connection.state.getSnapshot() === 'connected') void briefing.refresh()
    })
    const reportPresentation = (presentation: RightbarPresentation): void => {
      if (presentation.shown) ctx.layout.openRightbar(presentation.track, presentation.fullscreen)
      else ctx.layout.closeRightbar()
    }
    const panelInjected = (): AssistantPanelInjected => ({
      maxActivities,
      openSession: sessionId => { ctx.uiWorkspace.openSession(sessionId) },
      copyPrompt: text => navigator.clipboard.writeText(text),
      reportPresentation,
      actOnBriefing: action => briefing.act(action),
      refreshBriefing: () => briefing.refresh(),
      hooks: { connectionState: connection.state, sessionView: sessionViewSource, briefing },
    })
    const toggleInjected = (): AssistantToggleInjected => ({
      revealConversation: () => { ctx.layout.selectPanel(null) },
      collapseSidebarOnce: () => { ctx.layout.toggleSidebar() },
      hooks: { briefing },
    })
    const bridgeInjected = (_sessionId: SessionId): AssistantSessionBridgeInjected => ({
      publishSessionView: view => { sessionViewSource.setSessionView(view) },
      clearSessionView: sessionId => { sessionViewSource.clearSessionView(sessionId) },
    })
    const disposeRightbar = ctx.slots.inject('rightbar', () => ctx.slots.register({
      name: 'rightbar',
      priority: REPLACEMENT_PRIORITY,
      locale: NS,
      store,
      inject: panelInjected,
    }, AssistantPanel))
    const disposeFooter = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'wa-assistant-toggle',
      order: 90,
      locale: NS,
      store,
      inject: toggleInjected,
    }, AssistantToggle))
    const disposeBrandMark = ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
      name: 'sidebar.brand.mark',
      priority: REPLACEMENT_PRIORITY,
    }, AssistantBrandMark))
    const disposeHeaderCorner = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
      name: 'conversation.session.header.corner',
      priority: REPLACEMENT_PRIORITY,
      inject: bridgeInjected,
    }, AssistantSessionBridge))
    const disposeReceipt = receipt === null || receipt.style === 'off'
      ? undefined
      : ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.user-badges',
        id: 'wa-assistant-receipt',
        locale: NS,
        inject: (): ReceiptBadgeInjected => ({ policy: receipt }),
      }, ReceiptBadge))
    reportPresentation(INITIAL_PRESENTATION)
    return () => {
      unsubscribeConnection()
      briefing.dispose()
      disposeReceipt?.()
      disposeHeaderCorner()
      disposeBrandMark()
      disposeFooter()
      disposeRightbar()
      reportPresentation(CLOSED_PRESENTATION)
    }
  }, 'wa-ui: slot registrations')
}
