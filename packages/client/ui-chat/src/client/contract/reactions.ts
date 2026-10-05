/** Chat acknowledgement-reaction registration and paired-message metadata. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

/** Assistant acknowledgement that a matching policy may present beside user input. */
export interface AssistantReaction {
  /** Durable assistant message identity. */
  readonly assistantMessageId: MessageId
  /** Emoji the assistant emitted as settled acknowledgement text. */
  readonly emoji: string
}

/** Assistant acknowledgement plus the direct user or steering message it belongs to. */
export interface AssistantReactionPair extends AssistantReaction {
  /** Stable Chat Assistant node identity. */
  readonly assistantNodeId: string
  /** Stable Chat user or steering node identity. */
  readonly userNodeId: string
  /** Durable user or steering message identity. */
  readonly userMessageId: MessageId
}

/** Exact-preset policy enabling one assistant acknowledgement emoji. */
export interface ChatReactionPolicy {
  /** Agent preset ids that may render the acknowledgement reaction. */
  readonly presetIds: readonly string[]
  /** Emoji accepted from the assistant's settled acknowledgement text. */
  readonly emoji: string
}

/** Browser Chat registry for optional assistant acknowledgement reactions. */
export interface ChatReactions {
  /** Reactive roster of active policies. */
  readonly policies: ObservableSnapshot<readonly ChatReactionPolicy[]>
  /**
   * Register one exact-preset acknowledgement policy.
   * @param policy - preset ids and emoji to enable.
   * @returns disposer removing the policy.
   */
  register(policy: ChatReactionPolicy): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional assistant acknowledgement reaction policies for Chat. */
    chatReactions: ChatReactions
  }
}
