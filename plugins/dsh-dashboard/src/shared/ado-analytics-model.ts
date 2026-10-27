/** Evidence and projections for single-type delivery reports; history follows the current cohort. */
import type { RiskCode, StateCategory } from './types.ts'

export interface AdoAnalyticsSettings {
  ageBands: number[]
  historyDays: number
  maxHistoryDays: number
  maxHistoryItems: number
  maxRevisionsPerItem: number
  revisionPageSize: number
  historyConcurrency: number
  historyTimeoutMs: number
  maxHistoryRequests: number
}

export interface AdoHistoryRange {
  /** Inclusive calendar dates in timeZone, not UTC instants. */
  start: string
  finish: string
  timeZone: string
  source: 'iteration' | 'recent'
  clipped: boolean
}

export interface AdoItemHistory {
  id: number
  /** Initial observation, last pre-window category observation, and in-window category changes. */
  changes: { at: string; category: StateCategory }[]
}

export interface AdoHistory {
  basis: 'current-cohort'
  type: string
  status: 'complete' | 'partial' | 'unavailable'
  fetchedAt: string
  range: AdoHistoryRange | null
  requestedItemIds: number[]
  items: AdoItemHistory[]
  omitted: { id: number; reason: string }[]
  warnings: string[]
}

export interface AdoAnalyticsSnapshot {
  version: 1
  timeZone: string
  settings: AdoAnalyticsSettings
  history?: AdoHistory
}

export type AdoChart = 'category' | 'area' | 'age' | 'stateAge' | 'dependency' | 'closure'
export interface AdoDrill {
  chart: AdoChart
  /** Areas match exact text; age intervals retain their encoded bounds across settings changes. */
  key: string
}

export type CategoryCounts = Record<StateCategory, number>

export interface AnalyticsGroup {
  key: string
  count: number
  itemIds: number[]
}

export interface OwnershipGroup {
  key: string
  label: string
  counts: CategoryCounts
  completed: number
  remaining: number
  risks: number
  itemIds: number[]
}

export interface AgeGroup extends AnalyticsGroup {
  lower: number | null
  upper: number | null
}

export type ClosureKey = 'blocked' | 'unassigned' | 'overdue' | 'resolved' | 'stale' | 'continue'
export type DependencyStatus = 'open' | 'completed' | 'unavailable'
export interface DependencyObservation {
  itemId: number
  predecessorId: number | null
  status: DependencyStatus
}

export interface HistoryPoint {
  date: string
  counts: CategoryCounts
  notCreated: number
  completedItemIds: number[]
  reopenedItemIds: number[]
}

export interface HistoryReport {
  basis: 'current-cohort'
  status: AdoHistory['status']
  range: AdoHistoryRange | null
  fetchedAt: string
  requestedCount: number
  availableCount: number
  omittedItemIds: number[]
  points: HistoryPoint[]
  warnings: string[]
}

export interface AdoAnalyticsReport {
  version: 1
  type: string
  sourceComplete: boolean
  typeItemIds: number[]
  baseItemIds: number[]
  matchingItemIds: number[]
  totals: {
    completed: number
    remaining: number
    eligible: number
    percent: number | null
    unknown: number
    removed: number
    flagged: number
    unassigned: number
    blocked: number
  }
  delivery: (AnalyticsGroup & { key: StateCategory })[]
  owners: OwnershipGroup[]
  areas: OwnershipGroup[]
  age: AgeGroup[]
  stateAge: AgeGroup[]
  risks: (AnalyticsGroup & { key: RiskCode })[]
  closure: (AnalyticsGroup & { key: ClosureKey })[]
  dependencies: {
    groups: (AnalyticsGroup & { key: 'open' | 'unavailable' | 'clear' })[]
    links: DependencyObservation[]
  }
  history: HistoryReport | null
}
