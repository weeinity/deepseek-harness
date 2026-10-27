/** Export the displayed selection without mutating the provider's retained snapshot. */
import type { DashboardSnapshot } from '../shared/types.ts'
import type { DashboardExportSnapshot } from '../shared/export-types.ts'
import type { Preferences } from './stores.ts'
import type { DashboardText } from './locale.ts'
import { baseFilters, filterItems, groupCounts, personKey, selectedType, summarize } from '../shared/selection.ts'
import { buildAdoAnalytics } from '../shared/ado-analytics.ts'
import { displayedAttentionFilter, projectAttention } from '../shared/personal-selection.ts'

/**
 * Capture chart scopes before projecting matching rows, without changing the retained snapshot.
 * @param snapshot Full validated source snapshot, including any explicitly loaded history.
 * @param preferences Current selection; pagination never limits exported matching rows.
 * @param t Locale-owned selection warnings.
 * @returns Local export data, not evidence accepted by the Host question routes.
 */
export function snapshotForExport(snapshot: DashboardSnapshot, preferences: Preferences, t: DashboardText): DashboardExportSnapshot {
  if (snapshot.kind === 'personal') {
    const filter = displayedAttentionFilter(snapshot, preferences.attentionFilter)
    const projected = projectAttention(snapshot, filter)
    if (filter === 'all') return projected
    const count = projected.sections.find(section => section.id === 'urgent')?.items.length ?? 0
    return {
      ...projected,
      warnings: [...snapshot.warnings, t('export.attentionSelection', {
        filter: t(`attention.filter.${filter}`), count,
      })],
    }
  }
  const filters = { ...preferences.filters, type: selectedType(snapshot, preferences.filters.type) }
  const adoReport = buildAdoAnalytics(snapshot, filters)
  const typedItems = snapshot.items.filter(item => item.type === filters.type)
  const items = filterItems(snapshot.items, filters, snapshot)
  const criteria = [t('export.criterion', { label: t('filter.type'), value: filters.type || t('unavailable') })]
  const add = (label: string, value: string) => { criteria.push(t('export.criterion', { label, value })) }
  if (filters.person) {
    const name = snapshot.items.find(item => personKey(item) === filters.person)?.assignee
      || t(filters.person === '__unassigned__' ? 'filter.unassigned' : 'unknown')
    add(t('filter.person'), t('export.person', { name, id: filters.person }))
  }
  if (filters.state) add(t('filter.state'), filters.state)
  if (filters.tag) add(t('filter.tag'), filters.tag)
  if (filters.text.trim()) add(t('filter.text'), filters.text.trim())
  if (filters.risk) add(t('ado.risks'), t(`risk.${filters.risk}`))
  if (filters.metric) criteria.push(t('filter.active', { label: t(`ado.${filters.metric}`) }))
  if (filters.drill) criteria.push(t('ado.analytics.selected', { chart: filters.drill.chart, label: filters.drill.key }))
  return {
    ...snapshot,
    ...(adoReport ? {
      adoReport,
      adoExportSelection: {
        summary: summarize(filterItems(snapshot.items, baseFilters(filters), snapshot)),
        states: groupCounts(typedItems, 'state'),
      },
    } : {}),
    defaultType: filters.type,
    items,
    warnings: [...snapshot.warnings, adoReport
      ? [t('table.count', { count: items.length }), ...criteria, t('ado.analytics.scopeHelp')].join(t('export.separator'))
      : t('export.filteredScope', { count: items.length, criteria: criteria.join(t('export.separator')) })],
  }
}
