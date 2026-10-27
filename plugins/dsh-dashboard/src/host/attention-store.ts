/**
 * Durable Personal Work decisions and confirmation-only proposals. A single-record
 * journal owns receipts, revisions, Undo history, and proposal resolutions together.
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  attentionProposalIdSchema, attentionToolInputSchema, attentionWriteSchema,
  type AttentionActionId, type AttentionDisposition, type AttentionIntent,
  type AttentionItemState, type AttentionKey, type AttentionMutation, type AttentionProposal,
  type AttentionProposalId, type AttentionTarget, type AttentionWrite,
} from '../shared/attention.ts'
import type { PersonalSnapshot } from '../shared/types.ts'
import type { AttentionProposalRequest, ProposeAttention } from './attention-contract.ts'
import {
  dashboardAttentionDomain, type AttentionActionRecord, type AttentionDecision,
  type AttentionProposalRecord,
} from './attention-domain.ts'
import { attentionHash, attentionTarget, validAttentionTarget } from './attention-identity.ts'

interface SavedItem {
  decision: AttentionDecision
  revision: number
  at: string
  lastActionId: AttentionActionId
  undoable: boolean
}

type Resolution = { status: 'applied'; actionId: AttentionActionId } | { status: 'cancelled' }

/** Rejections preserve stored decisions and require an explicit refresh or corrected command. */
export class AttentionError extends Error {
  constructor(readonly code: 'CLOSED' | 'NOT_READY' | 'STALE' | 'AMBIGUOUS' | 'SCOPE'
    | 'EXPIRED' | 'CONFLICT' | 'INVALID_INTENT' | 'CORRUPT', message: string) {
    super(message)
    this.name = 'AttentionError'
  }
}

function visible(): AttentionDisposition {
  return { mode: 'visible' }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported attention intent: ${String(value)}`)
}

function disposition(intent: AttentionIntent): AttentionDisposition {
  switch (intent.kind) {
    case 'hide': return { mode: 'hidden' }
    case 'handle': return { mode: 'handled' }
    case 'restore': return visible()
    case 'snooze': return { mode: 'snoozed', until: intent.until }
    default: return assertNever(intent)
  }
}

function targetOf(item: AttentionTarget): AttentionTarget {
  return { key: item.key, title: item.title, url: item.url, fingerprint: item.fingerprint }
}

function nativeKey(request: Pick<AttentionProposalRequest, 'sessionId' | 'questionId' | 'callId'>): string {
  return attentionHash([request.sessionId, request.questionId, request.callId])
}

function proposalFingerprint(record: Pick<AttentionProposalRecord, 'proposal' | 'callId' | 'evidenceDigest' | 'grantDigest'>): string {
  const p = record.proposal
  return attentionHash([p.sessionId, p.questionId, record.callId, record.evidenceDigest, record.grantDigest,
    p.target.key, p.target.title, p.target.url, p.target.fingerprint,
    p.expectedRevision, p.intent.kind, p.intent.kind === 'snooze' ? p.intent.until : null])
}

function requestFingerprint(request: AttentionWrite): string {
  return attentionHash([attentionWriteSchema.parse(request)])
}

function corrupt(condition: unknown): asserts condition {
  if (!condition) throw new AttentionError('CORRUPT', 'Dashboard attention storage contains an inconsistent journal or proposal.')
}

/** Single-owner attention writer; callers retain the ownership lock until dispose completes. */
export class AttentionStore {
  /** Resolves after ownership, authoritative domain validation, and complete journal replay. */
  readonly ready: Promise<void>
  private domain: Domain<typeof dashboardAttentionDomain> | undefined
  private readonly saved = new Map<AttentionKey, SavedItem>()
  private readonly actions = new Map<AttentionActionId, AttentionActionRecord>()
  private readonly staged = new Map<AttentionProposalId, AttentionProposalRecord>()
  private readonly origins = new Map<string, AttentionProposalRecord>()
  private readonly resolved = new Map<AttentionProposalId, Resolution>()
  private sequence = 0
  private initialized = false
  private closing = false
  private chain: Promise<void> = Promise.resolve()
  private disposal: Promise<void> | undefined

  /** @param ctx Native storage-domain service. @param options Clock and retained Host-writer ownership check. */
  constructor(private readonly ctx: Context, private readonly options: {
    now(): number
    checkOwnership(): Promise<void>
  }) {
    this.ready = this.initialize()
    // The public ready promise still rejects; observe early initialization failure before route admission.
    void this.ready.then(undefined, () => undefined)
    ctx.effect(() => () => this.dispose(), 'dashboardAttention.store()')
  }

  /** Add evaluated decisions without changing source rows, insights, metrics, or the input object.
   * @param raw Latest or retained Personal Work source snapshot.
   * @returns A new snapshot with current-row counts and saved non-default missing items.
   */
  decorate(raw: PersonalSnapshot): PersonalSnapshot {
    this.assertReadable()
    const now = this.options.now()
    const items = this.items(raw, now)
    const loaded = items.filter(item => item.itemId !== null)
    const activeSnoozes = loaded.flatMap(item => item.effective.mode === 'snoozed'
      ? [Date.parse(item.effective.until)] : [])
    const urgent = raw.sections.filter(section => section.id === 'urgent')
    return {
      ...raw,
      attention: {
        version: 1,
        revision: this.sequence,
        evaluatedAt: new Date(now).toISOString(),
        ...(activeSnoozes.length ? { nextExpiry: new Date(Math.min(...activeSnoozes)).toISOString() } : {}),
        sourceCount: urgent.length === 0 || urgent.some(section => section.source === 'unavailable')
          ? null : raw.metrics.attentionItems,
        loadedCount: loaded.length,
        visibleCount: loaded.filter(item => item.effective.mode === 'visible').length,
        hiddenCount: loaded.filter(item => item.effective.mode === 'hidden').length,
        handledCount: loaded.filter(item => item.effective.mode === 'handled').length,
        snoozedCount: loaded.filter(item => item.effective.mode === 'snoozed').length,
        items,
      },
    }
  }

  /** Stage an evidence-bound proposal; this callback never changes an item.
   * Matching native execution identities return the same durable proposal; conflicting reuse rejects.
   * @param request Trusted captured evidence and the model's single-item intent.
   * @param signal Cancellation before the durable write is admitted.
   * @returns Persisted proposal with derived clock/revision/resolution status.
   */
  readonly propose: ProposeAttention = async (request, signal) => {
    const input = attentionToolInputSchema.parse(request.input)
    const matches = request.grant.items.filter(item => item.key === input.itemKey)
    if (matches.length === 0) throw new AttentionError('SCOPE', 'The proposal item is not in the captured question evidence.')
    if (matches.length !== 1 || matches[0]!.ambiguous) {
      throw new AttentionError('AMBIGUOUS', 'Duplicate attention identities cannot be adjusted.')
    }
    const proof = structuredClone(matches[0]!)
    const proposal: AttentionProposalRecord['proposal'] = {
      id: attentionProposalIdSchema.parse(randomUUID()),
      sessionId: request.sessionId,
      questionId: request.questionId,
      target: targetOf(proof),
      intent: input.intent,
      expectedRevision: proof.revision,
      createdAt: new Date(this.options.now()).toISOString(),
      expiresAt: request.grant.expiresAt,
      status: 'pending',
    }
    const record: AttentionProposalRecord = {
      proposal,
      callId: request.callId,
      evidenceDigest: request.evidenceDigest,
      grantDigest: attentionHash([request.grant.snapshotId, request.grant.expiresAt,
        request.grant.items.map(item => [
          item.key, item.title, item.url, item.fingerprint, item.itemId, item.revision,
          item.disposition.mode, item.disposition.mode === 'snoozed' ? item.disposition.until : null,
          item.effective.mode, item.effective.mode === 'snoozed' ? item.effective.until : null,
          item.changed, item.ambiguous, item.updatedAt ?? null, item.lastActionId ?? null, item.undoable,
        ])]),
      fingerprint: '',
      present: proof.itemId !== null,
      createdSequence: 0,
    }
    record.fingerprint = proposalFingerprint(record)
    const origin = nativeKey(request)
    return this.enqueue(signal, async () => {
      const prior = this.origins.get(origin)
      if (prior !== undefined) {
        if (prior.fingerprint !== record.fingerprint) {
          throw new AttentionError('CONFLICT', 'This native proposal identity already belongs to different evidence or intent.')
        }
        return this.proposalView(prior)
      }
      const now = this.options.now()
      if (now >= Date.parse(proposal.expiresAt)) throw new AttentionError('EXPIRED', 'The captured proposal evidence has expired.')
      this.checkRevision(proof.key, proof.revision)
      this.checkIntent(input.intent, proof.itemId !== null, now)
      if (proof.itemId === null && this.saved.get(proof.key)?.decision.disposition.mode === 'visible') {
        throw new AttentionError('STALE', 'The missing attention item has already been restored.')
      }
      if (proof.itemId === null && !this.saved.has(proof.key)) {
        throw new AttentionError('STALE', 'The saved attention decision is unavailable.')
      }
      record.createdSequence = this.sequence
      record.proposal.createdAt = new Date(now).toISOString()
      await this.domain!.table('proposals').put(origin, record)
      this.origins.set(origin, record)
      this.staged.set(record.proposal.id, record)
      return this.proposalView(record)
    })
  }

  /** Reconcile a durable request before looking up its potentially expired source receipt.
   * Waits for admitted writes, validates ownership and payload identity, and never writes storage.
   * @param request Original UI command, including its original snapshot and request IDs.
   * @param signal Cancellation before the serialized receipt read.
   * @returns Undefined for an unrecorded request, an empty object for a committed cancellation,
   * or the original mutation even when newer decisions exist.
   */
  async reconcile(request: AttentionWrite, signal: AbortSignal): Promise<{ mutation?: AttentionMutation } | undefined> {
    const input = attentionWriteSchema.parse(request)
    const fingerprint = requestFingerprint(input)
    return this.enqueue(signal, () => {
      const prior = this.recorded(input, fingerprint)
      if (prior === undefined) return undefined
      const mutation = this.result(prior)
      return mutation === undefined ? {} : { mutation }
    })
  }

  /** Apply one confirmed UI command against retained and latest source proofs.
   * Request retries return their original durable result even after later item changes.
   * A committed write completes despite subsequent cancellation; failed durability publishes nothing.
   * @param request Validated UI operation and its request identity.
   * @param captured Host-issued immutable snapshot selected by the request receipt.
   * @param current Latest known raw source; never performs a provider read.
   * @param signal Cancellation before the durable write is admitted.
   * @returns Durable mutation, or undefined only for an explicit proposal cancellation.
   */
  async write(
    request: AttentionWrite, captured: PersonalSnapshot, current: () => PersonalSnapshot, signal: AbortSignal,
  ): Promise<AttentionMutation | undefined> {
    const input = attentionWriteSchema.parse(request)
    const fingerprint = requestFingerprint(input)
    return this.enqueue(signal, async () => {
      const prior = this.recorded(input, fingerprint)
      if (prior !== undefined) return this.result(prior)
      const now = this.options.now()
      const at = new Date(now).toISOString()
      const resolution = input.kind === 'confirm' ? this.resolved.get(input.proposalId) : undefined
      let outcome: AttentionActionRecord['outcome']
      if (input.kind === 'cancel') {
        this.proposalRecord(input.proposalId)
        if (this.resolved.get(input.proposalId)?.status === 'applied') {
          throw new AttentionError('CONFLICT', 'An applied proposal cannot be cancelled; use its available Undo action.')
        }
        outcome = { kind: 'cancel' }
      } else if (resolution?.status === 'applied') {
        outcome = { kind: 'replay', actionId: resolution.actionId }
      } else {
        const latest = current()
        let proof: AttentionItemState
        let after: AttentionDecision
        let kind: AttentionMutation['kind']
        if (input.kind === 'apply') {
          proof = this.currentProof(captured, latest, input.itemKey, input.expectedRevision, now)
          this.checkIntent(input.intent, proof.itemId !== null, now)
          after = { target: targetOf(proof), disposition: disposition(input.intent) }
          kind = input.intent.kind
        } else if (input.kind === 'confirm') {
          const record = this.proposalRecord(input.proposalId)
          const status = this.proposalView(record, this.items(latest, now)).status
          if (status !== 'pending') {
            throw new AttentionError(status === 'expired' ? 'EXPIRED' : 'STALE', 'The proposal is not pending for the current item and evidence.')
          }
          proof = this.currentProof(captured, latest, record.proposal.target.key, record.proposal.expectedRevision, now)
          if (!isDeepStrictEqual(targetOf(proof), record.proposal.target) || (proof.itemId !== null) !== record.present) {
            throw new AttentionError('STALE', 'The confirmation snapshot does not contain the proposed item proof.')
          }
          this.checkIntent(record.proposal.intent, proof.itemId !== null, now)
          after = { target: targetOf(proof), disposition: disposition(record.proposal.intent) }
          kind = record.proposal.intent.kind
        } else {
          const original = this.undoRecord(input.actionId)
          proof = this.currentProof(captured, latest, original.outcome.result.itemKey, undefined, now)
          if (proof.itemId === null) throw new AttentionError('INVALID_INTENT', 'Only Restore is available for a missing attention item.')
          after = original.outcome.before ?? { target: original.outcome.after.target, disposition: visible() }
          kind = 'undo'
        }
        const before = this.saved.get(proof.key)?.decision ?? null
        outcome = {
          kind: 'mutation',
          before,
          after,
          result: {
            id: input.requestId, itemKey: proof.key, kind, revision: proof.revision + 1,
            before: before?.disposition ?? visible(), after: after.disposition, at,
            undoable: kind !== 'undo',
          },
        }
      }
      const record: AttentionActionRecord = { sequence: this.sequence + 1, request: input, fingerprint, at, outcome }
      await this.domain!.table('actions').put(input.requestId, record)
      this.commit(record)
      return this.result(record)
    })
  }

  /** List persisted proposals with current source, revision, clock, and durable-resolution status.
   * @param current Latest known raw source snapshot.
   * @returns Detached proposal values; evaluating expiry does not write storage.
   */
  proposals(current: PersonalSnapshot): AttentionProposal[] {
    this.assertReadable()
    const items = this.items(current, this.options.now())
    return [...this.staged.values()].map(record => this.proposalView(record, items))
  }

  /** Stop intake, drain every admitted operation, and close the domain before releasing ownership.
   * @returns Idempotent quiescent teardown; the caller owns the external writer lock.
   */
  dispose(): Promise<void> {
    this.closing = true
    this.disposal ??= this.close()
    return this.disposal
  }

  private async initialize(): Promise<void> {
    await this.options.checkOwnership()
    this.domain = await this.ctx.storageDomain.open(dashboardAttentionDomain)
    try {
      this.replay()
      this.initialized = true
    } catch (error) {
      await this.closeDomain()
      throw error
    }
  }

  private async closeDomain(): Promise<void> {
    const domain = this.domain
    this.domain = undefined
    if (domain === undefined) return
    try {
      await this.options.checkOwnership()
    } finally {
      await domain.close()
    }
  }

  private async close(): Promise<void> {
    await Promise.allSettled([this.ready, this.chain])
    await this.closeDomain()
  }

  private assertReadable(): void {
    if (this.closing) throw new AttentionError('CLOSED', 'Dashboard attention storage is closing.')
    if (!this.initialized) throw new AttentionError('NOT_READY', 'Dashboard attention storage has not finished opening.')
  }

  private enqueue<T>(signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new AttentionError('CLOSED', 'Dashboard attention storage is closing.'))
    const result = this.chain.then(async () => {
      await this.ready
      signal.throwIfAborted()
      await this.options.checkOwnership()
      signal.throwIfAborted()
      return operation()
    })
    // Each caller retains its rejection; a failed write must not block independent later commands.
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }

  private recorded(request: AttentionWrite, fingerprint: string): AttentionActionRecord | undefined {
    const prior = this.actions.get(request.requestId)
    if (prior !== undefined && prior.fingerprint !== fingerprint) {
      throw new AttentionError('CONFLICT', 'This attention request ID already belongs to another command.')
    }
    return prior
  }

  private items(raw: PersonalSnapshot, now: number): AttentionItemState[] {
    const rows = raw.sections.filter(section => section.id === 'urgent')
      .flatMap(section => section.items.map(item => ({ itemId: item.id, target: attentionTarget(item) })))
    const counts = new Map<AttentionKey, number>()
    for (const row of rows) counts.set(row.target.key, (counts.get(row.target.key) ?? 0) + 1)
    const states = rows.map(row => this.itemState(row.target, row.itemId, counts.get(row.target.key)! > 1, now))
    for (const [key, saved] of this.saved) {
      if (!counts.has(key) && saved.decision.disposition.mode !== 'visible') {
        states.push(this.itemState(saved.decision.target, null, false, now))
      }
    }
    return states
  }

  private itemState(target: AttentionTarget, itemId: string | null, ambiguous: boolean, now: number): AttentionItemState {
    const saved = this.saved.get(target.key)
    const choice = saved?.decision.disposition ?? visible()
    const changed = itemId !== null && saved !== undefined && saved.decision.target.fingerprint !== target.fingerprint
    const expired = choice.mode === 'snoozed' && now >= Date.parse(choice.until)
    return structuredClone({
      ...target, itemId, revision: saved?.revision ?? 0, disposition: choice,
      effective: changed || ambiguous || expired ? visible() : choice,
      changed, ambiguous,
      ...(saved ? { updatedAt: saved.at, lastActionId: saved.lastActionId } : {}),
      undoable: itemId !== null && !ambiguous && (saved?.undoable ?? false),
    })
  }

  private currentProof(
    captured: PersonalSnapshot, current: PersonalSnapshot, key: AttentionKey,
    expected: number | undefined, now: number,
  ): AttentionItemState {
    const old = captured.attention?.items.filter(item => item.key === key) ?? []
    const latest = this.items(current, now).filter(item => item.key === key)
    if (old.length > 1 || latest.length > 1 || old[0]?.ambiguous || latest[0]?.ambiguous) {
      throw new AttentionError('AMBIGUOUS', 'Duplicate attention identities cannot be adjusted.')
    }
    const proof = old[0]
    const item = latest[0]
    if (proof === undefined || item === undefined
      || !isDeepStrictEqual(targetOf(proof), targetOf(item))
      || (proof.itemId === null) !== (item.itemId === null)
      || proof.revision !== item.revision || (expected !== undefined && proof.revision !== expected)) {
      throw new AttentionError('STALE', 'The attention item or decision changed; refresh before adjusting it.')
    }
    this.checkRevision(key, item.revision)
    return item
  }

  private checkRevision(key: AttentionKey, expected: number): void {
    if ((this.saved.get(key)?.revision ?? 0) !== expected) {
      throw new AttentionError('STALE', 'The attention decision changed; refresh before adjusting it.')
    }
  }

  private checkIntent(intent: AttentionIntent, present: boolean, now: number): void {
    if (!present && intent.kind !== 'restore') throw new AttentionError('INVALID_INTENT', 'Only Restore is available for a missing attention item.')
    if (intent.kind === 'snooze' && Date.parse(intent.until) <= now) {
      throw new AttentionError('INVALID_INTENT', 'Snooze requires an explicit future timestamp.')
    }
  }

  private proposalRecord(id: AttentionProposalId): AttentionProposalRecord {
    const record = this.staged.get(id)
    if (record === undefined) throw new AttentionError('SCOPE', 'The attention proposal is unavailable.')
    return record
  }

  private proposalView(record: AttentionProposalRecord, items?: AttentionItemState[]): AttentionProposal {
    const p = record.proposal
    const resolution = this.resolved.get(p.id)
    let status: AttentionProposal['status'] = resolution?.status ?? 'pending'
    const now = this.options.now()
    if (resolution === undefined) {
      if (now >= Date.parse(p.expiresAt)) status = 'expired'
      else if ((this.saved.get(p.target.key)?.revision ?? 0) !== p.expectedRevision
        || (p.intent.kind === 'snooze' && Date.parse(p.intent.until) <= now)) status = 'stale'
      else if (items !== undefined) {
        const matches = items.filter(item => item.key === p.target.key)
        const item = matches[0]
        if (matches.length !== 1 || item === undefined || item.ambiguous
          || !isDeepStrictEqual(targetOf(item), p.target) || (item.itemId !== null) !== record.present) status = 'stale'
      }
    }
    return structuredClone({ ...p, status, ...(resolution?.status === 'applied' ? { actionId: resolution.actionId } : {}) })
  }

  private undoRecord(id: AttentionActionId): AttentionActionRecord & {
    outcome: Extract<AttentionActionRecord['outcome'], { kind: 'mutation' }>
  } {
    const record = this.actions.get(id)
    if (record?.outcome.kind !== 'mutation' || !record.outcome.result.undoable
      || this.saved.get(record.outcome.result.itemKey)?.lastActionId !== id) {
      throw new AttentionError('STALE', 'Undo is available only for the latest undoable action on this item.')
    }
    return { ...record, outcome: record.outcome }
  }

  private result(record: AttentionActionRecord): AttentionMutation | undefined {
    if (record.outcome.kind === 'cancel') return undefined
    if (record.outcome.kind === 'mutation') return structuredClone(record.outcome.result)
    const original = this.actions.get(record.outcome.actionId)
    corrupt(original?.outcome.kind === 'mutation')
    return structuredClone(original.outcome.result)
  }

  private commit(record: AttentionActionRecord): void {
    this.actions.set(record.request.requestId, record)
    this.sequence = record.sequence
    if (record.outcome.kind === 'mutation') {
      const { after, result } = record.outcome
      this.saved.set(result.itemKey, {
        decision: after, revision: result.revision, at: result.at,
        lastActionId: result.id, undoable: result.undoable,
      })
      if (record.request.kind === 'confirm') {
        this.resolved.set(record.request.proposalId, { status: 'applied', actionId: result.id })
      }
    } else if (record.outcome.kind === 'cancel' && record.request.kind === 'cancel') {
      this.resolved.set(record.request.proposalId, { status: 'cancelled' })
    }
  }

  private replay(): void {
    const proposalsBySequence = new Map<number, AttentionProposalRecord[]>()
    for (const [key, record] of this.domain!.table('proposals').entries()) {
      const p = record.proposal
      corrupt(key === nativeKey({ ...p, callId: record.callId }) && !this.staged.has(p.id)
        && validAttentionTarget(p.target) && record.fingerprint === proposalFingerprint(record)
        && Date.parse(p.createdAt) < Date.parse(p.expiresAt))
      this.staged.set(p.id, record)
      this.origins.set(key, record)
      const bucket = proposalsBySequence.get(record.createdSequence) ?? []
      bucket.push(record)
      proposalsBySequence.set(record.createdSequence, bucket)
    }
    const validateProposals = () => {
      for (const record of proposalsBySequence.get(this.sequence) ?? []) {
        const p = record.proposal
        const saved = this.saved.get(p.target.key)
        corrupt(p.expectedRevision === (saved?.revision ?? 0)
          && (record.present || (p.intent.kind === 'restore' && saved !== undefined && saved.decision.disposition.mode !== 'visible'))
          && (p.intent.kind !== 'snooze' || Date.parse(p.intent.until) > Date.parse(p.createdAt)))
      }
      proposalsBySequence.delete(this.sequence)
    }
    validateProposals()
    const entries = [...this.domain!.table('actions').entries()].sort((a, b) => a[1].sequence - b[1].sequence)
    for (const [key, record] of entries) {
      corrupt(key === record.request.requestId && !this.actions.has(record.request.requestId)
        && record.sequence === this.sequence + 1 && record.fingerprint === requestFingerprint(record.request))
      this.validateTransition(record)
      this.commit(record)
      validateProposals()
    }
    corrupt(proposalsBySequence.size === 0)
  }

  private validateTransition(record: AttentionActionRecord): void {
    const { request, outcome } = record
    const staged = request.kind === 'confirm' || request.kind === 'cancel' ? this.staged.get(request.proposalId) : undefined
    const resolution = request.kind === 'confirm' || request.kind === 'cancel' ? this.resolved.get(request.proposalId) : undefined
    if (request.kind === 'confirm' || request.kind === 'cancel') {
      corrupt(staged !== undefined && staged.createdSequence < record.sequence)
    }
    if (outcome.kind === 'cancel') {
      corrupt(request.kind === 'cancel' && resolution?.status !== 'applied')
      return
    }
    if (outcome.kind === 'replay') {
      corrupt(request.kind === 'confirm' && resolution?.status === 'applied' && resolution.actionId === outcome.actionId)
      return
    }
    const { before, after, result } = outcome
    const saved = this.saved.get(result.itemKey)
    corrupt(request.kind !== 'cancel' && isDeepStrictEqual(before, saved?.decision ?? null)
      && validAttentionTarget(after.target) && after.target.key === result.itemKey
      && result.id === request.requestId && result.at === record.at
      && result.revision === (saved?.revision ?? 0) + 1
      && isDeepStrictEqual(result.before, before?.disposition ?? visible())
      && isDeepStrictEqual(result.after, after.disposition)
      && result.undoable === (request.kind !== 'undo'))
    if (request.kind === 'undo') {
      const original = this.actions.get(request.actionId)
      corrupt(original?.outcome.kind === 'mutation' && original.outcome.result.undoable
        && saved?.lastActionId === request.actionId && result.kind === 'undo'
        && isDeepStrictEqual(after, original.outcome.before ?? { target: original.outcome.after.target, disposition: visible() }))
      return
    }
    const intent = request.kind === 'apply' ? request.intent : staged!.proposal.intent
    corrupt(result.kind === intent.kind && isDeepStrictEqual(after.disposition, disposition(intent))
      && (intent.kind !== 'snooze' || Date.parse(intent.until) > Date.parse(record.at)))
    if (request.kind === 'apply') {
      corrupt(request.itemKey === result.itemKey && request.expectedRevision === (saved?.revision ?? 0))
    } else {
      corrupt(request.kind === 'confirm' && resolution === undefined
        && staged!.proposal.expectedRevision === (saved?.revision ?? 0)
        && isDeepStrictEqual(after.target, staged!.proposal.target)
        && Date.parse(record.at) < Date.parse(staged!.proposal.expiresAt))
    }
  }
}
