/** Same-origin Inbox data source; polling never starts model work. */
import type { BriefingSnapshot } from '@deepseek-ai/dsh-wa-briefing'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Only explicit user gestures mutate persisted Inbox policy. */
export type BriefingAction = { action: 'pause' | 'resume' } | { action: 'read' | 'dismiss'; id: SessionId }

/** Last verified server state, plus local request status. */
export interface BriefingView {
  readonly data: BriefingSnapshot | null
  readonly status: 'loading' | 'ready' | 'error'
  readonly busy: boolean
}

/** Renderer subscribes through the inject hooks compartment. */
export interface BriefingSource {
  getSnapshot(): BriefingView
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  act(action: BriefingAction): Promise<void>
  dispose(): void
}

/**
 * Create one feature-owned data source per mounted UI plugin.
 * @param refreshIntervalMs - Bounded snapshot polling interval configured by the Host.
 * @param requestTimeoutMs - Deadline for each HTTP request and response body.
 * @returns The observable and explicit mutation operations; dispose cancels fetches and timers.
 */
export function createBriefingSource(refreshIntervalMs: number, requestTimeoutMs: number): BriefingSource {
  let view: BriefingView = { data: null, status: 'loading', busy: false }
  const listeners = new Set<() => void>()
  const lifetime = new AbortController()
  let revision = 0
  let refreshing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = (next: BriefingView): void => {
    if (lifetime.signal.aborted) return
    view = next
    for (const listener of [...listeners]) listener()
  }
  const request = async (action?: BriefingAction): Promise<BriefingSnapshot> => {
    const deadline = new AbortController()
    const timeout = setTimeout(() => deadline.abort(), requestTimeoutMs)
    try {
      const response = await fetch('/api/work-assistant/briefing', {
        method: action === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store',
        headers: { 'x-dsh-assistant': '1', ...(action === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(action === undefined ? {} : { body: JSON.stringify(action) }),
        signal: AbortSignal.any([lifetime.signal, deadline.signal]),
      })
      if (!response.ok) throw new Error('Briefing request failed')
      return parseSnapshot(await response.json())
    } finally {
      clearTimeout(timeout)
    }
  }
  const schedule = (): void => {
    if (lifetime.signal.aborted) return
    clearTimeout(timer)
    timer = setTimeout(() => { void refresh() }, refreshIntervalMs)
  }
  const refresh = async (): Promise<void> => {
    if (lifetime.signal.aborted || refreshing || view.busy) return
    refreshing = true
    const current = revision
    try {
      const data = await request()
      if (current === revision) publish({ data, status: 'ready', busy: false })
    } catch {
      // HTTP, decode, and abort failures retain the last verified snapshot, never an optimistic state.
      if (current === revision) publish({ ...view, status: 'error' })
    } finally {
      refreshing = false
      schedule()
    }
  }
  const source: BriefingSource = {
    getSnapshot: () => view,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh,
    act: async action => {
      if (lifetime.signal.aborted || view.busy) return
      ++revision
      publish({ ...view, busy: true })
      try {
        const data = await request(action)
        publish({ data, status: 'ready', busy: false })
      } catch (error) {
        publish({ ...view, status: 'error', busy: false })
        throw error
      } finally {
        schedule()
      }
    },
    dispose: () => { lifetime.abort(); clearTimeout(timer); listeners.clear() },
  }
  void refresh()
  return source
}

function parseSnapshot(value: unknown): BriefingSnapshot {
  if (value === null || typeof value !== 'object') throw new Error('Invalid briefing response')
  const data = value as Record<string, unknown>
  if (data.version !== 1 || typeof data.enabled !== 'boolean' || typeof data.paused !== 'boolean'
    || typeof data.running !== 'boolean' || !Array.isArray(data.items) || data.items.length > 200) throw new Error('Invalid briefing response')
  for (const value of data.items) {
    if (value === null || typeof value !== 'object') throw new Error('Invalid briefing item')
    const item = value as Record<string, unknown>
    for (const key of ['id', 'sessionId', 'messageId', 'createdAt', 'text']) {
      if (typeof item[key] !== 'string' || item[key] === '') throw new Error('Invalid briefing item')
    }
    if (typeof item.read !== 'boolean' || typeof item.dismissed !== 'boolean') throw new Error('Invalid briefing item')
  }
  return value as BriefingSnapshot
}
