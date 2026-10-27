/** Capture only the selection that the dashboard currently renders. */
import type { DashboardChatSelection, SnapshotReceipt } from '../shared/chat.ts'
import { filterItems, pageItems, selectedType, sourceKey } from '../shared/selection.ts'
import { displayedAttentionFilter } from '../shared/personal-selection.ts'
import type { DashboardState } from './owner.ts'
import type { Preferences } from './stores.ts'

export interface ChatContext {
  receipt: SnapshotReceipt
  selection: DashboardChatSelection
}

/** A matching retained receipt may reopen history while a refresh is pending. */
export function displayedReceipt(state: DashboardState, prefs: Preferences): SnapshotReceipt | null {
  const resource = state[prefs.tab]
  if (resource.data === null || resource.receipt === null || resource.previousSource) return null
  if (prefs.tab === 'ado' && (prefs.source === null || resource.dataKey !== sourceKey(prefs.source))) return null
  return resource.receipt
}

/** Pending or different-source snapshots never authorize a new question. */
export function displayedContext(state: DashboardState, prefs: Preferences): ChatContext | null {
  const receipt = displayedReceipt(state, prefs)
  const resource = state[prefs.tab]
  if (receipt === null || resource.status === 'pending') return null
  if (prefs.tab === 'personal') {
    const snapshot = state.personal.data
    if (snapshot === null || state.attention?.pending) return null
    return {
      receipt,
      selection: { view: 'personal', stale: resource.stale, attentionFilter: displayedAttentionFilter(snapshot, prefs.attentionFilter),
        ...(snapshot.attention ? { attentionVersion: 1 as const } : {}) },
    }
  }
  const snapshot = state.ado.data
  if (snapshot === null) return null
  const filters = { ...prefs.filters, type: selectedType(snapshot, prefs.filters.type) }
  const rows = filterItems(snapshot.items, filters, snapshot)
  const pagination = pageItems(rows, prefs.sort, prefs.direction, prefs.page, prefs.pageSize)
  return {
    receipt,
    selection: {
      view: 'ado', filters, selectedItem: rows.find(item => item.id === prefs.selection)?.id ?? null,
      sort: prefs.sort, direction: prefs.direction, page: pagination.page,
      pageSize: prefs.pageSize, stale: resource.stale,
      ...(snapshot.analytics ? { analyticsVersion: 1 as const } : {}),
    },
  }
}
