import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { CLIENT_CONFIG_KEY, Config } from '../src/config.ts'
import { AssistantPanel, type AssistantPanelInjected, type RightbarPresentation } from '../src/client/AssistantPanel.tsx'
import { AssistantSessionBridge, type AssistantSessionBridgeInjected } from '../src/client/AssistantSessionBridge.tsx'
import { AssistantBrandMark, AssistantToggle, type AssistantToggleInjected } from '../src/client/AssistantToggle.tsx'
import { ReceiptBadge, type ReceiptBadgeInjected } from '../src/client/ReceiptBadge.tsx'
import { NOCTURNE_TOKENS } from '../src/client/theme.ts'
import { en, zh } from '../src/client/locales.ts'
import { buildAssistantSessionView } from '../src/client/sessionView.ts'

interface RecordedEntry {
  readonly name: string
  readonly id?: string
  readonly order?: number
  readonly priority?: number
  readonly locale?: string
  readonly store?: unknown
  readonly inject?: (...args: never[]) => unknown
  readonly component: unknown
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function boot(config = Config({ maxActivities: 3, defaultTab: 'memory' })) {
  vi.stubGlobal(CLIENT_CONFIG_KEY, config)
  const ctx = new Context()
  contexts.push(ctx)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 1, enabled: false, paused: false, running: false, items: [] }))))
  const registered: RecordedEntry[] = []
  const slots = {
    inject: vi.fn((_name: string, install: () => (() => void) | Iterable<() => void>) => {
      const dispose = install()
      const disposers = typeof dispose === 'function' ? [dispose] : [...dispose]
      return () => {
        for (const teardown of disposers.reverse()) teardown()
      }
    }),
    register: vi.fn((options: Omit<RecordedEntry, 'component'>, component: unknown) => {
      const entry = { ...options, component }
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index !== -1) registered.splice(index, 1)
      }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    register: vi.fn((namespace: string, dicts: unknown) => {
      dictionaries.set(namespace, dicts)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  const layout = {
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
    selectPanel: vi.fn(),
    toggleSidebar: vi.fn(),
  }
  const theme = {
    overrideTokens: vi.fn(() => vi.fn()),
  }
  let connectionState = 'connected'
  const connectionListeners = new Set<() => void>()
  const connection = {
    state: {
      getSnapshot: () => connectionState,
      subscribe: (listener: () => void) => { connectionListeners.add(listener); return () => { connectionListeners.delete(listener) } },
    },
    set: (state: string) => { connectionState = state; for (const listener of connectionListeners) listener() },
  }
  const uiWorkspace = {
    openSession: vi.fn(),
  }
  const reactionPolicies: object[] = []
  const chatReactions = {
    register: vi.fn((policy: object) => {
      reactionPolicies.push(policy)
      return () => { reactionPolicies.splice(reactionPolicies.indexOf(policy), 1) }
    }),
  }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('layout', layout as never)
  ctx.provide('theme', theme as never)
  ctx.provide('connection', connection as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('chatReactions', chatReactions as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { registered, dictionaries, layout, theme, connection, uiWorkspace, reactionPolicies, fiber }
}

function entry(entries: readonly RecordedEntry[], name: string): RecordedEntry {
  const found = entries.find(candidate => candidate.name === name)
  if (found === undefined) throw new Error(`expected ${name} registration`)
  return found
}

describe('wa-ui apply', () => {
  it('rejects a missing Host boot value before registering effects', async () => {
    vi.stubGlobal(CLIENT_CONFIG_KEY, undefined)
    const ctx = new Context()
    const effect = vi.spyOn(ctx, 'effect')
    try {
      expect(() => apply(ctx)).toThrow('public display configuration is missing')
      expect(effect).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates public boot fields before registering effects', async () => {
    vi.stubGlobal(CLIENT_CONFIG_KEY, { maxActivities: 0 })
    const ctx = new Context()
    const effect = vi.spyOn(ctx, 'effect')
    try {
      expect(() => apply(ctx)).toThrow()
      expect(effect).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('declares the services it reads and validates config', () => {
    expect(inject).toEqual(['slots', 'locale', 'layout', 'connection', 'uiWorkspace', 'theme', 'chatReactions'])
    expect(Config({}).maxActivities).toBe(6)
    expect(Config({}).defaultTab).toBe('timeline')
    expect(Config({}).receipt).toBeUndefined()
    expect(Config({ defaultTab: 'day' }).defaultTab).toBe('day')
    expect(() => Config({ maxActivities: 0 })).toThrow()
    expect(() => Config({ defaultTab: 'other' as never })).toThrow()
    expect(() => Config({ receipt: { presetIds: ['personal-assistant'] } as never })).toThrow()
    expect(() => Config({ receipt: { style: 'neutral' } as never })).toThrow()
    expect(() => Config({ receipt: { presetIds: ['personal-assistant'], style: 'approved' as never } })).toThrow()
  })

  it('registers dictionaries, theme tokens, the rightbar, sidebar entries, and Session bridge', async () => {
    const { registered, dictionaries, layout, theme } = await boot()
    expect(dictionaries.get('waAssistant')).toEqual({ zh, en })
    expect(theme.overrideTokens).toHaveBeenCalledWith('wa-nocturne', NOCTURNE_TOKENS)
    expect(registered.map(item => [
      item.name,
      item.id,
      item.order,
      item.priority,
      item.locale,
      item.component,
    ])).toEqual([
      ['rightbar', undefined, undefined, -100, 'waAssistant', AssistantPanel],
      ['sidebar.footer.action', 'wa-assistant-toggle', 90, undefined, 'waAssistant', AssistantToggle],
      ['sidebar.brand.mark', undefined, undefined, -100, undefined, AssistantBrandMark],
      ['conversation.session.header.corner', undefined, undefined, -100, undefined, AssistantSessionBridge],
    ])
    expect(entry(registered, 'rightbar').store).toBe(entry(registered, 'sidebar.footer.action').store)
    expect(entry(registered, 'conversation.session.header.corner').store).toBeUndefined()
    expect(entry(registered, 'conversation.session.header.corner').inject).toEqual(expect.any(Function))
    expect(layout.openRightbar).toHaveBeenCalledWith(true, false)
  })

  it('adds one policy-owned receipt contribution without replacing message renderers', async () => {
    const { registered, reactionPolicies, fiber } = await boot(Config({
      receipt: { presetIds: ['personal-assistant'], style: 'thumbs-up' },
    }))
    const receipt = entry(registered, 'conversation.chat.user-badges')
    expect(receipt.component).toBe(ReceiptBadge)
    expect(receipt.id).toBe('wa-assistant-receipt')
    expect((receipt.inject?.() as ReceiptBadgeInjected).policy).toEqual({
      presetIds: ['personal-assistant'], style: 'thumbs-up',
    })
    expect(registered.filter(item => item.name === 'conversation.chat.node')).toEqual([])
    expect(reactionPolicies).toEqual([{ presetIds: ['personal-assistant'], emoji: '\u{1f44d}' }])
    await fiber.dispose()
    expect(registered).toEqual([])
    expect(reactionPolicies).toEqual([])
  })

  it('does not wait for or occupy the badge slot when receipts are off', async () => {
    const { registered, reactionPolicies, fiber } = await boot(Config({
      receipt: { presetIds: ['personal-assistant'], style: 'off' },
    }))
    expect(registered.some(item => item.name === 'conversation.chat.user-badges')).toBe(false)
    expect(reactionPolicies).toEqual([])
    await fiber.dispose()
  })

  it('injects connection state, root Session view source, layout reporting, Session navigation, clipboard copy, and sidebar actions', async () => {
    const { registered, layout, connection, uiWorkspace } = await boot()
    const panel = entry(registered, 'rightbar').inject?.() as AssistantPanelInjected
    expect(panel.maxActivities).toBe(3)
    expect(panel.hooks.connectionState).toBe(connection.state)
    expect(panel.hooks.sessionView.getSnapshot()).toBeNull()
    const sessionView = buildAssistantSessionView('session-1' as never, [])
    const onSessionView = vi.fn()
    const unsubscribe = panel.hooks.sessionView.subscribe(onSessionView)
    const bridge = entry(registered, 'conversation.session.header.corner').inject?.('session-1' as never) as AssistantSessionBridgeInjected
    bridge.publishSessionView(sessionView)
    expect(panel.hooks.sessionView.getSnapshot()).toBe(sessionView)
    expect(onSessionView).toHaveBeenCalledTimes(1)
    bridge.clearSessionView('session-1' as never)
    expect(panel.hooks.sessionView.getSnapshot()).toBeNull()
    expect(onSessionView).toHaveBeenCalledTimes(2)
    unsubscribe()
    panel.reportPresentation({ shown: true, track: false, fullscreen: true } satisfies RightbarPresentation)
    expect(layout.openRightbar).toHaveBeenLastCalledWith(false, true)
    panel.reportPresentation({ shown: false, track: false, fullscreen: false } satisfies RightbarPresentation)
    expect(layout.closeRightbar).toHaveBeenCalledOnce()
    panel.openSession('session-1' as never)
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session-1')

    uiWorkspace.openSession.mockClear()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(panel.copyPrompt('Show my calendar')).resolves.toBeUndefined()
    expect(writeText).toHaveBeenCalledWith('Show my calendar')
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()

    const toggle = entry(registered, 'sidebar.footer.action').inject?.() as AssistantToggleInjected
    toggle.revealConversation()
    expect(layout.selectPanel).toHaveBeenCalledWith(null)
    toggle.collapseSidebarOnce()
    expect(layout.toggleSidebar).toHaveBeenCalled()
  })

  it('refreshes verified Inbox state after reconnect and disposes its source', async () => {
    const { registered, connection, fiber } = await boot()
    const panel = entry(registered, 'rightbar').inject?.() as AssistantPanelInjected
    const source = panel.hooks.briefing
    if (source.getSnapshot().status === 'loading') await new Promise<void>(resolve => {
      const unsubscribe = source.subscribe(() => { if (source.getSnapshot().status !== 'loading') { unsubscribe(); resolve() } })
    })
    const fetch = vi.mocked(globalThis.fetch)
    const before = fetch.mock.calls.length
    connection.set('disconnected')
    expect(fetch.mock.calls).toHaveLength(before)
    connection.set('connected')
    await new Promise<void>(resolve => {
      const unsubscribe = source.subscribe(() => { unsubscribe(); resolve() })
    })
    expect(fetch.mock.calls).toHaveLength(before + 1)
    await panel.actOnBriefing({ action: 'pause' })
    await panel.refreshBriefing()
    expect(fetch.mock.calls).toHaveLength(before + 3)
    await fiber.dispose()
    connection.set('connected')
    await source.refresh()
    expect(fetch.mock.calls).toHaveLength(before + 3)
  })

  it('propagates clipboard failures without navigating or mutating Sessions', async () => {
    const { registered, uiWorkspace } = await boot()
    const panel = entry(registered, 'rightbar').inject?.() as AssistantPanelInjected
    const writeText = vi.fn(async () => { throw new Error('denied') })
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await expect(panel.copyPrompt('Show my calendar')).rejects.toThrow('denied')
    expect(writeText).toHaveBeenCalledWith('Show my calendar')
    expect(uiWorkspace.openSession).not.toHaveBeenCalled()
  })

  it('removes registrations, dictionaries, theme tokens, and the rightbar track when the plugin fiber unloads', async () => {
    const { registered, dictionaries, fiber, layout, theme } = await boot()
    const disposeTheme = theme.overrideTokens.mock.results[0]?.value as () => void
    await fiber.dispose()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
    expect(disposeTheme).toHaveBeenCalled()
    expect(layout.closeRightbar).toHaveBeenCalled()
  })
})
