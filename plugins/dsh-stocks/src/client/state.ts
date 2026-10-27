/** Persistent viewing preferences; market data remains owned by the authenticated host. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'
import { symbolSchema } from '../shared/api.ts'
export const preferencesSchema = z
  .object({
    version: z.literal(1),
    tabs: z.array(symbolSchema).max(10),
    active: z.string(),
    market: z.enum(['us', 'in', 'de', 'ca', 'au', 'crypto', 'fx']),
  })
  .strict()
export type Preferences = z.infer<typeof preferencesSchema>
export const defaultPreferences = (): Preferences => ({
  version: 1,
  tabs: [],
  active: 'overview',
  market: 'us',
})
export function restorePreferences(text: string | null): Preferences {
  if (!text) return defaultPreferences()
  const value = preferencesSchema.parse(JSON.parse(text))
  value.tabs = [...new Set(value.tabs)]
  if (!['overview', 'watchlist', ...value.tabs].includes(value.active)) value.active = 'overview'
  return value
}
export function openTab(p: Preferences, symbol: string) {
  const next = symbolSchema.parse(symbol)
  if (!p.tabs.includes(next)) p.tabs = [...p.tabs, next].slice(-10)
  p.active = next
}
export function closeTab(p: Preferences, symbol: string) {
  const index = p.tabs.indexOf(symbol)
  p.tabs = p.tabs.filter((t) => t !== symbol)
  if (p.active === symbol) p.active = p.tabs[Math.max(0, index - 1)] ?? 'overview'
}
export function createStocksStore(initial: Preferences, storageError: boolean) {
  return defineStore({
    init: () => ({
      ...initial,
      storageError,
      toast: null as null | {
        id: number
        key: 'saved' | 'removed' | 'mutationError' | 'conflict'
        success: boolean
      },
    }),
    actions: {
      open: openTab,
      close: closeTab,
      select(p, tab: string) {
        if (['overview', 'watchlist', ...p.tabs].includes(tab)) p.active = tab
      },
      market(p, id: Preferences['market']) {
        p.market = id
      },
      storageFailed(p) {
        p.storageError = true
      },
      notify(p, key: 'saved' | 'removed' | 'mutationError' | 'conflict', success: boolean) {
        p.toast = { id: (p.toast?.id ?? 0) + 1, key, success }
      },
      dismiss(p) {
        p.toast = null
      },
    },
  })
}
