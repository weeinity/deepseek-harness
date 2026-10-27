/**
 * `/oauth` slash command: status / list / enable / disable / login / logout.
 *
 * Login cannot wait for the browser: DSH commands only render when the
 * handler returns, so a device-code poll looks like a hung `/oauth`. The
 * handler returns as soon as pi-ai notifies a URL or user code, and the
 * poll continues in the background.
 */

import type { OAuthPiAiAdapter } from './adapter.ts'

/** Provider authorization and catalog operations shared by commands and the Settings controller. */
export type OAuthControlAdapter = Pick<OAuthPiAiAdapter,
  'authPath' | 'catalogIds' | 'routeIds' | 'displayName' | 'checkAuth' | 'logout' | 'login'
>

export interface CommandResult {
  readonly kind: 'success' | 'error'
  readonly text: string
  /** Browser URL the client should open (auth_url or device verification). */
  readonly openUrl?: string
  /** Device code the user must enter, when applicable. */
  readonly userCode?: string
}

/** In-flight or last-finished login, keyed by provider id. */
export interface LoginWatch {
  readonly provider: string
  status: 'waiting' | 'ok' | 'error'
  detail?: string
  openUrl?: string
  userCode?: string
  readonly lines: string[]
}

const watches = new Map<string, LoginWatch>()

/** Test helper: drop every background login watch. */
export function resetLoginWatches(): void {
  watches.clear()
}

/** Snapshot of background login watches (for tests and `/oauth status`). */
export function listLoginWatches(): readonly LoginWatch[] {
  return [...watches.values()]
}

function usageText(authPath: string): string {
  return [
    'Usage:',
    '  /oauth status',
    '  /oauth list',
    '  /oauth enable <provider>',
    '  /oauth disable <provider>',
    '  /oauth login <provider>',
    '  /oauth logout <provider>',
    '',
    `Auth file: ${authPath}`,
    '',
    'Notes:',
    '  - Only enabled providers appear in the model picker.',
    '  - login auto-enables the provider when settings are available.',
    '  - openai (API) is not OAuth; use openai-codex for ChatGPT / Codex subscription.',
    '  - Grok is provider id "xai".',
    '  - Do not also configure the same provider id under llm-pi-ai (DUPLICATE_ADAPTER).',
    '  - Prefer Settings → OAuth / 订阅 for status + enable toggles.',
  ].join('\n')
}

function formatEvent(event: {
  type: string
  message?: string
  url?: string
  instructions?: string
  verificationUri?: string
  userCode?: string
}): string[] {
  switch (event.type) {
    case 'auth_url':
      return [
        `Open this URL:\n${event.url ?? ''}`,
        ...event.instructions ? [event.instructions] : [],
      ]
    case 'device_code':
      return [
        `Open this URL:\n${event.verificationUri ?? ''}`,
        `Enter code: ${event.userCode ?? ''}`,
      ]
    case 'info':
    case 'progress':
      return event.message ? [event.message] : []
    default:
      return []
  }
}

function isLoginNotice(type: string): boolean {
  return type === 'device_code' || type === 'auth_url'
}

/**
 * Choose a non-interactive answer for a select prompt.
 * Prefer device-code / headless options when present (Web has no local
 * OAuth callback port for browser login).
 */
function pickSelectOption(
  provider: string,
  options: readonly { id: string, label: string, description?: string }[],
): { id: string, label: string } {
  const byId = (id: string) => options.find(option => option.id === id)
  // openai-codex: browser needs localhost:1455 callback; device_code works in Web.
  if (provider === 'openai-codex') {
    const device = byId('device_code')
    if (device !== undefined) return device
  }
  const headless = options.find(option =>
    /device[_-]?code|headless|cli/i.test(`${option.id} ${option.label} ${option.description ?? ''}`))
  if (headless !== undefined) return headless
  // First option is usually the provider default.
  return options[0]!
}

/**
 * Answer a text prompt without a terminal when a blank / default is valid.
 * github-copilot asks for Enterprise URL with blank = github.com.
 */
function answerOptionalTextPrompt(
  provider: string,
  prompt: { type: string, message: string, placeholder?: string },
): string | undefined {
  if (prompt.type !== 'text') return undefined
  const blob = `${prompt.message} ${prompt.placeholder ?? ''}`.toLowerCase()
  if (provider === 'github-copilot' || /enterprise|blank for github\.com|github\.com/i.test(blob)) {
    // Empty → public github.com (pi-ai treats blank as non-enterprise).
    return ''
  }
  // Generic “blank for default” wording.
  if (/\bblank\b|\boptional\b|\bleave empty\b|\(empty\)/i.test(blob)) {
    return ''
  }
  return undefined
}

function resultExtras(watch: LoginWatch): Pick<CommandResult, 'openUrl' | 'userCode'> {
  return {
    ...watch.openUrl === undefined ? {} : { openUrl: watch.openUrl },
    ...watch.userCode === undefined ? {} : { userCode: watch.userCode },
  }
}

function waitingText(watch: LoginWatch): string {
  return [
    ...watch.lines,
    '',
    `Finish signing in to ${watch.provider} in the browser.`,
    'This command has returned so the UI is not stuck; the login continues in the background.',
    'When you are done, run /oauth status or refresh Settings → OAuth / 订阅.',
  ].join('\n')
}

/**
 * Start OAuth and return as soon as the user has something to open.
 * The device-code poll is not bound to the command AbortSignal — the Web
 * request ends when this handler returns, and aborting it would cancel login.
 */
async function startLogin(
  adapter: OAuthControlAdapter,
  provider: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const existing = watches.get(provider)
  if (existing?.status === 'waiting') {
    return { kind: 'success', text: waitingText(existing), ...resultExtras(existing) }
  }

  const lines: string[] = []
  const watch: LoginWatch = { provider, status: 'waiting', lines }
  watches.set(provider, watch)

  let released = false
  let release!: (error?: Error) => void
  const firstNotice = new Promise<void>((resolve, reject) => {
    release = (error?: Error): void => {
      if (released) return
      released = true
      if (error === undefined) resolve()
      else reject(error)
    }
  })

  const onAbort = (): void => {
    release(new Error('oauth login cancelled before the provider returned a URL'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const interaction = {
    prompt: async (prompt: {
      type: string
      message: string
      placeholder?: string
      options?: readonly { id: string, label: string, description?: string }[]
    }): Promise<string> => {
      // Web / slash-command has no stdin. Auto-pick select menus so providers
      // like openai-codex (browser vs device code) can continue to a URL/code.
      if (prompt.type === 'select' && prompt.options !== undefined && prompt.options.length > 0) {
        const preferred = pickSelectOption(provider, prompt.options)
        lines.push(
          `${prompt.message} → ${preferred.label} (${preferred.id})`,
        )
        return preferred.id
      }
      // github-copilot: optional Enterprise URL — blank means github.com.
      const optionalText = answerOptionalTextPrompt(provider, prompt)
      if (optionalText !== undefined) {
        lines.push(
          optionalText.length === 0
            ? `${prompt.message} → (default / blank)`
            : `${prompt.message} → ${optionalText}`,
        )
        return optionalText
      }
      throw new Error(
        `Interactive prompt required (${prompt.type}: ${prompt.message}`
        + `${prompt.placeholder ? ` / ${prompt.placeholder}` : ''}). `
        + `This provider cannot finish from Settings / /oauth; run: `
        + `node <profile>/node_modules/dsh-llm-oauth/bin/login.mjs ${provider}`,
      )
    },
    notify: (event: {
      type: string
      message?: string
      url?: string
      instructions?: string
      verificationUri?: string
      userCode?: string
    }): void => {
      lines.push(...formatEvent(event))
      if (event.type === 'auth_url' && event.url) {
        watch.openUrl = event.url
      }
      if (event.type === 'device_code') {
        if (event.verificationUri) watch.openUrl = event.verificationUri
        if (event.userCode) watch.userCode = event.userCode
      }
      if (isLoginNotice(event.type)) release()
    },
  }

  const finished = adapter.login(provider, interaction).then(
    () => {
      watch.status = 'ok'
      watch.detail = `Logged in to ${provider}. Tokens stored in ${adapter.authPath()}.`
    },
    (error: unknown) => {
      watch.status = 'error'
      watch.detail = error instanceof Error ? error.message : String(error)
      release(error instanceof Error ? error : new Error(watch.detail))
    },
  )

  try {
    await firstNotice
  } catch (error) {
    signal?.removeEventListener('abort', onAbort)
    return {
      kind: 'error',
      text: [watch.detail ?? (error instanceof Error ? error.message : String(error)), ...lines].join('\n'),
      ...resultExtras(watch),
    }
  }
  signal?.removeEventListener('abort', onAbort)

  // Keep the poll alive after this command returns.
  void finished

  if (watch.status === 'ok') {
    return {
      kind: 'success',
      text: watch.detail ?? `Logged in to ${provider}.`,
      ...resultExtras(watch),
    }
  }
  return { kind: 'success', text: waitingText(watch), ...resultExtras(watch) }
}

/**
 * Execute `/oauth` against the live adapter.
 * @param adapter - registered OAuth adapter.
 * @param rawInput - text after the command name.
 * @param signal - UI request cancellation; only aborts waiting for the first URL.
 */
export async function handleOauthCommand(
  adapter: OAuthControlAdapter,
  rawInput: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  const action = (parts[0] ?? 'status').toLowerCase()
  const target = parts[1]
  const catalog = typeof adapter.catalogIds === 'function' ? adapter.catalogIds() : adapter.routeIds()

  if (action === 'help' || action === '-h' || action === '--help') {
    return { kind: 'success', text: usageText(adapter.authPath()) }
  }

  if (action === 'list') {
    const rows = ['OAuth catalog owned by this plugin:']
    for (const id of catalog) {
      const auth = await adapter.checkAuth(id)
      rows.push(`  ${id.padEnd(20)} ${auth === undefined ? 'not logged in' : `${auth.type}${auth.source ? ` (${auth.source})` : ''}`}`)
    }
    rows.push('', 'Enable a provider with `/oauth enable <id>` or Settings → OAuth / 订阅.')
    return { kind: 'success', text: rows.join('\n') }
  }

  if (action === 'status') {
    const rows = [`Auth file: ${adapter.authPath()}`, '']
    for (const id of catalog) {
      const auth = await adapter.checkAuth(id)
      const watch = watches.get(id)
      const login = auth === undefined ? 'not logged in' : `ok (${auth.type}${auth.source ? `, ${auth.source}` : ''})`
      const extra = watch === undefined
        ? ''
        : watch.status === 'waiting'
          ? ' — browser login in progress'
          : watch.status === 'error'
            ? ` — last login error: ${watch.detail ?? 'failed'}`
            : ' — last login finished'
      rows.push(`${id}: ${login}${extra}`)
    }
    rows.push('', 'Tip: only enabled providers list models. Use /oauth enable <id> or the Settings panel.')
    return { kind: 'success', text: rows.join('\n') }
  }

  if (action === 'logout') {
    if (target === undefined) return { kind: 'error', text: 'Usage: /oauth logout <provider>' }
    try {
      watches.delete(target)
      await adapter.logout(target)
      return { kind: 'success', text: `Logged out ${target}.` }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  if (action === 'login') {
    if (target === undefined) {
      return { kind: 'error', text: 'Usage: /oauth login <provider>' }
    }
    return startLogin(adapter, target, signal)
  }

  // enable/disable are handled in runtime when settings exist; keep a clear error here.
  if (action === 'enable' || action === 'disable') {
    return {
      kind: 'error',
      text: `/${action} is handled by the plugin runtime. If you see this, settings may be unavailable.\n\n${usageText(adapter.authPath())}`,
    }
  }

  return { kind: 'error', text: `Unknown action "${action}".\n\n${usageText(adapter.authPath())}` }
}
