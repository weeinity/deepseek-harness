/** JSON data exchanged by authenticated dashboard source and analysis operations. */
import type { PersonalInsights } from './insights.ts'
import type { AdoAnalyticsSnapshot } from './ado-analytics-model.ts'
import type { AttentionView } from './attention.ts'
export type SourceState = 'live' | 'partial' | 'reference' | 'unavailable'
export interface SourceStatus {
  id: string
  state: SourceState
  updatedAt: string
  message?: string
}
export interface DashboardItem {
  id: string
  title: string
  detail: string
  url: string
  source: 'live' | 'reference'
  severity?: 'hot' | 'watch' | 'active'
  sourceDate?: string
  initials?: string
}
export type SectionId = 'urgent' | 'prep' | 'projects' | 'reply' | 'actions' | 'training' | 'oof' | 'people' | 'chats' | 'files'
export interface DashboardSection {
  id: SectionId
  items: DashboardItem[]
  source: SourceState
  note?: string
}
export interface CalendarItem {
  id: string
  title: string
  start: string
  end: string
  url: string
  organizer: string
  response: string
  online: boolean
  allDay: boolean
  free: boolean
  conflict: boolean
  optionalOverlap: boolean
  preview: string
}
export type AllocationCategory = 'customer' | 'training' | 'internal' | 'focus' | 'admin'
export interface PersonalSnapshot {
  kind: 'personal'
  generatedAt: string
  timeZone: string
  displayName: string
  email?: string
  nextBusinessDay: string
  sources: SourceStatus[]
  metrics: {
    overdueActions: number | null
    attentionItems: number
    unreadEmails: number | null
    meetingsNextDay: number | null
    teamsUnread: number | null
    projects: number
    oof: number | null
  }
  schedule: CalendarItem[]
  todayRemaining: CalendarItem[]
  weekLoad: { date: string; meetings: number; minutes: number }[]
  allocation: { category: AllocationCategory; minutes: number; percent: number }[]
  sections: DashboardSection[]
  referenceAsOf?: string
  warnings: string[]
  /** Absent when the producer has no interpretation data; never filled with sample claims. */
  insights?: PersonalInsights
  /** Local decisions evaluated separately from the immutable source rows and source-wide totals. */
  attention?: AttentionView
}
export interface AdoSource {
  input: string
  orgName: string
  project: string
  team?: string
  mode: 'iteration' | 'area' | 'query'
  path?: string
  includeChildren?: boolean
}
export type StateCategory = 'Proposed' | 'InProgress' | 'Resolved' | 'Completed' | 'Removed' | 'Unknown'
export type RiskCode = 'unassigned' | 'blocked' | 'stale' | 'overdue'
export interface AdoItem {
  id: number
  revision?: number
  project?: string
  title: string
  type: string
  state: string
  category: StateCategory
  assignee: string
  assigneeId: string
  areaPath: string
  iterationPath: string
  tags: string[]
  url: string
  changedAt?: string
  createdAt?: string
  stateChangedAt?: string
  /** Undefined means unobserved relations; null entries denote unresolved predecessor references. */
  predecessors?: (number | null)[]
  dueDate?: string
  estimate?: number
  estimateField?: string
  remainingWork?: number
  priority?: number
  risks: RiskCode[]
}
export interface AdoSnapshot {
  kind: 'ado'
  generatedAt: string
  source: AdoSource
  sourceUrl: string
  iteration?: { name: string; path: string; id: string; start?: string; finish?: string }
  items: AdoItem[]
  complete: boolean
  warnings: string[]
  defaultType: string
  analytics?: AdoAnalyticsSnapshot
}
export type DashboardSnapshot = PersonalSnapshot | AdoSnapshot
export interface DashboardSettings {
  /** Fresh source data skips automatic reads for this many seconds. */
  cacheSeconds: number
  timeZone: string
  refreshMinutes: number
  refreshMinute: number
  workdayStart: number
  workdayEnd: number
  hasReference: boolean
  maxChatQuestionChars: number
  defaultAdoSource?: AdoSource
}
/** Narrow internal provider API; UI callers cannot choose MCP operations. */
export interface ReadOnlyMcp {
  call(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
export interface PersonalOptions {
  timeZone: string
  referencePath?: string
  maxCalendarPages: number
  attention: { lookbackDays: number; maxItems: number; maxMessages: number }
  maxItems: number
  now: () => Date
}
export interface AdoOptions {
  maxItems: number
  pageSize: number
  staleDays: number
  blockedTags: string[]
  now: () => Date
}
