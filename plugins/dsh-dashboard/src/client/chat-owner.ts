/** Source-isolated question admission and read leases over native Session/Chat projections. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  chatOpenedSchema, chatSentSchema, questionIdSchema,
  type DashboardChatScope, type DashboardChatSend, type DashboardScopeId, type SnapshotReceipt,
} from '../shared/chat.ts'
import { boundedDiagnostic, responseSchema } from './validation.ts'
import type { ChatContext } from './chat-selection.ts'
import type { Request } from './owner.ts'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming: boolean
  interrupted: boolean
}

export type ChatError = 'open' | 'history' | 'rejected' | 'uncertain' | 'stop'
export interface ChatState {
  scope: DashboardChatScope | null
  status: 'idle' | 'opening' | 'ready' | 'error'
  sessionId: string | null
  messages: readonly ChatMessage[]
  running: boolean
  hasMore: boolean
  loadingOlder: boolean
  nativeError: string | null
  error: ChatError | null
  /** Bounded validated Host/native diagnostic associated with error; never a caught exception. */
  errorDetail: string | null
  pendingQuestion: string | null
  retryQuestion: string | null
  retryRevision: number | null
}

/** Native read resources; disposal never cancels the Agent. */
export interface ChatHistory {
  session: Pick<SessionFace, 'getSnapshot' | 'subscribe' | 'cancel' | 'loadOlder'>
  chat: ObservableSnapshot<Pick<ChatSnapshot, 'legacy'> | undefined>
  dispose(): Promise<void>
}
export type RetainChat = (sessionId: string, signal: AbortSignal) => Promise<ChatHistory>

interface Attempt {
  payload: DashboardChatSend
  draftRevision: number
  sessionId: string
  status: 'pending' | 'uncertain' | 'rejected' | 'accepted'
  reuseOnReject: boolean
  errorDetail: string | null
}
interface Conversation {
  scope: DashboardChatScope
  sessionId: string | null
  attempt: Attempt | null
  error: ChatError | null
  errorDetail: string | null
}
interface Reading {
  conversation: Conversation
  controller: AbortController
  history: ChatHistory | null
  unsubscribe: (() => void)[]
}
const empty = (scope: DashboardChatScope | null = null): ChatState => ({
  scope, status: 'idle', sessionId: null, messages: [], running: false,
  hasMore: false, loadingOlder: false, nativeError: null, error: null, errorDetail: null,
  pendingQuestion: null, retryQuestion: null, retryRevision: null,
})
/** These failures precede receipt lookup, so they cannot settle an earlier ambiguous attempt. */
const preAdmissionErrors = new Set([
  'INVALID_SCOPE', 'INVALID_REQUEST_ID', 'INVALID_QUESTION', 'INVALID_CONTEXT',
  'dashboard/invalid-input',
])
/** The Host proves receipt absence and excludes concurrent same-request admission before these failures. */
const absentReceiptErrors = new Set(['BUSY', 'MODEL_UNAVAILABLE', 'REQUEST_NOT_ADMITTED'])

/**
 * Project text from native Chat's durable messages and accumulated streaming blocks.
 * @param snapshot - native target publication; context and tool nodes stay outside Q&A.
 * @returns finalized questions/answers followed by any streaming answer text.
 */
export function textMessages(snapshot: Pick<ChatSnapshot, 'legacy'>): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const node of snapshot.legacy.nodes) {
    if (node.kind === 'user' || node.kind === 'steering') {
      const text = node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text) messages.push({ id: `${node.kind}:${node.seq}`, role: 'user', text, streaming: false, interrupted: false })
    } else if (node.kind === 'assistant') {
      const text = node.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n')
      if (text) messages.push({
        id: `assistant:${node.seq}`, role: 'assistant', text, streaming: false, interrupted: node.interrupted === true,
      })
    }
    // Other native nodes are context, tools, or diagnostics, not Dashboard Q&A.
  }
  const partial = snapshot.legacy.partial
  if (partial !== null) {
    const text = partial.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n')
    if (text) messages.push({
      id: `partial:${partial.turn}:${partial.step}`, role: 'assistant', text, streaming: true, interrupted: false,
    })
  }
  return messages
}

/** Reads follow page visibility; admission keeps its frozen source even after navigation. */
export class DashboardChatOwner implements ObservableSnapshot<ChatState> {
  private state: ChatState = empty()
  private receipt: SnapshotReceipt | null = null
  private readonly conversations = new Map<DashboardScopeId, Conversation>()
  private readonly listeners = new Set<() => void>()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly sends = new Set<AbortController>()
  private reading: Reading | null = null
  private disposed = false
  private published: ChatState = this.state

  constructor(
    private readonly request: Request,
    private readonly retain: RetainChat,
    private readonly uuid: () => string,
    private readonly personalSettled: (afterTurn: boolean) => void = () => {},
  ) {}

  getSnapshot = (): ChatState => this.state

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) void this.open()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.release()
        this.state = empty(this.receipt?.scope ?? null)
      }
    }
  }

  /** Canonical Host scope identity, not filters or an ordinary selected Conversation, owns history. */
  select = (receipt: SnapshotReceipt | null): void => {
    if (this.disposed) return
    const sameScope = this.receipt?.scope.id === receipt?.scope.id
    this.receipt = receipt
    if (sameScope) return
    this.release()
    this.state = empty(receipt?.scope ?? null)
    this.publish()
    void this.open()
  }

  /** Explicit recovery only; a failed native retain never starts a retry loop. */
  retryOpen = (): Promise<void> => {
    this.release()
    return this.open()
  }

  /**
   * Freeze one question's source and selection; ambiguous retries reuse its exact request id.
   * @param context - receipt and effective selection currently displayed.
   * @param question - source-local draft text.
   * @param draftRevision - revision cleared only after confirmed admission.
   * @returns confirmed Host admission, not model completion; false preserves the draft.
   */
  send = (context: ChatContext, question: string, draftRevision: number): Promise<boolean> => {
    const conversation = this.reading?.conversation
    if (this.disposed || this.listeners.size === 0 || this.state.status !== 'ready'
      || conversation?.scope.id !== context.receipt.scope.id || conversation.sessionId === null
      || !question.trim()) return Promise.resolve(false)
    const previous = conversation.attempt
    if (previous?.status === 'pending') return Promise.resolve(false)
    if (previous?.status === 'uncertain') {
      if (previous.payload.question !== question.trim()) return Promise.resolve(false)
      return this.submit(conversation, previous.payload, previous.draftRevision, previous.sessionId)
    }
    if (previous?.status === 'rejected' && previous.reuseOnReject
      && previous.payload.snapshotId === context.receipt.id && previous.payload.question === question.trim()
      && JSON.stringify(previous.payload.selection) === JSON.stringify(context.selection)) {
      return this.submit(conversation, previous.payload, draftRevision, previous.sessionId)
    }
    const selection = structuredClone(context.selection)
    if (selection.view === 'ado') Object.freeze(selection.filters)
    Object.freeze(selection)
    const payload: DashboardChatSend = Object.freeze({
      snapshotId: context.receipt.id, scopeId: context.receipt.scope.id,
      requestId: questionIdSchema.parse(this.uuid()), question: question.trim(), selection,
    })
    return this.submit(conversation, payload, draftRevision, conversation.sessionId)
  }

  /**
   * Retry the original question and selection even when the filters or draft changed.
   * @param scopeId - currently displayed canonical source.
   * @returns confirmed admission; clear only the original retryRevision.
   */
  retrySend = (scopeId: DashboardScopeId): Promise<boolean> => {
    const conversation = this.conversations.get(scopeId)
    if (this.disposed || this.state.status !== 'ready' || this.reading?.conversation !== conversation
      || conversation?.attempt?.status !== 'uncertain') return Promise.resolve(false)
    return this.submit(conversation, conversation.attempt.payload, conversation.attempt.draftRevision, conversation.attempt.sessionId)
  }

  /**
   * Stop the captured native Session, never the application's selected Conversation.
   * @param scopeId - source owning the visible answer.
   * @returns cancellation acknowledgement; errors remain source-local.
   */
  stop = (scopeId: DashboardScopeId): Promise<void> => this.command(scopeId, async history => {
    const result = await history.session.cancel()
    if (!result.ok) throw new Error('dashboard/stop')
  }, 'stop')

  /** @param scopeId - source whose native history should page. @returns native paging completion. */
  loadOlder = (scopeId: DashboardScopeId): Promise<void> =>
    this.command(scopeId, history => history.session.loadOlder(), 'history')

  /** Detach listeners, abort read/admission transport, and await all owned continuations. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.listeners.clear()
    this.release()
    for (const controller of this.sends) controller.abort()
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs])
    this.conversations.clear()
  }

  private open(): Promise<void> {
    const receipt = this.receipt
    if (this.disposed || this.listeners.size === 0 || receipt === null || this.reading !== null) return Promise.resolve()
    let conversation = this.conversations.get(receipt.scope.id)
    if (conversation === undefined) {
      conversation = { scope: receipt.scope, sessionId: null, attempt: null, error: null, errorDetail: null }
      this.conversations.set(receipt.scope.id, conversation)
    }
    const reading: Reading = { conversation, controller: new AbortController(), history: null, unsubscribe: [] }
    this.reading = reading
    const attempt = conversation.attempt
    conversation.error = attempt?.status === 'uncertain' || attempt?.status === 'rejected' ? attempt.status : null
    conversation.errorDetail = conversation.error === null ? null : attempt?.errorDetail ?? null
    this.state = { ...empty(receipt.scope), status: 'opening' }
    this.syncAttempt(conversation)
    return this.track((async () => {
      let errorDetail: string | null = null
      try {
        const response = responseSchema.parse(await this.request('chat-open', { snapshotId: receipt.id }, reading.controller.signal))
        if (!this.current(reading)) return
        if (!response.ok) {
          errorDetail = boundedDiagnostic(response.error.message)
          throw new Error('dashboard/open')
        }
        const opened = chatOpenedSchema.parse(response.value)
        if (opened.scope.id !== receipt.scope.id) throw new Error('dashboard/scope')
        conversation.sessionId = opened.sessionId
        const history = await this.retain(opened.sessionId, reading.controller.signal)
        if (!this.current(reading)) { await history.dispose(); return }
        reading.history = history
        const update = () => { if (this.current(reading)) this.project(reading) }
        reading.unsubscribe.push(history.session.subscribe(update))
        reading.unsubscribe.push(history.chat.subscribe(update))
        this.project(reading)
      } catch {
        if (!this.current(reading)) return
        conversation.error = reading.history === null ? 'open' : 'history'
        conversation.errorDetail = errorDetail
        this.release()
        this.state = { ...this.state, status: 'error', error: conversation.error, errorDetail }
        this.publish()
      }
    })())
  }

  private submit(conversation: Conversation, payload: DashboardChatSend, draftRevision: number, sessionId: string): Promise<boolean> {
    const controller = new AbortController()
    this.sends.add(controller)
    const reconciling = conversation.attempt?.status === 'uncertain'
    const attempt: Attempt = { payload, draftRevision, sessionId, status: 'pending', reuseOnReject: false, errorDetail: null }
    conversation.attempt = attempt
    conversation.error = null
    conversation.errorDetail = null
    this.syncAttempt(conversation)
    return this.track((async () => {
      try {
        const response = responseSchema.parse(await this.request('chat-send', payload, controller.signal))
        if (this.disposed) return false
        if (!response.ok) {
          attempt.reuseOnReject = absentReceiptErrors.has(response.error.code)
          const rejected = attempt.reuseOnReject || response.error.code === 'REQUEST_CONFLICT'
            || (!reconciling && preAdmissionErrors.has(response.error.code))
          attempt.status = rejected ? 'rejected' : 'uncertain'
          attempt.errorDetail = boundedDiagnostic(response.error.message)
          conversation.error = rejected ? 'rejected' : 'uncertain'
          conversation.errorDetail = attempt.errorDetail
          return false
        }
        const sent = chatSentSchema.parse(response.value)
        if (sent.requestId !== payload.requestId || sent.sessionId !== sessionId) throw new Error('dashboard/ack')
        attempt.status = 'accepted'
        return true
      } catch {
        attempt.status = 'uncertain'
        conversation.error = 'uncertain'
        conversation.errorDetail = null
        return false
      } finally {
        this.sends.delete(controller)
        this.syncAttempt(conversation)
      }
    })())
  }

  private project(reading: Reading): void {
    const history = reading.history
    if (history === null) return
    const session = history.session.getSnapshot()
    const snapshot = history.chat.getSnapshot()
    const failed = session.openState === 'error' || session.openError !== null || session.removed
    this.state = {
      ...this.state,
      status: failed ? 'error'
        : session.openState === 'open' && snapshot !== undefined ? 'ready' : 'opening',
      sessionId: reading.conversation.sessionId,
      messages: snapshot === undefined ? [] : textMessages(snapshot),
      running: session.running, hasMore: session.hasMore, loadingOlder: session.loadingOlder,
      nativeError: session.lastAgentError,
      error: failed ? 'history' : reading.conversation.error,
      errorDetail: failed ? session.openError === null ? null : boundedDiagnostic(session.openError.message)
        : reading.conversation.errorDetail,
    }
    this.syncAttempt(reading.conversation)
  }

  private command(scopeId: DashboardScopeId, action: (history: ChatHistory) => Promise<void>, error: ChatError): Promise<void> {
    const reading = this.reading
    const history = reading?.history
    if (this.disposed || reading?.conversation.scope.id !== scopeId || !history) return Promise.resolve()
    if (reading.conversation.error === error) {
      reading.conversation.error = null
      reading.conversation.errorDetail = null
      this.syncAttempt(reading.conversation)
    }
    return this.track((async () => {
      try { await action(history) } catch {
        if (this.current(reading)) {
          reading.conversation.error = error
          reading.conversation.errorDetail = null
          this.syncAttempt(reading.conversation)
        }
      }
    })())
  }

  private current(reading: Reading): boolean {
    return !this.disposed && this.reading === reading && !reading.controller.signal.aborted
  }

  private release(): void {
    const reading = this.reading
    this.reading = null
    if (reading === null) return
    for (const unsubscribe of reading.unsubscribe) unsubscribe()
    reading.controller.abort()
    if (reading.history !== null) {
      const history = reading.history
      void this.track((async () => {
        try { await history.dispose() } catch {
          // A released read has no consumer; cleanup must not reject another source's operations.
          console.error('[dsh-dashboard] Native history cleanup failed.')
        }
      })())
    }
  }

  private syncAttempt(conversation: Conversation): void {
    if (this.disposed || this.reading?.conversation !== conversation) return
    const attempt = conversation.attempt
    this.state = {
      ...this.state, error: conversation.error ?? (this.state.status === 'error' ? this.state.error : null),
      errorDetail: conversation.error !== null ? conversation.errorDetail
        : this.state.status === 'error' ? this.state.errorDetail : null,
      pendingQuestion: attempt?.status === 'pending' ? attempt.payload.question : null,
      retryQuestion: attempt?.status === 'uncertain' ? attempt.payload.question : null,
      retryRevision: attempt?.status === 'uncertain' ? attempt.draftRevision : null,
    }
    this.publish()
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.jobs.add(promise)
    const done = () => { this.jobs.delete(promise) }
    void promise.then(done, done)
    return promise
  }

  private publish(): void {
    const previous = this.published
    this.published = this.state
    notifySubscribers(this.listeners, 'dsh-dashboard-chat')
    if (this.listeners.size > 0 && this.state.scope?.id === 'personal' && this.state.sessionId !== null
      && this.state.status === 'ready' && (previous.status !== 'ready' || previous.sessionId !== this.state.sessionId
        || (previous.running && !this.state.running))) {
      this.personalSettled(previous.status === 'ready' && previous.sessionId === this.state.sessionId
        && previous.running && !this.state.running)
    }
  }
}
