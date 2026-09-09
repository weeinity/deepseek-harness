// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardSurfaceProps } from '../src/client/contract.ts'
import { TaskDetailsDialog } from '../src/client/TaskDetailsDialog.tsx'
import { en } from '../src/client/locales.ts'

const t = ((key: keyof typeof en, values?: Record<string, string>) => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(values ?? {})) value = value.replace('{' + name + '}', replacement)
  return value
}) as TaskboardSurfaceProps['t']

function task(copilot = false): TaskboardTask {
  return {
    id: 'task' as TaskboardTask['id'], revision: 1, ordinal: 1,
    workspaceId: 'workspace' as TaskboardTask['workspaceId'], title: 'Investigate', description: '',
    status: 'todo', rank: 0, labels: [],
    ...(copilot ? {
      agencyCopilotSessionId: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as NonNullable<TaskboardTask['agencyCopilotSessionId']>,
    } : {}),
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function props(copilot = false) {
  return {
    task: task(copilot),
    sessions: { byId: {}, jobsBySession: {} } as never,
    workspaces: { items: [{ workspaceId: 'workspace', title: 'mip' }] } as never,
    t,
    now: Date.parse('2026-01-01T01:00:00.000Z'),
    error: undefined,
    notice: undefined,
    onClose: vi.fn(), onSave: vi.fn(async () => {}), onMove: vi.fn(async () => {}),
    onArchive: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onStart: vi.fn(async () => {}), onOpenSession: vi.fn(),
    agencyStatus: copilot ? 'idle' as const : undefined,
    isLoopback: true,
    onStartAgencyCopilot: vi.fn(async () => {}), onOpenAgencyCopilot: vi.fn(async () => {}),
    onClearAgencyCopilot: vi.fn(async () => {}), onRefreshAgencyCopilot: vi.fn(async () => {}),
    listAgencyCopilotSessions: vi.fn<TaskboardSurfaceProps['listAgencyCopilotSessions']>(async () => ({ sessions: [], truncated: false })),
  }
}

afterEach(cleanup)

describe('TaskDetailsDialog', () => {
  it('starts a fresh Copilot identity without using the native DSH Session action', () => {
    const value = props()
    render(<TaskDetailsDialog {...value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start with Copilot' }))
    expect(value.onStartAgencyCopilot).toHaveBeenCalledOnce()
    expect(value.onStart).not.toHaveBeenCalled()
  })

  it('offers open, refresh, and unlink for a durable Copilot identity', async () => {
    const value = props(true)
    render(<TaskDetailsDialog {...value} />)
    screen.getByText('Ready to resume')
    const open = screen.getByRole('button', { name: 'Open/Resume Copilot' })
    const refresh = screen.getByRole('button', { name: 'Refresh status' })
    const unlink = screen.getByRole('button', { name: 'Unlink' })
    fireEvent.click(open)
    await waitFor(() => { expect((refresh as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(refresh)
    await waitFor(() => { expect((unlink as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(unlink)
    expect(value.onOpenAgencyCopilot).toHaveBeenCalledOnce()
    expect(value.onRefreshAgencyCopilot).toHaveBeenCalledOnce()
    expect(value.onClearAgencyCopilot).toHaveBeenCalledOnce()
  })

  it('disables launch controls away from the local DSH page', () => {
    const value = { ...props(), isLoopback: false }
    render(<TaskDetailsDialog {...value} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Start with Copilot' }).disabled).toBe(true)
    screen.getByText('Copilot terminals can only be launched from the local DSH page.')
  })

  it('shows editable task details, status, timestamps, and saves the existing fields', () => {
    const value = props()
    render(<TaskDetailsDialog {...value} />)
    const dialog = screen.getByRole('dialog', { name: 'Task details' })
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    screen.getByText('Updated 1h ago')
    screen.getByText('Created 1h ago')
    const title = within(dialog).getByRole('textbox', { name: 'Title' })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Workspace' }).readOnly).toBe(true)
    expect(document.activeElement).toBe(title)
    fireEvent.change(title, { target: { value: 'Investigate timeout' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Capture diagnostics' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), { target: { value: 'high' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Labels' }), { target: { value: 'api, bug, ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(value.onSave).toHaveBeenCalledExactlyOnceWith('Investigate timeout', 'Capture diagnostics', 'high', ['api', 'bug'], undefined)
  })

  it('keeps archived task details read-only with deletion but no editing or launch actions', () => {
    const value = props(true)
    value.task = { ...value.task, archivedAt: value.task.updatedAt }
    render(<TaskDetailsDialog {...value} />)
    screen.getByText('This task is archived and read-only.')
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).readOnly).toBe(true)
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' }).readOnly).toBe(true)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Priority' }).disabled).toBe(true)
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close', 'Delete'])
    expect(screen.queryByText('Ready to resume')).toBeNull()
    expect(value.listAgencyCopilotSessions).not.toHaveBeenCalled()
  })

  it('shows operation errors and notices inside the dialog', () => {
    render(<TaskDetailsDialog {...props()} error="Action failed: revision conflict" notice="Launch requested" />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('alert').textContent).toBe('Action failed: revision conflict')
    expect(within(dialog).getByText('Launch requested').getAttribute('role')).toBe('status')
  })

  it('saves a replacement Copilot session and blocks terminal actions until that link is saved', async () => {
    const value = props(true)
    const replacement = '2eb3dbf2-8b82-4863-b505-520708dcce80' as NonNullable<TaskboardTask['agencyCopilotSessionId']>
    value.listAgencyCopilotSessions.mockResolvedValue({
      sessions: [{ sessionId: replacement, summary: 'Another investigation', status: 'in_use' }], truncated: false,
    })
    const view = render(<TaskDetailsDialog {...value} />)
    await screen.findByRole('option', { name: /Another investigation/ })
    fireEvent.change(screen.getByRole('combobox', { name: en.copilotSession }), { target: { value: replacement } })
    screen.getByText(en.copilotSessionSave)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open/Resume Copilot' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Unlink' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(value.onSave).toHaveBeenCalledExactlyOnceWith('Investigate', '', undefined, [], replacement) })
    expect(value.onOpenAgencyCopilot).not.toHaveBeenCalled()
    expect(value.onStartAgencyCopilot).not.toHaveBeenCalled()
    view.rerender(<TaskDetailsDialog {...value} task={{ ...value.task, agencyCopilotSessionId: replacement, revision: 2 }} />)
    expect(screen.queryByText(en.copilotSessionSave)).toBeNull()
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Unlink' }).disabled).toBe(false) })
    view.rerender(<TaskDetailsDialog {...value} task={task()} />)
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.copilotSession }).value).toBe('')
  })

  it('saves an explicit cleared link without starting or unlinking a terminal as a separate action', () => {
    const value = props(true)
    render(<TaskDetailsDialog {...value} />)
    fireEvent.change(screen.getByRole('combobox', { name: en.copilotSession }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(value.onSave).toHaveBeenCalledExactlyOnceWith('Investigate', '', undefined, [], null)
    expect(value.onClearAgencyCopilot).not.toHaveBeenCalled()
    expect(value.onStartAgencyCopilot).not.toHaveBeenCalled()
  })

  it('does not resend an unchanged link when saving metadata while session discovery is unavailable', async () => {
    const value = props(true)
    value.listAgencyCopilotSessions.mockRejectedValue(new Error('Agency offline'))
    render(<TaskDetailsDialog {...value} />)
    await screen.findByRole('alert')
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Updated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(value.onSave).toHaveBeenCalledExactlyOnceWith('Updated', '', undefined, [], undefined)
  })
  it('closes on Escape without altering a task', () => {
    const value = props()
    render(<TaskDetailsDialog {...value} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(value.onClose).toHaveBeenCalledOnce()
    expect(value.onSave).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'escape', 'close'] as const)('keeps the draft when deletion is dismissed with %s', (action) => {
    const value = props(true)
    render(<TaskDetailsDialog {...value} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unsaved title' } })
    fireEvent.click(screen.getByRole('button', { name: en.deleteTask }))
    const confirmation = screen.getByRole('dialog', { name: en.deleteTaskTitle })
    expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: en.cancel }))
    within(confirmation).getByText(en.deleteTaskMessage.replace('{title}', value.task.title))
    if (action === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    else fireEvent.click(within(confirmation).getByRole('button', { name: action === 'cancel' ? en.cancel : en.close }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Unsaved title')
    expect(value.onDelete).not.toHaveBeenCalled()
    expect(value.onClose).not.toHaveBeenCalled()
    expect(value.onSave).not.toHaveBeenCalled()
  })
})
