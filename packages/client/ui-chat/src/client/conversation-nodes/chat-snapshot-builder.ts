import type { Context } from '@deepseek-ai/cordis'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type {
  ConversationLocation, ConversationNode, ConversationTimelineSnapshot, ConversationViewBuilder,
  ConversationViewDefinition, PartialAssistant, RunningToolCall,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import { isRunningTool } from '../contract/chat-nodes.ts'
import type { AssistantReaction, AssistantReactionPair } from '../contract/reactions.ts'
import type {
  ChatLocationNodeIndex, ChatNodeProcessSource, ChatNodeSource, ChatNodeStore, ChatSnapshot,
  ChatTurnNavigationIndex, ChatTurnProcessPresentation, LegacyConversationSlice, TurnNavigationItem,
} from '../contract/snapshot.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { sessionRecallLabels, skillInvocationName } from './event-projection.ts'
import { sameTurnNavigationItem, turnNavigationItem } from './turn-navigation.ts'
import { ChatTurnProcessProjector } from './turn-process-presentation.ts'

const EMPTY_KEYS: readonly string[] = []
const EMPTY_TURNS: readonly number[] = []
const EMPTY_ITEMS: readonly TurnNavigationItem[] = []
const EMPTY_LIST: readonly never[] = []

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function cachedSource<Key, Source>(
  sources: Map<Key, Source>,
  key: Key,
  create: () => Source,
): Source {
  let source = sources.get(key)
  if (source === undefined) {
    source = create()
    sources.set(key, source)
  }
  return source
}

/* jscpd:ignore-start -- Chat Node sources keep publication state inside the keyed Chat store. */
class MutableChatSource<Value> {
  private readonly listeners = new Set<() => void>()
  private published: Value

  constructor(
    private readonly read: () => Value,
    private readonly label: string,
  ) {
    this.published = read()
  }

  readonly getSnapshot = (): Value => this.read()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(): void {
    const next = this.getSnapshot()
    if (this.published === next) return
    this.published = next
    notifySubscribers(this.listeners, this.label)
  }
}
/* jscpd:ignore-end */

class MutableChatNodeStore implements ChatNodeStore {
  private readonly byKey = new Map<string, ChatConversationViewNode>()
  private readonly turnProcesses = new ChatTurnProcessProjector()
  private readonly sources = new Map<string, MutableChatSource<ChatConversationViewNode | undefined>>()
  private readonly processSources = new Map<string, MutableChatSource<ChatTurnProcessPresentation | undefined>>()
  private readonly dirtyKeys = new Set<string>()
  private readonly dirtyProcessKeys = new Set<string>()
  private valuesCache: readonly ChatConversationViewNode[] = EMPTY_LIST
  private valuesDirty = false

  get(key: string): ChatConversationViewNode | undefined {
    return this.byKey.get(key)
  }

  source(key: string): ChatNodeSource {
    return cachedSource(this.sources, key, () => new MutableChatSource(
      () => this.get(key),
      `[ui-chat] node source ${key}`,
    ))
  }

  processSource(key: string): ChatNodeProcessSource {
    return cachedSource(this.processSources, key, () => new MutableChatSource(
      () => this.process(key),
      `[ui-chat] node process source ${key}`,
    ))
  }

  process(key: string): ChatTurnProcessPresentation | undefined {
    return this.turnProcesses.get(this.get(key) as ChatNode | undefined)
  }

  values(): readonly ChatConversationViewNode[] {
    if (this.valuesDirty) {
      this.valuesCache = [...this.byKey.values()]
      this.valuesDirty = false
    }
    return this.valuesCache
  }

  replace(nodes: readonly ChatConversationViewNode[]): void {
    const previous = new Map(this.byKey)
    this.byKey.clear()
    for (const node of nodes) {
      this.byKey.set(node.key, node)
      if (previous.get(node.key) !== node) {
        this.dirtyKeys.add(node.key)
        this.dirtyProcessKeys.add(node.key)
      }
      previous.delete(node.key)
    }
    for (const key of previous.keys()) {
      this.dirtyKeys.add(key)
      this.dirtyProcessKeys.add(key)
    }
    this.valuesCache = [...this.byKey.values()]
    this.valuesDirty = false
  }

  upsert(nodes: readonly ChatConversationViewNode[]): void {
    let changed = false
    for (const node of nodes) {
      if (this.byKey.get(node.key) === node) continue
      this.byKey.set(node.key, node)
      this.dirtyKeys.add(node.key)
      this.dirtyProcessKeys.add(node.key)
      changed = true
    }
    if (changed) this.valuesDirty = true
  }

  touchProcesses(turns: ReadonlySet<number>, locations: ChatLocationNodeIndex): void {
    for (const turn of turns) {
      for (const key of locations.getTurn(turn)) this.dirtyProcessKeys.add(key)
    }
  }

  replaceProcesses(order: readonly string[], locations: ChatLocationNodeIndex): void {
    this.touchProcesses(this.turnProcesses.replace(order, locations, this), locations)
  }

  updateProcesses(turns: ReadonlySet<number>, locations: ChatLocationNodeIndex): void {
    this.touchProcesses(this.turnProcesses.update(turns, locations, this), locations)
  }

  publish(): void {
    const dirty = [...this.dirtyKeys]
    const dirtyProcesses = [...this.dirtyProcessKeys]
    this.dirtyKeys.clear()
    this.dirtyProcessKeys.clear()
    for (const key of dirty) this.sources.get(key)?.publish()
    for (const key of dirtyProcesses) this.processSources.get(key)?.publish()
  }
}

class MutableChatLocationIndex implements ChatLocationNodeIndex {
  private turns = new Map<number, readonly string[]>()
  private steps = new Map<string, readonly string[]>()

  getTurn(turn: number): readonly string[] {
    return this.turns.get(turn) ?? EMPTY_KEYS
  }

  getStep(turn: number, step: number): readonly string[] {
    return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS
  }

  rebuild(order: readonly string[], store: ChatNodeStore): void {
    const turns = new Map<number, string[]>()
    const steps = new Map<string, string[]>()
    for (const key of order) {
      const location = store.get(key)?.location
      if (location === undefined) continue
      const coordinates = locationCoordinates(location)
      if (coordinates.turn === undefined) continue
      const turnKeys = turns.get(coordinates.turn) ?? []
      turnKeys.push(key)
      turns.set(coordinates.turn, turnKeys)
      if (coordinates.step === undefined) continue
      const step = stepKey(coordinates.turn, coordinates.step)
      const stepKeys = steps.get(step) ?? []
      stepKeys.push(key)
      steps.set(step, stepKeys)
    }
    this.turns = updateIndex(this.turns, turns)
    this.steps = updateIndex(this.steps, steps)
  }

  /** Invalidate aggregate readers when member data changes without moving. */
  touch(nodes: readonly ChatConversationViewNode[]): void {
    const turns = new Set<number>()
    const steps = new Set<string>()
    for (const node of nodes) {
      const coordinates = locationCoordinates(node.location)
      if (coordinates.turn === undefined || !this.turns.get(coordinates.turn)?.includes(node.key)) continue
      turns.add(coordinates.turn)
      if (coordinates.step !== undefined) steps.add(stepKey(coordinates.turn, coordinates.step))
    }
    for (const turn of turns) {
      const keys = this.turns.get(turn)
      if (keys === undefined) continue
      this.turns.set(turn, [...keys])
    }
    for (const step of steps) {
      const keys = this.steps.get(step)
      if (keys === undefined) continue
      this.steps.set(step, [...keys])
    }
  }
}

function updateIndex<Key>(
  previous: ReadonlyMap<Key, readonly string[]>,
  nextMutable: ReadonlyMap<Key, string[]>,
): Map<Key, readonly string[]> {
  const next = new Map<Key, readonly string[]>()
  const keys = new Set([...previous.keys(), ...nextMutable.keys()])
  for (const key of keys) {
    const before = previous.get(key) ?? EMPTY_KEYS
    const candidate = nextMutable.get(key) ?? EMPTY_KEYS
    const value = sameReferences(before, candidate) ? before : candidate
    if (candidate.length > 0) next.set(key, value)
  }
  return next
}

/**
 * Loaded-Turn rail projection accumulated alongside the node store: a
 * structural change re-derives the Turn set, a content-only upsert re-derives
 * only the Turns whose nodes moved, and the published array keeps its identity
 * until an item actually changes. Renderers therefore consume final Turn data
 * instead of scanning the loaded window per frame.
 */
class MutableTurnNavigationIndex implements ChatTurnNavigationIndex {
  private current: readonly TurnNavigationItem[] = EMPTY_ITEMS
  private byTurn = new Map<number, TurnNavigationItem>()

  items(): readonly TurnNavigationItem[] {
    return this.current
  }

  /** Re-derive the whole Turn set; runs only when the loaded structure moves. */
  rebuild(
    timeline: ConversationTimelineSnapshot,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): void {
    const next: TurnNavigationItem[] = []
    const byTurn = new Map<number, TurnNavigationItem>()
    for (const turn of timeline.turnOrder) {
      const derived = turnNavigationItem(turn, locations, nodes)
      if (derived === undefined) continue
      const previous = this.byTurn.get(turn)
      const item = previous !== undefined && sameTurnNavigationItem(previous, derived) ? previous : derived
      next.push(item)
      byTurn.set(turn, item)
    }
    this.byTurn = byTurn
    const unchanged = next.length === this.current.length
      && next.every((item, index) => item === this.current[index])
    if (!unchanged) this.current = next
  }

  /** Re-derive only the Turns a content-only upsert touched. */
  touch(
    turns: ReadonlySet<number>,
    locations: ChatLocationNodeIndex,
    nodes: ChatNodeStore,
  ): void {
    if (turns.size === 0) return
    const next = this.current.map((item) => {
      if (!turns.has(item.turn)) return item
      const derived = turnNavigationItem(item.turn, locations, nodes)
      if (derived === undefined || sameTurnNavigationItem(item, derived)) return item
      this.byTurn.set(item.turn, derived)
      return derived
    })
    if (next.some((item, index) => item !== this.current[index])) this.current = next
  }
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function locationCoordinates(location: ConversationLocation): { turn?: number; step?: number } {
  if (location.kind === 'step') return { turn: location.turn.turn, step: location.step.step }
  if (location.kind === 'turn') return { turn: location.turn.turn }
  return {}
}

function locationTurnStatus(location: ConversationLocation): string | undefined {
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.status : undefined
}

function processPresentationInputChanged(
  previous: ChatNode | undefined,
  next: ChatNode,
  structural: boolean,
): boolean {
  if (structural || previous === undefined) return true
  if (locationTurnStatus(previous.location) !== locationTurnStatus(next.location)) return true
  if (previous.kind === 'turn-process' && next.kind === 'turn-process') {
    return previous.data !== next.data
  }
  return previous.kind === 'assistant-step'
    && next.kind === 'assistant-step'
    && previous.data.step !== next.data.step
}

interface TurnProcessPresentation {
  readonly control?: ChatNode<'turn-process'>
  readonly openingHumanAnchor?: number
  readonly earliestProcessAnchor?: number
}

function turnProcessPresentations(
  nodes: readonly ChatConversationViewNode[],
): ReadonlyMap<number, TurnProcessPresentation> {
  const presentations = new Map<number, TurnProcessPresentation>()
  for (const raw of nodes) {
    const node = raw as ChatNode
    if (node.kind === 'turn-process') {
      presentations.set(node.data.turn, { ...presentations.get(node.data.turn), control: node })
    }
  }
  for (const raw of nodes) {
    const node = raw as ChatNode
    const location = node.location
    if (location.kind !== 'turn' && location.kind !== 'step') continue
    const current: TurnProcessPresentation = presentations.get(location.turn.turn) ?? {}
    if ((node.kind === 'user' || node.kind === 'steering')
      && node.anchorSeq < (current.control?.data.controlAnchorSeq ?? Number.POSITIVE_INFINITY)) {
      presentations.set(location.turn.turn, {
        ...current,
        openingHumanAnchor: Math.min(current.openingHumanAnchor ?? node.anchorSeq, node.anchorSeq),
      })
      continue
    }
    if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) continue
    presentations.set(location.turn.turn, {
      ...current,
      earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq),
    })
  }
  return presentations
}

interface PresentationPosition {
  readonly anchor: number
  readonly rank: number
  readonly originalAnchor: number
}

function presentationPosition(
  raw: ChatConversationViewNode,
  presentations: ReadonlyMap<number, TurnProcessPresentation>,
): PresentationPosition {
  const node = raw as ChatNode
  const location = node.location
  if (location.kind !== 'turn' && location.kind !== 'step') {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const presentation = presentations.get(location.turn.turn)
  if (presentation === undefined) {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
  }
  const openingHumanAnchor = presentation.openingHumanAnchor
  if (openingHumanAnchor !== undefined
    && node.anchorSeq < openingHumanAnchor
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)) {
    return { anchor: openingHumanAnchor, rank: 2, originalAnchor: node.anchorSeq }
  }
  if (presentation.control !== undefined && node.key === presentation.control.key) {
    return openingHumanAnchor === undefined
      ? {
        anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
        rank: -1,
        originalAnchor: node.anchorSeq,
      }
      : { anchor: openingHumanAnchor, rank: 1, originalAnchor: node.anchorSeq }
  }
  return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq }
}

/**
 * Order visible Chat Nodes without changing existing relative order as process
 * eligibility changes. Opening human input precedes process candidates, while
 * each synthetic process control sits between them.
 * @param nodes - currently materialized Chat Nodes.
 * @returns visible Nodes in presentation order.
 */
export function orderedVisibleChatNodes(
  nodes: readonly ChatConversationViewNode[],
): ChatConversationViewNode[] {
  const visible = nodes.filter(node => node.visibility === 'visible')
  const presentations = turnProcessPresentations(visible)
  return visible.sort((left, right) => {
    const leftPosition = presentationPosition(left, presentations)
    const rightPosition = presentationPosition(right, presentations)
    return leftPosition.anchor - rightPosition.anchor
      || leftPosition.rank - rightPosition.rank
      || leftPosition.originalAnchor - rightPosition.originalAnchor
      || left.key.localeCompare(right.key)
  })
}

function referenceMessageSeq(node: ChatConversationViewNode): number | undefined {
  const candidate = node as ChatNode
  return candidate.kind === 'user' || candidate.kind === 'steering'
    ? candidate.data.seq
    : undefined
}

function followingRecall(node: ChatConversationViewNode): {
  readonly messageSeq: number
  readonly labels: readonly string[]
} | undefined {
  const candidate = node as ChatNode
  if (candidate.kind !== 'context') return undefined
  return {
    messageSeq: candidate.data.seq - 1,
    labels: sessionRecallLabels(candidate.data.source),
  }
}

function withReferenceLabels(
  node: ChatConversationViewNode,
  labels: readonly string[],
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.referenceLabels ?? EMPTY_KEYS
  const hasLabels = Object.hasOwn(candidate.data, 'referenceLabels')
  if (sameReferences(current, labels) && hasLabels === (labels.length > 0)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (labels.length === 0) delete data.referenceLabels
  else data.referenceLabels = labels
  return { ...candidate, data }
}

/** Associates a direct message with the sourced recall event that immediately follows it. */
class ReferenceLabelProjector {
  private readonly messagesBySeq = new Map<number, string>()
  private readonly labelsByMessageSeq = new Map<number, readonly string[]>()

  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.messagesBySeq.clear()
    this.labelsByMessageSeq.clear()
    for (const node of nodes) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) this.messagesBySeq.set(messageSeq, node.key)
      const recall = followingRecall(node)
      if (recall !== undefined && recall.labels.length > 0) {
        this.labelsByMessageSeq.set(recall.messageSeq, recall.labels)
      }
    }
    return nodes.map((node) => {
      const messageSeq = referenceMessageSeq(node)
      return messageSeq === undefined
        ? node
        : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS)
    })
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const byKey = new Map(upserts.map(node => [node.key, node]))
    const affected = new Set<number>()
    for (const node of upserts) {
      const messageSeq = referenceMessageSeq(node)
      if (messageSeq !== undefined) {
        this.messagesBySeq.set(messageSeq, node.key)
        affected.add(messageSeq)
      }
      const recall = followingRecall(node)
      if (recall === undefined) continue
      const current = this.labelsByMessageSeq.get(recall.messageSeq)
      if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq)
      else {
        this.labelsByMessageSeq.set(
          recall.messageSeq,
          current !== undefined && sameReferences(current, recall.labels) ? current : recall.labels,
        )
      }
      affected.add(recall.messageSeq)
    }
    for (const messageSeq of affected) {
      const key = this.messagesBySeq.get(messageSeq)
      if (key === undefined) continue
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS))
    }
    return [...byKey.values()]
  }
}

function sameAssistantReaction(
  left: AssistantReaction | AssistantReactionPair | undefined,
  right: AssistantReaction | AssistantReactionPair | undefined,
): boolean {
  return left?.assistantMessageId === right?.assistantMessageId
    && left?.emoji === right?.emoji
    && (left as AssistantReactionPair | undefined)?.assistantNodeId === (right as AssistantReactionPair | undefined)?.assistantNodeId
    && (left as AssistantReactionPair | undefined)?.userNodeId === (right as AssistantReactionPair | undefined)?.userNodeId
    && (left as AssistantReactionPair | undefined)?.userMessageId === (right as AssistantReactionPair | undefined)?.userMessageId
}

function withAssistantReaction(
  node: ChatConversationViewNode,
  reaction: AssistantReaction | undefined,
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.assistantReaction
  const hasReaction = Object.hasOwn(candidate.data, 'assistantReaction')
  if (sameAssistantReaction(current, reaction) && hasReaction === (reaction !== undefined)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (reaction === undefined) delete data.assistantReaction
  else data.assistantReaction = reaction
  return { ...candidate, data }
}

function withAssistantReactionPair(
  node: ChatConversationViewNode,
  reaction: AssistantReactionPair | undefined,
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'assistant-step') return node
  const current = candidate.data.assistantReaction
  const hasReaction = Object.hasOwn(candidate.data, 'assistantReaction')
  if (sameAssistantReaction(current, reaction) && hasReaction === (reaction !== undefined)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (reaction === undefined) delete data.assistantReaction
  else data.assistantReaction = reaction
  return { ...candidate, data }
}

interface ProjectionEntry {
  readonly seq: number
  readonly kind: string
}

/** First index whose sequence is at least `seq`. */
function projectionLowerBound(entries: readonly ProjectionEntry[], seq: number): number {
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((entries[middle]?.seq ?? Number.POSITIVE_INFINITY) < seq) low = middle + 1
    else high = middle
  }
  return low
}

/** Last index of the boundary-free run containing `index`. */
function projectionRunEnd(entries: readonly ProjectionEntry[], index: number): number {
  let end = index
  while (end + 1 < entries.length && entries[end + 1]?.kind !== 'boundary') end++
  return end
}

/** First index of the boundary-free run containing `index`. */
function projectionRunStart(entries: readonly ProjectionEntry[], index: number): number {
  let start = index
  while (start - 1 >= 0 && entries[start - 1]?.kind !== 'boundary') start--
  return start
}

type ReactionEntry =
  | {
    readonly kind: 'message'
    readonly key: string
    readonly seq: number
    readonly nodeId: string
    readonly messageId: AssistantReactionPair['userMessageId']
  }
  | {
    readonly kind: 'reaction'
    readonly key: string
    readonly seq: number
    readonly nodeId: string
    readonly assistantMessageId: AssistantReaction['assistantMessageId']
    readonly emoji: string
  }
  | {
    readonly kind: 'boundary'
    readonly key: string
    readonly seq: number
  }

function singleAssistantReactionEmoji(node: ChatNode<'assistant-step'>): string | undefined {
  const final = node.data.finalNode
  if (node.data.status !== 'settled'
    || node.location.kind !== 'step'
    || node.location.turn.end?.data.reason.kind !== 'completed'
    || final === undefined
    || final.interrupted === true
    || final.messageId === undefined) return undefined
  let emoji: string | undefined
  for (const block of node.data.blocks) {
    if (block.kind === 'reasoning') continue
    if (block.kind !== 'text') return undefined
    const text = block.text.trim()
    if (text === '') continue
    if (emoji !== undefined || text !== '👍') return undefined
    emoji = text
  }
  return emoji
}

function reactionEntryOf(node: ChatConversationViewNode): ReactionEntry | null {
  const candidate = node as ChatNode
  switch (candidate.kind) {
    case 'user':
    case 'steering':
      if (candidate.data.browserPromptRequestId === undefined) {
        return { kind: 'boundary', key: candidate.key, seq: candidate.anchorSeq }
      }
      return {
        kind: 'message',
        key: candidate.key,
        seq: candidate.anchorSeq,
        nodeId: candidate.id,
        messageId: candidate.data.messageId,
      }
    case 'assistant-step': {
      const emoji = singleAssistantReactionEmoji(candidate)
      const messageId = candidate.data.finalNode?.messageId
      return emoji === undefined || messageId === undefined
        ? { kind: 'boundary', key: candidate.key, seq: candidate.anchorSeq }
        : {
          kind: 'reaction',
          key: candidate.key,
          seq: candidate.anchorSeq,
          nodeId: candidate.id,
          assistantMessageId: messageId,
          emoji,
        }
    }
    case 'context':
    case 'model-retry':
    case 'system-prompt':
    case 'turn-process':
      return null
    default:
      return { kind: 'boundary', key: candidate.key, seq: candidate.anchorSeq }
  }
}

function sameReactionEntry(left: ReactionEntry, right: ReactionEntry): boolean {
  if (left.kind !== right.kind || left.seq !== right.seq) return false
  if (left.kind === 'message' && right.kind === 'message') {
    return left.nodeId === right.nodeId && left.messageId === right.messageId
  }
  if (left.kind === 'reaction' && right.kind === 'reaction') {
    return left.nodeId === right.nodeId
      && left.assistantMessageId === right.assistantMessageId
      && left.emoji === right.emoji
  }
  return true
}

function buildReactionPair(
  message: Extract<ReactionEntry, { kind: 'message' }>,
  reaction: Extract<ReactionEntry, { kind: 'reaction' }>,
): AssistantReactionPair {
  return {
    assistantNodeId: reaction.nodeId,
    assistantMessageId: reaction.assistantMessageId,
    emoji: reaction.emoji,
    userNodeId: message.nodeId,
    userMessageId: message.messageId,
  }
}

/** Pairs settled assistant-only acknowledgements with the nearest direct message. */
export class AssistantReactionProjector {
  private readonly entries = new Map<string, ReactionEntry>()
  private sorted: ReactionEntry[] = []
  private readonly messageReactions = new Map<string, AssistantReaction>()
  private readonly assistantReactions = new Map<string, AssistantReactionPair>()

  /**
   * Rebuild the index from a whole Node set and attach acknowledgement pairs.
   * @param nodes - every materialized Chat Node, in any order.
   * @returns the same Nodes, paired user and assistant Nodes carrying metadata.
   */
  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.entries.clear()
    this.sorted = []
    this.messageReactions.clear()
    this.assistantReactions.clear()
    for (const node of nodes) {
      const entry = reactionEntryOf(node)
      if (entry === null) continue
      this.entries.set(entry.key, entry)
      this.sorted.push(entry)
    }
    this.sorted.sort((left, right) => left.seq - right.seq)
    for (let index = 0; index < this.sorted.length; index++) {
      const entry = this.sorted[index]
      if (entry === undefined || entry.kind === 'boundary') continue
      const end = projectionRunEnd(this.sorted, index)
      this.replaceRun(index, end, new Set())
      index = end
    }
    return nodes.map(node => this.withMetadata(node))
  }

  /**
   * Fold one incremental upsert set and re-read only affected message runs.
   * @param upserts - the changed Nodes.
   * @param store - the resident Nodes, read by key for paired Nodes outside the upsert set.
   * @returns the upserts plus any resident paired Node whose metadata changed.
   */
  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const dirty: number[] = []
    const affected = new Set<string>()
    for (const node of upserts) {
      const next = reactionEntryOf(node)
      const previous = this.entries.get(node.key)
      if (previous !== undefined) {
        if (next !== null && sameReactionEntry(previous, next)) {
          if (next.kind === 'message' || next.kind === 'reaction') {
            dirty.push(next.seq)
            affected.add(next.key)
          }
          continue
        }
        this.remove(previous)
        this.forget(previous, affected)
        dirty.push(previous.seq)
      }
      if (next === null) continue
      this.insert(next)
      dirty.push(next.seq)
    }
    if (dirty.length === 0) return upserts
    for (const seq of dirty) {
      for (const [start, end] of this.runsAround(seq)) this.replaceRun(start, end, affected)
    }
    const byKey = new Map(upserts.map(node => [node.key, node]))
    for (const key of affected) {
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      const next = this.withMetadata(node)
      if (next !== node || byKey.has(key)) byKey.set(key, next)
    }
    return [...byKey.values()]
  }

  private withMetadata(node: ChatConversationViewNode): ChatConversationViewNode {
    return withAssistantReactionPair(
      withAssistantReaction(node, this.messageReactions.get(node.key)),
      this.assistantReactions.get(node.key),
    )
  }

  private insert(entry: ReactionEntry): void {
    this.sorted.splice(projectionLowerBound(this.sorted, entry.seq), 0, entry)
    this.entries.set(entry.key, entry)
  }

  private remove(entry: ReactionEntry): void {
    this.sorted.splice(this.sorted.indexOf(entry), 1)
    this.entries.delete(entry.key)
  }

  private forget(entry: ReactionEntry, affected: Set<string>): void {
    if (entry.kind === 'message' && this.messageReactions.delete(entry.key)) affected.add(entry.key)
    if (entry.kind === 'reaction' && this.assistantReactions.delete(entry.key)) affected.add(entry.key)
  }

  private runsAround(seq: number): Array<readonly [number, number]> {
    const at = projectionLowerBound(this.sorted, seq)
    const here = this.sorted[at]
    const ranges: Array<readonly [number, number]> = []
    const add = (index: number): void => {
      if (index < 0 || index >= this.sorted.length || this.sorted[index]?.kind === 'boundary') return
      ranges.push([projectionRunStart(this.sorted, index), projectionRunEnd(this.sorted, index)])
    }
    if (here !== undefined && here.seq === seq && here.kind !== 'boundary') add(at)
    else {
      add(at - 1)
      add(here !== undefined && here.seq === seq ? at + 1 : at)
    }
    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1])
    const merged: Array<readonly [number, number]> = []
    for (const range of ranges) {
      const previous = merged.at(-1)
      if (previous !== undefined && range[0] <= previous[1]) {
        merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])]
      } else {
        merged.push(range)
      }
    }
    return merged
  }

  private replaceRun(start: number, end: number, affected: Set<string>): void {
    let latestMessage: Extract<ReactionEntry, { kind: 'message' }> | undefined
    const usedMessages = new Set<string>()
    const nextMessages = new Map<string, AssistantReaction>()
    const nextAssistants = new Map<string, AssistantReactionPair>()
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'message') latestMessage = entry
      if (entry?.kind !== 'reaction' || latestMessage === undefined || usedMessages.has(latestMessage.key)) continue
      const pair = buildReactionPair(latestMessage, entry)
      nextMessages.set(latestMessage.key, {
        assistantMessageId: pair.assistantMessageId,
        emoji: pair.emoji,
      })
      nextAssistants.set(entry.key, pair)
      usedMessages.add(latestMessage.key)
    }
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'message') {
        const next = nextMessages.get(entry.key)
        if (!sameAssistantReaction(this.messageReactions.get(entry.key), next)) affected.add(entry.key)
        if (next === undefined) this.messageReactions.delete(entry.key)
        else this.messageReactions.set(entry.key, next)
      }
      if (entry?.kind === 'reaction') {
        const next = nextAssistants.get(entry.key)
        if (!sameAssistantReaction(this.assistantReactions.get(entry.key), next)) affected.add(entry.key)
        if (next === undefined) this.assistantReactions.delete(entry.key)
        else this.assistantReactions.set(entry.key, next)
      }
    }
  }
}

function withSkillNames(
  node: ChatConversationViewNode,
  names: readonly string[],
): ChatConversationViewNode {
  const candidate = node as ChatNode
  if (candidate.kind !== 'user' && candidate.kind !== 'steering') return node
  const current = candidate.data.skillNames ?? EMPTY_KEYS
  const hasNames = Object.hasOwn(candidate.data, 'skillNames')
  if (sameReferences(current, names) && hasNames === (names.length > 0)) return node
  const data: Record<string, unknown> = { ...candidate.data }
  if (names.length === 0) delete data.skillNames
  else data.skillNames = names
  return { ...candidate, data }
}

/** What skill-name batches are made of; every other Node is transparent. */
type SlashEntryKind = 'message' | 'skill' | 'boundary'

interface SlashEntry {
  readonly key: string
  readonly seq: number
  readonly kind: SlashEntryKind
  /** The injected skill name of a `skill` entry. */
  readonly name: string | null
}

/**
 * Classify one Node for batching: a direct message, a `skill-invocation`
 * context, or a boundary of any other kind. A context that injects no skill
 * (workspace rules, the catalog, a recall) is transparent and yields null.
 */
function slashEntryOf(node: ChatConversationViewNode): SlashEntry | null {
  const candidate = node as ChatNode
  if (candidate.kind === 'user' || candidate.kind === 'steering') {
    return { key: node.key, seq: node.anchorSeq, kind: 'message', name: null }
  }
  if (candidate.kind === 'context') {
    const name = skillInvocationName(candidate.data.source)
    return name === null ? null : { key: node.key, seq: node.anchorSeq, kind: 'skill', name }
  }
  return { key: node.key, seq: node.anchorSeq, kind: 'boundary', name: null }
}

function sameSlashEntry(left: SlashEntry, right: SlashEntry): boolean {
  return left.seq === right.seq && left.kind === right.kind && left.name === right.name
}

/**
 * Attaches each direct message's step-loaded skill names to its Node.
 *
 * A step's `skill-invocation` injections follow the direct messages the host
 * scanned for `/name` gestures and precede the step's first Node of any other
 * kind, so every non-message, non-context Node closes a batch. Every ended
 * Turn publishes its `turn-tail` Node on `turn/end` whatever the reason, so a
 * batch never spans Turns, and `step/start` precedes the direct message in
 * the log, so no boundary separates a message from its injections. Names
 * attach to every direct message of the batch: the bubble decorates only the
 * tokens its own text carries.
 *
 * The index holds only messages, skill injections, and boundaries, ordered by
 * `anchorSeq`. An apply re-reads just the batches around the Nodes whose
 * classification changed and never scans the store, so an assistant
 * streaming frame costs nothing here (the append hot path never scans the
 * Chat Nodes).
 */
export class SkillNameProjector {
  private readonly entries = new Map<string, SlashEntry>()
  /** Every indexed entry in `anchorSeq` order. */
  private sorted: SlashEntry[] = []

  /**
   * Rebuild the index from a whole Node set and attach names to its messages.
   * @param nodes - every materialized Chat Node, in any order.
   * @returns the same Nodes, direct messages carrying their batch's names.
   */
  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.entries.clear()
    this.sorted = []
    for (const node of nodes) {
      const entry = slashEntryOf(node)
      if (entry === null) continue
      this.entries.set(entry.key, entry)
      this.sorted.push(entry)
    }
    this.sorted.sort((left, right) => left.seq - right.seq)
    const names = new Map<string, readonly string[]>()
    for (let index = 0; index < this.sorted.length; index++) {
      if (this.sorted[index]?.kind === 'boundary') continue
      const end = projectionRunEnd(this.sorted, index)
      this.assignRun(index, end, names)
      index = end
    }
    return nodes.map(node => withSkillNames(node, names.get(node.key) ?? EMPTY_KEYS))
  }

  /**
   * Fold one incremental upsert set: re-read only the batches around the
   * Nodes whose classification changed.
   * @param upserts - the changed Nodes.
   * @param store - the resident Nodes, read by key for the messages of an affected batch.
   * @returns the upserts plus any resident message whose names changed.
   */
  apply(
    upserts: readonly ChatConversationViewNode[],
    store: ChatNodeStore,
  ): readonly ChatConversationViewNode[] {
    const dirty: number[] = []
    for (const node of upserts) {
      const next = slashEntryOf(node)
      const previous = this.entries.get(node.key)
      if (previous !== undefined) {
        if (next !== null && sameSlashEntry(previous, next)) {
          // A rebuilt message Node carries Definition state only, never the
          // names a previous apply attached: re-read its batch.
          if (next.kind === 'message') dirty.push(next.seq)
          continue
        }
        this.remove(previous)
        dirty.push(previous.seq)
      }
      if (next === null) continue
      this.insert(next)
      dirty.push(next.seq)
    }
    if (dirty.length === 0) return upserts
    const names = new Map<string, readonly string[]>()
    for (const seq of dirty) this.collectAround(seq, names)
    const byKey = new Map(upserts.map(node => [node.key, node]))
    for (const [key, list] of names) {
      const node = byKey.get(key) ?? store.get(key)
      if (node === undefined) continue
      const next = withSkillNames(node, list)
      if (next !== node || byKey.has(key)) byKey.set(key, next)
    }
    return [...byKey.values()]
  }

  private insert(entry: SlashEntry): void {
    this.sorted.splice(projectionLowerBound(this.sorted, entry.seq), 0, entry)
    this.entries.set(entry.key, entry)
  }

  private remove(entry: SlashEntry): void {
    this.sorted.splice(this.sorted.indexOf(entry), 1)
    this.entries.delete(entry.key)
  }

  /** Record the names every message of the run `[start, end]` carries. */
  private assignRun(start: number, end: number, names: Map<string, readonly string[]>): void {
    const list: string[] = []
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'skill' && entry.name !== null && !list.includes(entry.name)) list.push(entry.name)
    }
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index]
      if (entry?.kind === 'message') names.set(entry.key, list)
    }
  }

  /**
   * Re-read the run(s) around one changed seq: the run holding a message or
   * skill entry, or — for a boundary, or a seq that left the index — the runs
   * on both sides of that position.
   */
  private collectAround(seq: number, names: Map<string, readonly string[]>): void {
    const at = projectionLowerBound(this.sorted, seq)
    const here = this.sorted[at]
    if (here !== undefined && here.seq === seq && here.kind !== 'boundary') {
      this.assignRun(projectionRunStart(this.sorted, at), projectionRunEnd(this.sorted, at), names)
      return
    }
    if (at - 1 >= 0 && this.sorted[at - 1]?.kind !== 'boundary') {
      this.assignRun(projectionRunStart(this.sorted, at - 1), at - 1, names)
    }
    const right = here !== undefined && here.seq === seq ? at + 1 : at
    if (right < this.sorted.length && this.sorted[right]?.kind !== 'boundary') {
      this.assignRun(right, projectionRunEnd(this.sorted, right), names)
    }
  }
}

interface LegacyContribution {
  readonly anchorSeq: number
  readonly nodes: readonly ConversationNode[]
  readonly partial: PartialAssistant | null
  readonly running: RunningToolCall | null
}

const EMPTY_CONTRIBUTION: LegacyContribution = {
  anchorSeq: 0,
  nodes: EMPTY_LIST,
  partial: null,
  running: null,
}

function legacyContribution(raw: ChatConversationViewNode): LegacyContribution {
  const node = raw as ChatNode
  // Content-free settled Assistants remain in the finalized compatibility
  // stream so StatsPills preserves its pre-assembly step counts; hidden running
  // attempts have no final Node to contribute.
  if (raw.visibility !== 'visible' && node.kind !== 'assistant-step') return EMPTY_CONTRIBUTION
  switch (node.kind) {
    case 'user':
    case 'steering':
    case 'context':
    case 'command':
    case 'compaction':
    case 'turn-error':
    case 'turn-max-tokens':
    case 'unknown':
      return { anchorSeq: node.anchorSeq, nodes: [node.data], partial: null, running: null }
    case 'assistant-step': {
      const data = node.data
      if (data.status === 'running') {
        if (raw.visibility !== 'visible') return EMPTY_CONTRIBUTION
        return {
          anchorSeq: node.anchorSeq,
          nodes: EMPTY_LIST,
          partial: { turn: data.turn, step: data.step, blocks: data.blocks },
          running: null,
        }
      }
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.finalNode === undefined ? EMPTY_LIST : [data.finalNode],
        partial: null,
        running: null,
      }
    }
    case 'tool-call': {
      const root = node.data.root
      return isRunningTool(root)
        ? { anchorSeq: node.anchorSeq, nodes: EMPTY_LIST, partial: null, running: root }
        : { anchorSeq: node.anchorSeq, nodes: [root], partial: null, running: null }
    }
    case 'manual-compaction': {
      const data = node.data
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
        partial: null,
        running: null,
      }
    }
    case 'model-retry':
      return {
        anchorSeq: node.anchorSeq,
        nodes: node.data.attempts,
        partial: null,
        running: null,
      }
    case 'turn-tail':
    case 'system-prompt':
      // These known Chat rows intentionally make no legacy timeline contribution.
      return EMPTY_CONTRIBUTION
    default:
      return EMPTY_CONTRIBUTION
  }
}

function sameContribution(left: LegacyContribution | undefined, right: LegacyContribution): boolean {
  return left !== undefined
    && left.anchorSeq === right.anchorSeq
    && left.partial?.blocks === right.partial?.blocks
    && left.partial?.turn === right.partial?.turn
    && left.partial?.step === right.partial?.step
    && left.running === right.running
    && sameReferences(left.nodes, right.nodes)
}

/** Incremental compatibility projection for StatsPills and legacy top-level snapshot fields. */
class LegacySliceBuilder {
  private readonly contributions = new Map<string, LegacyContribution>()
  private readonly finalizedContributions = new Map<string, LegacyContribution>()
  private readonly runningContributions = new Map<string, LegacyContribution>()
  private readonly partialContributions = new Map<string, LegacyContribution>()
  private finalized: readonly ConversationNode[] = EMPTY_LIST
  private runningCalls: readonly RunningToolCall[] = EMPTY_LIST
  private partial: PartialAssistant | null = null
  private timeline: ConversationTimelineSnapshot | undefined
  private turnTimings: LegacyConversationSlice['turnTimings'] = new Map()
  private turnEnds: LegacyConversationSlice['turnEnds'] = new Map()

  replace(
    nodes: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    this.contributions.clear()
    this.finalizedContributions.clear()
    this.runningContributions.clear()
    this.partialContributions.clear()
    for (const node of nodes) {
      const contribution = legacyContribution(node)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    this.rebuildFinalized()
    this.rebuildRunning()
    this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  apply(
    upserts: readonly ChatConversationViewNode[],
    timeline: ConversationTimelineSnapshot,
  ): LegacyConversationSlice {
    let finalizedChanged = false
    let runningChanged = false
    let partialChanged = false
    for (const node of upserts) {
      const contribution = legacyContribution(node)
      const previous = this.contributions.get(node.key)
      if (sameContribution(previous, contribution)) continue
      finalizedChanged ||= finalizedContributionChanged(previous, contribution)
      runningChanged ||= runningContributionChanged(previous, contribution)
      partialChanged ||= partialContributionChanged(previous, contribution)
      this.contributions.set(node.key, contribution)
      this.indexContribution(node.key, contribution)
    }
    if (finalizedChanged) this.rebuildFinalized()
    if (runningChanged) this.rebuildRunning()
    if (partialChanged) this.rebuildPartial()
    this.updateTimeline(timeline)
    return this.snapshot()
  }

  private indexContribution(key: string, contribution: LegacyContribution): void {
    updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0)
    updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null)
    updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null)
  }

  private rebuildFinalized(): void {
    const finalized = [...this.finalizedContributions.values()]
      .flatMap(value => value.nodes)
      .sort((left, right) => left.seq - right.seq)
    if (!sameReferences(this.finalized, finalized)) this.finalized = finalized
  }

  private rebuildRunning(): void {
    const runningCalls = [...this.runningContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .flatMap(value => value.running === null ? [] : [value.running])
    if (!sameReferences(this.runningCalls, runningCalls)) this.runningCalls = runningCalls
  }

  private rebuildPartial(): void {
    const partial = [...this.partialContributions.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq)
      .findLast(value => value.partial !== null)?.partial ?? null
    if (this.partial?.blocks !== partial?.blocks
      || this.partial?.turn !== partial?.turn
      || this.partial?.step !== partial?.step) this.partial = partial
  }

  private updateTimeline(timeline: ConversationTimelineSnapshot): void {
    if (this.timeline === timeline) return
    this.timeline = timeline
    const turnTimings = new Map<number, { startTime: number; endTime?: number }>()
    const turnEnds = new Map<number, number>()
    for (const turn of timeline.turns.values()) {
      if (turn.start !== undefined) {
        turnTimings.set(turn.turn, {
          startTime: turn.start.time,
          ...turn.end === undefined ? {} : { endTime: turn.end.time },
        })
      }
      if (turn.end !== undefined) turnEnds.set(turn.turn, turn.end.seq)
    }
    this.turnTimings = turnTimings
    this.turnEnds = turnEnds
  }

  private snapshot(): LegacyConversationSlice {
    return {
      nodes: this.finalized,
      turnTimings: this.turnTimings,
      turnEnds: this.turnEnds,
      partial: this.partial,
      runningCalls: this.runningCalls,
    }
  }
}

function updateContributionIndex(
  index: Map<string, LegacyContribution>,
  key: string,
  contribution: LegacyContribution,
  present: boolean,
): void {
  if (present) index.set(key, contribution)
  else index.delete(key)
}

function finalizedContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  const previousNodes = previous?.nodes ?? EMPTY_LIST
  return !sameReferences(previousNodes, next.nodes)
    || ((previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq)
}

function runningContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.running !== next.running
    || ((previous.running !== null || next.running !== null)
      && previous.anchorSeq !== next.anchorSeq)
}

function partialContributionChanged(
  previous: LegacyContribution | undefined,
  next: LegacyContribution,
): boolean {
  return previous?.partial?.blocks !== next.partial?.blocks
    || previous?.partial?.turn !== next.partial?.turn
    || previous?.partial?.step !== next.partial?.step
    || (((previous?.partial ?? null) !== null || next.partial !== null)
      && previous?.anchorSeq !== next.anchorSeq)
}

/** Incremental keyed Chat builder registered under the `chat` target. */
export class ChatSnapshotBuilder implements ConversationViewBuilder<ChatConversationViewNode, ChatSnapshot> {
  private readonly store = new MutableChatNodeStore()
  private readonly locations = new MutableChatLocationIndex()
  private readonly navigation = new MutableTurnNavigationIndex()
  private readonly legacy = new LegacySliceBuilder()
  private readonly referenceLabels = new ReferenceLabelProjector()
  private readonly skillNames = new SkillNameProjector()
  private readonly assistantReactions = new AssistantReactionProjector()
  private order: readonly string[] = EMPTY_KEYS
  /** Last published timeline: a Turn boundary can land without a new node. */
  private timeline: ConversationTimelineSnapshot | null = null
  readonly empty: ChatSnapshot

  constructor() {
    this.empty = this.snapshot({ turnOrder: EMPTY_TURNS, turns: new Map() })
  }

  replace(input: {
    readonly nodes: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const nodes = this.assistantReactions.replace(
      this.skillNames.replace(this.referenceLabels.replace(input.nodes)),
    )
    this.store.replace(nodes)
    this.order = orderedVisibleChatNodes(nodes).map(node => node.key)
    this.locations.rebuild(this.order, this.store)
    this.store.replaceProcesses(this.order, this.locations)
    this.navigation.rebuild(input.timeline, this.locations, this.store)
    this.timeline = input.timeline
    const snapshot = this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline))
    this.store.publish()
    return snapshot
  }

  apply(input: {
    readonly upserts: readonly ChatConversationViewNode[]
    readonly timeline: ConversationTimelineSnapshot
  }): ChatSnapshot {
    const upserts = this.assistantReactions.apply(
      this.skillNames.apply(this.referenceLabels.apply(input.upserts, this.store), this.store),
      this.store,
    )
    const processTurns = new Set<number>()
    let structural = false
    const contentOnly: ChatConversationViewNode[] = []
    for (const node of upserts) {
      const previous = this.store.get(node.key)
      const nodeStructural = previous === undefined
        || previous.kind !== node.kind
        || previous.anchorSeq !== node.anchorSeq
        || previous.visibility !== node.visibility
        || locationIdentity(previous.location) !== locationIdentity(node.location)
      structural ||= nodeStructural
      if (!nodeStructural) contentOnly.push(node)
      if (processPresentationInputChanged(previous as ChatNode | undefined, node as ChatNode, nodeStructural)) {
        const previousTurn = previous === undefined ? undefined : locationCoordinates(previous.location).turn
        const nextTurn = locationCoordinates(node.location).turn
        if (previousTurn !== undefined) processTurns.add(previousTurn)
        if (nextTurn !== undefined) processTurns.add(nextTurn)
      }
    }
    this.store.upsert(upserts)
    if (structural) {
      const next = orderedVisibleChatNodes(this.store.values()).map(node => node.key)
      this.order = sameReferences(this.order, next) ? this.order : next
      this.locations.rebuild(this.order, this.store)
    }
    this.locations.touch(contentOnly)
    this.store.updateProcesses(processTurns, this.locations)
    if (structural || input.timeline !== this.timeline) {
      this.navigation.rebuild(input.timeline, this.locations, this.store)
    } else {
      this.navigation.touch(turnsOf(contentOnly), this.locations, this.store)
    }
    this.timeline = input.timeline
    const snapshot = this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline))
    this.store.publish()
    return snapshot
  }

  private snapshot(
    timeline: ConversationTimelineSnapshot,
    legacy = this.legacy.replace(EMPTY_LIST, timeline),
  ): ChatSnapshot {
    return {
      order: this.order,
      nodes: this.store,
      locations: this.locations,
      navigation: this.navigation,
      timeline,
      legacy,
    }
  }
}

/** Turns owning the given nodes, for the content-only navigation update. */
function turnsOf(nodes: readonly ChatConversationViewNode[]): ReadonlySet<number> {
  const turns = new Set<number>()
  for (const node of nodes) {
    const turn = locationCoordinates(node.location).turn
    if (turn !== undefined) turns.add(turn)
  }
  return turns
}

function locationIdentity(location: ConversationLocation): string {
  const coordinates = locationCoordinates(location)
  return `${location.kind}:${coordinates.turn ?? ''}:${coordinates.step ?? ''}`
}

/** Chat target factory contributed to the Conversation view registry. */
export const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => new ChatSnapshotBuilder(),
  isActive: snapshot => snapshot.order.some(key => snapshot.nodes.get(key)?.kind !== 'command'),
}

/**
 * Register the incremental Chat target builder.
 * @param ctx - owning UI Conversation context.
 */
export function registerChatConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(chatViewDefinition)
}
