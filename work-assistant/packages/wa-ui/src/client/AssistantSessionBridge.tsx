import { useEffect, useMemo } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { buildAssistantSessionView, type AssistantSessionView } from './sessionView.ts'

/** Root bridge callbacks injected from the apply-owned rightbar source. */
export interface AssistantSessionBridgeInjected {
  /** Publish this mounted Session's loaded-window view to the root rail. */
  publishSessionView(view: AssistantSessionView): void
  /** Clear only the view still owned by this unmounting Session. */
  clearSessionView(sessionId: AssistantSessionView['sessionId']): void
}

/** Strict Session bridge that publishes the loaded Chat window to the root assistant rail. */
export type AssistantSessionBridgeProps =
  PropsRuntime<'conversation.session.header.corner'>
  & InjectFace<AssistantSessionBridgeInjected>

/** Keep the stock header corner empty while sharing current loaded-window tool metadata. */
export function AssistantSessionBridge(props: AssistantSessionBridgeProps) {
  const { clearSessionView, publishSessionView, sessionId } = props
  const chat = props.useConversation(snapshot => snapshot.views.get('chat'))
  const nodes = chat?.legacy.nodes
  const view = useMemo(
    () => buildAssistantSessionView(sessionId, nodes),
    [nodes, sessionId],
  )

  useEffect(() => {
    publishSessionView(view)
    return () => { clearSessionView(sessionId) }
  }, [clearSessionView, publishSessionView, sessionId, view])

  return null
}
