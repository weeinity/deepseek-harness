/** Present a model-chosen acknowledgement on its originating Web message. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { ReceiptPolicy } from '../receipt-policy.ts'
import styles from './ReceiptBadge.module.css'

/** Apply-owned policy; message and committed-reply facts come from Chat. */
export interface ReceiptBadgeInjected {
  readonly policy: ReceiptPolicy
}

/** The shared Chat owner supplies identity and verified browser ingress provenance. */
export type ReceiptBadgeProps =
  PropsRuntime<'conversation.chat.user-badges'>
  & PropsLocale<'waAssistant'>
  & InjectFace<ReceiptBadgeInjected>

/**
 * Render only an eligible committed acknowledgement chosen by the assistant.
 * @param props - Session identity, paired user and assistant messages, and display policy.
 * @returns A passive reaction, or no element when no eligible reply exists.
 */
export function ReceiptBadge(props: ReceiptBadgeProps) {
  const presetId = props.useProjection('agentPreset')
  if (props.browserPromptRequestId === undefined
    || props.assistantReaction === undefined
    || props.assistantReaction.emoji !== '\u{1f44d}'
    || presetId === null
    || presetId === undefined
    || !props.policy.presetIds.includes(presetId)) return null
  return (
    <ReceiptMark
      messageId={props.messageId}
      assistantMessageId={props.assistantReaction.assistantMessageId}
      style={props.policy.style}
      meaning={props.t('receipt.meaning')}
      neutralLabel={props.t('receipt.neutral')}
    />
  )
}

/** Localized presentation supplied by the Session-scoped reaction contribution. */
interface ReceiptMarkProps {
  readonly messageId?: ReceiptBadgeProps['messageId']
  readonly assistantMessageId?: ReceiptBadgeProps['messageId']
  readonly style: ReceiptPolicy['style']
  readonly meaning: string
  readonly neutralLabel: string
}

/**
 * Render a receipt without live announcements or approval controls.
 * @param props - Localized labels, display style, and optional message identity.
 * @returns A passive receipt, or no element when disabled.
 */
export function ReceiptMark({ style, meaning, neutralLabel, messageId, assistantMessageId }: ReceiptMarkProps) {
  if (style === 'off') return null
  return (
    <span className={styles.badge} role="img" aria-label={meaning} title={meaning} data-testid="wa-message-receipt" data-message-id={messageId} data-assistant-message-id={assistantMessageId}>
      <span className={style === 'thumbs-up' ? styles.emoji : undefined} aria-hidden="true">
        {style === 'thumbs-up' ? '\u{1f44d}' : neutralLabel}
      </span>
    </span>
  )
}
