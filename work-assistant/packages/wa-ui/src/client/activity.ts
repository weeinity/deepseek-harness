import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Preset id owned by the personal-assistant profile. */
export const PERSONAL_ASSISTANT_PRESET = 'personal-assistant'

/** Display state derived from Session summary flags without treating idle as success. */
export type ActivityStatus = 'running' | 'finished' | 'idle'

/** Render-ready recent conversation row. */
export interface ActivityRow {
  readonly id: SessionId
  readonly title: string
  readonly updatedAt: number
  readonly status: ActivityStatus
  readonly selected: boolean
}

/** Project bounded recent nonblank personal-assistant conversations from the Session list. */
export function recentPersonalAssistantRows(state: SessionListState, maxRows: number): readonly ActivityRow[] {
  return personalAssistantRows(state).slice(0, Math.max(0, Math.trunc(maxRows)))
}

/** Select personal conversations before independently bounding the timeline and queue. */
export function personalAssistantRows(state: SessionListState): readonly ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const id of state.ids) {
    const summary = state.byId[id]
    if (summary === undefined || summary.blank || agentPresetOf(summary) !== PERSONAL_ASSISTANT_PRESET) continue
    rows.push({
      id: summary.id,
      title: summary.displayTitle,
      updatedAt: summary.updatedAt,
      status: statusOf(summary),
      selected: summary.id === state.current,
    })
  }
  rows.sort((left, right) =>
    right.updatedAt - left.updatedAt
    || left.title.localeCompare(right.title)
    || String(left.id).localeCompare(String(right.id)))
  return rows
}

/** Conversation group using the browser's local calendar day. */
export interface ActivityGroup {
  readonly day: number
  readonly label: 'today' | 'yesterday' | 'date'
  readonly rows: readonly ActivityRow[]
}

/** Group sorted conversations by local day; `now` also makes midnight behavior reproducible. */
export function groupActivities(rows: readonly ActivityRow[], now: number): readonly ActivityGroup[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const groups = new Map<number, ActivityRow[]>()
  for (const row of rows) {
    const date = new Date(row.updatedAt)
    date.setHours(0, 0, 0, 0)
    const day = date.getTime()
    const group = groups.get(day)
    if (group === undefined) groups.set(day, [row])
    else group.push(row)
  }
  return [...groups].map(([day, items]) => ({
    day,
    label: day === today.getTime() ? 'today' : day === yesterday.getTime() ? 'yesterday' : 'date',
    rows: items,
  }))
}

function agentPresetOf(summary: SessionSummary): string | undefined {
  const projections = summary.projectionValues as Readonly<Record<string, unknown>> | undefined
  const preset = projections?.['agentPreset']
  return typeof preset === 'string' ? preset : undefined
}

function statusOf(summary: SessionSummary): ActivityStatus {
  if (summary.running) return 'running'
  if (summary.completed === true) return 'finished'
  return 'idle'
}
