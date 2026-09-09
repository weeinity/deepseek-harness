// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TaskboardSnapshot, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TaskboardSurfaceProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { Taskboard } from '../src/client/Taskboard.tsx'

function makeTask(overrides: Partial<TaskboardTask> = {}): TaskboardTask {
  return {
    id: 'task' as TaskboardTask['id'], revision: 1, ordinal: 1,
    workspaceId: 'workspace' as WorkspaceId, title: 'Investigate', description: 'Collect diagnostic evidence.',
    status: 'todo', rank: 0, labels: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mountBoard(
  dictionary: Readonly<Record<keyof typeof en, string>> = en,
  tasks: readonly TaskboardTask[] = [],
  extraWorkspaces: WorkspaceSnapshot['items'] = [],
) {
  const workspaceId = 'workspace' as WorkspaceId
  let taskboard: TaskboardSnapshot = {
    tasks, state: 'idle', phase: 'ready', error: null,
    agencyByTask: {}, agencyState: 'idle', agencyError: null,
  }
  const sessions: SessionListState = {
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const workspaces: WorkspaceSnapshot = {
    items: [{
      workspaceId, title: 'Workspace', path: 'Q:\\workspace', sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }, ...extraWorkspaces],
    archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
  const createTask = vi.fn<TaskboardSurfaceProps['createTask']>(async (request) => {
    const created = makeTask(request)
    taskboard = { ...taskboard, tasks: [...taskboard.tasks, created] }
    return created
  })
  const locale = new LocaleRuntime(new Context())
  locale.register('taskboard', { en: dictionary, zh: dictionary })
  const props: TaskboardSurfaceProps = {
    useTaskboard: selector => selector(taskboard),
    useSessions: selector => selector(sessions),
    useWorkspaces: selector => selector(workspaces),
    useSessionPendingInteraction: selector => selector(new Map()),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
    t: locale.bind('taskboard'),
    createTask,
    updateTask: vi.fn(async () => {}),
    moveTask: vi.fn(async () => {}),
    archiveTask: vi.fn<TaskboardSurfaceProps['archiveTask']>(async (task) => {
      taskboard = { ...taskboard, tasks: taskboard.tasks.map(candidate => candidate.id === task.id
        ? { ...candidate, revision: candidate.revision + 1, archivedAt: '2026-01-02T00:00:00.000Z' }
        : candidate) }
    }),
    deleteTask: vi.fn<TaskboardSurfaceProps['deleteTask']>(async (task) => {
      taskboard = { ...taskboard, tasks: taskboard.tasks.filter(candidate => candidate.id !== task.id) }
    }),
    startWork: vi.fn(async () => {}),
    openSession: vi.fn(),
    agencyCopilotCapability: vi.fn(async () => false),
    listAgencyCopilotSessions: vi.fn(async () => ({ sessions: [], truncated: false })),
    startAgencyCopilot: vi.fn(async () => {}),
    openAgencyCopilot: vi.fn<TaskboardSurfaceProps['openAgencyCopilot']>(async () => 'resume-accepted'),
    clearAgencyCopilot: vi.fn(async () => {}),
    refreshAgencyCopilot: vi.fn(async () => {}),
    isLoopback: true,
    closeSurface: vi.fn(),
  }
  return { ...render(<Taskboard {...props} />), createTask, workspaceId, props, sessions, workspaces,
    setTaskboard: (update: Partial<TaskboardSnapshot>) => { taskboard = { ...taskboard, ...update } },
  }
}

afterEach(cleanup)

describe('Taskboard creation controls', () => {
  it.each([['English', en], ['Chinese', zh]] as const)(
    'keeps task creation in the header without column actions in %s',
    (_language, dictionary) => {
      const { container } = mountBoard(dictionary)
      const columns = container.querySelectorAll<HTMLElement>('section[data-status]')
      expect(columns).toHaveLength(5)
      for (const column of columns) {
        expect(within(column).getByText(dictionary.empty)).toBeTruthy()
        expect(within(column).queryByRole('button')).toBeNull()
      }
      expect(screen.getAllByRole('button', { name: dictionary.newTask })).toHaveLength(1)
    },
  )

  it.each([['English', en], ['Chinese', zh]] as const)(
    'shows the existing fields and optional Copilot session in the reference layout in %s',
    (_language, dictionary) => {
      mountBoard(dictionary)
      fireEvent.click(screen.getByRole('button', { name: dictionary.newTask }))
      const dialog = screen.getByRole('dialog', { name: dictionary.newTask })
      const title = within(dialog).getByRole('textbox', { name: dictionary.taskTitle })
      const description = within(dialog).getByRole('textbox', { name: dictionary.description })
      const workspace = within(dialog).getByRole('combobox', { name: dictionary.workspace })
      const copilot = within(dialog).getByRole('combobox', { name: dictionary.copilotSession })
      expect([...dialog.querySelectorAll('input, textarea, select')]).toEqual([title, description, workspace, copilot])
      expect(dialog.parentElement?.parentElement).toBe(document.body)
      expect(title.getAttribute('placeholder')).toBe(dictionary.taskTitlePlaceholder)
      expect(description.getAttribute('placeholder')).toBe(dictionary.taskDescriptionPlaceholder)
      expect(document.activeElement).toBe(title)
      expect(within(dialog).getAllByRole('button').map(button => button.textContent)).toEqual([
        dictionary.copilotSessionsRefresh, dictionary.cancel, dictionary.createTask,
      ])
      fireEvent.click(within(dialog).getByRole('button', { name: dictionary.cancel }))
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )

  it('requires a title before creating a task', () => {
    const { createTask } = mountBoard()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(createTask).not.toHaveBeenCalled()
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).validity.valueMissing).toBe(true)
  })

  it('creates a backlog task from the header', async () => {
    const { createTask, workspaceId } = mountBoard()
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Investigate request' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Check the request and document the result.' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull() })
    const details = screen.getByRole('dialog', { name: 'Task details' })
    expect(within(details).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Investigate request')
    expect(createTask).toHaveBeenCalledExactlyOnceWith({
      workspaceId, title: 'Investigate request', description: 'Check the request and document the result.', status: 'backlog',
    })
  })

  it('creates a task with the selected existing Copilot session without starting a terminal', async () => {
    const board = mountBoard()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as NonNullable<TaskboardTask['agencyCopilotSessionId']>
    vi.mocked(board.props.listAgencyCopilotSessions).mockResolvedValue({
      sessions: [{ sessionId, summary: 'Existing investigation', status: 'idle' }], truncated: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    await within(dialog).findByRole('option', { name: /Existing investigation/ })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Continue investigation' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.copilotSession }), { target: { value: sessionId } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await screen.findByRole('dialog', { name: 'Task details' })
    expect(board.createTask).toHaveBeenCalledExactlyOnceWith({
      workspaceId: board.workspaceId, title: 'Continue investigation', description: '', status: 'backlog', agencyCopilotSessionId: sessionId,
    })
    expect(board.props.startAgencyCopilot).not.toHaveBeenCalled()
    expect(board.props.startWork).not.toHaveBeenCalled()
  })

  it('clears the selected Copilot session when the new task Workspace changes', async () => {
    const otherWorkspace = 'other' as WorkspaceId
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as NonNullable<TaskboardTask['agencyCopilotSessionId']>
    const board = mountBoard(en, [], [{
      workspaceId: otherWorkspace, title: 'Other', path: 'Q:\\other', sessionIds: [],
      createdAt: '', updatedAt: '',
    }])
    vi.mocked(board.props.listAgencyCopilotSessions).mockImplementation(async workspaceId => ({
      sessions: workspaceId === board.workspaceId ? [{ sessionId, status: 'idle' }] : [], truncated: false,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    await within(dialog).findByRole('option', { name: new RegExp(sessionId) })
    const picker = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: en.copilotSession })
    fireEvent.change(picker, { target: { value: sessionId } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Workspace' }), { target: { value: otherWorkspace } })
    await within(dialog).findByText(en.copilotSessionsEmpty)
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: en.copilotSession }).value).toBe('')
    expect(within(dialog).queryByRole('option', { name: new RegExp(sessionId) })).toBeNull()
    expect(board.props.listAgencyCopilotSessions).toHaveBeenLastCalledWith(otherWorkspace)
  })

  it('retains the new task and selected session when Host validation rejects creation', async () => {
    const board = mountBoard()
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as NonNullable<TaskboardTask['agencyCopilotSessionId']>
    vi.mocked(board.props.listAgencyCopilotSessions).mockResolvedValue({
      sessions: [{ sessionId, status: 'idle' }], truncated: false,
    })
    board.createTask.mockRejectedValueOnce(new Error('Session belongs to another Workspace'))
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    const dialog = screen.getByRole('dialog', { name: 'New task' })
    await within(dialog).findByRole('option', { name: new RegExp(sessionId) })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Title' }), { target: { value: 'Continue' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.copilotSession }), { target: { value: sessionId } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    await within(dialog).findByRole('alert')
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Continue')
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: en.copilotSession }).value).toBe(sessionId)
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Create' }).disabled).toBe(false)
    expect(board.createTask).toHaveBeenCalledOnce()
  })
  describe('Taskboard details and Archive', () => {
    it.each([['English', en], ['Chinese', zh]] as const)(
      'requires confirmation and allows retrying failed deletion in %s',
      async (_language, dictionary) => {
        const task = makeTask()
        const board = mountBoard(dictionary, [task])
        vi.mocked(board.props.deleteTask).mockRejectedValueOnce(new Error('Failed to fetch'))
        fireEvent.click(screen.getByRole('article', { name: task.title }))
        fireEvent.click(screen.getByRole('button', { name: dictionary.deleteTask }))
        let confirmation = screen.getByRole('dialog', { name: dictionary.deleteTaskTitle })
        within(confirmation).getByText(dictionary.deleteTaskMessage.replace('{title}', task.title))
        expect(board.props.deleteTask).not.toHaveBeenCalled()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.getByRole('dialog', { name: dictionary.taskDetails })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: dictionary.deleteTask }))
        confirmation = screen.getByRole('dialog', { name: dictionary.deleteTaskTitle })
        const remove = within(confirmation).getByRole<HTMLButtonElement>('button', { name: dictionary.deleteTask })
        fireEvent.click(remove)
        await waitFor(() => {
          expect(within(confirmation).getByRole('alert').textContent).toBe(dictionary.error.replace('{message}', 'Failed to fetch'))
          expect(remove.disabled).toBe(false)
        })
        expect(board.props.deleteTask).toHaveBeenCalledExactlyOnceWith(task)
        expect(screen.getByRole('article', { name: task.title })).toBeTruthy()
        fireEvent.click(remove)
        await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
        expect(board.props.deleteTask).toHaveBeenCalledTimes(2)
        expect(screen.queryByRole('article', { name: task.title })).toBeNull()
      },
    )

    it.each([false, true])('deletes only the confirmed linked task, archived: %s', async (archived) => {
      const task = makeTask({
        sessionId: 'session' as NonNullable<TaskboardTask['sessionId']>,
        agencyCopilotSessionId: 'copilot' as NonNullable<TaskboardTask['agencyCopilotSessionId']>,
        ...(archived ? { archivedAt: '2026-01-02T00:00:00.000Z' } : {}),
      })
      const other = makeTask({ id: 'other' as TaskboardTask['id'], title: 'Keep this task' })
      const board = mountBoard(en, [task, other])
      if (archived) fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
      fireEvent.click(screen.getByRole('article', { name: task.title }))
      fireEvent.click(screen.getByRole('button', { name: en.deleteTask }))
      const confirmation = screen.getByRole('dialog', { name: en.deleteTaskTitle })
      fireEvent.click(within(confirmation).getByRole('button', { name: en.deleteTask }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(board.props.deleteTask).toHaveBeenCalledExactlyOnceWith(task)
      expect(screen.queryByRole('article', { name: task.title })).toBeNull()
      if (archived) fireEvent.click(screen.getByRole('button', { name: en.backToBoard }))
      expect(screen.getByRole('article', { name: other.title })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Archived (0)' })).toBeTruthy()
      expect(board.props.clearAgencyCopilot).not.toHaveBeenCalled()
      expect(board.props.openAgencyCopilot).not.toHaveBeenCalled()
      expect(board.props.startAgencyCopilot).not.toHaveBeenCalled()
      expect(board.props.openSession).not.toHaveBeenCalled()
    })

    it('keeps pending deletion open and prevents duplicate confirmation', async () => {
      const task = makeTask()
      const board = mountBoard(en, [task])
      const pending = Promise.withResolvers<undefined>()
      vi.mocked(board.props.deleteTask).mockImplementationOnce(async () => {
        await pending.promise
        board.setTaskboard({ tasks: [] })
      })
      fireEvent.click(screen.getByRole('article', { name: task.title }))
      fireEvent.click(screen.getByRole('button', { name: en.deleteTask }))
      const confirmation = screen.getByRole('dialog', { name: en.deleteTaskTitle })
      const remove = within(confirmation).getByRole<HTMLButtonElement>('button', { name: en.deleteTask })
      fireEvent.click(remove)
      expect(remove.disabled).toBe(true)
      expect(within(confirmation).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
      expect(screen.getByRole('article', { name: task.title })).toBeTruthy()
      fireEvent.click(remove)
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.click(within(confirmation).getByRole('button', { name: en.close }))
      expect(screen.getByRole('dialog', { name: en.deleteTaskTitle })).toBe(confirmation)
      expect(board.props.deleteTask).toHaveBeenCalledExactlyOnceWith(task)
      pending.resolve(undefined)
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(screen.queryByRole('article')).toBeNull()
    })

    it.each([['English', en], ['Chinese', zh]] as const)('opens task details and the Archive list in %s', (_language, dictionary) => {
      const active = makeTask()
      const archived = makeTask({
        id: 'archive' as TaskboardTask['id'], title: 'Completed investigation', status: 'done',
        archivedAt: '2026-01-02T00:00:00.000Z',
      })
      mountBoard(dictionary, [active, archived])
      expect(screen.queryByText(archived.title)).toBeNull()
      fireEvent.click(screen.getByRole('article', { name: active.title }))
      expect(screen.getByRole('dialog', { name: dictionary.taskDetails })).toBeTruthy()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: dictionary.archivedCount.replace('{count}', '1') }))
      const archive = screen.getByRole('region', { name: dictionary.archiveTitle })
      expect(within(archive).getByText(archived.description)).toBeTruthy()
      expect(within(archive).getByRole('article').draggable).toBe(false)
      expect(screen.queryByText(active.title)).toBeNull()
      fireEvent.click(within(archive).getByRole('article'))
      screen.getByText(dictionary.archivedReadOnly)
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: dictionary.close }))
      fireEvent.click(screen.getByRole('button', { name: dictionary.backToBoard }))
      expect(screen.getByRole('article', { name: active.title })).toBeTruthy()
      expect(screen.queryByText(archived.title)).toBeNull()
    })

    it.each([false, true])('moves an archived task into the Archive list with session links: %s', async (linked) => {
      const task = makeTask(linked ? {
        sessionId: 'session' as NonNullable<TaskboardTask['sessionId']>,
        agencyCopilotSessionId: 'copilot' as NonNullable<TaskboardTask['agencyCopilotSessionId']>,
      } : {})
      const { props } = mountBoard(en, [task])
      fireEvent.click(screen.getByRole('article', { name: task.title }))
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(props.archiveTask).toHaveBeenCalledExactlyOnceWith(task)
      expect(screen.queryByRole('article')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
      expect(screen.getByRole('article', { name: task.title })).toBeTruthy()
    })

    it.each([['English', en], ['Chinese', zh]] as const)(
      'keeps failed archives open and permits an explicit retry in %s',
      async (_language, dictionary) => {
        const task = makeTask({ status: 'done' })
        const { props } = mountBoard(dictionary, [task])
        vi.mocked(props.archiveTask).mockRejectedValueOnce(new Error('Failed to fetch'))
        fireEvent.click(screen.getByRole('article', { name: task.title }))
        const dialog = screen.getByRole('dialog', { name: dictionary.taskDetails })
        const archive = within(dialog).getByRole<HTMLButtonElement>('button', { name: dictionary.archive })
        fireEvent.click(archive)
        await waitFor(() => {
          expect(within(dialog).getByRole('alert').textContent)
            .toBe(dictionary.error.replace('{message}', 'Failed to fetch'))
          expect(archive.disabled).toBe(false)
        })
        expect(props.archiveTask).toHaveBeenCalledExactlyOnceWith(task)
        expect(screen.getByRole('dialog')).toBe(dialog)
        expect(screen.getByRole('button', { name: dictionary.archivedCount.replace('{count}', '0') })).toBeTruthy()
        fireEvent.click(archive)
        await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
        expect(props.archiveTask).toHaveBeenCalledTimes(2)
        expect(props.archiveTask).toHaveBeenLastCalledWith(task)
        expect(screen.queryByText(dictionary.error.replace('{message}', 'Failed to fetch'))).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: dictionary.archivedCount.replace('{count}', '1') }))
        expect(screen.getByRole('article', { name: task.title })).toBeTruthy()
      },
    )

    it('waits for the archive response and prevents duplicate actions while it is pending', async () => {
      const task = makeTask()
      const board = mountBoard(en, [task])
      const pending = Promise.withResolvers<undefined>()
      vi.mocked(board.props.archiveTask).mockImplementationOnce(async () => {
        await pending.promise
        board.setTaskboard({ tasks: [{ ...task, revision: 2, archivedAt: '2026-01-02T00:00:00.000Z' }] })
      })
      fireEvent.click(screen.getByRole('article', { name: task.title }))
      const archive = screen.getByRole<HTMLButtonElement>('button', { name: 'Archive' })
      fireEvent.click(archive)
      expect(archive.disabled).toBe(true)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true)
      expect(screen.getByRole('button', { name: 'Archived (0)' })).toBeTruthy()
      fireEvent.click(archive)
      expect(board.props.archiveTask).toHaveBeenCalledExactlyOnceWith(task)
      pending.resolve(undefined)
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      expect(screen.queryByRole('article')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
      expect(screen.getByRole('article', { name: task.title })).toBeTruthy()
    })

    it('filters archived task descriptions and preserves filters when returning to the board', () => {
      mountBoard(en, [
        makeTask({ title: 'Current task' }),
        makeTask({ id: 'archive' as TaskboardTask['id'], title: 'Older task', description: 'Network evidence', archivedAt: '2026-01-02T00:00:00.000Z' }),
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
      const search = screen.getByPlaceholderText('Search tasks…')
      fireEvent.change(search, { target: { value: 'Network' } })
      expect(screen.getByRole('article', { name: 'Older task' })).toBeTruthy()
      fireEvent.change(search, { target: { value: 'Current' } })
      screen.getByText('No archived tasks match the current filters.')
      fireEvent.click(screen.getByRole('button', { name: 'Back to board' }))
      expect(screen.getByRole('article', { name: 'Current task' })).toBeTruthy()
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Archived (0)' })).toBeTruthy()
    })

    it('does not inspect archived Copilot identities', () => {
      const archived = makeTask({
        archivedAt: '2026-01-02T00:00:00.000Z',
        agencyCopilotSessionId: 'copilot' as NonNullable<TaskboardTask['agencyCopilotSessionId']>,
      })
      const { props } = mountBoard(en, [archived])
      expect(props.refreshAgencyCopilot).not.toHaveBeenCalled()
    })

    it('keeps durable status separate from live DSH and Copilot progress on cards', () => {
      const sessionId = 'session' as NonNullable<TaskboardTask['sessionId']>
      const copilotId = 'copilot' as NonNullable<TaskboardTask['agencyCopilotSessionId']>
      const task = makeTask({
        status: 'in_progress', sessionId,
        agencyCopilotSessionId: copilotId,
      })
      const board = mountBoard(en, [task])
      board.sessions.byId[sessionId] = {
        id: sessionId, displayTitle: 'Investigation', running: true, blank: false, updatedAt: Date.now(),
      }
      board.setTaskboard({ agencyByTask: { [task.id]: { taskId: task.id, sessionId: copilotId, status: 'idle' } } })
      board.rerender(<Taskboard {...board.props} />)
      const card = screen.getByRole('article', { name: task.title })
      within(card).getByText('In Progress')
      within(card).getByText('Running')
      within(card).getByText('Ready to resume')
      board.sessions.byId[sessionId].running = false
      board.setTaskboard({ agencyByTask: { [task.id]: { taskId: task.id, sessionId: copilotId, status: 'in_use' } } })
      board.rerender(<Taskboard {...board.props} />)
      within(card).getByText('In Progress')
      within(card).getByText('Copilot running')
      expect(within(card).queryByText('Running', { exact: true })).toBeNull()
      expect(within(card).queryByText('Done')).toBeNull()
      expect(board.props.moveTask).not.toHaveBeenCalled()
    })
  })
})
