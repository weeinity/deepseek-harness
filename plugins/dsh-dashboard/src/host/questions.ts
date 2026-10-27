/** Serialize complete HTTP admissions and reconcile durable receipts before requiring cached evidence. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DashboardChatScope, DashboardChatSend } from '../shared/chat.ts'
import { DashboardChatError, type DashboardChatSessions } from './chat/index.ts'
import { captureAttentionGrant } from './chat/capture.ts'
import type { AttentionGrant } from './attention-contract.ts'
import type { SnapshotContexts } from './snapshot-context.ts'

type ChatServices = Pick<DashboardChatSessions, 'reconcile' | 'open' | 'submit'>
type Evidence = Pick<SnapshotContexts, 'scope' | 'compile'> & Partial<Pick<SnapshotContexts, 'attentionGrant'>>
type Receipt = Awaited<ReturnType<DashboardChatSessions['submit']>>

/** A matching retry shares all preparation, not just the final native queue operation. */
export class DashboardQuestions {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<Receipt> }>()

  constructor(
    private readonly chats: ChatServices,
    private readonly contexts: Evidence,
    private readonly maxQuestionChars: number,
    private readonly archive: (sessionId: SessionId) => Promise<void>,
  ) {}

  /**
   * Preserve original admission after cache expiry, navigation, or a lost acknowledgement.
   * @param request Schema-parsed wire request; its full normalized JSON determines identity.
   * @param signal Cancels preparation before native submission, not an admitted Agent turn.
   * @returns Original or newly queued receipt; never model completion.
   */
  submit(request: DashboardChatSend, signal: AbortSignal): Promise<Receipt> {
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const key = `${request.scopeId}/${request.requestId}`
    const previous = this.pending.get(key)
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return Promise.reject(new DashboardChatError('REQUEST_CONFLICT', 'This request identifier already belongs to a different dashboard question or selection.'))
      }
      return previous.promise
    }
    const promise = this.admit(request, fingerprint, signal)
    this.pending.set(key, { fingerprint, promise })
    const settled = () => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key) }
    void promise.then(settled, settled)
    return promise
  }

  private async admit(request: DashboardChatSend, requestFingerprint: string, signal: AbortSignal): Promise<Receipt> {
    const original = await this.chats.reconcile({
      scopeId: request.scopeId, requestId: request.requestId, requestFingerprint,
    })
    if (original) return original
    let prepared: { scope: DashboardChatScope; contextText: string; attentionGrant?: AttentionGrant }
    try {
      signal.throwIfAborted()
      if (request.question.length > this.maxQuestionChars) {
        throw new Error(`Dashboard questions are limited to ${this.maxQuestionChars} characters.`)
      }
      const scope = this.contexts.scope(request.snapshotId)
      const contextText = this.contexts.compile(request.snapshotId, request.scopeId, request.selection)
      const attentionGrant = captureAttentionGrant(
        this.contexts.attentionGrant?.(request.snapshotId, request.scopeId, request.selection),
      )
      const opened = await this.chats.open(scope)
      await this.archive(opened.sessionId)
      signal.throwIfAborted()
      prepared = { scope, contextText, ...(attentionGrant === undefined ? {} : { attentionGrant }) }
    } catch (error) {
      // Durable lookup and the complete-request single-flight prove no earlier admission exists.
      throw new DashboardChatError('REQUEST_NOT_ADMITTED', error instanceof Error ? error.message : 'Dashboard question preparation failed before admission.')
    }
    try {
      return await this.chats.submit({
        ...prepared, requestId: request.requestId, requestFingerprint,
        question: request.question, snapshotId: request.snapshotId,
      })
    } catch (error) {
      if (error instanceof DashboardChatError && error.code.startsWith('INVALID_')) {
        throw new DashboardChatError('REQUEST_NOT_ADMITTED', error.message)
      }
      throw error
    }
  }
}
