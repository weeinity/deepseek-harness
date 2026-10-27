/** Read-only selection, aggregation, and pagination over one validated ADO snapshot. */
import type { AdoItem, AdoSnapshot, AdoSource, RiskCode, StateCategory } from './types.ts'
import type { AdoDrill } from './ado-analytics-model.ts'
import { filterAdoItems, included, personKey } from './ado-analytics.ts'
export { baseFilters, included, personKey } from './ado-analytics.ts'

export type View = 'personal' | 'ado'
export type MetricFilter = '' | 'completed' | 'remaining' | 'risks'
export type SortKey = 'id' | 'title' | 'type' | 'state' | 'assignee' | 'priority' | 'changedAt'
export interface Filters {
  type: string
  person: string
  state: string
  tag: string
  text: string
  metric: MetricFilter
  risk: RiskCode | ''
  drill?: AdoDrill
}
export const emptyFilters = (): Filters => ({
  type: '', person: '', state: '', tag: '', text: '', metric: '', risk: '',
})

/** Source identity includes every query selector; it never depends on object property order. */
export function sourceKey(source: AdoSource): string {
  return JSON.stringify([
    source.input, source.orgName, source.project, source.team ?? '', source.mode,
    source.path ?? '', source.includeChildren ?? false,
  ])
}

export function selectedType(snapshot: AdoSnapshot, preferred: string): string {
  return snapshot.items.some(item => item.type === preferred) ? preferred : snapshot.defaultType
}

/** Drill selections require their snapshot; absent areas match no rows and age keys preserve their interval bounds. */
export function filterItems(items: readonly AdoItem[], filters: Filters, snapshot?: AdoSnapshot): AdoItem[] {
  return filterAdoItems(items, filters, snapshot)
}

export interface EstimateTotal { field: string; total: number; count: number }
export function summarize(items: readonly AdoItem[]) {
  const eligible = items.filter(included)
  const estimates = new Map<string, EstimateTotal>()
  for (const item of eligible) {
    if (item.estimate === undefined || !item.estimateField) continue
    const entry = estimates.get(item.estimateField) ?? { field: item.estimateField, total: 0, count: 0 }
    entry.total += item.estimate
    entry.count++
    estimates.set(entry.field, entry)
  }
  return {
    completed: eligible.filter(item => item.category === 'Completed').length,
    remaining: eligible.filter(item => item.category !== 'Completed').length,
    people: new Set(eligible.filter(item => personKey(item) !== '__unassigned__').map(personKey)).size,
    risks: eligible.filter(item => item.risks.length > 0).length,
    unknown: items.filter(item => item.category === 'Unknown').length,
    removed: items.filter(item => item.category === 'Removed').length,
    estimates: [...estimates.values()],
    remainingWork: eligible.some(item => item.remainingWork !== undefined)
      ? eligible.reduce((sum, item) => sum + (item.remainingWork ?? 0), 0) : null,
    remainingWorkCount: eligible.filter(item => item.remainingWork !== undefined).length,
  }
}

export function groupCounts(items: readonly AdoItem[], field: 'state' | 'person'): { key: string; label: string; count: number }[] {
  const groups = new Map<string, { key: string; label: string; count: number }>()
  for (const item of items) {
    const key = field === 'state' ? item.state : personKey(item)
    const entry = groups.get(key) ?? { key, label: field === 'state' ? item.state : item.assignee, count: 0 }
    entry.count++
    groups.set(key, entry)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

/** Missing sort values stay last in both directions; id makes ties deterministic. */
export function pageItems(items: readonly AdoItem[], sort: SortKey, direction: 'asc' | 'desc', page: number, pageSize: number) {
  const ordered = [...items].sort((a, b) => {
    const left = a[sort]
    const right = b[sort]
    if (left === undefined || right === undefined) return left === right ? a.id - b.id : left === undefined ? 1 : -1
    const comparison = sort === 'changedAt' ? Date.parse(String(left)) - Date.parse(String(right))
      : typeof left === 'number' && typeof right === 'number'
        ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })
    return (direction === 'asc' ? comparison : -comparison) || a.id - b.id
  })
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize))
  const current = Math.max(0, Math.min(page, pages - 1))
  return { items: ordered.slice(current * pageSize, (current + 1) * pageSize), page: current, pages, total: ordered.length }
}

export const categories: readonly StateCategory[] = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed', 'Unknown']
