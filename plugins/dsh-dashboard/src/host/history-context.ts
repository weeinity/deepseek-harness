/** Bound optional history work independently of current-source reads and immutable question evidence. */
import type { AdoHistory } from '../shared/ado-analytics-model.ts'
import type { AdoHistoryRequest } from '../shared/requests.ts'
import type { AdoSnapshot } from '../shared/types.ts'
import { SnapshotContexts } from './snapshot-context.ts'

type Loader = (snapshot: AdoSnapshot, type: string, signal: AbortSignal) => Promise<AdoHistory>

export class DashboardHistoryReads {
  private active = false
  private readonly cache = new Map<string, AdoHistory>()

  constructor(
    private readonly contexts: SnapshotContexts,
    private readonly load: Loader,
    private readonly maxEntries: number,
  ) {}

  /** A second history read is refused, not coupled to another caller's cancellation. */
  async read(request: AdoHistoryRequest, signal: AbortSignal) {
    signal.throwIfAborted()
    const { snapshot, baseId } = this.contexts.adoSnapshot(request.snapshotId)
    if (!snapshot.analytics) throw new Error('Refresh the Azure DevOps source before loading delivery history.')
    if (!snapshot.items.some(item => item.type === request.type)) {
      throw new Error('The requested work-item type is absent from this snapshot. Select an available type.')
    }
    const key = `${baseId}\0${request.type}`
    const cached = this.cache.get(key)
    if (!request.force && cached) return this.contexts.retainAdoHistory(request.snapshotId, cached)
    if (this.active) throw new Error('Another Dashboard history read is in progress. Retry after it finishes.')
    this.active = true
    try {
      const history = await this.load(snapshot, request.type, signal)
      signal.throwIfAborted()
      const result = this.contexts.retainAdoHistory(request.snapshotId, history)
      this.cache.delete(key)
      while (this.cache.size >= this.maxEntries) {
        const oldest = this.cache.keys().next().value
        if (oldest === undefined) break
        this.cache.delete(oldest)
      }
      this.cache.set(key, history)
      return result
    } finally {
      this.active = false
    }
  }

  clear(): void { this.cache.clear() }
}
