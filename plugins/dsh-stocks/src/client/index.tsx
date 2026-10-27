/** Stocks is an independent main panel beside Dashboard and Taskboard. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { createStocksStore, defaultPreferences, restorePreferences, type Preferences } from './state.ts'
import { en, zh } from './locale.ts'
import { Stocks } from './Stocks.tsx'
import type { Injected, ToastProps } from './contract.ts'
export const name = 'dsh-stocks'
export const inject = ['slots', 'locale', 'theme']
function Launcher({ size }: { size: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 12c2-3.5 5-5 8-5s5 2 6.5 5c-1.5 3-3.5 5-6.5 5s-6-1.5-8-5Z" />
      <path d="M7 12 2.5 8.5v7Z" />
      <path d="M12.5 9.5c-.7 1.6-.7 3.4 0 5" />
      <path d="M17.5 11h.01" />
    </svg>
  )
}
function Notices(props: ToastProps) {
  const toast = props.useStore((s) => s.toast)
  return toast ? (
    <Toast
      key={toast.id}
      text={props.t(toast.key)}
      tone={toast.success ? 'success' : undefined}
      onDone={props.actions.dismiss}
    />
  ) : null
}
export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('stocks', { en, zh }))
  let initial = defaultPreferences()
  let storageError = false
  try {
    initial = restorePreferences(localStorage.getItem('dsh-stocks.preferences.v1'))
  } catch (error) {
    storageError = true
    console.warn(
      '[dsh-stocks] Tab preferences unavailable',
      error instanceof Error ? error.name : 'read-error',
    )
  }
  const store = createStocksStore(initial, storageError)
  const palette = {
    getSnapshot: () => ctx.theme.getTheme().active.colorScheme,
    subscribe: (listener: () => void) => ctx.on('theme/change', listener),
  }
  const persist = (value: Preferences) => {
    try {
      localStorage.setItem('dsh-stocks.preferences.v1', JSON.stringify(value))
      return true
    } catch (error) {
      console.warn('[dsh-stocks] Preferences not saved', error instanceof Error ? error.name : 'write-error')
      return false
    }
  }
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: 'stocks',
        locale: 'stocks',
        store,
        inject: (): Injected => ({ persist, hooks: { palette } }),
      },
      Stocks,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: 'stocks' as MainPanelId,
        order: 31,
        label: () => ctx.locale.bind('stocks')('label'),
      },
      Launcher,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'stocks-notices', locale: 'stocks', store }, Notices),
  )
}
