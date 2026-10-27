/** Entry-owned preferences only; server snapshots belong to DashboardOwner. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { AdoSource } from '../shared/types.ts'
import type { AttentionFilter } from '../shared/insights.ts'
import { emptyFilters, sourceKey, type Filters, type SortKey, type View } from '../shared/selection.ts'

export interface QuestionDraft { text: string; revision: number }

export interface Preferences {
  tab: View
  source: AdoSource | null
  filters: Filters
  sort: SortKey
  direction: 'asc' | 'desc'
  page: number
  pageSize: number
  selection: number | null
  drafts: Record<string, QuestionDraft>
  mobilePane: 'data' | 'chat'
  attentionFilter: AttentionFilter
}

/** One root-scoped handle retains navigation and source-isolated drafts across page mounts. */
export function createDashboardStore() {
  return defineStore({
    init: (): Preferences => ({
      tab: 'personal', source: null, filters: emptyFilters(),
      sort: 'id', direction: 'asc', page: 0, pageSize: 20, selection: null, drafts: {}, mobilePane: 'data',
      attentionFilter: 'all',
    }),
    actions: {
      tab(draft, tab: View) { draft.tab = tab },
      attentionFilter(draft, value: AttentionFilter) { draft.attentionFilter = value },
      source(draft, source: AdoSource) {
        if (draft.source !== null && sourceKey(draft.source) === sourceKey(source)) return
        draft.source = source
        draft.filters = emptyFilters()
        draft.page = 0
        draft.selection = null
      },
      filter(draft, filter: Partial<Filters>) {
        Object.assign(draft.filters, filter)
        draft.page = 0
        draft.selection = null
      },
      clear(draft) { draft.filters = emptyFilters(); draft.page = 0; draft.selection = null },
      sort(draft, sort: SortKey) {
        draft.direction = draft.sort === sort && draft.direction === 'asc' ? 'desc' : 'asc'
        draft.sort = sort
        draft.page = 0
      },
      page(draft, page: number) { draft.page = page },
      pageSize(draft, size: number) { draft.pageSize = size; draft.page = 0 },
      select(draft, id: number | null) { draft.selection = id },
      question(draft, scopeId: string, text: string) {
        draft.drafts[scopeId] = { text, revision: (draft.drafts[scopeId]?.revision ?? 0) + 1 }
      },
      accepted(draft, scopeId: string, revision: number) {
        const question = draft.drafts[scopeId]
        if (question?.revision === revision) draft.drafts[scopeId] = { text: '', revision: revision + 1 }
      },
      mobilePane(draft, pane: 'data' | 'chat') { draft.mobilePane = pane },
    },
  })
}
