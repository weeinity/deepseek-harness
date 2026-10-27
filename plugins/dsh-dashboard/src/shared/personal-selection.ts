/** Shared attention selection keeps the Dashboard, export, and logged question evidence aligned. */
import type { AttentionFilter } from './insights.ts'
import type { DashboardItem, PersonalSnapshot } from './types.ts'
import { attentionItemVisible } from './attention.ts'

/**
 * Select and rank attention rows without mutating the retained snapshot.
 * @param snapshot - personal data and optional source-owned classifications.
 * @param filter - selected attention segment; All also works without classifications.
 * @returns matching rows in consequence rank and original-order tie breaks.
 * @throws Error when a classification-dependent filter has no classification evidence.
 */
export function selectAttention(snapshot: PersonalSnapshot, filter: AttentionFilter): DashboardItem[] {
  const rows = (snapshot.sections.find(section => section.id === 'urgent')?.items ?? [])
    .filter(item => attentionItemVisible(snapshot.attention, item.id))
  if (filter !== 'all' && snapshot.insights?.attentionCounts == null) {
    throw new Error('This snapshot has no attention classifications. Select All or refresh the dashboard.')
  }
  const annotations = new Map(snapshot.insights?.attention.map(item => [item.itemId, item]))
  return rows.map((item, index) => ({ item, index, annotation: annotations.get(item.id) }))
    .filter(({ annotation }) => filter === 'all'
      || (filter === 'pastDue' ? annotation?.category === 'pastDue' : annotation?.thisWeekend === true))
    .sort((left, right) => (left.annotation?.rank ?? Number.MAX_SAFE_INTEGER)
      - (right.annotation?.rank ?? Number.MAX_SAFE_INTEGER) || left.index - right.index)
    .map(({ item }) => item)
}

/**
 * Resolve the displayed segment when classifications are unavailable.
 * @param snapshot - current source data.
 * @param requested - retained preference, which may belong to an earlier classified snapshot.
 * @returns All for unavailable classifications; the UI must disclose that unavailable state.
 */
export function displayedAttentionFilter(snapshot: PersonalSnapshot, requested: AttentionFilter): AttentionFilter {
  return snapshot.insights?.attentionCounts == null ? 'all' : requested
}

/**
 * Resolve older captured selections that predate attention filtering.
 * @param selection - parsed wire selection; omission must remain absent until after retry reconciliation.
 * @returns the requested segment, or All for an older selection.
 */
export function resolveAttentionFilter(selection: { attentionFilter?: AttentionFilter }): AttentionFilter {
  return selection.attentionFilter ?? 'all'
}

/**
 * Project only the attention rows; unrelated sections and source-wide metrics retain their meaning.
 * @param snapshot - immutable source data.
 * @param filter - selected attention segment.
 * @returns an export/model projection with matching annotations and unchanged source-wide readings.
 */
export function projectAttention(snapshot: PersonalSnapshot, filter: AttentionFilter): PersonalSnapshot {
  if (filter === 'all' && snapshot.insights === undefined && snapshot.attention === undefined) return snapshot
  const selected = selectAttention(snapshot, filter)
  const ids = new Set(selected.map(item => item.id))
  return {
    ...snapshot,
    sections: snapshot.sections.map(section => section.id === 'urgent' ? { ...section, items: selected } : section),
    ...(snapshot.insights === undefined ? {} : {
      insights: { ...snapshot.insights, attention: snapshot.insights.attention.filter(item => ids.has(item.itemId)) },
    }),
  }
}
