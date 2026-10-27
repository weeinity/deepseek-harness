/** Derive all slot seats from framework contracts and the entry's own declarations. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ObservableSnapshot, PropsStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AdoSource, DashboardSnapshot } from '../shared/types.ts'
import type { DashboardState } from './owner.ts'
import type { View } from '../shared/selection.ts'
import type { DashboardScopeId, SnapshotReceipt } from '../shared/chat.ts'
import type { ChatContext } from './chat-selection.ts'
import type { ChatState } from './chat-owner.ts'
import type { createDashboardStore } from './stores.ts'
import type { AttentionActions } from './AttentionControls.tsx'

export interface DashboardInjected {
  hooks: { dashboard: ObservableSnapshot<DashboardState>; dashboardChat: ObservableSnapshot<ChatState> }
  select: (view: View, source: AdoSource | null) => void
  refresh: () => Promise<void>
  loadAdoHistory: (type: string, force?: boolean) => Promise<void>
  attentionActions: Omit<AttentionActions, 'state'>
  exportSnapshot: (snapshot: DashboardSnapshot) => boolean
  selectChat: (receipt: SnapshotReceipt | null) => void
  sendQuestion: (context: ChatContext, question: string, revision: number) => Promise<boolean>
  retryQuestion: (scopeId: DashboardScopeId) => Promise<boolean>
  retryHistory: () => Promise<void>
  stopQuestion: (scopeId: DashboardScopeId) => Promise<void>
  loadHistory: (scopeId: DashboardScopeId) => Promise<void>
}

export type DashboardProps = PropsRuntime<'main'> & PropsStore<ReturnType<typeof createDashboardStore>>
  & InjectFace<DashboardInjected> & PropsLocale<'dashboard'>

export type LauncherProps = PropsRuntime<'sidebar.panellist'>
