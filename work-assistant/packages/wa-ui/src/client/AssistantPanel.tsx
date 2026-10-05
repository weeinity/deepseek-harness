import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { ConnectionState, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { groupActivities, personalAssistantRows, recentPersonalAssistantRows, type ActivityGroup, type ActivityRow, type ActivityStatus } from './activity.ts'
import { ASSISTANT_TABS, type AssistantPanelStore, type AssistantTab } from './store.ts'
import type { AssistantSessionView, AssistantSessionViewSource, CalendarEventItem, CalendarPanelData, CalendarWindow, MemoryEntry, MemoryPanelData, ProblemData } from './sessionView.ts'
import type { BriefingAction, BriefingSource, BriefingView } from './briefing.ts'
import styles from './AssistantPanel.module.css'

/** Panel presentation reported to the layout service. */
export interface RightbarPresentation {
  /** Whether any assistant panel content is visible. */
  readonly shown: boolean
  /** Whether the frame should reserve the normal right-column track. */
  readonly track: boolean
  /** Whether the panel covers the viewport instead of occupying the track. */
  readonly fullscreen: boolean
}

/** Apply-world callbacks and observables privately injected into the panel. */
export interface AssistantPanelInjected {
  /** Maximum real rows shown in each bounded rail section. */
  readonly maxActivities: number
  /** Navigate through the Workspace UI so the Conversation panel is selected too. */
  readonly openSession: (sessionId: SessionId) => void
  /** Copy a suggested request without changing a conversation or submitting input. */
  readonly copyPrompt: (text: string) => Promise<void>
  /** Report visible rightbar geometry to the root layout store. */
  readonly reportPresentation: (presentation: RightbarPresentation) => void
  /** Persist one explicit Inbox or policy action. */
  readonly actOnBriefing: (action: BriefingAction) => Promise<void>
  /** Re-read saved state without starting model work. */
  readonly refreshBriefing: () => Promise<void>
  /** Renderer-bound observables. */
  readonly hooks: {
    /** Current transport lifecycle; this does not imply provider sign-in. */
    readonly connectionState: ConnectionStateSource
    /** Current loaded-window assistant data from the root-owned bridge source. */
    readonly sessionView: AssistantSessionViewSource
    /** Saved proactive messages; independent of the selected conversation. */
    readonly briefing: BriefingSource
  }
}

/** Composed props for the root rightbar replacement. */
export type AssistantPanelProps =
  PropsRuntime<'rightbar'>
  & PropsStore<AssistantPanelStore>
  & InjectFace<AssistantPanelInjected>
  & PropsLocale<'waAssistant'>

const CLOSED_PRESENTATION: RightbarPresentation = Object.freeze({
  shown: false,
  track: false,
  fullscreen: false,
})

const TAB_LABELS = {
  timeline: 'tabs.timeline',
  queue: 'tabs.queue',
  day: 'tabs.day',
  memory: 'tabs.memory',
  inbox: 'tabs.inbox',
} as const satisfies Record<AssistantTab, Parameters<AssistantPanelProps['t']>[0]>

type DraftNotice = { readonly level: 'info' | 'error'; readonly text: string } | null

/** Render the personal-assistant identity, DSH connection state, and real recorded assistant data. */
export function AssistantPanel(props: AssistantPanelProps) {
  const expanded = props.useStore(state => state.expanded)
  const tab = props.useStore(state => state.tab)
  const storedSessionView = props.useSessionView(state => state)
  const conversationActive = props.usePanelInfo(info => info.activePanelId === null)
  const visible = expanded && conversationActive
  const fullscreen = visible && !props.canShow
  const track = visible && props.canShow
  const sessions = props.useSessions(state => state)
  const pendingInteractions = props.useSessionPendingInteraction(state => state)
  const connectionState = props.useConnectionState(state => state)
  const briefing = props.useBriefing(state => state)
  const unread = briefing.data?.items.filter(item => !item.read).length ?? 0
  const rows = useMemo(
    () => recentPersonalAssistantRows(sessions, props.maxActivities),
    [sessions, props.maxActivities],
  )
  const allPersonalRows = useMemo(() => personalAssistantRows(sessions), [sessions])
  const groups = useMemo(() => groupActivities(rows, Date.now()), [rows])
  const currentView = currentSessionView(storedSessionView, sessions.current)
  const queue = useMemo(
    () => buildQueueModel(allPersonalRows, pendingInteractions, props.maxActivities, props.t),
    [allPersonalRows, pendingInteractions, props.maxActivities, props.t],
  )
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftNotice, setDraftNotice] = useState<DraftNotice>(null)
  const { reportPresentation } = props

  useLayoutEffect(() => {
    reportPresentation(visible
      ? { shown: true, track, fullscreen }
      : CLOSED_PRESENTATION)
  }, [fullscreen, reportPresentation, track, visible])

  useLayoutEffect(() => () => {
    reportPresentation(CLOSED_PRESENTATION)
  }, [reportPresentation])

  useEffect(() => {
    if (!visible || !fullscreen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      props.actions.close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [fullscreen, props.actions, visible])

  const requestDraft = async (text: string): Promise<void> => {
    setDraftBusy(true)
    setDraftNotice(null)
    try {
      await props.copyPrompt(text)
      setDraftNotice({ level: 'info', text: props.t('request.copied') })
    } catch {
      setDraftNotice({ level: 'error', text: props.t('request.failed') })
    } finally {
      setDraftBusy(false)
    }
  }

  if (!visible) return null

  return (
    <aside
      className={styles.panel}
      data-testid="wa-assistant-panel"
      data-presentation={fullscreen ? 'fullscreen' : 'push'}
      aria-labelledby="wa-assistant-heading"
    >
      <header className={styles.header}>
        <button
          className={styles.closeButton}
          type="button"
          aria-label={props.t('panel.hide')}
          title={props.t('panel.hide')}
          onClick={() => { props.actions.close() }}
        >
          <CloseGlyph />
        </button>
        <div className={styles.identity}>
          <AssistantAvatar label={props.t('avatar.label')} />
          <h2 className={styles.heading} id="wa-assistant-heading">{props.t('identity.name')}</h2>
          <p className={styles.role}>{props.t('identity.role')}</p>
          <ConnectionStatus state={connectionState} t={props.t} />
        </div>
        <AssistantTabs active={tab} selectTab={props.actions.selectTab} t={props.t} />
        {unread > 0 && (
          <button className={styles.outlineButton} type="button" onClick={() => props.actions.selectTab('inbox')} aria-live="polite">
            <span>{props.t('inbox.unread', { count: unread })}</span>
            <span className={styles.inboxPreview}>{briefing.data?.items.find(item => !item.read)?.text}</span>
          </button>
        )}
      </header>
      <div className={styles.body}>
        {tab === 'inbox' && <InboxPane view={briefing} t={props.t} act={props.actOnBriefing} refresh={props.refreshBriefing} openSession={props.openSession} />}
        {tab === 'timeline' && (
          <TimelinePane
            state={sessions}
            groups={groups}
            t={props.t}
            openSession={props.openSession}
          />
        )}
        {tab === 'queue' && (
          <QueuePane
            pending={queue.pending}
            running={queue.running}
            t={props.t}
            openSession={props.openSession}
          />
        )}
        {tab === 'day' && (
          <DayPane
            view={currentView}
            maxRows={props.maxActivities}
            busy={draftBusy}
            notice={draftNotice}
            t={props.t}
            openSession={props.openSession}
            requestDraft={requestDraft}
          />
        )}
        {tab === 'memory' && (
          <MemoryPane
            view={currentView}
            maxRows={props.maxActivities}
            busy={draftBusy}
            notice={draftNotice}
            t={props.t}
            openSession={props.openSession}
            requestDraft={requestDraft}
          />
        )}
      </div>
    </aside>
  )
}

function InboxPane({ view, t, act, refresh, openSession }: {
  readonly view: BriefingView
  readonly t: AssistantPanelProps['t']
  readonly act: (action: BriefingAction) => Promise<void>
  readonly refresh: () => Promise<void>
  readonly openSession: (sessionId: SessionId) => void
}) {
  const perform = async (action: BriefingAction, sessionId?: SessionId): Promise<void> => {
    try {
      await act(action)
      if (sessionId !== undefined) openSession(sessionId)
    } catch {
      // The source publishes the localized error state; rejected reads never navigate.
    }
  }
  const data = view.data
  return (
    <section id="wa-assistant-inbox" role="tabpanel" aria-labelledby="wa-assistant-tab-inbox">
      <h3 className={styles.sectionHeading}>{t('tabs.inbox')}</h3>
      {view.status === 'loading' && <p className={styles.stateMessage}>{t('inbox.loading')}</p>}
      {view.status === 'error' && <p className={styles.stateMessage} role="alert">{t('inbox.error')}</p>}
      <button className={styles.outlineButton} type="button" disabled={view.busy} onClick={() => { void refresh() }}>{t('inbox.refresh')}</button>
      {data !== null && <>
        <p className={styles.subtle}>{t(!data.enabled ? 'inbox.disabled' : data.paused ? 'inbox.paused' : 'inbox.active')}</p>
        {data.enabled && <button className={styles.outlineButton} type="button" disabled={view.busy || view.status !== 'ready'}
          onClick={() => { void perform({ action: data.paused ? 'resume' : 'pause' }) }}>
          {t(data.paused ? 'inbox.resume' : 'inbox.pause')}
        </button>}
        {data.running && <p className={styles.stateMessage}>{t('inbox.running')}</p>}
        {data.items.length === 0 && <p className={styles.stateMessage}>{t('inbox.empty')}</p>}
        <ul className={styles.lineList}>
          {data.items.map(item => <li className={styles.inboxItem} key={item.id}>
            <p className={styles.subtle}>{t('inbox.reason')} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
            {!item.read && <span className={styles.subtle}>{t('inbox.new')}</span>}
            <p className={styles.inboxText}>{item.text}</p>
            <div className={styles.inboxActions}>
              <button className={styles.outlineButton} type="button" disabled={view.busy}
                onClick={() => { void perform({ action: 'read', id: item.id }, item.sessionId) }}>{t('inbox.reply')}</button>
              {!item.read && <button className={styles.outlineButton} type="button" disabled={view.busy}
                onClick={() => { void perform({ action: 'read', id: item.id }) }}>{t('inbox.read')}</button>}
              <button className={styles.outlineButton} type="button" disabled={view.busy}
                onClick={() => { void perform({ action: 'dismiss', id: item.id }) }}>{t('inbox.dismiss')}</button>
            </div>
          </li>)}
        </ul>
      </>}
    </section>
  )
}

function AssistantAvatar({ label }: { readonly label: string }) {
  return (
    <div className={styles.avatar} role="img" aria-label={label}>
      <svg className={styles.avatarGlyph} viewBox="0 0 42 42" aria-hidden="true">
        <path d="M13 23.5c3.1-5.6 8.1-8.2 15.4-7.2-1.6 6.9-5.6 10.5-12.8 10.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M25 12.5l1.1 2.2 2.4 0.4-1.7 1.8 0.4 2.4-2.2-1.1-2.2 1.1 0.4-2.4-1.7-1.8 2.4-0.4z" fill="currentColor" />
      </svg>
      <span className={styles.avatarBadge} aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 3.5 13.7 9l5.3 1.8-5.3 1.8L12 18l-1.7-5.4L5 10.8 10.3 9 12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  )
}

function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 4.2 8 8m3.8 3.8L8 8m0 0 3.8-3.8M8 8l-3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ConnectionStatus({
  state,
  t,
}: {
  readonly state: ConnectionState | undefined
  readonly t: AssistantPanelProps['t']
}) {
  const status = state ?? 'unknown'
  return (
    <div className={clsx(styles.statusLine, statusClass(status))} role="status">
      <span className={styles.statusDot} aria-hidden="true" />
      <span>{t(statusKey(status))}</span>
    </div>
  )
}

function AssistantTabs({
  active,
  selectTab,
  t,
}: {
  readonly active: AssistantTab
  readonly selectTab: (tab: AssistantTab) => void
  readonly t: AssistantPanelProps['t']
}) {
  const refs = useRef<Record<AssistantTab, HTMLButtonElement | null>>({
    timeline: null,
    queue: null,
    day: null,
    memory: null,
    inbox: null,
  })
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: AssistantTab): void => {
    const current = ASSISTANT_TABS.indexOf(tab)
    const last = ASSISTANT_TABS.length - 1
    const next = event.key === 'ArrowRight'
      ? ASSISTANT_TABS[current === last ? 0 : current + 1]
      : event.key === 'ArrowLeft'
        ? ASSISTANT_TABS[current === 0 ? last : current - 1]
        : event.key === 'Home'
          ? ASSISTANT_TABS[0]
          : event.key === 'End'
            ? ASSISTANT_TABS[last]
            : undefined
    if (next === undefined) return
    event.preventDefault()
    selectTab(next)
    refs.current[next]?.focus()
  }
  return (
    <div className={styles.tabList} role="tablist" aria-label={t('tabs.label')}>
      {ASSISTANT_TABS.map(item => (
        <button
          key={item}
          ref={(node) => { refs.current[item] = node }}
          className={styles.tab}
          type="button"
          role="tab"
          aria-selected={item === active}
          aria-controls={`wa-assistant-${item}`}
          id={`wa-assistant-tab-${item}`}
          onClick={() => { selectTab(item) }}
          onKeyDown={event => { onKeyDown(event, item) }}
        >
          {t(TAB_LABELS[item])}
        </button>
      ))}
    </div>
  )
}

function TimelinePane({
  state,
  groups,
  t,
  openSession,
}: {
  readonly state: SessionListState
  readonly groups: readonly ActivityGroup[]
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
}) {
  const empty = groups.every(group => group.rows.length === 0)
  return (
    <section id="wa-assistant-timeline" role="tabpanel" aria-labelledby="wa-assistant-tab-timeline">
      <h3 className={styles.sectionHeading}>{t('activity.heading')}</h3>
      {state.phase === 'pending' && empty
        ? <p className={styles.stateMessage} role="status">{t('activity.loading')}</p>
        : empty
          ? <p className={styles.stateMessage}>{t('activity.empty')}</p>
          : groups.map(group => (
              <ActivityGroupView
                key={group.day}
                group={group}
                t={t}
                openSession={openSession}
              />
            ))}
    </section>
  )
}

function ActivityGroupView({
  group,
  t,
  openSession,
}: {
  readonly group: ActivityGroup
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
}) {
  return (
    <section className={styles.timelineGroup} aria-label={activityGroupLabel(group, t)}>
      <h4 className={styles.groupHeading}>{activityGroupLabel(group, t)}</h4>
      <ul className={styles.lineList}>
        {group.rows.map(row => (
          <ActivityItem key={row.id} row={row} t={t} openSession={openSession} />
        ))}
      </ul>
    </section>
  )
}

function ActivityItem({
  row,
  t,
  openSession,
}: {
  readonly row: ActivityRow
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
}) {
  const time = formatUpdatedAt(row.updatedAt)
  return (
    <li>
      <button
        className={styles.lineButton}
        data-testid="wa-assistant-activity-row"
        type="button"
        aria-current={row.selected ? 'page' : undefined}
        aria-label={t('activity.open', { title: row.title, time })}
        onClick={() => { openSession(row.id) }}
      >
        <StatusGlyph status={row.status} />
        <span className={styles.lineText}>
          <span className={styles.lineTitle} title={row.title}>{row.title}</span>
          <span className={styles.lineDetail}>
            <span>{t(activityStatusKey(row.status))}</span>
            {row.selected && <span>{t('activity.selected')}</span>}
          </span>
          <time className={styles.lineTime} dateTime={new Date(row.updatedAt).toISOString()}>{time}</time>
        </span>
      </button>
    </li>
  )
}

function QueuePane({
  pending,
  running,
  t,
  openSession,
}: {
  readonly pending: readonly PendingCard[]
  readonly running: readonly ActivityRow[]
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
}) {
  return (
    <section id="wa-assistant-queue" role="tabpanel" aria-labelledby="wa-assistant-tab-queue">
      <h3 className={styles.sectionHeading}>{t('queue.heading')}</h3>
      <h4 className={styles.groupHeading}>{t('queue.waitingHeading')}</h4>
      {pending.length === 0
        ? <p className={styles.stateMessage}>{t('queue.empty')}</p>
        : (
            <div className={styles.cardStack}>
              {pending.map(card => (
                <article className={styles.card} key={card.sessionId}>
                  <div className={styles.cardKicker}>{card.kicker}</div>
                  <h5 className={styles.cardTitle}>{card.title}</h5>
                  <p className={styles.cardBody}>{card.detail}</p>
                  <button
                    className={styles.outlineButton}
                    type="button"
                    aria-label={t('queue.reviewAria', { title: card.title })}
                    onClick={() => { openSession(card.sessionId) }}
                  >
                    {t('queue.review')}
                  </button>
                </article>
              ))}
            </div>
          )}
      <h4 className={styles.groupHeading}>{t('queue.runningHeading')}</h4>
      {running.length === 0
        ? <p className={styles.stateMessage}>{t('queue.runningEmpty')}</p>
        : (
            <ul className={styles.lineList}>
              {running.map(row => (
                <li className={styles.runningRow} key={row.id}>
                  <span className={styles.lineTitle} title={row.title}>{row.title}</span>
                  <span className={styles.pill}>{t('activity.running')}</span>
                </li>
              ))}
            </ul>
          )}
    </section>
  )
}

function DayPane({
  view,
  maxRows,
  busy,
  notice,
  t,
  openSession,
  requestDraft,
}: {
  readonly view: AssistantSessionView | null
  readonly maxRows: number
  readonly busy: boolean
  readonly notice: DraftNotice
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
  readonly requestDraft: (text: string) => Promise<void>
}) {
  const data = view?.day ?? null
  return (
    <section id="wa-assistant-day" role="tabpanel" aria-labelledby="wa-assistant-tab-day">
      <h3 className={styles.sectionHeading}>{t('day.heading')}</h3>
      {renderCalendarBody(data, view, maxRows, t, openSession)}
      <RailActions notice={notice}>
        <button
          className={styles.outlineButton}
          type="button"
          disabled={busy}
          onClick={() => { void requestDraft(t('day.requestDraft')) }}
        >
          {t('day.request')}
        </button>
      </RailActions>
      <p className={styles.stateMessage} data-testid="wa-assistant-request">{t('day.requestDraft')}</p>
    </section>
  )
}

function MemoryPane({
  view,
  maxRows,
  busy,
  notice,
  t,
  openSession,
  requestDraft,
}: {
  readonly view: AssistantSessionView | null
  readonly maxRows: number
  readonly busy: boolean
  readonly notice: DraftNotice
  readonly t: AssistantPanelProps['t']
  readonly openSession: (sessionId: SessionId) => void
  readonly requestDraft: (text: string) => Promise<void>
}) {
  const data = view?.memory ?? null
  return (
    <section id="wa-assistant-memory" role="tabpanel" aria-labelledby="wa-assistant-tab-memory">
      <h3 className={styles.sectionHeading}>{t('memory.heading')}</h3>
      {renderMemoryBody(data, view, maxRows, t, openSession)}
      <RailActions notice={notice}>
        <button
          className={styles.outlineButton}
          type="button"
          disabled={busy}
          onClick={() => { void requestDraft(t('memory.addDraft')) }}
        >
          {t('memory.add')}
        </button>
      </RailActions>
      <p className={styles.stateMessage} data-testid="wa-assistant-request">{t('memory.addDraft')}</p>
    </section>
  )
}

function RailActions({
  notice,
  children,
}: {
  readonly notice: DraftNotice
  readonly children: ReactNode
}) {
  return (
    <div className={styles.railActions}>
      {children}
      {notice !== null && <p className={clsx(styles.notice, styles[notice.level])} role="status">{notice.text}</p>}
    </div>
  )
}

function renderCalendarBody(
  data: CalendarPanelData | null,
  view: AssistantSessionView | null,
  maxRows: number,
  t: AssistantPanelProps['t'],
  openSession: (sessionId: SessionId) => void,
) {
  if (view === null) return <p className={styles.stateMessage}>{t('day.noSession')}</p>
  if (data === null || data.status === 'empty') {
    if (view.unsupportedSeq !== null) return <ProblemCard problem={{ status: 'unsupported', sourceSeq: view.unsupportedSeq }} message={t('day.statusUnsupported')} buttonText={t('day.openTranscript')} sessionId={view.sessionId} openSession={openSession} />
    return <p className={styles.stateMessage}>{t('day.empty')}</p>
  }
  if (data.status !== 'ready') return <ProblemCard problem={data} message={calendarProblemMessage(data, t)} buttonText={t('day.openTranscript')} sessionId={view.sessionId} openSession={openSession} />
  const events = data.events.slice(0, maxRows)
  const showEventDates = calendarWindowNeedsEventDates(data.window, data.timeZone, data.events)
  return (
    <>
      <p className={styles.subtle}>{t('day.window', { timeZone: data.timeZone, start: compactDateTime(data.window.start, data.timeZone), end: compactDateTime(data.window.end, data.timeZone) })}</p>
      {events.length === 0
        ? <p className={styles.stateMessage}>{t('day.empty')}</p>
        : (
            <ul className={styles.agendaList}>
              {events.map(event => <CalendarEventRow key={event.id} event={event} showDate={showEventDates} t={t} />)}
            </ul>
          )}
      {data.truncated && <p className={styles.subtle}>{t('day.truncated')}</p>}
      {!data.truncated && data.events.length > events.length && <p className={styles.subtle}>{t('day.bounded', { count: events.length })}</p>}
    </>
  )
}

function renderMemoryBody(
  data: MemoryPanelData | null,
  view: AssistantSessionView | null,
  maxRows: number,
  t: AssistantPanelProps['t'],
  openSession: (sessionId: SessionId) => void,
) {
  if (view === null) return <p className={styles.stateMessage}>{t('memory.noSession')}</p>
  if (data === null || data.status === 'empty') {
    if (view.unsupportedSeq !== null) return <ProblemCard problem={{ status: 'unsupported', sourceSeq: view.unsupportedSeq }} message={t('memory.statusUnsupported')} buttonText={t('memory.openTranscript')} sessionId={view.sessionId} openSession={openSession} />
    return <p className={styles.stateMessage}>{t('memory.empty')}</p>
  }
  if (data.status !== 'ready') return <ProblemCard problem={data} message={memoryProblemMessage(data, t)} buttonText={t('memory.openTranscript')} sessionId={view.sessionId} openSession={openSession} />
  const entries = data.entries.slice(0, maxRows)
  return (
    <>
      <ul className={styles.memoryList}>
        {entries.map(entry => <MemoryRow key={`${entry.note}:${entry.sourceSeq}`} entry={entry} t={t} />)}
      </ul>
      {data.truncated && <p className={styles.subtle}>{t('memory.truncated')}</p>}
      {!data.truncated && data.entries.length > entries.length && <p className={styles.subtle}>{t('memory.bounded', { count: entries.length })}</p>}
    </>
  )
}

function CalendarEventRow({
  event,
  showDate,
  t,
}: {
  readonly event: CalendarEventItem
  readonly showDate: boolean
  readonly t: AssistantPanelProps['t']
}) {
  return (
    <li className={styles.agendaRow}>
      <time className={styles.agendaTime} dateTime={event.start.instant}>{formatCalendarTime(event, showDate, t)}</time>
      <span className={styles.agendaText}>
        <span className={styles.lineTitle} title={event.title}>{event.title}</span>
        <span className={styles.lineDetail}>{calendarDetail(event, t)}</span>
      </span>
    </li>
  )
}

function MemoryRow({
  entry,
  t,
}: {
  readonly entry: MemoryEntry
  readonly t: AssistantPanelProps['t']
}) {
  return (
    <li className={styles.memoryRow}>
      <span className={styles.memoryDot} aria-hidden="true" />
      <span className={styles.memoryText}>
        <span className={styles.lineTitle} title={entry.note}>{entry.note}</span>
        <span className={styles.lineDetail}>{memoryDetail(entry, t)}</span>
      </span>
      <span className={styles.pill}>{t(memorySourceKey(entry.source))}</span>
    </li>
  )
}

function ProblemCard({
  problem,
  message,
  buttonText,
  sessionId,
  openSession,
}: {
  readonly problem: ProblemData
  readonly message: string
  readonly buttonText: string
  readonly sessionId: SessionId
  readonly openSession: (sessionId: SessionId) => void
}) {
  return (
    <article className={styles.problemCard} data-problem={problem.status}>
      <p>{message}</p>
      <button className={styles.outlineButton} type="button" onClick={() => { openSession(sessionId) }}>{buttonText}</button>
    </article>
  )
}

function StatusGlyph({ status }: { readonly status: ActivityStatus }) {
  return (
    <span className={clsx(styles.glyph, styles[`glyph${capitalize(status)}`])} aria-hidden="true">
      {status === 'running'
        ? <span className={styles.runningDot} />
        : status === 'finished'
          ? <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          : <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>}
    </span>
  )
}

interface PendingCard {
  readonly sessionId: SessionId
  readonly title: string
  readonly kicker: string
  readonly detail: string
}

function buildQueueModel(rows: readonly ActivityRow[], pending: ReadonlyMap<SessionId, SessionPendingInteraction>, maxRows: number, t: AssistantPanelProps['t']): { readonly pending: readonly PendingCard[]; readonly running: readonly ActivityRow[] } {
  const pendingCards: PendingCard[] = []
  const waiting = new Set<SessionId>()
  for (const row of rows) {
    const interaction = pending.get(row.id)
    if (interaction === undefined) continue
    waiting.add(row.id)
    const title = pendingTitle(interaction, row.title, t)
    pendingCards.push({
      sessionId: row.id,
      title,
      kicker: pendingKicker(interaction, t),
      detail: pendingDetail(interaction, title, t),
    })
  }
  return {
    pending: pendingCards.slice(0, maxRows),
    running: rows.filter(row => row.status === 'running' && !waiting.has(row.id)).slice(0, maxRows),
  }
}

function pendingTitle(interaction: SessionPendingInteraction, fallback: string, t: AssistantPanelProps['t']): string {
  const record = interaction as unknown as Readonly<Record<string, unknown>>
  if (interaction.kind === 'approval') {
    const tool = textField(record, 'toolName')
    return tool === undefined ? fallback : t('queue.pendingApproval', { tool })
  }
  return textField(record, 'title') ?? textField(record, 'question') ?? fallback
}

function pendingKicker(interaction: SessionPendingInteraction, t: AssistantPanelProps['t']): string {
  const record = interaction as unknown as Readonly<Record<string, unknown>>
  if (interaction.kind === 'approval') return textField(record, 'toolName') ?? t('queue.pendingKind', { kind: interaction.kind })
  return t('queue.pendingKind', { kind: interaction.kind })
}

function pendingDetail(interaction: SessionPendingInteraction, title: string, t: AssistantPanelProps['t']): string {
  const record = interaction as unknown as Readonly<Record<string, unknown>>
  for (const key of ['reason', 'message', 'prompt', 'question'] as const) {
    const value = textField(record, key)
    if (value !== undefined && value !== title) return value
  }
  return t('queue.pendingGeneric')
}

function textField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function currentSessionView(view: AssistantSessionView | null, current: SessionId | undefined): AssistantSessionView | null {
  return view !== null && current !== undefined && view.sessionId === current ? view : null
}

/** Format a Session summary timestamp for compact display. */
export function formatUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(updatedAt))
}

function activityGroupLabel(group: ActivityGroup, t: AssistantPanelProps['t']): string {
  switch (group.label) {
    case 'today': return t('activity.group.today')
    case 'yesterday': return t('activity.group.yesterday')
    case 'date': return t('activity.group.date', { date: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(group.day)) })
  }
}

function calendarProblemMessage(problem: ProblemData, t: AssistantPanelProps['t']): string {
  switch (problem.status) {
    case 'failed': return t('day.statusFailed')
    case 'malformed': return t('day.statusMalformed')
    case 'unsupported': return t('day.statusUnsupported')
  }
}

function memoryProblemMessage(problem: ProblemData, t: AssistantPanelProps['t']): string {
  switch (problem.status) {
    case 'failed': return t('memory.statusFailed')
    case 'malformed': return t('memory.statusMalformed')
    case 'unsupported': return t('memory.statusUnsupported')
  }
}

function formatCalendarTime(event: CalendarEventItem, showDate: boolean, t: AssistantPanelProps['t']): string {
  const startDate = compactLocalDate(event.start.local)
  const endDateKey = calendarEndDateKey(event)
  const endDate = endDateKey === null ? event.end.local : compactLocalDate(endDateKey)
  const sameDay = endDateKey !== null && localDateKey(event.start.local) === endDateKey
  if (event.allDay) {
    if (!showDate) return t('day.allDay')
    return sameDay
      ? t('day.time.allDayDate', { date: startDate, allDay: t('day.allDay') })
      : t('day.time.allDayRange', { startDate, endDate, allDay: t('day.allDay') })
  }
  const start = compactLocalTime(event.start.local)
  const end = compactLocalTime(event.end.local)
  if (!showDate && sameDay) return `${start}–${end}`
  return sameDay
    ? t('day.time.sameDay', { date: startDate, start, end })
    : t('day.time.multiDay', { startDate, start, endDate, end })
}

function calendarDetail(event: CalendarEventItem, t: AssistantPanelProps['t']): string {
  const parts = [
    event.location === undefined ? undefined : t('day.location', { location: event.location }),
    event.recurring ? t('day.recurring') : undefined,
    event.busy ? t('day.busy') : undefined,
    !event.allDay && event.durationMinutes > 0 ? t('day.duration', { minutes: event.durationMinutes }) : undefined,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? event.start.timeZone : parts.join(' · ')
}

function memoryDetail(entry: MemoryEntry, t: AssistantPanelProps['t']): string {
  switch (entry.source) {
    case 'read':
      return entry.summary === '' ? t('memory.revision', { revision: shortRevision(entry.revision) }) : entry.summary
    case 'listed':
      return t('memory.revision', { revision: shortRevision(entry.revision) })
    case 'written':
      return t('memory.writeDetail', { bytes: entry.contentBytes ?? 0 })
    case 'absent':
      return t('memory.absentDetail')
  }
}

function memorySourceKey(source: MemoryEntry['source']): Parameters<AssistantPanelProps['t']>[0] {
  switch (source) {
    case 'read': return 'memory.read'
    case 'listed': return 'memory.listed'
    case 'written': return 'memory.written'
    case 'absent': return 'memory.absent'
  }
}

function statusKey(state: ConnectionState | 'unknown'): Parameters<AssistantPanelProps['t']>[0] {
  switch (state) {
    case 'connected': return 'status.connected'
    case 'connecting': return 'status.connecting'
    case 'disconnected': return 'status.disconnected'
    case 'unknown': return 'status.unknown'
  }
  return 'status.unknown'
}

function statusClass(state: ConnectionState | 'unknown'): string | undefined {
  switch (state) {
    case 'connected': return styles.statusConnected
    case 'connecting': return styles.statusConnecting
    case 'disconnected': return styles.statusDisconnected
    case 'unknown': return styles.statusUnknown
  }
  return styles.statusUnknown
}

function activityStatusKey(status: ActivityStatus): Parameters<AssistantPanelProps['t']>[0] {
  switch (status) {
    case 'running': return 'activity.running'
    case 'finished': return 'activity.finished'
    case 'idle': return 'activity.idle'
  }
}

function compactDateTime(value: string, timeZone: string): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(parsed))
  } catch {
    return value
  }
}

function calendarWindowNeedsEventDates(window: CalendarWindow, timeZone: string, events: readonly CalendarEventItem[]): boolean {
  const windowStart = localDateKeyForInstant(window.start, timeZone)
  const windowEnd = localDateKeyForInstant(window.end, timeZone, true)
  if (windowStart !== null && windowEnd !== null && windowStart !== windowEnd) return true
  return events.some(event => localDateKey(event.start.local) !== calendarEndDateKey(event))
}

function calendarEndDateKey(event: CalendarEventItem): string | null {
  // iCalendar all-day end dates exclude the final midnight.
  return event.allDay
    ? localDateKeyForInstant(event.end.instant, event.end.timeZone, true)
    : localDateKey(event.end.local)
}

function localDateKeyForInstant(value: string, timeZone: string, endExclusive = false): string | null {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return localDateKey(value)
  try {
    const at = new Date(parsed - (endExclusive ? 1 : 0))
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at)
    const year = parts.find(part => part.type === 'year')?.value
    const month = parts.find(part => part.type === 'month')?.value
    const day = parts.find(part => part.type === 'day')?.value
    return year === undefined || month === undefined || day === undefined ? null : `${year}-${month}-${day}`
  } catch {
    return localDateKey(value)
  }
}

function localDateKey(value: string): string | null {
  return /^(?<date>\d{4}-\d{2}-\d{2})/u.exec(value)?.groups?.['date'] ?? null
}

function compactLocalDate(value: string): string {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})/u.exec(value)
  if (match?.groups === undefined) return value
  const year = Number(match.groups['year'])
  const month = Number(match.groups['month'])
  const day = Number(match.groups['day'])
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function compactLocalTime(value: string): string {
  return /[T ](?<time>\d{2}:\d{2})/u.exec(value)?.groups?.['time']
    ?? /^(?<time>\d{1,2}:\d{2})/u.exec(value)?.groups?.['time']
    ?? value
}

function shortRevision(value: string | null): string {
  if (value === null) return 'null'
  return value.length > 18 ? `${value.slice(0, 18)}…` : value
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
