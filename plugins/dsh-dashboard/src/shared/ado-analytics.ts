/** Pure ADO projections share exact item sets with drill filtering; no chart loads external data. */
import { DateTime } from 'luxon'
import type {
  AdoAnalyticsReport, AdoDrill, AgeGroup, AnalyticsGroup, CategoryCounts, ClosureKey,
  DependencyObservation, OwnershipGroup,
} from './ado-analytics-model.ts'
import type { Filters } from './selection.ts'
import type { AdoItem, AdoSnapshot, RiskCode, StateCategory } from './types.ts'
import { projectAdoHistory } from './ado-history.ts'
import { adoAgeInterval, adoDrillSchema } from './ado-analytics-schema.ts'

const categories: readonly StateCategory[] = ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed', 'Unknown']
const riskKeys: readonly RiskCode[] = ['unassigned', 'blocked', 'stale', 'overdue']
const closureKeys: readonly ClosureKey[] = ['blocked', 'unassigned', 'overdue', 'resolved', 'stale', 'continue']

/** Unknown and Removed items do not enter progress, estimate, or risk denominators. */
export function included(item: AdoItem): boolean {
  return item.category !== 'Unknown' && item.category !== 'Removed'
}

export function personKey(item: AdoItem): string {
  return item.assigneeId || item.assignee || '__unassigned__'
}

/** Clear chart refinements without mutating or adding an optional wire field. */
export function baseFilters(filters: Filters): Filters {
  const { drill: _drill, ...base } = filters
  return { ...base, metric: '', risk: '' }
}

function unfinished(item: AdoItem): boolean {
  return included(item) && item.category !== 'Completed'
}

function countCategories(items: readonly AdoItem[]): CategoryCounts {
  const counts: CategoryCounts = { Proposed: 0, InProgress: 0, Resolved: 0, Completed: 0, Removed: 0, Unknown: 0 }
  for (const item of items) counts[item.category]++
  return counts
}

function group<K extends string>(key: K, items: readonly AdoItem[]): AnalyticsGroup & { key: K } {
  return { key, count: items.length, itemIds: items.map(item => item.id) }
}

function fieldsMatch(item: AdoItem, filters: Filters, text: string): boolean {
  return item.type === filters.type
    && (!filters.person || personKey(item) === filters.person)
    && (!filters.state || item.state === filters.state)
    && (!filters.tag || item.tags.includes(filters.tag))
    && (!text || `${item.id} ${item.title} ${item.assignee} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(text))
}

function fieldsItems(items: readonly AdoItem[], filters: Filters): AdoItem[] {
  const text = filters.text.trim().toLocaleLowerCase()
  return items.filter(item => fieldsMatch(item, filters, text))
}

function closureKey(item: AdoItem): ClosureKey {
  if (item.risks.includes('blocked')) return 'blocked'
  if (item.risks.includes('unassigned')) return 'unassigned'
  if (item.risks.includes('overdue')) return 'overdue'
  if (item.category === 'Resolved') return 'resolved'
  return item.risks.includes('stale') ? 'stale' : 'continue'
}

function elapsedAge(item: AdoItem, field: 'createdAt' | 'stateChangedAt', now: number): number | null {
  const raw = item[field]
  const date = raw ? DateTime.fromISO(raw, { zone: 'utc' }) : null
  const days = date?.isValid ? (now - date.toMillis()) / 86_400_000 : NaN
  return Number.isFinite(days) && days >= 0 ? days : null
}

function ageGroups(snapshot: AdoSnapshot, items: readonly AdoItem[], field: 'createdAt' | 'stateChangedAt'): AgeGroup[] {
  const bands = snapshot.analytics!.settings.ageBands
  const groups: AgeGroup[] = bands.map((upper, index) => ({
    key: index ? `${bands[index - 1]}-${upper}` : `lt-${upper}`,
    lower: index ? bands[index - 1]! : 0, upper, count: 0, itemIds: [],
  }))
  groups.push({ key: `gte-${bands.at(-1)}`, lower: bands.at(-1)!, upper: null, count: 0, itemIds: [] })
  const unknown: AgeGroup = { key: 'unknown', lower: null, upper: null, count: 0, itemIds: [] }
  groups.push(unknown)
  const now = Date.parse(snapshot.generatedAt)
  for (const item of items.filter(unfinished)) {
    const days = elapsedAge(item, field, now)
    const row = days === null ? unknown
      : groups.find(entry => entry.lower !== null && days >= entry.lower && (entry.upper === null || days < entry.upper))!
    row.count++
    row.itemIds.push(item.id)
  }
  return groups
}

function ownership(items: readonly AdoItem[], field: 'owner' | 'area'): OwnershipGroup[] {
  const groups = new Map<string, AdoItem[]>()
  for (const item of items) {
    const key = field === 'owner' ? personKey(item) : item.areaPath
    const members = groups.get(key) ?? []
    members.push(item)
    groups.set(key, members)
  }
  return [...groups].map(([key, members]) => ({
    key,
    label: field === 'owner' ? members[0]!.assignee : key,
    counts: countCategories(members),
    completed: members.filter(item => item.category === 'Completed').length,
    remaining: members.filter(unfinished).length,
    risks: members.filter(item => unfinished(item) && item.risks.length > 0).length,
    itemIds: members.map(item => item.id),
  })).sort((left, right) => left.label.localeCompare(right.label, 'en') || left.key.localeCompare(right.key, 'en'))
}

function dependencies(snapshot: AdoSnapshot, items: readonly AdoItem[]): AdoAnalyticsReport['dependencies'] {
  const byId = new Map(snapshot.items.map(item => [item.id, item]))
  const links: DependencyObservation[] = []
  const groups = ['open', 'unavailable', 'clear'].map(key => group(key as 'open' | 'unavailable' | 'clear', []))
  for (const item of items.filter(unfinished)) {
    const observations: DependencyObservation[] = (item.predecessors ?? [null]).map(predecessorId => {
      const predecessor = predecessorId === null ? undefined : byId.get(predecessorId)
      const status = predecessor?.category === 'Completed' ? 'completed'
        : predecessor && unfinished(predecessor) ? 'open' : 'unavailable'
      return { itemId: item.id, predecessorId, status }
    })
    links.push(...observations)
    const key = observations.some(link => link.status === 'open') ? 'open'
      : observations.some(link => link.status === 'unavailable') ? 'unavailable' : 'clear'
    const row = groups.find(row => row.key === key)!
    row.count++
    row.itemIds.push(item.id)
  }
  return { groups, links }
}

function chartGroups(snapshot: AdoSnapshot, base: readonly AdoItem[]) {
  return {
    category: categories.map(category => group(category, base.filter(item => item.category === category))),
    area: ownership(base, 'area'),
    age: ageGroups(snapshot, base, 'createdAt'),
    stateAge: ageGroups(snapshot, base, 'stateChangedAt'),
    dependency: dependencies(snapshot, base),
    closure: closureKeys.map(key => group(key, base.filter(item => unfinished(item) && closureKey(item) === key))),
  }
}

function drillIds(snapshot: AdoSnapshot, filters: Filters, drill: AdoDrill): Set<number> {
  if (!snapshot.analytics) throw new Error('ADO analytics drill requires snapshot metadata')
  if (!adoDrillSchema.safeParse(drill).success) throw new Error(`Unrecognized ADO ${drill.chart} selection`)
  const base = fieldsItems(snapshot.items, filters)
  if (drill.chart === 'area') return new Set(base.filter(item => item.areaPath === drill.key).map(item => item.id))
  if (drill.chart === 'age' || drill.chart === 'stateAge') {
    const interval = adoAgeInterval(drill.key)!
    const field = drill.chart === 'age' ? 'createdAt' : 'stateChangedAt'
    const now = Date.parse(snapshot.generatedAt)
    return new Set(base.filter(item => {
      if (!unfinished(item)) return false
      const days = elapsedAge(item, field, now)
      return interval.lower === null ? days === null
        : days !== null && days >= interval.lower && (interval.upper === null || days < interval.upper)
    }).map(item => item.id))
  }
  const charts = chartGroups(snapshot, base)
  const rows = drill.chart === 'dependency' ? charts.dependency.groups : charts[drill.chart]
  const selected = rows?.find(row => row.key === drill.key)
  if (!selected) throw new Error(`Unrecognized ADO ${drill.chart} selection`)
  return new Set(selected.itemIds)
}

/**
 * Apply existing table filters and exact analytics drill membership without building a report recursively.
 * @param items Candidate rows.
 * @param filters Selection including optional chart membership.
 * @param snapshot Required when a drill is present; predecessors resolve only within this snapshot.
 * @returns Matching rows in input order; absent areas match no rows and age intervals retain their bounds after settings changes.
 * @throws For missing analytics metadata or malformed drill keys.
 */
export function filterAdoItems(items: readonly AdoItem[], filters: Filters, snapshot?: AdoSnapshot): AdoItem[] {
  if (filters.drill && !snapshot) throw new Error('ADO analytics drill requires its snapshot')
  const ids = filters.drill ? drillIds(snapshot!, filters, filters.drill) : null
  return fieldsItems(items, filters).filter(item =>
    (!ids || ids.has(item.id))
    && (!filters.risk || item.risks.includes(filters.risk))
    && (!filters.metric
      || (included(item) && (filters.metric === 'completed' ? item.category === 'Completed'
        : filters.metric === 'remaining' ? item.category !== 'Completed' : item.risks.length > 0))))
}

/**
 * Build single-type evidence at snapshot time; ownership ignores non-type filters and history uses base rows.
 * @param snapshot Validated current snapshot, optionally carrying revision evidence.
 * @param filters Table selection; metric, risk, and drill do not narrow chart denominators.
 * @returns Null for older snapshots without analytics metadata.
 */
export function buildAdoAnalytics(snapshot: AdoSnapshot, filters: Filters): AdoAnalyticsReport | null {
  if (!snapshot.analytics) return null
  const typeItems = snapshot.items.filter(item => item.type === filters.type)
  const base = fieldsItems(snapshot.items, filters)
  const charts = chartGroups(snapshot, base)
  const remaining = base.filter(unfinished)
  const completed = base.filter(item => item.category === 'Completed').length
  const eligible = remaining.length + completed
  return {
    version: 1, type: filters.type, sourceComplete: snapshot.complete,
    typeItemIds: typeItems.map(item => item.id), baseItemIds: base.map(item => item.id),
    matchingItemIds: filterAdoItems(snapshot.items, filters, snapshot).map(item => item.id),
    totals: {
      completed, remaining: remaining.length, eligible, percent: eligible ? completed * 100 / eligible : null,
      unknown: base.filter(item => item.category === 'Unknown').length,
      removed: base.filter(item => item.category === 'Removed').length,
      flagged: remaining.filter(item => item.risks.length > 0).length,
      unassigned: remaining.filter(item => item.risks.includes('unassigned')).length,
      blocked: remaining.filter(item => item.risks.includes('blocked')).length,
    },
    delivery: charts.category, owners: ownership(typeItems, 'owner'), areas: charts.area,
    age: charts.age, stateAge: charts.stateAge,
    risks: riskKeys.map(key => group(key, remaining.filter(item => item.risks.includes(key)))),
    closure: charts.closure, dependencies: charts.dependency,
    history: projectAdoHistory(snapshot, filters.type, base.map(item => item.id)),
  }
}
