import { describe, expect, it } from 'vitest'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ConversationLocation, StepLocation, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '../src/client/contract/chat-nodes.ts'
import type { ChatNodeStore } from '../src/client/contract/snapshot.ts'
import { AssistantReactionProjector } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'

function completedStepLocation(
  reason: 'completed' | 'aborted' = 'completed',
): Extract<ConversationLocation, { kind: 'step' }> {
  const empty = createSnapshotStore(undefined)
  const data = { get: () => undefined, source: () => empty }
  const step: StepLocation = {
    turn: 1,
    step: 1,
    start: undefined,
    end: { type: 'step/end', seq: SessionSeq(99), time: 99, data: { turn: 1, step: 1 } },
    status: 'closed',
    data,
  }
  const turn: TurnLocation = {
    turn: 1,
    start: undefined,
    end: {
      type: 'turn/end',
      seq: SessionSeq(100),
      time: 100,
      data: {
        turn: 1,
        reason: reason === 'completed' ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } },
      },
    },
    status: 'closed',
    steps: [step],
    data,
  }
  return { kind: 'step', turn, step }
}

function viewNode(
  kind: string,
  seq: number,
  data: Record<string, unknown>,
  location: ConversationLocation = { kind: 'session' },
): ChatConversationViewNode {
  return {
    key: `${kind}:${seq}`,
    kind,
    id: `${kind}-node-${String(seq)}`,
    target: 'chat',
    anchorSeq: seq,
    location,
    visibility: 'visible',
    data: { kind, seq, time: seq, ...data },
  } as unknown as ChatConversationViewNode
}

const user = (seq: number, text = 'thanks') =>
  viewNode('user', seq, {
    messageId: `user-${String(seq)}`,
    browserPromptRequestId: `rpc-${String(seq)}`,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
const context = (seq: number) =>
  viewNode('context', seq, { content: [], source: { kind: 'agent-instructions', changes: [] } })
const turnProcess = (seq: number) =>
  viewNode('turn-process', seq, { turn: 1, controlAnchorSeq: seq, processStartSeq: seq, answerAnchorSeq: null })
const assistant = (
  seq: number,
  blocks: readonly Record<string, unknown>[],
  status: 'running' | 'settled' | 'interrupted' = 'settled',
  location: ConversationLocation = completedStepLocation(),
) => viewNode('assistant-step', seq, {
  status,
  turn: 1,
  step: 1,
  blocks,
  ...(status === 'running'
    ? {}
    : {
      finalNode: {
        kind: 'assistant',
        seq,
        time: seq,
        turn: 1,
        step: 1,
        messageId: `assistant-${String(seq)}` as MessageId,
        blocks,
        ...(status === 'interrupted' ? { interrupted: true } : {}),
      },
    }),
}, location)
const reaction = (seq: number) => assistant(seq, [
  { kind: 'reasoning', text: 'Thought a while' },
  { kind: 'text', text: ' 👍 ' },
])
const boundary = (seq: number) => assistant(seq, [{ kind: 'text', text: 'ordinary reply' }])

function storeOf(nodes: readonly ChatConversationViewNode[]): ChatNodeStore & { valuesCalls: number } {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  const store = {
    valuesCalls: 0,
    get: (key: string) => byKey.get(key),
    values: () => {
      store.valuesCalls += 1
      return [...byKey.values()]
    },
    source: () => { throw new Error('unused') },
    processSource: () => { throw new Error('unused') },
  }
  return store
}

const userReaction = (node: ChatConversationViewNode | undefined) =>
  (node?.data as { assistantReaction?: unknown } | undefined)?.assistantReaction
const assistantReaction = userReaction

describe('AssistantReactionProjector', () => {
  it('pairs a settled thumbs-up reply with the nearest direct message', () => {
    const projector = new AssistantReactionProjector()
    const out = projector.replace([user(2), context(3), turnProcess(3.9), reaction(4)])

    expect(userReaction(out[0])).toEqual({
      assistantMessageId: 'assistant-4',
      emoji: '👍',
    })
    expect(assistantReaction(out[3])).toEqual({
      assistantNodeId: 'assistant-step-node-4',
      assistantMessageId: 'assistant-4',
      emoji: '👍',
      userNodeId: 'user-node-2',
      userMessageId: 'user-2',
    })
  })

  it('ignores running, interrupted, extra text, tool, image, other, and ordinary assistant replies', () => {
    const projector = new AssistantReactionProjector()
    const out = projector.replace([
      user(2),
      assistant(3, [{ kind: 'text', text: '👍' }], 'running'),
      assistant(4, [{ kind: 'text', text: '👍' }], 'interrupted'),
      assistant(5, [{ kind: 'text', text: '👍' }, { kind: 'text', text: 'ack' }]),
      assistant(6, [{ kind: 'tool-call', callId: 'c', name: 'read', argsRaw: '{}' }]),
      assistant(7, [{ kind: 'image', attachment: {} }]),
      assistant(8, [{ kind: 'other', block: { type: 'future' } }]),
      boundary(9),
    ])

    expect(out.every(node => userReaction(node) === undefined)).toBe(true)
  })

  it('waits for a completed turn before pairing assistant replies', () => {
    const projector = new AssistantReactionProjector()
    const open = projector.replace([
      user(2),
      assistant(4, [{ kind: 'text', text: '👍' }], 'settled', {
        kind: 'step',
        turn: { ...completedStepLocation().turn, end: undefined, status: 'open' },
        step: completedStepLocation().step,
      } as unknown as ConversationLocation),
    ])
    const failed = projector.replace([user(2), assistant(
      4,
      [{ kind: 'text', text: '👍' }],
      'settled',
      completedStepLocation('aborted'),
    )])

    expect(open.every(node => userReaction(node) === undefined)).toBe(true)
    expect(failed.every(node => userReaction(node) === undefined)).toBe(true)
  })

  it('updates a streaming assistant to a committed reaction without scanning the store', () => {
    const projector = new AssistantReactionProjector()
    const replaced = projector.replace([user(2), assistant(4, [{ kind: 'text', text: '👍' }], 'running')])
    const store = storeOf(replaced)
    const settled = reaction(4)
    const out = projector.apply([settled], store)

    expect(out.map(node => node.key).sort()).toEqual(['assistant-step:4', 'user:2'])
    expect(userReaction(out.find(node => node.key === 'user:2'))).toMatchObject({
      assistantMessageId: 'assistant-4',
      emoji: '👍',
    })
    expect(assistantReaction(out.find(node => node.key === 'assistant-step:4'))).toMatchObject({
      userMessageId: 'user-2',
    })
    expect(store.valuesCalls).toBe(0)
  })

  it('removes a pair when the assistant node is rebuilt as non-reaction output', () => {
    const projector = new AssistantReactionProjector()
    const replaced = projector.replace([user(2), reaction(4)])
    const store = storeOf(replaced)
    const ordinary = boundary(4)
    const out = projector.apply([ordinary], store)

    expect(out.map(node => node.key).sort()).toEqual(['assistant-step:4', 'user:2'])
    expect(userReaction(out.find(node => node.key === 'user:2'))).toBeUndefined()
    expect(assistantReaction(out.find(node => node.key === 'assistant-step:4'))).toBeUndefined()
  })

  it('does not pair across a conversational boundary', () => {
    const projector = new AssistantReactionProjector()
    const out = projector.replace([user(2), boundary(3), reaction(4)])

    expect(userReaction(out[0])).toBeUndefined()
    expect(assistantReaction(out[2])).toBeUndefined()
  })

  it.each(['user', 'steering'])('keeps the reply visible after a non-Web %s message', (kind) => {
    const projector = new AssistantReactionProjector()
    const nonWeb = viewNode(kind, 3, {
      messageId: 'non-web',
      content: [{ type: 'text', text: 'thanks' }],
      source: { kind: 'user' },
    })
    const out = projector.replace([user(2), nonWeb, reaction(4)])

    expect(out.every(node => userReaction(node) === undefined)).toBe(true)
  })
})
