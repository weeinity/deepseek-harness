/** Global Dashboard page and source-isolated Q&A; ordinary Conversation selection is untouched. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { DashboardInjected } from './contract.ts'
import { Dashboard } from './Dashboard.tsx'
import { DashboardLauncher } from './DashboardLauncher.tsx'
import { DashboardOwner } from './owner.ts'
import { DashboardCache } from './cache.ts'
import { DashboardChatOwner } from './chat-owner.ts'
import { createDashboardStore } from './stores.ts'
import { en, zh, NS } from './locale.ts'
import { SnapshotDownloads } from './download.ts'
import { renderDashboardHtml } from '../export/html.ts'
import { createDashboardRequest } from './transport.ts'

export const name = 'dsh-dashboard'
export const inject = ['slots', 'locale', 'sessions', 'uiConversation']
const DASHBOARD_PANEL_ID = 'dashboard' as MainPanelId

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Dashboard Q&A history retained while its source-local conversation is open. */
    dashboardChat: unknown
  }
}

/** Register only effect-owned root slots and native history readers. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }))
  const store = createDashboardStore()
  const request = createDashboardRequest(fetch)
  const dashboard = new DashboardOwner(request, {
    now: () => Date.now(),
    hidden: () => typeof document === 'undefined' || document.hidden,
    onVisibility: callback => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', callback)
      return () => { document.removeEventListener('visibilitychange', callback) }
    },
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      return () => { clearTimeout(timer) }
    },
  }, () => crypto.randomUUID(), new DashboardCache(() => sessionStorage, () => {
    console.warn('[dsh-dashboard] Tab cache unavailable; source data remains in memory. Reload may require a source read.')
  }))
  const chat = new DashboardChatOwner(request, async (id, signal) => {
    // The validated Host response is the only source of this opaque Session identity.
    const reference = ctx.sessions.retain(id as SessionId, { source: 'dashboardChat', signal })
    try {
      await reference.ready
      return {
        session: reference.binding.session,
        chat: ctx.uiConversation.binding(reference.binding).target('chat'),
        dispose: async () => { reference.release() },
      }
    } catch (error) {
      reference.release()
      throw error
    }
  }, () => crypto.randomUUID(), afterTurn => { void dashboard.readAttention(afterTurn) })
  const downloads = new SnapshotDownloads(renderDashboardHtml, {
    createUrl: html => URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })),
    startDownload: (url, filename) => {
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.hidden = true
      document.body.appendChild(link)
      try { link.click() } finally { link.remove() }
    },
    revokeUrl: url => { URL.revokeObjectURL(url) },
    // Downloads expose no completion event; retain the URL through navigation initiation.
    afterNavigation: callback => { setTimeout(callback, 1000) },
  })
  ctx.effect(() => async () => { await Promise.all([dashboard.dispose(), chat.dispose(), downloads.dispose()]) })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: DASHBOARD_PANEL_ID, locale: NS, store,
    inject: (): DashboardInjected => ({
      hooks: { dashboard, dashboardChat: chat },
      select: dashboard.select, refresh: dashboard.refresh, exportSnapshot: downloads.download,
      loadAdoHistory: dashboard.loadAdoHistory,
      attentionActions: {
        apply: dashboard.applyAttention, undo: dashboard.undoAttention, decide: dashboard.decideAttention,
        retry: dashboard.retryAttention, read: dashboard.readAttention,
      },
      selectChat: chat.select, sendQuestion: chat.send, retryQuestion: chat.retrySend,
      retryHistory: chat.retryOpen, stopQuestion: chat.stop, loadHistory: chat.loadOlder,
    }),
  }, Dashboard))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: DASHBOARD_PANEL_ID,
    order: 30,
    label: () => ctx.locale.bind(NS)('view.label'),
  }, DashboardLauncher))
}
