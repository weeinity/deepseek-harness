// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobView, JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type { GoalProjection } from '@deepseek-ai/dsh-goal/client'
import type { TaskboardLauncherProps } from '../src/client/contract.ts'
import { TaskCard, type TaskCardProps } from '../src/client/TaskCard.tsx'
import { TaskboardLauncher } from '../src/client/TaskboardLauncher.tsx'
import { ConnectionPicker } from '../src/client/ConnectionPicker.tsx'
import { agencyStatusLabel, priorityLabel, statusLabel, taskActivity, taskboardErrorText, taskTimeLabel, workspaceTitle } from '../src/client/view.ts'
import { en, zh } from '../src/client/locales.ts'
import { copilot, dsh, jobs, sessions, task, translate, workspaces } from './fixtures.client.ts'

afterEach(cleanup)

function activity() {
  const state = sessions()
  const goal: GoalProjection = { goal: {
    id: 'goal' as GoalProjection['goal']['id'], revision: 1, objective: 'Review', phase: 'blocked',
    blockedReason: { code: 'review-needed', message: 'Review requested' }, maxGoalRounds: 5,
  }, roundsStarted: 1, createdAt: 0, updatedAt: 1 }
  state.byId[dsh.sessionId] = { ...state.byId[dsh.sessionId]!, running: true, projectionValues: { goal } }
  const rows: JobView[] = (['running', 'stopping', 'completed'] as const).map((status, index) => ({
    id: `job-${index}` as JobView['id'], kind: 'bash', label: 'Work', status, startedAt: 0,
    output: { total: 0, earliest: 0 },
  }))
  return { sessions: state, jobs: { rows: { [dsh.sessionId]: rows }, observed: {} } satisfies JobsSnapshot }
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
    const state = activity()
    const row = task({ connection: dsh })
    expect(taskActivity(row, state.sessions, state.jobs)).toEqual({ running: true, jobs: 2, blocked: true })
    expect(taskActivity(task({ connection: copilot }), state.sessions, state.jobs)).toEqual({ running: false, jobs: 0, blocked: false })
    expect(taskActivity(row, { ...state.sessions, byId: {} }, jobs())).toEqual({ running: false, jobs: 0, blocked: false })
    expect(row.status).toBe('todo')
  })

  it('opens cards only with activation keys and handles native drag events when enabled', () => {
    const props: TaskCardProps = {
      task: task({ connection: dsh, priority: 'urgent', labels: ['one', 'two', 'three', 'four', 'hidden'] }),
      sessions: activity().sessions, jobs: activity().jobs,
      agencyStatus: undefined, t: translate(), now: Date.parse('2026-01-01'),
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

  it.each([16, 18])('renders the decorative launcher glyph at size %s', (size) => {
    const { container } = render(<TaskboardLauncher {...{ size, active: true } as TaskboardLauncherProps} />)
    const icon = container.querySelector('svg')
    expect(icon?.getAttribute('width')).toBe(String(size))
    expect(icon?.getAttribute('height')).toBe(String(size))
    expect(screen.queryByRole('button')).toBeNull()
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
