// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskDetailsDialogProps } from '../src/client/TaskDetailsDialog.tsx'
import { TaskDetailsDialog } from '../src/client/TaskDetailsDialog.tsx'
import { en, zh } from '../src/client/locales.ts'
import { TASK_STATUSES, statusLabel } from '../src/client/view.ts'
import { copilot, dsh, execution, options, sessions, task, translate, workspaces } from './fixtures.client.ts'

function props(overrides: Partial<TaskboardTask> = {}) {
  return {
    task: task(overrides), sessions: sessions(), workspaces: workspaces(), t: translate(), now: Date.parse('2026-01-01T01:00:00Z'),
    options, error: undefined, notice: undefined,
    onClose: vi.fn(), onSave: vi.fn<TaskDetailsDialogProps['onSave']>(async () => {}), onMove: vi.fn(async () => {}),
    onArchive: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onRestore: vi.fn(async () => {}), onDuplicate: vi.fn(),
    onStart: vi.fn<TaskDetailsDialogProps['onStart']>(async () => {}), onOpenSession: vi.fn(),
    onConnect: vi.fn<TaskDetailsDialogProps['onConnect']>(async () => {}), onDisconnect: vi.fn(async () => {}),
    onConfirmPermissions: vi.fn(async () => {}), agencyStatus: undefined, isLoopback: true,
    onOpenAgencyCopilot: vi.fn(async () => {}), onRefreshAgencyCopilot: vi.fn(async () => {}),
    listAgencyCopilotSessions: vi.fn(async () => ({ sessions: [{ sessionId: copilot.sessionId, status: 'idle' as const }], truncated: false })),
  } satisfies TaskDetailsDialogProps
}
afterEach(cleanup)
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })

describe('TaskDetailsDialog execution management', () => {
  it.each([en, zh])('places Save and Close immediately before Save in the selected locale', (dictionary) => {
    const value = props()
    render(<TaskDetailsDialog {...value} t={translate(dictionary)} />)
    const actions = screen.getAllByRole('button')
    expect(actions[actions.indexOf(button(dictionary.saveAndClose)) + 1]).toBe(button(dictionary.save))
    expect(button(dictionary.archive).disabled).toBe(false)
    expect(button(dictionary.deleteTask).disabled).toBe(false)
  })

  it.each(['succeeded', 'failed'] as const)('closes after Save and Close only when saving %s', async (outcome) => {
    const value = props({ revision: 4 })
    const gate = Promise.withResolvers<undefined>()
    value.onSave.mockReturnValueOnce(gate.promise)
    const view = render(<TaskDetailsDialog {...value} />)
    change(en.description, 'Retained draft')
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, revision: 5 }} />)
    try {
      fireEvent.click(button(en.saveAndClose))
      expect(value.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'Retained draft' }), 4)
      expect(button(en.save).disabled).toBe(true)
      expect(button(en.saveAndClose).disabled).toBe(true)
      expect(value.onClose).not.toHaveBeenCalled()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(value.onClose).not.toHaveBeenCalled()
      if (outcome === 'succeeded') {
        gate.resolve(undefined)
        await waitFor(() => { expect(value.onClose).toHaveBeenCalledOnce() })
      } else {
        gate.reject(new Error('Revision conflict'))
        await screen.findByText(/Revision conflict/)
        expect(value.onClose).not.toHaveBeenCalled()
        expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.description }).value).toBe('Retained draft')
        fireEvent.click(button(en.saveAndClose))
        await waitFor(() => { expect(value.onClose).toHaveBeenCalledOnce() })
        expect(value.onSave.mock.calls[1]?.[1]).toBe(4)
      }
      expect(value.onStart).not.toHaveBeenCalled()
    } finally { gate.resolve(undefined) }
  })

  it.each([en, zh])('enables only the Host-projected manual destinations in the selected locale', async (dictionary) => {
    const value = props()
    const t = translate(dictionary)
    const view = render(<TaskDetailsDialog {...value} t={t} />)
    for (const status of TASK_STATUSES) {
      const row = task({ status })
      view.rerender(<TaskDetailsDialog {...value} task={row} t={t} />)
      for (const destination of TASK_STATUSES) {
        expect(button(statusLabel(t, destination)).disabled).toBe(!row.allowedManualStatuses.includes(destination))
      }
    }
    view.rerender(<TaskDetailsDialog {...value} t={t} />)
    expect(button(dictionary.todo).disabled).toBe(true)
    expect(button(dictionary.inProgress).disabled).toBe(false)
    expect(button(dictionary.inReview).disabled).toBe(false)
    expect(button(dictionary.done).disabled).toBe(false)
    fireEvent.click(button(dictionary.inProgress))
    await waitFor(() => { expect(value.onMove).toHaveBeenCalledExactlyOnceWith('in_progress') })
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('saves an unchanged task against its displayed revision without submitting work', async () => {
    const value = props({ revision: 4 })
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(value.onSave).toHaveBeenCalledWith(expect.objectContaining({ title: value.task.title }), 4) })
    expect(value.onClose).not.toHaveBeenCalled()
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it.each(['dsh', 'copilot'] as const)('resolves a legacy DSH choice from saved %s settings explicitly', async (kind) => {
    const saved = kind === 'dsh' ? { kind, presetId: 'standard', permission: 'read-only' } : { kind, permission: 'read-only' as const }
    const value = props({ unresolvedConnections: [dsh, copilot], executionSettings: saved })
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(`${en.dsh}: ${dsh.sessionId}`))
    await waitFor(() => { expect(value.onConnect).toHaveBeenCalledWith(dsh, kind === 'dsh' ? saved : { kind: 'dsh' }) })
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('shows a pending Copilot reservation and scheduled trigger without enabling native navigation', () => {
    const value = props({ connection: copilot, executionSettings: { kind: 'copilot' },
      executions: [execution('pending', { connection: copilot, trigger: 'schedule', createsConnection: true,
        executionSettings: { kind: 'copilot' } })] })
    render(<TaskDetailsDialog {...value} />)
    expect(screen.getAllByText(en['execution.pending'])).toHaveLength(2)
    screen.getByText(en.scheduledRun)
    expect(button(en.openAgencyCopilot).disabled).toBe(true)
    expect(button(`${en.copilot}: ${copilot.sessionId}`).disabled).toBe(true)
    expect(value.onOpenAgencyCopilot).not.toHaveBeenCalled()
  })

  it('edits an unconnected Workspace and clears a priority without submitting work', async () => {
    const value = props({ priority: 'high' })
    const other = { ...value.workspaces.items[0]!, workspaceId: 'second' as typeof value.task.workspaceId, title: 'Second Workspace', sessionIds: [] }
    render(<TaskDetailsDialog {...value} workspaces={{ ...value.workspaces, items: [...value.workspaces.items, other] }} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.workspace }), { target: { value: other.workspaceId } })
    fireEvent.change(screen.getByRole('combobox', { name: en.priority }), { target: { value: '' } })
    fireEvent.click(button(en.save))
    await waitFor(() => {
      expect(value.onSave).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: other.workspaceId, priority: null }), value.task.revision,
      )
    })
    expect(value.onConnect).not.toHaveBeenCalled()
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('switches disconnected execution providers only through a saved field update', async () => {
    const value = props()
    const view = render(<TaskDetailsDialog {...value} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.connectionKind }), { target: { value: 'copilot' } })
    await screen.findByRole('combobox', { name: en.copilotSession })
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(button(en.save).disabled).toBe(false) })
    expect(value.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ executionSettings: { kind: 'copilot', permission: 'read-only' } }), 1)
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, revision: 2, executionSettings: { kind: 'copilot', permission: 'read-only' } }} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.connectionKind }), { target: { value: 'dsh' } })
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(value.onSave).toHaveBeenLastCalledWith(expect.objectContaining({ executionSettings: { kind: 'dsh' } }), 2) })
    expect(value.onConnect).not.toHaveBeenCalled()
  })

  it('keeps manual status changes available for a clean running task and reports a rejected move', async () => {
    const value = props({ status: 'in_progress', connection: dsh, executions: [execution('running')] })
    value.onMove.mockRejectedValueOnce('Move was rejected')
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.inReview))
    await screen.findByText(translate()('error', { message: 'Move was rejected' }))
    expect(value.onMove).toHaveBeenCalledExactlyOnceWith('in_review')
    expect(button(en.inReview).disabled).toBe(false)
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('keeps delete confirmation during a pending failure and lets the user cancel it afterward', async () => {
    const value = props()
    const gate = Promise.withResolvers<undefined>()
    value.onDelete.mockReturnValue(gate.promise)
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.deleteTask))
    fireEvent.click(button(en.cancel))
    screen.getByRole('dialog', { name: en.taskDetails })
    fireEvent.click(button(en.deleteTask))
    try {
      fireEvent.click(button(en.deleteTask))
      fireEvent.keyDown(document, { key: 'Escape' })
      screen.getByRole('dialog', { name: en.deleteTaskTitle })
      gate.reject(new Error('Delete rejected'))
      await screen.findByText(/Delete rejected/)
      fireEvent.keyDown(document, { key: 'Escape' })
      screen.getByRole('dialog', { name: en.taskDetails })
      expect(value.onClose).not.toHaveBeenCalled()
    } finally { gate.resolve(undefined) }
  })

  it('refreshes a linked Copilot observation and permits withdrawing an unsent permission review', async () => {
    const value = props({ connection: copilot, executionSettings: { kind: 'copilot', permission: 'full-access' } })
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.refreshCopilot))
    await waitFor(() => { expect(button(en.refreshCopilot).disabled).toBe(false) })
    expect(value.onRefreshAgencyCopilot).toHaveBeenCalledOnce()
    const review = screen.getByRole('checkbox', { name: en.confirmPermissionCheck })
    fireEvent.click(review)
    expect(button(en.confirmPermissions).disabled).toBe(false)
    fireEvent.click(review)
    expect(button(en.confirmPermissions).disabled).toBe(true)
    expect(value.onConfirmPermissions).not.toHaveBeenCalled()
  })

  it('renders historical models and frozen handover independently of current options and Workspace availability', () => {
    const handover = { goal: 'Previous goal', progress: 'Previous progress', next: 'Previous next', references: ['saved-reference'],
      source: dsh, frozenAt: '2026-01-01T00:00:00Z' }
    const value = props({ archivedAt: '2026-01-02', executions: [
      execution('succeeded', { executionSettings: { kind: 'dsh', presetId: 'Old preset', permission: 'read-only',
        model: { provider: 'former-provider', model: 'former-model' } }, handover }),
      execution('failed', { connection: copilot, executionSettings: { kind: 'copilot', model: 'former-copilot' } }),
    ] })
    render(<TaskDetailsDialog {...value} workspaces={{ ...value.workspaces, items: [] }} />)
    screen.getByText('Old preset')
    screen.getByText('former-provider: former-model')
    screen.getByText('former-copilot')
    for (const text of ['Previous goal', 'Previous progress', 'Previous next', 'saved-reference']) screen.getByText(text)
    expect(screen.getByText(new RegExp(handover.frozenAt))).toBeTruthy()
  })

  it('explains unavailable native execution and disables local terminal navigation', () => {
    const value = props({ connection: copilot, executionSettings: { kind: 'copilot' } })
    render(<TaskDetailsDialog {...value} isLoopback={false} options={{ ...options, copilotAvailable: false }} />)
    expect(button(en.startWork).disabled).toBe(true)
    expect(button(en.openAgencyCopilot).disabled).toBe(true)
    screen.getByText(en.copilotExecutionUnavailable)
  })
  it.each([en, zh])('renders one connection kind and all five workflow statuses in the selected locale', (dictionary) => {
    const value = props()
    render(<TaskDetailsDialog {...value} t={translate(dictionary)} />)
    for (const status of ['backlog', 'todo', 'inProgress', 'inReview', 'done'] as const) button(dictionary[status])
    expect(screen.queryByRole('combobox', { name: dictionary.copilotSession })).toBeNull()
    expect(screen.getByRole('combobox', { name: dictionary.linkedSession })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: dictionary.prompt })).toBeTruthy()
    expect(screen.getByText(dictionary.startWorkHint)).toBeTruthy()
  })

  it('connects a same-Workspace Session without running or opening it', async () => {
    const value = props()
    render(<TaskDetailsDialog {...value} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.linkedSession }), { target: { value: dsh.sessionId } })
    expect(button(en.startWork).disabled).toBe(true)
    fireEvent.click(button(en.connect))
    await waitFor(() =>{  expect(value.onConnect).toHaveBeenCalledExactlyOnceWith(dsh) })
    expect(value.onStart).not.toHaveBeenCalled()
    expect(value.onOpenSession).not.toHaveBeenCalled()
    expect(value.listAgencyCopilotSessions).not.toHaveBeenCalled()
  })

  it('excludes Sessions outside the task Workspace even if present in the Session list', () => {
    const value = props()
    const other = 'other-session' as typeof dsh.sessionId
    value.sessions.ids.push(other)
    value.sessions.byId[other] = { id: other, displayTitle: 'Another Workspace', blank: false, running: false, updatedAt: 1 }
    render(<TaskDetailsDialog {...value} />)
    const picker = screen.getByRole('combobox', { name: en.linkedSession })
    expect(within(picker).getByRole('option', { name: 'Existing DSH' })).toBeTruthy()
    expect(within(picker).queryByRole('option', { name: 'Another Workspace' })).toBeNull()
  })

  it('blocks duplicate clicks until Host admission settles', async () => {
    const value = props()
    const admission = Promise.withResolvers<undefined>()
    value.onStart.mockReturnValue(admission.promise)
    render(<TaskDetailsDialog {...value} />)
    try {
      fireEvent.click(button(en.startWork))
      fireEvent.click(button(en.startWork))
      expect(value.onStart).toHaveBeenCalledOnce()
      expect(button(en.startWork).disabled).toBe(true)
    } finally { admission.resolve(undefined) }
    await waitFor(() => { expect(button(en.startWork).disabled).toBe(false) })
  })

  it('preserves legacy choices until one is explicitly connected', async () => {
    const value = props({ unresolvedConnections: [dsh, copilot] })
    render(<TaskDetailsDialog {...value} />)
    expect(button(en.startWork).disabled).toBe(true)
    screen.getByText(en.legacyHint)
    fireEvent.click(button(`${en.copilot}: ${copilot.sessionId}`))
    await waitFor(() =>{  expect(value.onConnect).toHaveBeenCalledExactlyOnceWith(copilot, { kind: 'copilot', permission: 'read-only' }) })
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it.each([dsh, copilot])('keeps $kind read-only, opens without prompt, and exposes explicit disconnect', async (connection) => {
    const value = props({ connection, executionSettings: connection.kind === 'dsh' ? { kind: 'dsh' } : { kind: 'copilot' } })
    render(<TaskDetailsDialog {...value} />)
    expect(screen.queryByRole('combobox', { name: en.connectionKind })).toBeNull()
    fireEvent.click(button(connection.kind === 'dsh' ? en.openSession : en.openAgencyCopilot))
    await waitFor(() =>{  expect(button(en.disconnect).disabled).toBe(false) })
    expect(connection.kind === 'dsh' ? value.onOpenSession : value.onOpenAgencyCopilot).toHaveBeenCalledOnce()
    expect(value.onStart).not.toHaveBeenCalled()
    fireEvent.click(button(en.disconnect))
    await waitFor(() =>{  expect(value.onDisconnect).toHaveBeenCalledOnce() })
  })

  it('retains the exact conversation on Run Again without a separate status command', async () => {
    const value = props({ connection: dsh, executions: [execution('succeeded')], status: 'in_review' })
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.runAgain))
    await waitFor(() =>{  expect(button(en.runAgain).disabled).toBe(false) })
    expect(value.onStart).toHaveBeenCalledOnce()
    expect(value.onConnect).not.toHaveBeenCalled()
    expect(value.onMove).not.toHaveBeenCalled()
    expect(value.onOpenSession).not.toHaveBeenCalled()
  })

  it.each(['pending', 'running'] as const)('distinguishes %s and blocks competing attempts', (status) => {
    const value = props({ status: 'in_progress', connection: dsh, executions: [execution(status)] })
    render(<TaskDetailsDialog {...value} />)
    screen.getByText(en[`execution.${status}`])
    expect(button(en.runAgain).disabled).toBe(true)
    expect(button(en.disconnect).disabled).toBe(true)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.prompt }).disabled).toBe(true)
    expect(button(en.inReview).disabled).toBe(false)
  })

  it.each(['pending', 'running'] as const)('saves planning fields during %s without writing frozen execution inputs', async (status) => {
    const value = props({ connection: dsh, executions: [execution(status)] })
    render(<TaskDetailsDialog {...value} />)
    for (const name of [en.taskTitle, en.description, en.labels]) {
      expect(screen.getByRole<HTMLInputElement>('textbox', { name }).disabled).toBe(false)
    }
    const priority = screen.getByRole<HTMLSelectElement>('combobox', { name: en.priority })
    expect(priority.disabled).toBe(false)
    change(en.taskTitle, 'Planning title')
    change(en.description, 'Planning description')
    change(en.labels, 'urgent, follow-up')
    fireEvent.change(priority, { target: { value: 'high' } })
    expect(button(en.save).disabled).toBe(false)
    fireEvent.click(button(en.save))
    await waitFor(() => {
      expect(value.onSave).toHaveBeenCalledExactlyOnceWith({
        title: 'Planning title', description: 'Planning description', priority: 'high', labels: ['urgent', 'follow-up'],
      }, value.task.revision)
    })
    expect(value.onStart).not.toHaveBeenCalled()
    expect(value.onMove).not.toHaveBeenCalled()
  })

  it('preserves an unsaved execution draft when another Client begins a run', () => {
    const value = props()
    const view = render(<TaskDetailsDialog {...value} />)
    change(en.prompt, 'Unsaved execution instructions')
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, revision: 2, connection: dsh,
      executions: [execution('running')] }} />)
    expect(button(en.save).disabled).toBe(true)
    expect(button(en.saveAndClose).disabled).toBe(true)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('Unsaved execution instructions')
    fireEvent.click(button(en.editAsCopy))
    expect(value.onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Unsaved execution instructions' }))
    expect(value.onSave).not.toHaveBeenCalled()
  })

  it('locks Workspace, provider, and preset while legacy connection choices remain unresolved', () => {
    const value = props({ unresolvedConnections: [dsh, copilot] })
    render(<TaskDetailsDialog {...value} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.workspace }).disabled).toBe(true)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.preset }).disabled).toBe(true)
    expect(screen.queryByRole('combobox', { name: en.connectionKind })).toBeNull()
    expect(button(en.startWork).disabled).toBe(true)
  })

  it('disables current and historical links to a pending conversation reservation without reporting it missing', () => {
    const value = props({ connection: dsh, executions: [execution('pending', { createsConnection: true, connection: dsh })] })
    value.sessions.byId = {}
    render(<TaskDetailsDialog {...value} />)
    expect(button(en.openSession).disabled).toBe(true)
    expect(button(`${en.dsh}: ${dsh.sessionId}`).disabled).toBe(true)
    expect(screen.queryByText(en.sessionMissing)).toBeNull()
    fireEvent.click(button(`${en.dsh}: ${dsh.sessionId}`))
    expect(value.onOpenSession).not.toHaveBeenCalled()
  })

  it.each([en.taskTitle, en.description, en.prompt, en.cron, en.goal])('requires saving an edited %s before Run', (field) => {
    const value = props()
    render(<TaskDetailsDialog {...value} />)
    change(field, 'Changed input')
    expect(button(en.startWork).disabled).toBe(true)
    screen.getByText(en.startWorkSave)
  })

  it('retains errors and the draft on failed Save and permits explicit retry', async () => {
    const value = props()
    value.onSave.mockRejectedValueOnce(new Error('Invalid cron: requires 5 fields'))
    render(<TaskDetailsDialog {...value} />)
    change(en.cron, 'bad cron')
    fireEvent.click(button(en.save))
    await screen.findByText(/Invalid cron: requires 5 fields/)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.cron }).value).toBe('bad cron')
    expect(button(en.startWork).disabled).toBe(true)
    change(en.cron, '*/10 * * * *')
    fireEvent.click(button(en.save))
    await waitFor(() =>{  expect(value.onSave).toHaveBeenCalledTimes(2) })
    expect(value.onSave.mock.calls[1]?.[0].schedule).toMatchObject({ enabled: false, cron: '*/10 * * * *', timeZone: options.timeZone })
  })

  it('retains the draft base revision when another Client changes the task', async () => {
    const value = props()
    const view = render(<TaskDetailsDialog {...value} />)
    change(en.description, 'My unsaved description')
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, revision: 2, title: 'Edited elsewhere' }} />)
    fireEvent.click(button(en.save))
    await waitFor(() => {
      expect(value.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        title: value.task.title, description: 'My unsaved description',
      }), 1)
    })
  })

  it('uses one retry identity after a failed admission and another after a successful Run', async () => {
    const value = props()
    value.onStart.mockRejectedValueOnce(new Error('Connection lost'))
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.startWork))
    await screen.findByText(/Connection lost/)
    fireEvent.click(button(en.startWork))
    await waitFor(() =>{  expect(button(en.startWork).disabled).toBe(false) })
    expect(value.onStart.mock.calls[0]?.[0]).toBe(value.onStart.mock.calls[1]?.[0])
    fireEvent.click(button(en.startWork))
    await waitFor(() =>{  expect(value.onStart).toHaveBeenCalledTimes(3) })
    expect(value.onStart.mock.calls[2]?.[0]).not.toBe(value.onStart.mock.calls[1]?.[0])
  })

  it('shows a missing connected Session explicitly without creating a replacement', () => {
    const value = props({ connection: dsh })
    value.sessions.byId = {}
    render(<TaskDetailsDialog {...value} />)
    screen.getByRole('alert')
    screen.getByText(en.sessionMissing)
    expect(button(en.openSession).disabled).toBe(true)
    expect(value.onConnect).not.toHaveBeenCalled()
  })

  it('orders history newest first and retains outcome, errors, timestamps, and each connection link', async () => {
    const value = props({ executions: [
      execution('succeeded'), execution('failed', { connection: copilot, error: { code: 'dispatch', message: 'Agent unavailable' } }),
      execution('cancelled'),
    ] })
    render(<TaskDetailsDialog {...value} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map(row => within(row).getByText(/^(Succeeded|Failed|Cancelled)$/).textContent)).toEqual(['Cancelled', 'Failed', 'Succeeded'])
    screen.getByText('dispatch: Agent unavailable')
    expect(within(rows[1]!).getByText(/Started/)).toBeTruthy()
    expect(within(rows[1]!).getByText(/Ended/)).toBeTruthy()
    fireEvent.click(within(rows[1]!).getByRole('button'))
    await waitFor(() =>{  expect(value.onOpenAgencyCopilot).toHaveBeenCalledExactlyOnceWith('failed') })
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('edits authoritative presets, model, permission, schedule and preserves frozen handover on unrelated edits', async () => {
    const handover = { goal: 'Goal', progress: 'Progress', next: 'Next', references: ['Q:\\source'], source: dsh, frozenAt: '2026-01-01T00:00:00Z' }
    const value = props({ handover })
    render(<TaskDetailsDialog {...value} />)
    expect(screen.getByRole<HTMLOptionElement>('option', { name: /Broken agent/ }).disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: en.preset }), { target: { value: 'default' } })
    fireEvent.change(screen.getByRole('combobox', { name: en.model }), { target: { value: JSON.stringify(['deepseek', 'deepseek-chat']) } })
    change(en.reasoningEffort, 'high')
    fireEvent.change(screen.getByRole('combobox', { name: en.schedulePreset }), { target: { value: 'monday9' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.scheduleEnabled }))
    fireEvent.click(button(en.save))
    await waitFor(() =>{  expect(value.onSave).toHaveBeenCalledOnce() })
    expect(value.onSave.mock.calls[0]?.[0]).toMatchObject({
      handover, schedule: { enabled: true, cron: '0 9 * * 1', timeZone: options.timeZone },
      executionSettings: { kind: 'dsh', presetId: 'default', model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } },
    })
    expect(value.onSave.mock.calls[0]?.[0].handover).toBe(handover)
  })

  it('keeps Host schedule timestamps out of writes and leaves unchanged schedules untouched', async () => {
    const value = props({ schedule: {
      enabled: true, cron: '0 9 * * *', timeZone: 'UTC', nextRunAt: '2026-01-02T09:00:00Z', lastTriggeredAt: '2026-01-01T09:00:00Z',
    } })
    render(<TaskDetailsDialog {...value} />)
    screen.getByText('Next run: 2026-01-02T09:00:00Z')
    change(en.description, 'Planning-only edit')
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(button(en.save).disabled).toBe(false) })
    expect(value.onSave.mock.calls[0]?.[0]).not.toHaveProperty('schedule')
    change(en.cron, '0 * * * *')
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(value.onSave).toHaveBeenCalledTimes(2) })
    expect(value.onSave.mock.calls[1]?.[0].schedule).toEqual({ enabled: true, cron: '0 * * * *', timeZone: 'UTC' })
  })

  it('requires explicit permission review and sends confirmation only for saved inputs', async () => {
    const value = props({ executionSettings: { kind: 'copilot', permission: 'full-access' } })
    render(<TaskDetailsDialog {...value} />)
    expect(button(en.confirmPermissions).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirmPermissionCheck }))
    fireEvent.click(button(en.confirmPermissions))
    await waitFor(() =>{  expect(value.onConfirmPermissions).toHaveBeenCalledOnce() })
    change(en.goal, 'Updated goal')
    expect(button(en.confirmPermissions).disabled).toBe(true)
    expect(button(en.startWork).disabled).toBe(true)
  })

  it('invalidates an unsent permission review when a newer task revision arrives', () => {
    const value = props({ executionSettings: { kind: 'copilot', permission: 'workspace-write' } })
    const view = render(<TaskDetailsDialog {...value} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirmPermissionCheck }))
    expect(button(en.confirmPermissions).disabled).toBe(false)
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, revision: value.task.revision + 1,
      executionSettings: { kind: 'copilot', permission: 'full-access' } }} />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.confirmPermissionCheck }).checked).toBe(false)
    expect(button(en.confirmPermissions).disabled).toBe(true)
    expect(value.onConfirmPermissions).not.toHaveBeenCalled()
  })

  it('restores read-only archived tasks and opens editable copies without copying connection or history', async () => {
    const value = props({ archivedAt: '2026-01-01', connection: dsh, executions: [execution('succeeded')] })
    render(<TaskDetailsDialog {...value} />)
    expect(screen.queryByRole('button', { name: en.runAgain })).toBeNull()
    fireEvent.click(button(en.duplicate))
    expect(value.onDuplicate.mock.calls[0]?.[0]).not.toHaveProperty('connection')
    expect(value.onDuplicate.mock.calls[0]?.[0]).not.toHaveProperty('executions')
    fireEvent.click(button(en.restore))
    await waitFor(() =>{  expect(value.onRestore).toHaveBeenCalledOnce() })
  })

  it('keeps delete confirmation open on failure and closes only through a deliberate action', async () => {
    const value = props()
    value.onDelete.mockRejectedValueOnce(new Error('Revision conflict'))
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(button(en.deleteTask))
    fireEvent.click(button(en.deleteTask))
    await screen.findByText(/Revision conflict/)
    expect(screen.getByRole('dialog', { name: en.deleteTaskTitle })).toBeTruthy()
    fireEvent.click(button(en.cancel))
    expect(screen.getByRole('dialog', { name: en.taskDetails })).toBeTruthy()
  })
})
