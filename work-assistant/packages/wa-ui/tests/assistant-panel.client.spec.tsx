// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type { ConversationNode, ConversationSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { groupActivities, recentPersonalAssistantRows } from '../src/client/activity.ts'
import { AssistantPanel, type AssistantPanelProps } from '../src/client/AssistantPanel.tsx'
import { AssistantSessionBridge } from '../src/client/AssistantSessionBridge.tsx'
import { AssistantBrandMark, AssistantToggle, type AssistantToggleProps } from '../src/client/AssistantToggle.tsx'
import { en } from '../src/client/locales.ts'
import { buildAssistantSessionView, createAssistantSessionViewSource } from '../src/client/sessionView.ts'
import { createAssistantPanelStore } from '../src/client/store.ts'
import type { BriefingAction, BriefingView } from '../src/client/briefing.ts'
import type { BriefingItem } from '../../wa-briefing/src/inbox.ts'

interface Source<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

const unusedHook = (() => { throw new Error('unused standard hook was read') }) as never
const emptyWorkspacesHook = ((selector: (snapshot: unknown) => unknown) => selector({})) as never

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function source<T>(initial: T): Source<T> {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (value) => {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function selectorHook<T>(observable: Pick<Source<T>, 'getSnapshot' | 'subscribe'>) {
  return function useSelector<S>(selector: (snapshot: T) => S): S {
    return selector(useSyncExternalStore(observable.subscribe, observable.getSnapshot))
  }
}

function t(key: Parameters<AssistantPanelProps['t']>[0], params?: Record<string, unknown>): string {
  return ((en as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name: string) => String(params?.[name] ?? ''))
}

function summary(id: string, overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: Date.UTC(2026, 8, 17, 16, 0),
    projectionValues: { agentPreset: 'personal-assistant' } as SessionSummary['projectionValues'],
    ...overrides,
  }
}

function listState(rows: readonly SessionSummary[], options: {
  readonly current?: SessionId
  readonly phase?: SessionListState['phase']
} = {}): SessionListState {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])) as Record<SessionId, SessionSummary>,
    current: options.current,
    phase: options.phase ?? 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function pendingInteraction(sessionId: SessionId, overrides: Partial<SessionPendingInteraction> & Record<string, unknown>): SessionPendingInteraction {
  return {
    key: `${String(sessionId)}-pending`,
    kind: 'approval',
    sessionId,
    ...overrides,
  } as SessionPendingInteraction
}

function mountAssistant(options: {
  readonly sessions?: SessionListState
  readonly pending?: ReadonlyMap<SessionId, SessionPendingInteraction>
  readonly connection?: ConnectionState
  readonly canShow?: boolean
  readonly width?: number
  readonly viewportWidth?: number
  readonly wide?: boolean
  readonly maxActivities?: number
  readonly copyPrompt?: (text: string) => Promise<void>
  readonly defaultTab?: 'timeline' | 'queue' | 'day' | 'memory' | 'inbox'
  readonly briefing?: BriefingView
  readonly actOnBriefing?: (action: BriefingAction) => Promise<void>
} = {}) {
  const store = createAssistantPanelStore(options.defaultTab).create()
  const sessions = source(options.sessions ?? listState([]))
  const pending = source(options.pending ?? new Map<SessionId, SessionPendingInteraction>())
  const connection = source<ConnectionState | undefined>(options.connection)
  const sessionView = createAssistantSessionViewSource()
  const briefing = source<BriefingView>(options.briefing ?? { data: null, status: 'loading', busy: false })
  const actOnBriefing = vi.fn(options.actOnBriefing ?? (async () => {}))
  const refreshBriefing = vi.fn(async () => {})
  const panelInfo = source({ activePanelId: null })
  const reportPresentation = vi.fn()
  const openSession = vi.fn()
  const copyPrompt = vi.fn(options.copyPrompt ?? (async () => {}))
  const revealConversation = vi.fn(() => { panelInfo.set({ activePanelId: null }) })
  const collapseSidebarOnce = vi.fn()
  let owner = {
    width: options.width ?? 560,
    viewportWidth: options.viewportWidth ?? 1280,
    canShow: options.canShow ?? true,
    wide: options.wide ?? true,
  }
  const renderSurface = () => (
    <>
      <AssistantToggle
        wide={owner.wide}
        useBriefing={selectorHook(briefing)}
        useStore={selectorHook(store)}
        actions={store.actions}
        usePanelInfo={selectorHook(panelInfo)}
        useSessions={selectorHook(sessions)}
        useSessionPendingInteraction={selectorHook(pending)}
        useWorkspaces={emptyWorkspacesHook}
        revealConversation={revealConversation}
        collapseSidebarOnce={collapseSidebarOnce}
        t={t}
      />
      <AssistantPanel
        width={owner.width}
        viewportWidth={owner.viewportWidth}
        canShow={owner.canShow}
        useStore={selectorHook(store)}
        actions={store.actions}
        usePanelInfo={selectorHook(panelInfo)}
        useSessions={selectorHook(sessions)}
        useSessionPendingInteraction={selectorHook(pending)}
        useWorkspaces={emptyWorkspacesHook}
        useConnectionState={selectorHook(connection)}
        useSessionView={selectorHook(sessionView)}
        useBriefing={selectorHook(briefing)}
        actOnBriefing={actOnBriefing}
        refreshBriefing={refreshBriefing}
        maxActivities={options.maxActivities ?? 6}
        openSession={openSession}
        copyPrompt={copyPrompt}
        reportPresentation={reportPresentation}
        t={t}
      />
    </>
  )
  const view = render(renderSurface())
  return {
    ...view,
    store,
    sessions,
    pending,
    connection,
    sessionView,
    briefing,
    actOnBriefing,
    refreshBriefing,
    panelInfo,
    reportPresentation,
    openSession,
    copyPrompt,
    revealConversation,
    collapseSidebarOnce,
    updateOwner(next: Partial<typeof owner>) {
      owner = { ...owner, ...next }
      view.rerender(renderSurface())
    },
  }
}

function toolResult(seq: number, name: string, meta: unknown, isError = false): ConversationNode {
  return {
    kind: 'tool-result',
    seq,
    time: Date.UTC(2026, 8, 17, 16, seq),
    callId: `call-${seq}`,
    call: { name, argsRaw: '{}' },
    callTime: Date.UTC(2026, 8, 17, 16, seq - 1),
    content: [],
    isError,
    meta,
    subCalls: [],
  } as ConversationNode
}

function workAssistantMeta(kind: string, value: unknown): unknown {
  return { workAssistant: { version: 1, kind, value } }
}

function calendarValue(overrides: Record<string, unknown> = {}) {
  return {
    timeZone: 'America/Los_Angeles',
    window: { start: '2026-09-17T16:00:00.000Z', end: '2026-09-18T00:00:00.000Z' },
    count: 1,
    truncated: false,
    events: [{
      id: 'event-1',
      uid: 'uid-1',
      title: 'Design review',
      start: { instant: '2026-09-17T21:00:00.000Z', local: '2026-09-17T14:00:00', timeZone: 'America/Los_Angeles', allDay: false },
      end: { instant: '2026-09-17T22:00:00.000Z', local: '2026-09-17T15:00:00', timeZone: 'America/Los_Angeles', allDay: false },
      durationMinutes: 60,
      allDay: false,
      busy: true,
      location: 'Room 4',
      status: 'confirmed',
      recurring: false,
      override: false,
    }],
    ...overrides,
  }
}

function conversation(nodes: readonly ConversationNode[]): ConversationSnapshot {
  return {
    views: { get: target => target === 'chat' ? { legacy: { nodes } } : undefined },
    activeTargets: new Set(['chat']),
  } as ConversationSnapshot
}

function mountCalendarResult(value: unknown) {
  const current = 'current' as SessionId
  const surface = mountAssistant({
    defaultTab: 'day',
    sessions: listState([summary('current', { displayTitle: 'Current' })], { current }),
  })
  act(() => {
    surface.sessionView.setSessionView(buildAssistantSessionView(current, [
      toolResult(1, 'calendar_list', workAssistantMeta('calendar-list', value)),
    ]))
  })
  return surface
}

const briefingItem = {
  id: 'briefing-1', sessionId: 'briefing-1', messageId: 'message-1', createdAt: '2026-03-01T08:00:00.000Z',
  text: 'Your planning meeting starts soon. Would you like to prepare?', read: false, dismissed: false,
} as BriefingItem

function inboxView(overrides: Partial<BriefingView['data'] & object> = {}): BriefingView {
  return { status: 'ready', busy: false, data: { version: 1, enabled: true, paused: false, running: false, items: [briefingItem], ...overrides } }
}

describe('proactive Inbox panel', () => {
  it('announces unread messages without navigating or marking them read on render', () => {
    const surface = mountAssistant({ briefing: inboxView() })
    expect(screen.getByRole('button', { name: /^Inbox: 1 unread/u })).toBeTruthy()
    expect(surface.openSession).not.toHaveBeenCalled()
    expect(surface.actOnBriefing).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^Inbox: 1 unread/u }))
    expect(screen.getByRole('tabpanel').id).toBe('wa-assistant-inbox')
    expect(screen.getAllByText(briefingItem.text).length).toBeGreaterThan(0)
    expect(screen.getByText('Unread')).toBeTruthy()
    expect(screen.getByText(/Your opted-in scheduled briefing/u)).toBeTruthy()
  })

  it('opens only after read state is committed, while mark-read and dismiss never navigate', async () => {
    const gate = Promise.withResolvers<void>()
    const surface = mountAssistant({ defaultTab: 'inbox', briefing: inboxView(), actOnBriefing: () => gate.promise })
    fireEvent.click(screen.getByRole('button', { name: 'Open and reply' }))
    expect(surface.openSession).not.toHaveBeenCalled()
    await act(async () => { gate.resolve(); await gate.promise })
    expect(surface.actOnBriefing).toHaveBeenCalledWith({ action: 'read', id: briefingItem.id })
    expect(surface.openSession).toHaveBeenCalledWith(briefingItem.sessionId)
    surface.openSession.mockClear()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Mark read' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })) })
    expect(surface.actOnBriefing).toHaveBeenLastCalledWith({ action: 'dismiss', id: briefingItem.id })
    expect(surface.openSession).not.toHaveBeenCalled()
  })

  it('keeps rejected open operations in place and exposes verified error state', async () => {
    const surface = mountAssistant({ defaultTab: 'inbox', briefing: inboxView(), actOnBriefing: async () => { throw new Error('offline') } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open and reply' })) })
    expect(surface.openSession).not.toHaveBeenCalled()
    act(() => surface.briefing.set({ ...inboxView(), status: 'error' }))
    expect(screen.getByRole('alert').textContent).toContain('Refresh to confirm saved state')
    expect((screen.getByRole('button', { name: 'Pause proactive briefings' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getAllByText(briefingItem.text).length).toBeGreaterThan(0)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh Inbox' })) })
    expect(surface.refreshBriefing).toHaveBeenCalledOnce()
  })

  it('renders loading, disabled, paused, running, and empty states without claiming delivery', async () => {
    const surface = mountAssistant({ defaultTab: 'inbox' })
    expect(screen.getByText('Loading Inbox…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pause proactive/u })).toBeNull()
    act(() => surface.briefing.set(inboxView({ enabled: false, items: [] })))
    expect(screen.getByText(/Proactive briefings are not enabled/u)).toBeTruthy()
    expect(screen.getByText('No briefing messages yet.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pause proactive/u })).toBeNull()
    act(() => surface.briefing.set(inboxView({ paused: true, running: true, items: [{ ...briefingItem, read: true }] })))
    expect(screen.getByText('Preparing a briefing…')).toBeTruthy()
    expect(screen.getByText(/Saved messages remain available/u)).toBeTruthy()
    expect(screen.queryByText('Unread')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resume proactive briefings' })) })
    expect(surface.actOnBriefing).toHaveBeenLastCalledWith({ action: 'resume' })
    act(() => surface.briefing.set(inboxView({ items: [] })))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause proactive briefings' })) })
    expect(surface.actOnBriefing).toHaveBeenLastCalledWith({ action: 'pause' })
    expect(surface.copyPrompt).not.toHaveBeenCalled()
  })

  it('retains unread indication while collapsed and previews latest message on other tabs', () => {
    const surface = mountAssistant({ briefing: inboxView(), wide: false })
    expect(screen.getByText(briefingItem.text)).toBeTruthy()
    fireEvent.click(screen.getByTestId('wa-assistant-toggle'))
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show assistant panel · Inbox: 1 unread' }).textContent).toContain('1')
    act(() => surface.briefing.set(inboxView({ items: [{ ...briefingItem, read: true }] })))
    expect(screen.getByRole('button', { name: 'Show assistant panel' })).toBeTruthy()
    expect(surface.actOnBriefing).not.toHaveBeenCalled()
  })

  it('disables all Inbox actions while a mutation is pending', () => {
    mountAssistant({ defaultTab: 'inbox', briefing: { ...inboxView(), busy: true } })
    for (const name of ['Refresh Inbox', 'Pause proactive briefings', 'Open and reply', 'Mark read', 'Dismiss']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})

describe('AssistantPanel', () => {
  it('renders Nocturne identity, tabs, and DSH connection states without sign-in claims', () => {
    const surface = mountAssistant({ connection: 'connected' })
    expect(screen.getByRole('heading', { name: 'Harness' })).toBeTruthy()
    expect(screen.getByText('Calendar and memory')).toBeTruthy()
    expect(screen.getByText('Connected to DSH')).toBeTruthy()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Timeline', 'Queue', 'Day', 'Memory', 'Inbox'])
    act(() => { surface.connection.set(undefined) })
    expect(screen.getByText('Checking DSH connection')).toBeTruthy()
    act(() => { surface.connection.set('connecting') })
    expect(screen.getByText('Connecting to DSH')).toBeTruthy()
    act(() => { surface.connection.set('disconnected') })
    expect(screen.getByText('Disconnected from DSH')).toBeTruthy()
    expect(screen.queryByText(/signed in/iu)).toBeNull()
  })

  it('supports keyboard tab selection and keeps each panel addressable', () => {
    mountAssistant()
    const tabs = screen.getAllByRole('tab')
    tabs[0]?.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Queue' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tabpanel').id).toBe('wa-assistant-queue')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Queue' }), { key: 'End' })
    expect(screen.getByRole('tab', { name: 'Inbox' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Day' }))
    expect(screen.getByRole('tabpanel').id).toBe('wa-assistant-day')
  })

  it('shows honest pending and empty activity states', () => {
    const surface = mountAssistant({ sessions: listState([], { phase: 'pending' }) })
    expect(screen.getByText('Loading personal-assistant conversations…')).toBeTruthy()
    act(() => { surface.sessions.set(listState([])) })
    expect(screen.getByText('No recent personal-assistant conversations yet.')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('sorts, filters, groups, bounds, and navigates real SessionSummary rows', () => {
    const current = 'current' as SessionId
    const rows = [
      summary('blank', { blank: true, displayTitle: 'Blank draft', updatedAt: Date.UTC(2026, 8, 17, 19, 0) }),
      summary('other', {
        displayTitle: 'Other preset',
        updatedAt: Date.UTC(2026, 8, 17, 18, 0),
        projectionValues: { agentPreset: 'headless' } as SessionSummary['projectionValues'],
      }),
      summary('current', {
        displayTitle: 'Inbox triage',
        running: true,
        updatedAt: Date.UTC(2026, 8, 17, 20, 0),
      }),
      summary('finished', {
        displayTitle: 'Calendar planning',
        completed: true,
        updatedAt: Date.UTC(2026, 8, 16, 17, 0),
      }),
      summary('idle', {
        displayTitle: 'Memory review',
        updatedAt: Date.UTC(2026, 8, 17, 18, 30),
      }),
    ]
    const state = listState(rows, { current })
    expect(recentPersonalAssistantRows(state, 3)).toMatchInlineSnapshot(`
      [
        {
          "id": "current",
          "selected": true,
          "status": "running",
          "title": "Inbox triage",
          "updatedAt": 1789675200000,
        },
        {
          "id": "idle",
          "selected": false,
          "status": "idle",
          "title": "Memory review",
          "updatedAt": 1789669800000,
        },
        {
          "id": "finished",
          "selected": false,
          "status": "finished",
          "title": "Calendar planning",
          "updatedAt": 1789578000000,
        },
      ]
    `)
    expect(groupActivities(recentPersonalAssistantRows(state, 3), Date.UTC(2026, 8, 17, 23, 0)).map(group => [group.label, group.rows.map(row => row.id)])).toEqual([
      ['today', ['current', 'idle']],
      ['yesterday', ['finished']],
    ])
    const surface = mountAssistant({ sessions: state, maxActivities: 3 })
    const buttons = screen.getAllByTestId('wa-assistant-activity-row')
    expect(buttons.map(button => button.textContent)).toEqual([
      expect.stringContaining('Inbox triage'),
      expect.stringContaining('Memory review'),
      expect.stringContaining('Calendar planning'),
    ])
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('Running')).toBeTruthy()
    expect(screen.getByText('Idle')).toBeTruthy()
    expect(screen.getByText('Finished')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open Memory review/iu }))
    expect(surface.openSession).toHaveBeenCalledWith('idle')
  })

  it('shows pending interactions and running conversations without answering approvals', () => {
    const current = 'current' as SessionId
    const other = 'other' as SessionId
    const waiting = pendingInteraction(current, { toolName: 'memory_write', reason: 'Approve writing one personal memory note' })
    const asking = pendingInteraction(other, { kind: 'ask-user', question: 'Which note should I read?' })
    const surface = mountAssistant({
      defaultTab: 'queue',
      sessions: listState([
        summary('current', { displayTitle: 'Memory write', running: true }),
        summary('other', { displayTitle: 'Clarify note', running: false }),
        summary('running', { displayTitle: 'Calendar lookup', running: true }),
      ], { current }),
      pending: new Map([[current, waiting], [other, asking]]),
    })
    expect(screen.getByText('Waiting on you')).toBeTruthy()
    expect(screen.getByText('memory_write needs approval')).toBeTruthy()
    expect(screen.getByText('Approve writing one personal memory note')).toBeTruthy()
    expect(screen.getByText('Which note should I read?')).toBeTruthy()
    expect(screen.getByText('Running now')).toBeTruthy()
    expect(screen.getByText('Calendar lookup')).toBeTruthy()
    expect(screen.queryByText('Memory write', { selector: 'li *' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review memory_write needs approval' }))
    expect(surface.openSession).toHaveBeenCalledWith(current)
  })

  it('keeps long titles readable through the title attribute', () => {
    const title = 'Quarterly planning conversation with a deliberately long agenda title that must not stretch the panel'
    mountAssistant({ sessions: listState([summary('long', { displayTitle: title })]) })
    expect(screen.getByText(title).getAttribute('title')).toBe(title)
  })

  it('renders current-session calendar and memory metadata and hides stale selections', () => {
    const current = 'current' as SessionId
    const view = buildAssistantSessionView(current, [
      toolResult(1, 'calendar_list', workAssistantMeta('calendar-list', calendarValue())),
      toolResult(2, 'memory_read', workAssistantMeta('memory-read', { note: 'profile.md', exists: true, revision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', content: 'Keep summaries concise\nNever paste transcripts.' })),
      toolResult(3, 'memory_list', workAssistantMeta('memory-list', { notes: [{ note: 'profile.md', revision: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }], truncated: false })),
      toolResult(4, 'memory_write', workAssistantMeta('memory-write', { note: 'decisions.md', revision: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', commit: 'abc', contentBytes: 42 })),
    ])
    const surface = mountAssistant({
      defaultTab: 'day',
      sessions: listState([summary('current', { displayTitle: 'Current' }), summary('other', { displayTitle: 'Other' })], { current }),
    })
    act(() => { surface.sessionView.setSessionView(view) })
    expect(screen.getByText('Design review')).toBeTruthy()
    expect(screen.getByText(/Room 4/iu)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(screen.getByText('profile.md')).toBeTruthy()
    expect(screen.getByText(/Revision sha256:bbbb/iu)).toBeTruthy()
    expect(screen.queryByText('Keep summaries concise')).toBeNull()
    expect(screen.getByText('decisions.md')).toBeTruthy()
    expect(screen.getByText('Stored 42 bytes; the tool result does not include the full content.')).toBeTruthy()
    act(() => { surface.sessions.set(listState([summary('current', { displayTitle: 'Current' }), summary('other', { displayTitle: 'Other' })], { current: 'other' as SessionId })) })
    expect(screen.getByText('Open a personal-assistant conversation to see memory results recorded there.')).toBeTruthy()
  })

  it('formats calendar windows in the recorded time zone and dates multi-day rows', () => {
    const current = 'current' as SessionId
    const view = buildAssistantSessionView(current, [
      toolResult(1, 'calendar_list', workAssistantMeta('calendar-list', calendarValue({
        timeZone: 'Pacific/Kiritimati',
        window: { start: '2026-09-17T16:00:00.000Z', end: '2026-09-19T16:00:00.000Z' },
        events: [
          {
            id: 'event-1',
            uid: 'uid-1',
            title: 'Morning plan',
            start: { instant: '2026-09-17T19:30:00.000Z', local: '2026-09-18T09:30:00', timeZone: 'Pacific/Kiritimati', allDay: false },
            end: { instant: '2026-09-17T20:15:00.000Z', local: '2026-09-18T10:15:00', timeZone: 'Pacific/Kiritimati', allDay: false },
            durationMinutes: 45,
            allDay: false,
            busy: true,
            location: 'Room 4',
            status: 'confirmed',
            recurring: false,
            override: false,
          },
          {
            id: 'event-2',
            uid: 'uid-2',
            title: 'Next day review',
            start: { instant: '2026-09-18T21:00:00.000Z', local: '2026-09-19T11:00:00', timeZone: 'Pacific/Kiritimati', allDay: false },
            end: { instant: '2026-09-18T21:30:00.000Z', local: '2026-09-19T11:30:00', timeZone: 'Pacific/Kiritimati', allDay: false },
            durationMinutes: 30,
            allDay: false,
            busy: true,
            status: 'confirmed',
            recurring: false,
            override: false,
          },
        ],
      }))),
    ])
    const surface = mountAssistant({
      defaultTab: 'day',
      sessions: listState([summary('current', { displayTitle: 'Current' })], { current }),
    })
    act(() => { surface.sessionView.setSessionView(view) })
    expect(screen.getByText(/Pacific\/Kiritimati.*Sep 18.*Sep 20/u)).toBeTruthy()
    expect(screen.getByText('Sep 18, 09:30–10:15')).toBeTruthy()
    expect(screen.getByText('Sep 19, 11:00–11:30')).toBeTruthy()
  })

  it('formats real space-separated timed local datetimes', () => {
    mountCalendarResult(calendarValue({
      timeZone: 'UTC',
      window: { start: '2026-09-18T00:00:00.000Z', end: '2026-09-19T00:00:00.000Z' },
      events: [{
        id: 'space-time',
        uid: 'space-time',
        title: 'Space separated event',
        start: { instant: '2026-09-18T09:30:00.000Z', local: '2026-09-18 09:30:00', timeZone: 'UTC', allDay: false },
        end: { instant: '2026-09-18T10:15:00.000Z', local: '2026-09-18 10:15:00', timeZone: 'UTC', allDay: false },
        durationMinutes: 45,
        allDay: false,
        busy: false,
        status: 'confirmed',
        recurring: false,
        override: false,
      }],
    }))
    expect(screen.getByText('09:30–10:15', { selector: 'time' })).toBeTruthy()
  })

  it('keeps one-day all-day events date-free in a single-day window', () => {
    mountCalendarResult(calendarValue({
      timeZone: 'UTC',
      window: { start: '2026-09-18T00:00:00.000Z', end: '2026-09-19T00:00:00.000Z' },
      events: [{
        id: 'single-all-day',
        uid: 'single-all-day',
        title: 'Focus Friday',
        start: { instant: '2026-09-18T00:00:00.000Z', local: '2026-09-18', timeZone: 'UTC', allDay: true },
        end: { instant: '2026-09-19T00:00:00.000Z', local: '2026-09-19', timeZone: 'UTC', allDay: true },
        durationMinutes: 1440,
        allDay: true,
        busy: false,
        status: 'confirmed',
        recurring: false,
        override: false,
      }],
    }))
    expect(screen.getByText('All day', { selector: 'time' })).toBeTruthy()
    expect(screen.queryByText(/Sep 18.*All day/u, { selector: 'time' })).toBeNull()
    expect(screen.queryByText(/Sep 19.*All day/u, { selector: 'time' })).toBeNull()
  })

  it('uses the last included local date for multi-day all-day event ranges across DST', () => {
    mountCalendarResult(calendarValue({
      timeZone: 'America/Los_Angeles',
      window: { start: '2026-10-31T07:00:00.000Z', end: '2026-11-03T08:00:00.000Z' },
      events: [{
        id: 'dst-all-day',
        uid: 'dst-all-day',
        title: 'Release focus',
        start: { instant: '2026-10-31T07:00:00.000Z', local: '2026-10-31', timeZone: 'America/Los_Angeles', allDay: true },
        end: { instant: '2026-11-03T08:00:00.000Z', local: '2026-11-03', timeZone: 'America/Los_Angeles', allDay: true },
        durationMinutes: 4320,
        allDay: true,
        busy: false,
        status: 'confirmed',
        recurring: false,
        override: false,
      }],
    }))
    expect(screen.getByText('Oct 31 to Nov 2 · All day', { selector: 'time' })).toBeTruthy()
    expect(screen.queryByText(/Nov 3.*All day/u, { selector: 'time' })).toBeNull()
  })

  it('dates same-day timed rows when the recorded window spans multiple local dates', () => {
    mountCalendarResult(calendarValue({
      timeZone: 'UTC',
      window: { start: '2026-09-18T00:00:00.000Z', end: '2026-09-20T00:00:00.000Z' },
      events: [{
        id: 'multi-window',
        uid: 'multi-window',
        title: 'Multi-window sync',
        start: { instant: '2026-09-18T09:30:00.000Z', local: '2026-09-18T09:30:00', timeZone: 'UTC', allDay: false },
        end: { instant: '2026-09-18T10:15:00.000Z', local: '2026-09-18T10:15:00', timeZone: 'UTC', allDay: false },
        durationMinutes: 45,
        allDay: false,
        busy: false,
        status: 'confirmed',
        recurring: false,
        override: false,
      }],
    }))
    expect(screen.getByText('Sep 18, 09:30–10:15', { selector: 'time' })).toBeTruthy()
    expect(screen.queryByText('09:30–10:15', { selector: 'time' })).toBeNull()
  })

  it('shows malformed, unsupported, and failed recorded data as actionable states', () => {
    const current = 'current' as SessionId
    const surface = mountAssistant({
      defaultTab: 'day',
      sessions: listState([summary('current', { displayTitle: 'Current' })], { current }),
    })
    act(() => {
      surface.sessionView.setSessionView(buildAssistantSessionView(current, [
        toolResult(1, 'calendar_list', workAssistantMeta('calendar-list', { events: [] })),
      ]))
    })
    expect(screen.getByText('Calendar result data in this conversation is malformed.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open transcript' }))
    expect(surface.openSession).toHaveBeenCalledWith(current)
    act(() => {
      surface.sessionView.setSessionView(buildAssistantSessionView(current, [
        toolResult(2, 'calendar_list', undefined, true),
      ]))
    })
    expect(screen.getByText('The calendar tool failed in this conversation.')).toBeTruthy()
    act(() => {
      surface.sessionView.setSessionView(buildAssistantSessionView(current, [
        toolResult(3, 'future_tool', { workAssistant: { version: 2, kind: 'future', value: {} } }),
      ]))
    })
    expect(screen.getByText('This conversation has assistant data this UI cannot read yet.')).toBeTruthy()
  })

  it('supports wraparound, Home, and unrelated keys in the assistant tab strip', () => {
    mountAssistant({ canShow: false })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Timeline' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Inbox' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Inbox' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Queue' }), { key: 'ArrowLeft' })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Inbox' }), { key: 'Home' })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Timeline' }), { key: 'a' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
  })

  it('keeps empty and bounded recorded calendar and memory states explicit', () => {
    const current = 'current' as SessionId
    const surface = mountAssistant({ defaultTab: 'day', maxActivities: 1, sessions: listState([summary('current', {})], { current }) })
    act(() => surface.sessionView.setSessionView(buildAssistantSessionView(current, [])))
    expect(screen.getByText(en['day.empty'])).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(screen.getByText(en['memory.empty'])).toBeTruthy()
    const notes = [
      toolResult(1, 'memory_read', workAssistantMeta('memory-read', { note: 'profile.md', exists: false, revision: null, content: null })),
      toolResult(2, 'memory_read', workAssistantMeta('memory-read', { note: 'decisions.md', exists: true, revision: 'short', content: '' })),
    ]
    act(() => surface.sessionView.setSessionView(buildAssistantSessionView(current, notes)))
    expect(screen.getByText(/first 1 recorded notes/u)).toBeTruthy()
    act(() => surface.sessionView.setSessionView(buildAssistantSessionView(current, [notes[0]!])))
    expect(screen.getByText(en['memory.absent'])).toBeTruthy()
    act(() => surface.sessionView.setSessionView(buildAssistantSessionView(current, [notes[1]!])) )
    expect(screen.getByText('Revision short')).toBeTruthy()
    act(() => surface.sessionView.setSessionView(buildAssistantSessionView(current, [toolResult(3, 'memory_read', workAssistantMeta('memory-read', { note: 'profile.md', exists: true, revision: 'r1', content: 'Concise notes' }))])))
    expect(screen.getByText('Concise notes')).toBeTruthy()
  })

  it.each(['failed', 'malformed', 'unsupported'] as const)('renders the recorded memory %s state', status => {
    const current = 'current' as SessionId
    const surface = mountAssistant({ defaultTab: 'memory', sessions: listState([summary('current', {})], { current }) })
    const view = buildAssistantSessionView(current, [])
    act(() => surface.sessionView.setSessionView({ ...view, memory: { status, sourceSeq: 1 } }))
    expect(screen.getByRole('button', { name: 'Open transcript' })).toBeTruthy()
    expect(screen.getByText(status === 'failed' ? 'The memory tool failed in this conversation.' : status === 'malformed' ? 'Memory result data in this conversation is malformed.' : 'This conversation has assistant data this UI cannot read yet.')).toBeTruthy()
  })

  it('copies quick-action requests without navigation or input mutation', async () => {
    const current = 'current' as SessionId
    const surface = mountAssistant({
      defaultTab: 'memory',
      sessions: listState([summary('current', { displayTitle: 'Current' })], { current }),
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy memory request' }))
    })
    expect(surface.copyPrompt).toHaveBeenCalledWith('Help me add one personal memory note. Ask me which single note to save before writing.')
    expect(surface.openSession).not.toHaveBeenCalled()
    expect(screen.getByText('Request copied. Paste it into chat, review it, and send when ready.')).toBeTruthy()
    expect(screen.getByTestId('wa-assistant-request').textContent).toBe('Help me add one personal memory note. Ask me which single note to save before writing.')

    surface.copyPrompt.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('tab', { name: 'Day' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy calendar request' }))
    })
    expect(surface.copyPrompt).toHaveBeenCalledWith('Show my calendar for today. Use an explicit local time window and summarize conflicts only if the calendar data shows them.')
    expect(surface.openSession).not.toHaveBeenCalled()
    expect(screen.getByText('Could not copy. Select the request text below and copy it into chat.')).toBeTruthy()
    expect(screen.getByTestId('wa-assistant-request').textContent).toBe('Show my calendar for today. Use an explicit local time window and summarize conflicts only if the calendar data shows them.')
  })

  it('closes, reopens, uses fullscreen on narrow viewports, and preserves manual closure across resize and Escape', () => {
    const surface = mountAssistant({ canShow: true, width: 620, viewportWidth: 1440 })
    expect(screen.getByTestId('wa-assistant-panel').getAttribute('data-presentation')).toBe('push')
    expect(screen.getByTestId('wa-assistant-panel').getAttribute('style')).toBeNull()
    expect(surface.reportPresentation).toHaveBeenLastCalledWith({ shown: true, track: true, fullscreen: false })

    fireEvent.click(within(screen.getByTestId('wa-assistant-panel')).getByRole('button', { name: 'Hide assistant panel' }))
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()
    expect(surface.reportPresentation).toHaveBeenLastCalledWith({ shown: false, track: false, fullscreen: false })

    surface.updateOwner({ canShow: false, width: 0, viewportWidth: 560 })
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()
    surface.updateOwner({ canShow: true, width: 620, viewportWidth: 1440 })
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()

    fireEvent.click(screen.getByTestId('wa-assistant-toggle'))
    expect(surface.revealConversation).toHaveBeenCalled()
    expect(screen.getByTestId('wa-assistant-panel').getAttribute('data-presentation')).toBe('push')

    surface.updateOwner({ canShow: false, width: 0, viewportWidth: 560 })
    expect(screen.getByTestId('wa-assistant-panel').getAttribute('data-presentation')).toBe('fullscreen')
    expect(surface.reportPresentation).toHaveBeenLastCalledWith({ shown: true, track: false, fullscreen: true })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()
    surface.updateOwner({ canShow: true, width: 620, viewportWidth: 1440 })
    expect(screen.queryByTestId('wa-assistant-panel')).toBeNull()
  })

  it('keeps collapsed-sidebar reopen accessible and collapses an initially wide sidebar once', () => {
    const surface = mountAssistant({ wide: true })
    expect(surface.collapseSidebarOnce).toHaveBeenCalledTimes(1)
    const toggle = screen.getByTestId('wa-assistant-toggle')
    expect(toggle.getAttribute('aria-label')).toBe('Hide assistant panel')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-label')).toBe('Show assistant panel')
    surface.updateOwner({ wide: false })
    expect(surface.collapseSidebarOnce).toHaveBeenCalledTimes(1)
  })

  it('renders the public Nocturne brand mark at the owner-provided size', () => {
    const { container } = render(<AssistantBrandMark size={28} useSessions={unusedHook} useSessionPendingInteraction={unusedHook} useWorkspaces={unusedHook} />)
    const mark = container.querySelector('span')
    expect(mark?.getAttribute('style')).toContain('width: 28px')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('AssistantSessionBridge', () => {
  it('publishes only the current loaded Chat window and clears it on unmount', () => {
    const sessionView = createAssistantSessionViewSource()
    const sessionId = 'current' as SessionId
    const chat = source(conversation([
      toolResult(1, 'calendar_list', workAssistantMeta('calendar-list', calendarValue())),
    ]))
    const { unmount } = render(
      <AssistantSessionBridge
        sessionId={sessionId}
        useSession={unusedHook}
        useProjection={unusedHook}
        useConversation={selectorHook(chat)}
        useSessions={unusedHook}
        useSessionPendingInteraction={unusedHook}
        useWorkspaces={unusedHook}
        publishSessionView={view => { sessionView.setSessionView(view) }}
        clearSessionView={id => { sessionView.clearSessionView(id) }}
      />,
    )
    expect(sessionView.getSnapshot()?.day.status).toBe('ready')
    act(() => {
      chat.set(conversation([
        toolResult(2, 'memory_read', workAssistantMeta('memory-read', { note: 'profile.md', exists: false, revision: null, content: null })),
      ]))
    })
    expect(sessionView.getSnapshot()?.memory.status).toBe('ready')
    sessionView.setSessionView(buildAssistantSessionView('new' as SessionId, []))
    unmount()
    expect(sessionView.getSnapshot()?.sessionId).toBe('new')
    sessionView.clearSessionView('new' as SessionId)
    expect(sessionView.getSnapshot()).toBeNull()
  })
})
