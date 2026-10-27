/** Synthetic, instance-local fixtures for current-cohort analytics. */
import { adoAnalyticsSettingsSchema } from '../src/shared/ado-analytics-schema.ts'
import type { AdoAnalyticsSettings } from '../src/shared/ado-analytics-model.ts'
import type { AdoItem, AdoSnapshot, StateCategory } from '../src/shared/types.ts'

export const asOf = '2026-09-13T12:00:00.000Z'

export function item(id: number, fields: Partial<AdoItem> = {}): AdoItem {
  return {
    id, revision: 1, project: 'Project', title: `Item ${id}`, type: 'Story', state: 'Doing', category: 'InProgress',
    assignee: 'Alice', assigneeId: 'alice', areaPath: 'Project\\Area', iterationPath: 'Project\\Sprint',
    tags: [], url: '', createdAt: '2026-09-12T12:00:00.000Z', changedAt: asOf,
    stateChangedAt: '2026-09-12T12:00:00.000Z', predecessors: [], risks: [], ...fields,
  }
}

export function snapshot(items: AdoItem[], settings: Partial<AdoAnalyticsSettings> = {}): AdoSnapshot {
  return {
    kind: 'ado', generatedAt: asOf,
    source: { input: 'Project\\Area', orgName: 'example-org', project: 'Project', mode: 'area', path: 'Project\\Area' },
    sourceUrl: '', items, complete: true, warnings: [], defaultType: 'Story',
    analytics: { version: 1, timeZone: 'UTC', settings: adoAnalyticsSettingsSchema.parse(settings) },
  }
}

export const metadata = {
  name: 'Story',
  states: [
    { name: 'New', category: 'Proposed' },
    { name: 'Doing', category: 'InProgress' },
    { name: 'Verified', category: 'Resolved' },
    { name: 'Delivered', category: 'Completed' },
    { name: 'Discarded', category: 'Removed' },
  ],
}

export function revision(id: number, rev: number, at: string, state: string, fields: Record<string, unknown> = {}) {
  return {
    id, rev,
    fields: { 'System.WorkItemType': 'Story', 'System.State': state, 'System.ChangedDate': at, ...fields },
  }
}

export function counts(category: StateCategory, count: number) {
  return { Proposed: 0, InProgress: 0, Resolved: 0, Completed: 0, Removed: 0, Unknown: 0, [category]: count }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
