import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { AssistantPanelStore } from './store.ts'
import type { BriefingSource } from './briefing.ts'
import styles from './AssistantToggle.module.css'

/** Apply-world action used when reopening from a global panel. */
export interface AssistantToggleInjected {
  /** Return the main column to Conversation before showing the assistant panel. */
  readonly revealConversation: () => void
  /** Collapse the stock sidebar once when the personal profile first renders wide. */
  readonly collapseSidebarOnce: () => void
  /** Persisted unread state remains visible when the assistant panel is closed. */
  readonly hooks: { readonly briefing: BriefingSource }
}

/** Composed props for the sidebar footer assistant toggle. */
export type AssistantToggleProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<AssistantPanelStore>
  & InjectFace<AssistantToggleInjected>
  & PropsLocale<'waAssistant'>

/** Sidebar footer action that hides and reopens the assistant panel. */
export function AssistantToggle(props: AssistantToggleProps) {
  const initialWide = useRef(props.wide)
  const collapsed = useRef(false)
  const expanded = props.useStore(state => state.expanded)
  const conversationActive = props.usePanelInfo(info => info.activePanelId === null)
  const active = expanded && conversationActive
  const briefing = props.useBriefing(state => state)
  const unread = briefing.data?.items.filter(item => !item.read).length ?? 0
  const label = active ? props.t('panel.hide') : props.t('panel.show')
  const accessibleLabel = unread > 0 ? label + ' · ' + props.t('inbox.unread', { count: unread }) : label
  useEffect(() => {
    if (!initialWide.current || collapsed.current) return
    collapsed.current = true
    props.collapseSidebarOnce()
  }, [props.collapseSidebarOnce])
  return (
    <button
      className={clsx(styles.button, !props.wide && styles.collapsed)}
      data-testid="wa-assistant-toggle"
      type="button"
      aria-label={accessibleLabel}
      aria-pressed={active}
      title={accessibleLabel}
      onClick={() => {
        if (active) {
          props.actions.close()
        } else {
          props.revealConversation()
          props.actions.open()
        }
      }}
    >
      <AssistantIcon />
      {unread > 0 && <span className={styles.unread} aria-hidden="true">{unread}</span>}
      {props.wide && <span className={styles.label}>{label}</span>}
    </button>
  )
}

/** Composed props for the public sidebar brand mark replacement. */
export type AssistantBrandMarkProps = PropsRuntime<'sidebar.brand.mark'>

/** Compact Nocturne brand mark for the stock sidebar rail. */
export function AssistantBrandMark(props: AssistantBrandMarkProps) {
  return (
    <span
      className={styles.brandMark}
      style={{ width: props.size, height: props.size }}
      aria-hidden="true"
    />
  )
}

function AssistantIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3.5 9.5c2-3.9 5.6-5.9 10.8-5.2-0.9 4.9-3.8 7.5-8.9 7.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.3 2.2 12 3.7l1.6.3-1.2 1.2.3 1.6-1.4-.8-1.5.8.3-1.6L9 4l1.6-.3z" fill="currentColor" />
      <path d="M4 14h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
