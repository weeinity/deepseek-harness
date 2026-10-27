/** React-free, subscription-owned request lifetime with identity-checked publication. */
import { DateTime } from 'luxon'
import type { DashboardCache } from './cache.ts'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { AdoSnapshot, AdoSource, DashboardSettings, PersonalSnapshot } from '../shared/types.ts'
import { adoSourceSchema } from '../shared/requests.ts'
import type { SnapshotReceipt } from '../shared/chat.ts'
import {
  attentionWriteSchema, isAttentionRejectionCode, type AttentionActionId, type AttentionIntent, type AttentionItemState,
  type AttentionMutation, type AttentionProposal, type AttentionProposalId, type AttentionWrite,
} from '../shared/attention.ts'
import { refreshClockSlots } from '../shared/schedule.ts'
import { sourceKey, type View } from '../shared/selection.ts'
import { adoSchema, attentionResponseSchema, boundedDiagnostic, personalSchema, responseSchema, settingsSchema, snapshotResponseSchema } from './validation.ts'

export type Request = (endpoint: 'settings' | 'snapshot' | 'ado-history' | 'chat-open' | 'chat-send'
  | 'attention-read' | 'attention-write', payload: unknown, signal: AbortSignal) => Promise<unknown>
export interface AttentionState {
  status: 'idle' | 'reading' | 'writing' | 'error'
  error: 'read' | 'rejected' | 'uncertain' | null
  errorDetail: string | null
  pending: AttentionWrite | null
  proposals: readonly AttentionProposal[]
  mutation: AttentionMutation | null
}
const emptyAttention = (): AttentionState => ({
  status: 'idle', error: null, errorDetail: null, pending: null, proposals: [], mutation: null,
})
export interface HistoryResource {
  status: 'idle' | 'pending' | 'ready' | 'error'
  type: string | null
  errorDetail: string | null
}
export interface Resource<T> {
  status: 'idle' | 'pending' | 'ready' | 'error'
  data: T | null
  stale: boolean
  previousSource: boolean
  error: 'request' | 'invalid' | null
  errorDetail: string | null
  dataKey: string | null
  /** Issued with data; a failed refresh retains both or neither. */
  receipt: SnapshotReceipt | null
}
export interface DashboardState {
  settings: DashboardSettings | null
  personal: Resource<PersonalSnapshot>
  ado: Resource<AdoSnapshot>
  adoHistory?: HistoryResource
  attention?: AttentionState
}
export interface Environment {
  now(): number
  hidden(): boolean
  onVisibility(callback: () => void): () => void
  schedule(callback: () => void, milliseconds: number): () => void
}
const empty = <T>(): Resource<T> => ({
  status: 'idle', data: null, stale: false, previousSource: false, error: null, errorDetail: null, dataKey: null, receipt: null,
})

/** Only the Host-sanitized message is displayable; exception objects and response details are not. */
class SourceRequestError extends Error {
  readonly detail: string | null

  constructor(message: string) {
    super('dashboard/source')
    this.detail = boundedDiagnostic(message)
  }
}

/** Delay to the next configured local-clock slot; missed slots are not replayed. */
export function refreshDelay(settings: DashboardSettings, now: number): number {
  const local = DateTime.fromMillis(now, { zone: settings.timeZone })
  const { first, last } = refreshClockSlots(settings)
  let day = local.startOf('day')
  for (let offset = 0; offset < 8; offset++, day = day.plus({ days: 1 })) {
    if (day.weekday > 5) continue
    let next = Number.POSITIVE_INFINITY
    for (let slot = first; slot <= last; slot += settings.refreshMinutes) {
      const hour = Math.floor(slot / 60)
      const minute = slot % 60
      const candidate = day.set({ hour, minute, second: 0, millisecond: 0 })
      // A clock gap has no occurrence; a repeated clock slot has two real instants.
      if (candidate.hour !== hour || candidate.minute !== minute) continue
      for (const occurrence of candidate.getPossibleOffsets()) {
        const instant = occurrence.toMillis()
        if (instant > now) next = Math.min(next, instant)
      }
    }
    if (Number.isFinite(next)) return next - now
  }
  throw new Error('No Dashboard refresh slot exists in the next eight local days. Check the timezone and workday settings.')
}

/** Last valid data survives failures; a different ADO source is explicitly marked as previous. */
export class DashboardOwner implements ObservableSnapshot<DashboardState> {
  private state: DashboardState = { settings: null, personal: empty(), ado: empty() }
  private readonly listeners = new Set<() => void>()
  private readonly jobs = new Set<Promise<void>>()
  private selection: { view: View; source: AdoSource | null } | null = null
  private dataSourceKey: string | null = null
  private active: { controller: AbortController; promise: Promise<void> } | null = null
  private historyActive: { controller: AbortController; promise: Promise<void>; type: string } | null = null
  private cancelTimer: (() => void) | null = null
  private detachVisibility: (() => void) | null = null
  private attentionActive: { controller: AbortController; promise: Promise<void>; write: boolean } | null = null
  private cancelAttentionTimer: (() => void) | null = null
  private attentionReadAgain = false
  private disposed = false

  constructor(private readonly request: Request, private readonly environment: Environment,
    private readonly uuid: () => string = () => crypto.randomUUID(), private readonly cache?: DashboardCache) {
    this.state = { ...this.state, ...cache?.restore() }
    this.dataSourceKey = this.state.ado.dataKey
    for (const view of ['personal', 'ado'] as const) {
      const resource = this.state[view]
      this.state = { ...this.state, [view]: { ...resource, stale: resource.data !== null && !this.fresh(resource) } }
    }
  }

  getSnapshot = (): DashboardState => this.state

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.detachVisibility = this.environment.onVisibility(() => {
        if (this.environment.hidden()) this.pause()
        else this.resume()
      })
      void this.refresh(false)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.detachVisibility?.()
        this.detachVisibility = null
        this.pause()
      }
    }
  }

  select = (view: View, source: AdoSource | null): void => {
    if (this.disposed) return
    const next = source === null ? null : adoSourceSchema.parse(source)
    const previous = this.selection
    if (previous?.view === view && (view === 'personal'
      || (previous.source === null ? null : sourceKey(previous.source)) === (next === null ? null : sourceKey(next)))) return
    this.pause()
    this.selection = { view, source: next }
    if (view === 'ado' && next !== null && this.state.ado.data !== null) {
      this.state = { ...this.state, ado: {
        ...this.state.ado, stale: this.dataSourceKey !== sourceKey(next) || !this.fresh(this.state.ado),
        previousSource: this.dataSourceKey !== sourceKey(next),
      } }
      this.publish()
    }
    void this.refresh(false)
  }

  /** Reuse fresh data without a request; stale and forced reads retain visible data and dedupe concurrent work. */
  refresh = (force = true): Promise<void> => {
    if (this.disposed || this.listeners.size === 0 || this.environment.hidden() || this.selection === null) return Promise.resolve()
    if (this.active !== null) return this.active.promise
    const selection = this.selection
    const resource = this.state[selection.view]
    const key = selection.view === 'personal' ? 'personal' : selection.source === null ? null : sourceKey(selection.source)
    if (!force && resource.dataKey === key && this.fresh(resource)) {
      this.scheduleSource()
      this.scheduleAttention()
      return Promise.resolve()
    }
    if (selection.view === 'personal' && this.attentionActive?.write) return this.attentionActive.promise
    if (selection.view === 'personal') this.cancelAttentionRead()
    if (selection.view === 'ado' && selection.source === null && this.state.settings !== null) return Promise.resolve()
    this.cancelHistory()
    this.cancelTimer?.()
    this.cancelTimer = null
    const controller = new AbortController()
    const operation = { controller, promise: Promise.resolve() }
    this.active = operation
    this.state = { ...this.state, [selection.view]: {
      ...resource, status: 'pending', stale: resource.data !== null, error: null, errorDetail: null,
    } }
    this.publish()
    const isCurrent = () => this.active === operation && !controller.signal.aborted && !this.disposed
    operation.promise = (async () => {
      try {
        if (this.state.settings === null) {
          const result = responseSchema.parse(await this.request('settings', {}, controller.signal))
          if (!isCurrent()) return
          if (!result.ok) throw new SourceRequestError(result.error.message)
          this.state = { ...this.state, settings: settingsSchema.parse(result.value) }
          this.publish()
        }
        if (!isCurrent()) return
        if (selection.view === 'ado' && selection.source === null) {
          this.state = { ...this.state, ado: { ...this.state.ado, status: 'idle' } }
          this.publish()
          return
        }
        const payload = selection.view === 'personal'
          ? { view: 'personal', force }
          : { view: 'ado', source: selection.source, force }
        const response = responseSchema.parse(await this.request('snapshot', payload, controller.signal))
        if (!isCurrent()) return
        if (!response.ok) throw new SourceRequestError(response.error.message)
        const { receipt } = snapshotResponseSchema.refine(value =>
          (selection.view === 'personal') === (value.receipt.scope.id === 'personal')).parse(response)
        if (selection.view === 'personal') {
          this.state = { ...this.state, personal: {
            status: 'ready', data: personalSchema.parse(response.value), stale: false, previousSource: false,
            error: null, errorDetail: null, dataKey: 'personal', receipt,
          } }
        } else {
          const data = adoSchema.parse(response.value)
          this.dataSourceKey = selection.source === null ? null : sourceKey(selection.source)
          this.state = { ...this.state, ado: {
            status: 'ready', data, stale: false, previousSource: false, error: null, errorDetail: null, dataKey: this.dataSourceKey, receipt,
          }, adoHistory: {
            status: data.analytics?.history ? 'ready' : 'idle',
            type: data.analytics?.history?.type ?? null, errorDetail: null,
          } }
        }
        this.publish()
      } catch (error) {
        if (!isCurrent()) return
        this.state = { ...this.state, [selection.view]: {
          ...this.state[selection.view], status: 'error',
          stale: this.state[selection.view].data !== null,
          error: error instanceof Error && error.name === 'ZodError' ? 'invalid' : 'request',
          errorDetail: error instanceof SourceRequestError ? error.detail : null,
        } }
        this.publish()
      } finally {
        if (this.active === operation) {
          this.active = null
          if (selection.view === 'personal' && (this.attentionReadAgain || this.state.personal.data?.attention)) {
            this.attentionReadAgain = false
            await this.readAttention()
          }
          const settings = this.state.settings
          if (settings !== null && (selection.view === 'personal' || selection.source !== null)
            && this.selection === selection && this.listeners.size > 0 && !this.environment.hidden() && !this.disposed) {
            this.cancelTimer?.()
            this.cancelTimer = this.environment.schedule(() => {
              this.cancelTimer = null
              void this.refresh(false)
            }, refreshDelay(settings, this.environment.now()))
          }
        }
      }
    })()
    this.jobs.add(operation.promise)
    void operation.promise.then(() => { this.jobs.delete(operation.promise) })
    return operation.promise
  }

  /** Re-evaluate local expiry and proposal status without provider or model calls.
   * @param afterTurn Coalesce a settled native turn that may have staged proposals during an active read.
   * @returns Completion of the owned local read and any coalesced follow-up.
   */
  readAttention = (afterTurn = false): Promise<void> => {
    if (!this.canAttend()) return Promise.resolve()
    if (this.active !== null || this.attentionActive !== null) {
      this.attentionReadAgain ||= afterTurn
      return this.attentionActive?.promise ?? this.active!.promise
    }
    return this.attentionRequest(null)
  }

  /** Capture the rendered item revision; only Restore is valid for an absent saved decision. */
  applyAttention = (item: AttentionItemState, intent: AttentionIntent): Promise<void> => {
    if (!this.canWriteAttention() || item.ambiguous || (item.itemId === null && intent.kind !== 'restore')) return Promise.resolve()
    return this.startAttentionWrite({
      kind: 'apply', itemKey: item.key, expectedRevision: item.revision, intent,
    })
  }

  /** Undo targets the durable action, not a guessed inverse operation. */
  undoAttention = (actionId: AttentionActionId): Promise<void> =>
    this.startAttentionWrite({ kind: 'undo', actionId })

  /** Only an explicit card click confirms or cancels its Host-issued proposal. */
  decideAttention = (proposalId: AttentionProposalId, kind: 'confirm' | 'cancel'): Promise<void> =>
    this.startAttentionWrite({ kind, proposalId })

  /** Retry retains the exact operation, snapshot and id after an uncertain transport outcome. */
  retryAttention = (): Promise<void> => {
    const pending = this.state.attention?.pending
    if (!this.canAttend() || !pending || this.attentionActive?.write) return Promise.resolve()
    return this.attentionRequest(pending)
  }

  private canAttend(): boolean {
    return !this.disposed && this.listeners.size > 0 && !this.environment.hidden()
      && this.selection?.view === 'personal' && this.state.personal.data?.attention !== undefined
      && this.state.personal.receipt !== null
  }

  private canWriteAttention(): boolean {
    return this.canAttend() && !this.state.attention?.pending && !this.attentionActive?.write
  }

  private startAttentionWrite(command:
    | { kind: 'apply'; itemKey: AttentionItemState['key']; expectedRevision: number; intent: AttentionIntent }
    | { kind: 'undo'; actionId: AttentionActionId }
    | { kind: 'confirm' | 'cancel'; proposalId: AttentionProposalId }): Promise<void> {
    if (!this.canWriteAttention()) return Promise.resolve()
    const payload = attentionWriteSchema.parse({
      ...command, requestId: this.uuid(), snapshotId: this.state.personal.receipt!.id,
    })
    if (payload.kind === 'apply') Object.freeze(payload.intent)
    return this.attentionRequest(Object.freeze(payload))
  }

  private attentionRequest(payload: AttentionWrite | null): Promise<void> {
    this.cancelAttentionRead()
    if (payload !== null && this.active !== null) {
      const source = this.active
      this.active = null
      source.controller.abort()
      this.state = { ...this.state, personal: { ...this.state.personal, status: 'ready' } }
    }
    const receipt = this.state.personal.receipt!
    const controller = new AbortController()
    const operation = { controller, promise: Promise.resolve(), write: payload !== null }
    this.attentionActive = operation
    this.state = { ...this.state, attention: {
      ...(this.state.attention ?? emptyAttention()), status: payload ? 'writing' : 'reading',
      ...(payload ? { pending: payload, error: null, errorDetail: null, mutation: null } : {}),
    } }
    this.publish()
    const isCurrent = () => this.attentionActive === operation && !controller.signal.aborted && this.canAttend()
      && this.state.personal.receipt?.id === receipt.id
    operation.promise = (async () => {
      let succeeded = false
      try {
        const raw = await this.request(payload ? 'attention-write' : 'attention-read',
          payload ?? { view: 'personal' }, controller.signal)
        if (!isCurrent()) return
        const response = responseSchema.parse(raw)
        if (!response.ok) {
          const rejected = payload !== null && isAttentionRejectionCode(response.error.code)
          this.state = { ...this.state, attention: {
            ...this.state.attention!, status: 'error', error: payload ? (rejected ? 'rejected' : 'uncertain') : 'read',
            errorDetail: boundedDiagnostic(response.error.message),
            ...(rejected ? { pending: null } : {}),
          } }
          this.publish()
          return
        }
        const result = attentionResponseSchema.parse(raw)
        if (payload && payload.kind !== 'cancel' && !result.mutation) throw new Error('dashboard/attention-acknowledgement')
        if ((payload?.kind === 'apply' && (result.mutation?.itemKey !== payload.itemKey
          || result.mutation.kind !== payload.intent.kind))
          || (payload?.kind === 'undo' && result.mutation?.kind !== 'undo')
          || (payload?.kind === 'cancel' && result.mutation !== undefined)) throw new Error('dashboard/attention-acknowledgement')
        // An attention acknowledgement supersedes any earlier source request, including non-cooperative transports.
        const source = this.active
        if (source !== null && this.selection?.view === 'personal') {
          this.active = null
          source.controller.abort()
        }
        this.state = { ...this.state,
          personal: { ...this.state.personal, data: result.value, receipt: result.receipt },
          attention: {
            ...this.state.attention!, status: 'idle', proposals: result.proposals,
            ...(payload ? { pending: null, error: null, errorDetail: null, mutation: result.mutation ?? null }
              : { error: this.state.attention!.pending ? 'uncertain' as const : null,
                errorDetail: null,
                mutation: this.state.attention!.mutation && result.value.attention?.items.some(item =>
                  item.undoable && item.lastActionId === this.state.attention!.mutation!.id)
                  ? this.state.attention!.mutation : null }),
          },
        }
        succeeded = true
        this.publish()
      } catch {
        if (!isCurrent()) return
        this.state = { ...this.state, attention: { ...this.state.attention!,
          status: 'error', error: payload ? 'uncertain' : 'read', errorDetail: null,
        } }
        this.publish()
      } finally {
        if (this.attentionActive === operation) {
          this.attentionActive = null
          if (this.attentionReadAgain) {
            this.attentionReadAgain = false
            await this.readAttention()
          } else if (succeeded) this.scheduleAttention()
          this.scheduleSource()
        }
      }
    })()
    this.jobs.add(operation.promise)
    void operation.promise.then(() => { this.jobs.delete(operation.promise) })
    return operation.promise
  }

  private cancelAttentionRead(): void {
    this.cancelAttentionTimer?.()
    this.cancelAttentionTimer = null
    const operation = this.attentionActive
    if (operation?.write) return
    this.attentionActive = null
    operation?.controller.abort()
  }

  private scheduleAttention(): void {
    this.cancelAttentionTimer?.()
    this.cancelAttentionTimer = null
    if (!this.canAttend()) return
    const expiry = this.state.personal.data?.attention?.nextExpiry
    if (!expiry) return
    this.cancelAttentionTimer = this.environment.schedule(() => {
      this.cancelAttentionTimer = null
      void this.readAttention()
    }, Math.min(2_147_483_647, Math.max(0, Date.parse(expiry) - this.environment.now())))
  }

  private scheduleSource(): void {
    const settings = this.state.settings
    if (this.disposed || this.listeners.size === 0 || this.environment.hidden() || this.active !== null
      || settings === null || this.cancelTimer !== null || this.selection === null
      || (this.selection.view === 'ado' && this.selection.source === null)) return
    this.cancelTimer = this.environment.schedule(() => {
      this.cancelTimer = null
      void this.refresh(false)
    }, refreshDelay(settings, this.environment.now()))
  }

  /** Optional revision reads replace data and receipt together, never the source or its current fields. */
  loadAdoHistory = (type: string, force = false): Promise<void> => {
    const selection = this.selection
    const resource = this.state.ado
    if (this.disposed || this.listeners.size === 0 || this.environment.hidden()
      || selection?.view !== 'ado' || selection.source === null || resource.status === 'pending'
      || resource.previousSource || resource.dataKey !== sourceKey(selection.source)
      || !resource.data?.analytics || !resource.receipt) return Promise.resolve()
    if (this.historyActive?.type === type) return this.historyActive.promise
    this.cancelHistory()
    const snapshot = resource.data
    const receipt = resource.receipt
    const controller = new AbortController()
    const operation = { controller, promise: Promise.resolve(), type }
    this.historyActive = operation
    this.state = { ...this.state, adoHistory: { status: 'pending', type, errorDetail: null } }
    this.publish()
    const isCurrent = () => this.historyActive === operation && !controller.signal.aborted && !this.disposed
      && this.state.ado.receipt?.id === receipt.id && this.state.ado.dataKey === resource.dataKey
    operation.promise = (async () => {
      try {
        const response = responseSchema.parse(await this.request('ado-history', {
          snapshotId: receipt.id, type, force,
        }, controller.signal))
        if (!isCurrent()) return
        if (!response.ok) throw new SourceRequestError(response.error.message)
        const result = snapshotResponseSchema.parse(response)
        const data = adoSchema.parse(result.value)
        const currentFields = (value: AdoSnapshot) => JSON.stringify({
          ...value, analytics: value.analytics ? { ...value.analytics, history: undefined } : undefined,
        })
        if (result.receipt.scope.id !== receipt.scope.id || data.analytics?.history?.type !== type
          || currentFields(snapshot) !== currentFields(data)) {
          throw new SourceRequestError('The history response does not match the captured Azure DevOps source. Refresh the source and retry.')
        }
        this.state = { ...this.state, ado: { ...this.state.ado, data, receipt: result.receipt },
          adoHistory: { status: 'ready', type, errorDetail: null } }
        this.publish()
      } catch (error) {
        if (!isCurrent()) return
        this.state = { ...this.state, adoHistory: {
          status: 'error', type, errorDetail: error instanceof SourceRequestError ? error.detail : null,
        } }
        this.publish()
      } finally {
        if (this.historyActive === operation) this.historyActive = null
      }
    })()
    this.jobs.add(operation.promise)
    void operation.promise.then(() => { this.jobs.delete(operation.promise) })
    return operation.promise
  }

  /** Detach callbacks before aborting and await all owned request continuations. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.listeners.clear()
    this.detachVisibility?.()
    this.detachVisibility = null
    this.pause()
    await Promise.all([...this.jobs])
  }

  private pause(): void {
    this.cancelAttentionRead()
    const attention = this.attentionActive
    this.attentionActive = null
    this.attentionReadAgain = false
    attention?.controller.abort()
    if (this.state.attention) this.state = { ...this.state, attention: {
      ...this.state.attention, status: attention?.write ? 'error' : 'idle',
      ...(attention?.write ? { error: 'uncertain' as const, errorDetail: null } : {}),
    } }
    this.cancelHistory()
    this.cancelTimer?.()
    this.cancelTimer = null
    const operation = this.active
    this.active = null
    operation?.controller.abort()
    for (const view of ['personal', 'ado'] as const) {
      const resource = this.state[view]
      if (resource.status === 'pending') {
        this.state = { ...this.state, [view]: {
          ...resource, status: resource.data === null ? 'idle' : 'ready', stale: resource.data !== null,
        } }
      }
    }
    this.publish()
  }

  private cancelHistory(): void {
    const operation = this.historyActive
    this.historyActive = null
    operation?.controller.abort()
    if (this.state.adoHistory?.status === 'pending') {
      const history = this.state.ado.data?.analytics?.history
      this.state = { ...this.state, adoHistory: {
        status: history ? 'ready' : 'idle', type: history?.type ?? null, errorDetail: null,
      } }
    }
  }

  private fresh(resource: Resource<PersonalSnapshot | AdoSnapshot>): boolean {
    const settings = this.state.settings
    if (settings === null || resource.data === null || resource.receipt === null) return false
    const now = this.environment.now()
    const age = now - Date.parse(resource.data.generatedAt)
    return age >= 0 && age < settings.cacheSeconds * 1000 && Date.parse(resource.receipt.expiresAt) > now
  }

  private resume(): void {
    void this.refresh(false)
    void this.readAttention()
  }

  private publish(): void {
    this.cache?.save(this.state)
    notifySubscribers(this.listeners, 'dsh-dashboard')
  }
}
