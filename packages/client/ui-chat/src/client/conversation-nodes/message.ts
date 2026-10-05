import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { InboxState } from './inbox.ts'
import { chatNode } from './common.ts'
import { contextForm, contextProvenance } from './event-projection.ts'
import type { AssistantReaction } from '../contract/reactions.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** Browser prompt RPC identity recorded on the admitted user message. */
  readonly browserPromptRequestId?: SessionRequestId
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /** Assistant acknowledgement paired with this message by Chat projection. */
  readonly assistantReaction?: AssistantReaction
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** Browser prompt RPC identity recorded on the admitted steering message. */
  readonly browserPromptRequestId?: SessionRequestId
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /** Assistant acknowledgement paired with this message by Chat projection. */
  readonly assistantReaction?: AssistantReaction
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | ContextMessageNode

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source
  return source.kind === 'plugin' && source.plugin === 'compact'
}

function browserPromptRequestId(source: unknown): SessionRequestId | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const candidate = source as { readonly kind?: unknown; readonly rpcId?: unknown }
  return candidate.kind === 'user'
    && typeof candidate.rpcId === 'string'
    && candidate.rpcId.length > 0
    && candidate.rpcId.trim() === candidate.rpcId
    ? candidate.rpcId as SessionRequestId
    : undefined
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: event => event.type === 'user/message'
    && isAppendSurfaceEvent(event)
    && !isCompactionCheckpoint(event)
    ? { id: String(event.data.id), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') throw new Error('input-message start requires user/message')
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        provenance: contextProvenance(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('inbox-next-step')
      ?.state.currentClaimed.has(String(event.data.id)) === true
    const rpcId = browserPromptRequestId(event.data.source)
    const rpc = rpcId === undefined ? {} : { browserPromptRequestId: rpcId }
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...rpc,
      }
      : {
        kind: 'user',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...rpc,
      }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return chatNode(context, context.state.kind, context.state.seq, context.state)
  },
}

/**
 * Register the user, steering, and injected-context message contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition)
}
