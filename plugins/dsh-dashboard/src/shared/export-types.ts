/** Local export projections are not accepted as Host-retained question evidence. */
import type { AdoAnalyticsReport } from './ado-analytics-model.ts'
import type { groupCounts, summarize } from './selection.ts'
import type { DashboardSnapshot } from './types.ts'

/** Captured before matching rows narrow the snapshot; chart and KPI scopes differ. */
export interface AdoExportSelection {
  summary: ReturnType<typeof summarize>
  states: ReturnType<typeof groupCounts>
}

/** Optional fields keep ordinary snapshot render/download callers source-compatible. */
export type DashboardExportSnapshot = DashboardSnapshot & {
  adoReport?: AdoAnalyticsReport
  adoExportSelection?: AdoExportSelection
}
