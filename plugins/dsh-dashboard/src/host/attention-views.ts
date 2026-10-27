/** Publish local decisions independently of source caching and retain every issued view unchanged. */
import {
  attentionWriteSchema, isAttentionRejectionCode,
  type AttentionActionId, type AttentionMutation, type AttentionProposal, type AttentionRejectionCode, type AttentionWrite,
} from '../shared/attention.ts'
import type { SnapshotReceipt } from '../shared/chat.ts'
import type { PersonalSnapshot } from '../shared/types.ts'
import { AttentionError, type AttentionStore } from './attention-store.ts'
import { DashboardSnapshotError, type SnapshotContexts } from './snapshot-context.ts'

interface AttentionResponse {
  value: PersonalSnapshot
  receipt: SnapshotReceipt
  proposals: AttentionProposal[]
  mutation?: AttentionMutation
}

/** Only admission wraps these errors; a post-commit failure leaves the request uncertain. */
export class AttentionWriteRejection extends Error {
  constructor(readonly code: AttentionRejectionCode, message: string) {
    super(message)
    this.name = 'AttentionWriteRejection'
  }
}

export class DashboardAttentionViews {
  private latest: PersonalSnapshot | undefined
  private generation = -1
  private readonly writes = new Map<AttentionActionId, { fingerprint: string; promise: Promise<AttentionResponse> }>()

  constructor(
    private readonly store: Pick<AttentionStore, 'decorate' | 'proposals' | 'reconcile' | 'write'>,
    private readonly contexts: SnapshotContexts,
  ) {}

  /** An earlier, slower source read cannot replace a later completed read.
   * @param source Unadjusted provider result.
   * @param generation Monotonically increasing source-read admission number.
   * @returns The latest known source with current local decisions and a new immutable receipt.
   */
  publish(source: PersonalSnapshot, generation: number) {
    if (generation >= this.generation) {
      this.latest = structuredClone(source)
      this.generation = generation
    }
    return this.capture(this.source())
  }

  /** Re-evaluate the explicitly requested Personal view without source or model work.
   * Display receipt expiry does not stop local snoozes; mutation and question proofs remain strict.
   * @returns Cached source with current decisions, proposal statuses, and a fresh receipt.
   */
  read() {
    return this.capture(this.source())
  }

  /** Confirm durable idempotency before requiring an older receipt to remain retained.
   * @param request Validated explicit user operation.
   * @param signal Request cancellation before durable admission.
   * @returns A durable result and the current view; no optimistic state is published.
   */
  write(request: AttentionWrite, signal: AbortSignal): Promise<AttentionResponse> {
    const captured = attentionWriteSchema.parse(request)
    const fingerprint = JSON.stringify(captured)
    const previous = this.writes.get(captured.requestId)
    if (previous !== undefined) {
      return previous.fingerprint === fingerprint ? previous.promise
        : Promise.reject(new AttentionWriteRejection('CONFLICT', 'This pending request ID belongs to another attention operation.'))
    }
    const operation = { fingerprint, promise: this.commit(captured, signal) }
    this.writes.set(captured.requestId, operation)
    const remove = () => {
      if (this.writes.get(captured.requestId) === operation) this.writes.delete(captured.requestId)
    }
    void operation.promise.then(remove, remove)
    return operation.promise
  }

  private async commit(request: AttentionWrite, signal: AbortSignal): Promise<AttentionResponse> {
    const reconciled = await this.admit(() => this.store.reconcile(request, signal))
    if (reconciled !== undefined) {
      return { ...this.capture(this.latest ?? this.contexts.personalSnapshot(request.snapshotId)), ...reconciled }
    }
    const captured = await this.admit(() => this.contexts.personalSnapshot(request.snapshotId))
    const mutation = await this.admit(() => this.store.write(request, captured, () => this.latest ?? captured, signal))
    return {
      ...this.capture(this.latest ?? captured),
      ...(mutation === undefined ? {} : { mutation }),
    }
  }

  private async admit<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if ((error instanceof AttentionError || error instanceof DashboardSnapshotError) && isAttentionRejectionCode(error.code)) {
        throw new AttentionWriteRejection(error.code, error.message)
      }
      throw error
    }
  }

  /** Read the latest unadjusted source for the provider cache.
   * @returns The immutable source accepted by publish.
   */
  source(): PersonalSnapshot {
    if (this.latest === undefined) throw new Error('Load Personal Work before changing its attention view.')
    return this.latest
  }

  private capture(source: PersonalSnapshot) {
    const value = this.store.decorate(source)
    return { value, receipt: this.contexts.retain(value), proposals: this.store.proposals(source) }
  }
}
