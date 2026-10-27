/** Props derived from the registered main page and shell toast seats. */
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsStore, ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { createStocksStore, Preferences } from './state.ts'
export type Stores = PropsStore<ReturnType<typeof createStocksStore>>
export interface Injected {
  persist: (p: Preferences) => boolean
  hooks: { palette: ObservableSnapshot<'light' | 'dark'> }
}
export type StocksProps = PropsRuntime<'main'> & Stores & PropsLocale<'stocks'> & InjectFace<Injected>
export type ToastProps = PropsRuntime<'shell.overlay'> & Stores & PropsLocale<'stocks'>
