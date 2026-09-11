// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewTaskDialog, type NewTaskDialogProps } from '../src/client/NewTaskDialog.tsx'
import { en } from '../src/client/locales.ts'
import { copilot, dsh, options, sessions, task, translate, workspaces } from './fixtures.client.ts'

afterEach(cleanup)

function props(overrides: Partial<NewTaskDialogProps> = {}): NewTaskDialogProps {
  return {
    workspaceId: task().workspaceId, workspaces: workspaces(), sessions: sessions(), status: 'todo', options, t: translate(),
    listAgencyCopilotSessions: vi.fn<NewTaskDialogProps['listAgencyCopilotSessions']>(async () => ({
      sessions: [{ sessionId: copilot.sessionId, status: 'idle' }], truncated: false,
    })),
    onCancel: vi.fn(), onCreate: vi.fn<NewTaskDialogProps['onCreate']>(async request => task({
      ...request, id: 'created' as ReturnType<typeof task>['id'],
    })),
    onCreated: vi.fn(), onArchiveOriginal: vi.fn(async () => {}), ...overrides,
  }
}

const change = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
const select = (name: string, value: string) => fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } })

describe('New Task execution drafts', () => {
  it('requires a title for Save and Close and treats an unmarked form submission as Save', async () => {
    const value = props()
    render(<NewTaskDialog {...value} />)
    fireEvent.click(screen.getByRole('button', { name: en.saveAndClose }))
    expect(value.onCreate).not.toHaveBeenCalled()
    change(en.taskTitle, 'Keyboard draft')
    const form = screen.getByRole('textbox', { name: en.taskTitle }).closest('form')
    if (form === null) throw new Error('Creation form is missing')
    fireEvent.submit(form)
    await waitFor(() => {
      expect(value.onCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Keyboard draft' }), false)
    })
  })

  it.each([false, true])('retains the close choice while retrying source archival: %s', async (closeAfterSave) => {
    const value = props({ sourceTask: task(), initial: { workspaceId: task().workspaceId, title: 'Copy' } })
    vi.mocked(value.onArchiveOriginal).mockRejectedValueOnce(new Error('Archive rejected'))
    render(<NewTaskDialog {...value} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.archiveOriginal }))
    fireEvent.click(screen.getByRole('button', { name: closeAfterSave ? en.saveAndClose : en.save }))
    await screen.findByText(/Archive rejected/)
    expect(value.onCreated).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: en.cancel })).toBeNull()
    expect(screen.queryByRole('button', { name: en.saveAndClose })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retryArchive }))
    await waitFor(() => {
      expect(value.onCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Copy' }), closeAfterSave)
    })
    expect(value.onCreate).toHaveBeenCalledOnce()
    expect(value.onArchiveOriginal).toHaveBeenCalledTimes(2)
  })

  it('offers no Sessions for a copied Workspace that is no longer available until a destination is selected', async () => {
    const value = props()
    render(<NewTaskDialog {...value} initial={{ title: 'Orphaned copy', workspaceId: 'removed' as typeof value.workspaceId }} />)
    expect(screen.queryByRole('option', { name: 'Existing DSH' })).toBeNull()
    select(en.workspace, value.workspaceId)
    screen.getByRole('option', { name: 'Existing DSH' })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(value.onCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: value.workspaceId })) })
  })

  it('clears selected connections when retargeting the Workspace or provider and saves edited planning fields', async () => {
    const value = props()
    const other = { ...value.workspaces.items[0]!, workspaceId: 'second' as typeof value.workspaceId,
      title: 'Second Workspace', sessionIds: [] }
    render(<NewTaskDialog {...value} workspaces={{ ...value.workspaces, items: [...value.workspaces.items, other] }} />)
    change(en.taskTitle, 'Created task')
    change(en.description, 'Planning description')
    change(en.labels, ' one, two ,, three ')
    select(en.priority, 'urgent')
    select(en.linkedSession, dsh.sessionId)
    select(en.workspace, other.workspaceId)
    select(en.connectionKind, 'copilot')
    await screen.findByRole('option', { name: new RegExp(copilot.sessionId) })
    select(en.copilotSession, copilot.sessionId)
    select(en.connectionKind, 'dsh')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(value.onCreated).toHaveBeenCalledOnce() })
    expect(value.onCreate).toHaveBeenCalledExactlyOnceWith({
      workspaceId: other.workspaceId, title: 'Created task', description: 'Planning description', status: 'todo',
      labels: ['one', 'two', 'three'], priority: 'urgent', prompt: '', executionSettings: { kind: 'dsh' },
    })
    expect(value.onArchiveOriginal).not.toHaveBeenCalled()
  })

  it('preserves explicit schedule and handover inputs while permitting removal of a copied priority', async () => {
    const schedule = { enabled: false, cron: '0 9 * * *', timeZone: 'UTC' }
    const handover = { goal: 'Review', progress: 'Inspected', next: 'Discuss', references: ['README.md'], frozenAt: '2026-01-01' }
    const value = props({ sourceTask: task({ archivedAt: '2026-01-02' }), initial: {
      workspaceId: task().workspaceId, title: 'Copy', priority: 'high', schedule, handover,
    } })
    render(<NewTaskDialog {...value} />)
    expect(screen.queryByRole('checkbox', { name: en.archiveOriginal })).toBeNull()
    select(en.priority, '')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await waitFor(() => { expect(value.onCreated).toHaveBeenCalledOnce() })
    expect(value.onCreate).toHaveBeenCalledWith(expect.objectContaining({ schedule, handover }))
    const request = vi.mocked(value.onCreate).mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('priority')
    expect(value.onArchiveOriginal).not.toHaveBeenCalled()
  })

  it('lets a user finish a created copy after a separately reported archival failure without creating twice', async () => {
    const value = props({ sourceTask: task(), initial: { workspaceId: task().workspaceId, title: 'Copy' } })
    vi.mocked(value.onArchiveOriginal).mockRejectedValue('Archive store unavailable')
    render(<NewTaskDialog {...value} />)
    fireEvent.click(screen.getByRole('checkbox', { name: en.archiveOriginal }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(/Archive store unavailable/)
    expect(value.onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.finishCopy }))
    expect(value.onCreated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Copy' }), true)
    expect(value.onCreate).toHaveBeenCalledOnce()
    expect(value.onArchiveOriginal).toHaveBeenCalledOnce()
  })

  it('retains an opaque creation failure and disables submission until authoritative options exist', async () => {
    const value = props()
    vi.mocked(value.onCreate).mockRejectedValueOnce('Create store unavailable')
    const view = render(<NewTaskDialog {...value} options={undefined} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.save }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.saveAndClose }).disabled).toBe(true)
    view.rerender(<NewTaskDialog {...value} />)
    change(en.taskTitle, 'Retained title')
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    await screen.findByText(/Create store unavailable/)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).value).toBe('Retained title')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(value.onCancel).toHaveBeenCalledOnce()
    expect(value.onCreated).not.toHaveBeenCalled()
  })
})
