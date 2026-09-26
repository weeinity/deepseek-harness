// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TaskboardSnapshot } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardLauncherProps } from '../src/client/contract.ts'
import { TaskCard, type TaskCardProps } from '../src/client/TaskCard.tsx'
import { TaskboardLauncher } from '../src/client/TaskboardLauncher.tsx'
import { ConnectionPicker } from '../src/client/ConnectionPicker.tsx'
import { agencyStatusLabel, priorityLabel, statusLabel, taskActivity, taskboardErrorText, taskTimeLabel, workspaceTitle } from '../src/client/view.ts'
import { en, zh } from '../src/client/locales.ts'
import { copilot, dsh, runtime, sessions, task, translate, workspaces } from './fixtures.client.ts'

afterEach(cleanup)

function activitySessions() {
  const state = sessions()
  const goal: GoalProjection = { goal: {
    id: 'goal' as GoalProjection['goal']['id'], revision: 1, objective: 'Review', phase: 'blocked',
    blockedReason: { code: 'review-needed', message: 'Review requested' }, maxGoalRounds: 5,
  }, roundsStarted: 1, createdAt: 0, updatedAt: 1 }
  state.byId[dsh.sessionId] = { ...state.byId[dsh.sessionId]!, running: true, projectionValues: { goal } }
  const jobs: SessionJob[] = (['running', 'stopping', 'completed'] as const).map((status, index) => ({
    id: `job-${index}` as SessionJob['id'], kind: 'bash', label: 'Work', status, startedAt: 0,
  }))
  return { ...state, jobsBySession: { [dsh.sessionId]: jobs } }
}

describe('Taskboard presentation', () => {
  it('retains direct and opaque command diagnostics', () => {
    const diagnostic = Object.assign(new Error('Carrier unavailable'), {
      isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
    })
    expect(taskboardErrorText(diagnostic)).toBe(diagnostic.message)
    expect(taskboardErrorText(new Error('Local failure'))).toBe('Local failure')
    expect(taskboardErrorText('Opaque rejection')).toBe('Opaque rejection')
  })

  it.each([en, zh])('localizes each observed Agency state and all durable labels', (dictionary) => {
    const t = translate(dictionary)
    for (const [state, label] of [
      ['in_use', dictionary.copilotRunning], ['idle', dictionary.copilotIdle],
      ['missing', dictionary.copilotNotStarted], ['workspace_mismatch', dictionary.copilotWorkspaceMismatch],
      ['unavailable', dictionary.copilotUnavailable], ['unknown', dictionary.copilotUnknown], [undefined, dictionary.copilotUnknown],
    ] as const) expect(agencyStatusLabel(state, t)).toBe(label)
    for (const [priority, label] of [[undefined, dictionary.priorityNone], ['low', dictionary.priorityLow],
      ['medium', dictionary.priorityMedium], ['high', dictionary.priorityHigh], ['urgent', dictionary.priorityUrgent]] as const) {
      expect(priorityLabel(t, priority)).toBe(label)
    }
    expect(statusLabel(t, 'backlog')).toBe(dictionary.backlog)
    expect(statusLabel(t, 'done')).toBe(dictionary.done)
    expect(taskTimeLabel(t, '2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z'))).toBe(t('time.now'))
    expect(taskTimeLabel(t, '2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:00Z'))).toBe(t('time.minutes', { n: 2 }))
    expect(workspaceTitle(task(), workspaces())).toBe('Workspace')
    expect(workspaceTitle(task(), { ...workspaces(), items: [] })).toBe(task().workspaceId)
  })

  it('derives only live jobs and the durable blocked goal without changing planning status', () => {
    const state = activitySessions()
    const row = task({ connection: dsh })
    expect(taskActivity(row, state)).toEqual({ running: true, jobs: 2, blocked: true })
    expect(taskActivity(task({ connection: copilot }), state)).toEqual({ running: false, jobs: 0, blocked: false })
    expect(taskActivity(row, { ...state, byId: {}, jobsBySession: {} })).toEqual({ running: false, jobs: 0, blocked: false })
    expect(row.status).toBe('todo')
  })

  it('opens cards only with activation keys and handles native drag events when enabled', () => {
    const props: TaskCardProps = {
      task: task({ connection: dsh, priority: 'urgent', labels: ['one', 'two', 'three', 'four', 'hidden'] }),
      sessions: activitySessions(), agencyStatus: undefined, t: translate(), now: Date.parse('2026-01-01'),
      selected: true, draggable: true, dragging: false, moving: false,
      onOpen: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onDropBefore: vi.fn(),
    }
    const view = render(<TaskCard {...props} />)
    const card = screen.getByRole('article')
    expect(card.title).toBe(en.dragToMove)
    screen.getByText(en.blocked)
    screen.getByText(translate()('jobs', { count: 2 }))
    expect(screen.queryByText('hidden')).toBeNull()
    fireEvent.keyDown(card, { key: 'ArrowDown' })
    expect(props.onOpen).not.toHaveBeenCalled()
    fireEvent.keyDown(card, { key: ' ' })
    fireEvent.keyDown(card, { key: 'Enter' })
    expect(props.onOpen).toHaveBeenCalledTimes(2)
    fireEvent.dragStart(card)
    fireEvent.dragOver(card)
    fireEvent.drop(card)
    fireEvent.dragEnd(card)
    expect(props.onDragStart).toHaveBeenCalledOnce()
    expect(props.onDragEnd).toHaveBeenCalledOnce()
    expect(props.onDropBefore).toHaveBeenCalledOnce()
    const active = { ...props.sessions, byId: {
      [dsh.sessionId]: { ...props.sessions.byId[dsh.sessionId]!, projectionValues: { goal: null } },
    } }
    view.rerender(<TaskCard {...props} sessions={active} />)
    screen.getByText(en.live)
    view.rerender(<TaskCard {...props} task={task({ unresolvedConnections: [dsh, copilot] })} />)
    screen.getByText(en.legacyChoice)
    view.rerender(<TaskCard {...props} task={task({ archivedAt: '2026-01-02', connection: copilot,
      executionSettings: { kind: 'copilot' } })} agencyStatus="in_use" />)
    screen.getByText(en.copilotLinked)
    expect(card.getAttribute('data-running')).toBeNull()
    view.rerender(<TaskCard {...props} task={task({ connection: copilot, executionSettings: { kind: 'copilot' } })} agencyStatus="in_use" />)
    screen.getByText(en.copilotRunning)
    expect(card.getAttribute('data-running')).toBe('true')
  })

  it.each([true, false])('renders the wide=%s launcher with archive-aware counts and navigation', (wide) => {
    const state: TaskboardSnapshot = { tasks: [task(), task({ archivedAt: '2026-01-02' })], runtime,
      state: 'idle', phase: 'ready', error: null, agencyByTask: {}, agencyState: 'idle', agencyError: null }
    const props: TaskboardLauncherProps = {
      wide, mainSurface: 'taskboard', useTaskboard: selector => selector(state), toggleSurface: vi.fn(), t: translate(),
      useSessions: selector => selector(sessions()), useWorkspaces: selector => selector(workspaces()),
      useSessionPendingInteraction: selector => selector(new Map()),
      useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
    }
    const view = render(<TaskboardLauncher {...props} />)
    const button = screen.getByRole('button', { name: en.launcher })
    expect(button.getAttribute('aria-current')).toBe('page')
    if (wide) screen.getByText('1')
    else expect(button.title).toBe(en.launcher)
    fireEvent.click(button)
    expect(props.toggleSurface).toHaveBeenCalledOnce()
    view.rerender(<TaskboardLauncher {...props} mainSurface="chat" />)
    expect(button.getAttribute('aria-current')).toBeNull()
  })

  it('shows raw DSH identities during partial projection and permits clearing a saved selection', () => {
    const changed = vi.fn()
    const props = { kind: 'dsh' as const, value: dsh, workspaceId: task().workspaceId, workspaces: workspaces(),
      sessions: { ...sessions(), byId: {} }, disabled: false, t: translate(),
      listSessions: vi.fn(async () => ({ sessions: [], truncated: false })), onChange: changed }
    const view = render(<ConnectionPicker {...props} />)
    screen.getByRole('option', { name: dsh.sessionId })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(changed).toHaveBeenCalledExactlyOnceWith(undefined)
    view.rerender(<ConnectionPicker {...props} value={copilot} workspaces={{ ...workspaces(), items: [] }} />)
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  it('projects and clears the selected Copilot identity independently of another provider selection', async () => {
    const changed = vi.fn()
    const props = { kind: 'copilot' as const, value: copilot, workspaceId: task().workspaceId,
      workspaces: workspaces(), sessions: sessions(), disabled: false, t: translate(),
      listSessions: vi.fn(async () => ({ sessions: [{ sessionId: copilot.sessionId, status: 'idle' as const }], truncated: false })),
      onChange: changed }
    const view = render(<ConnectionPicker {...props} />)
    await screen.findByRole('option', { name: new RegExp(en.copilotIdle) })
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(changed).toHaveBeenLastCalledWith(undefined)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: copilot.sessionId } })
    expect(changed).toHaveBeenLastCalledWith(copilot)
    view.rerender(<ConnectionPicker {...props} value={dsh} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('')
  })
})
