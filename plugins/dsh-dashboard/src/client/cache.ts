/** Validated, tab-local display cache. Source timestamps and Host receipts are never renewed here. */
import { z } from 'zod'
import { receiptSchema } from '../shared/chat.ts'
import { sourceKey } from '../shared/selection.ts'
import type { DashboardState, Resource } from './owner.ts'
import { adoSchema, personalSchema, settingsSchema } from './validation.ts'

const storedSchema = z.object({
  version: z.literal(1), settings: settingsSchema,
  personal: z.object({ data: personalSchema, receipt: receiptSchema }).nullable(),
  ado: z.object({ data: adoSchema, receipt: receiptSchema }).nullable(),
})

/** Cache failures affect reload speed only, never a successful source read or local decision. */
export class DashboardCache {
  private previous: readonly unknown[] = []

  constructor(private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'>,
    private readonly report: () => void) {}

  /** Restore only validated data; mismatched receipts or malformed cache entries are discarded. */
  restore(): Partial<DashboardState> {
    try {
      const raw = this.storage().getItem('dsh-dashboard:snapshots:v1')
      if (raw === null) return {}
      const saved = storedSchema.parse(JSON.parse(raw))
      if (saved.personal && saved.personal.receipt.scope.id !== 'personal') throw new Error('cache/scope')
      if (saved.ado && !saved.ado.receipt.scope.id.startsWith('ado:')) throw new Error('cache/scope')
      const resource = <T>(entry: { data: T; receipt: Resource<T>['receipt'] }, dataKey: string): Resource<T> => ({
        ...entry, status: 'ready', stale: false, previousSource: false, error: null, errorDetail: null, dataKey,
      })
      return {
        settings: saved.settings,
        ...(saved.personal ? { personal: resource(saved.personal, 'personal') } : {}),
        ...(saved.ado ? { ado: resource(saved.ado, sourceKey(saved.ado.data.source)), adoHistory: {
          status: saved.ado.data.analytics?.history ? 'ready' : 'idle',
          type: saved.ado.data.analytics?.history?.type ?? null, errorDetail: null,
        } } : {}),
      }
    } catch (error) {
      // Browser storage may be unavailable or contain an obsolete display snapshot.
      this.report()
      return {}
    }
  }

  /** Persist at most the current Personal and ADO snapshots; pending operations are never replayed. */
  save(state: DashboardState): void {
    if (!state.settings) return
    const next = [state.settings, state.personal.data, state.personal.receipt, state.ado.data, state.ado.receipt]
    if (next.every((value, index) => value === this.previous[index])) return
    this.previous = next
    const entry = <T>(resource: Resource<T>) => resource.data && resource.receipt
      ? { data: resource.data, receipt: resource.receipt } : null
    try {
      this.storage().setItem('dsh-dashboard:snapshots:v1', JSON.stringify({
        version: 1, settings: state.settings, personal: entry(state.personal), ado: entry(state.ado),
      }))
    } catch (error) {
      // Quota/security failures preserve the in-memory display and its original freshness.
      this.report()
    }
  }
}
