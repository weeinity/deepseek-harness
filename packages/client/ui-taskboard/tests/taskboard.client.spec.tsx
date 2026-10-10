// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskboardSnapshot, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardSurfaceProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { Taskboard } from '../src/client/Taskboard.tsx'
import { createTaskboardNavigationStore } from '../src/client/navigation-store.ts'
import { copilot, dsh, execution, jobs, options, runtime, sessions, task, translate, workspaces } from './fixtures.client.ts'

function mountBoard(
  tasks: readonly TaskboardTask[] = [], dictionary: typeof en | typeof zh = en, initial: Partial<TaskboardSnapshot> = {},
  sources: { sessions?: ReturnType<typeof sessions>; workspaces?: ReturnType<typeof workspaces> } = {},
  callbacks: Partial<TaskboardSurfaceProps> = {},
) {
  let state: TaskboardSnapshot = { tasks, state: 'idle', phase: 'ready', error: null, runtime,
    agencyByTask: {}, agencyState: 'idle', agencyError: null, ...initial }
  let sessionState = sources.sessions ?? sessions()
  let workspaceState = sources.workspaces ?? workspaces()
  const navigation = createTaskboardNavigationStore().create()
  const props: TaskboardSurfaceProps = {
    useTaskboard: selector => selector(state), useJobs: selector => selector(jobs()),
    usePanelInfo: selector => selector({ activePanelId: null }),
    useSessionStatus: selector => selector(new Map()), useSessionRetainInfo: () => undefined,
    useResource: () => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} }),
    watchJobRows: vi.fn(() => () => {}), useSessions: selector => selector(sessionState),
    useWorkspaces: selector => selector(workspaceState),
    useStore: selector => selector(navigation.getSnapshot()), actions: navigation.actions,
    t: translate(dictionary), createTask: vi.fn<TaskboardSurfaceProps['createTask']>(async (request) => {
      const created = task({ ...request, id: 'copy' as TaskboardTask['id'] })
      state = { ...state, tasks: [...state.tasks, created] }
      return created
    }),
    updateTask: vi.fn(async () => {}), moveTask: vi.fn(async () => {}),
    archiveTask: vi.fn<TaskboardSurfaceProps['archiveTask']>(async (row) => {
      state = { ...state, tasks: state.tasks.map(item => item.id === row.id ? { ...item, archivedAt: '2026-01-02', revision: item.revision + 1 } : item) }
    }),
    deleteTask: vi.fn<TaskboardSurfaceProps['deleteTask']>(async (row) => {
      state = { ...state, tasks: state.tasks.filter(item => item.id !== row.id) }
    }),
    restoreTask: vi.fn<TaskboardSurfaceProps['restoreTask']>(async (row) => {
      const { archivedAt: _archivedAt, ...restored } = row
      state = { ...state, tasks: state.tasks.map(item => item.id === row.id ? restored : item) }
    }),
    startWork: vi.fn(async () => {}), connectTask: vi.fn(async () => {}), disconnectTask: vi.fn(async () => {}),
    confirmPermissions: vi.fn(async () => {}), executionOptions: vi.fn(async () => options),
    openSession: vi.fn(), agencyCopilotCapability: vi.fn(async () => true),
    listAgencyCopilotSessions: vi.fn(async () => ({ sessions: [{ sessionId: copilot.sessionId, status: 'idle' as const }], truncated: false })),
    openAgencyCopilot: vi.fn<TaskboardSurfaceProps['openAgencyCopilot']>(async () => 'resume-accepted'),
    refreshAgencyCopilot: vi.fn(async () => {}),
    isLoopback: true, closeSurface: vi.fn(), ...callbacks,
  }
  const view = render(<Taskboard {...props} />)
  return { props, ...view, navigation, get sessions() { return sessionState }, get workspaces() { return workspaceState },
    requestTask: (id: TaskboardTask['id']) => { navigation.actions.openTask(id); view.rerender(<Taskboard {...props} />) },
    replaceSessions: (next: ReturnType<typeof sessions>) => { sessionState = next; view.rerender(<Taskboard {...props} />) },
    replaceWorkspaces: (next: ReturnType<typeof workspaces>) => { workspaceState = next; view.rerender(<Taskboard {...props} />) },
    replace: (patch: Partial<TaskboardSnapshot>) => { state = { ...state, ...patch }; view.rerender(<Taskboard {...props} />) } }
}
afterEach(cleanup)
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
async function ready(name = en.newTask) { await waitFor(() =>{  expect(button(name).disabled).toBe(false) }) }
const change = (name: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })
function clickMask(dialog: HTMLElement): void {
  const mask = dialog.previousElementSibling
  if (mask === null) throw new Error('Modal mask is missing')
  fireEvent.click(mask)
}

function dragData() {
  const values = new Map<string, string>()
  return {
    effectAllowed: '', dropEffect: 'none',
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => { values.set(type, value) },
  }
}

function selectedSessions() {
  const state = sessions()
  state.byId[dsh.sessionId] = {
    ...state.byId[dsh.sessionId]!,
    retainedBy: { mainView: 1 },
  }
  return state
}

describe('Taskboard', () => {
  it.each([en, zh])('keeps the header focused on task actions', async (dictionary) => {
    mountBoard([], dictionary)
    await ready(dictionary.newTask)
    expect(within(screen.getByRole('banner')).getAllByRole('button').map(control => control.textContent?.trim())).toEqual([
      dictionary.close, translate(dictionary)('archivedCount', { count: 0 }), dictionary.newTask,
    ])
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it.each([en, zh])('opens the requested task after clearing unrelated search, Workspace, and archive filters', async (dictionary) => {
    const row = task({ connection: dsh })
    const otherWorkspace = { ...workspaces().items[0]!, workspaceId: 'other' as TaskboardTask['workspaceId'],
      title: 'Other Workspace', sessionIds: [] }
    const value = mountBoard([row], dictionary, {}, {
      workspaces: { ...workspaces(), items: [...workspaces().items, otherWorkspace] },
    })
    await ready(dictionary.newTask)
    fireEvent.change(screen.getByRole('combobox', { name: dictionary.workspace }), { target: { value: otherWorkspace.workspaceId } })
    fireEvent.change(screen.getByPlaceholderText(dictionary.search), { target: { value: 'No matching task' } })
    fireEvent.click(button(translate(dictionary)('archivedCount', { count: 0 })))
    value.requestTask(row.id)
    const dialog = await screen.findByRole('dialog', { name: dictionary.taskDetails })
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: dictionary.taskTitle }).value).toBe(row.title)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(screen.getByPlaceholderText<HTMLInputElement>(dictionary.search).value).toBe('')
    expect(value.navigation.getSnapshot().requestedTaskId).toBeUndefined()
    fireEvent.click(within(dialog).getByRole('button', { name: dictionary.close }))
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: dictionary.workspace }).value).toBe(row.workspaceId)
    expect(screen.getByRole('article', { name: row.title })).toBeDefined()
    expect(screen.queryByRole('button', { name: dictionary.backToBoard })).toBeNull()
    for (const operation of ['createTask', 'updateTask', 'moveTask', 'connectTask', 'startWork'] as const) {
      expect(value.props[operation]).not.toHaveBeenCalled()
    }
    value.unmount()
    render(<Taskboard {...value.props} />)
    await ready(dictionary.newTask)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('waits for the task baseline and opens archived task details read-only', async () => {
    const row = task({ connection: dsh, archivedAt: '2026-01-02' })
    const value = mountBoard([], en, { phase: 'pending' })
    value.requestTask(row.id)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(value.navigation.getSnapshot().requestedTaskId).toBe(row.id)
    value.replace({ phase: 'ready', tasks: [row] })
    const dialog = await screen.findByRole('dialog', { name: en.taskDetails })
    await within(dialog).findByText(`${en.archivedReadOnly} ${en.restoreHint}`)
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).disabled).toBe(true)
    expect(within(dialog).queryByRole('button', { name: en.startWork })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
    expect(button(en.backToBoard)).toBeDefined()
    expect(screen.getByRole('article', { name: row.title })).toBeDefined()
  })

  it.each([en, zh])('reports a requested task removed before navigation instead of opening another task', async (dictionary) => {
    const row = task()
    const value = mountBoard([row], dictionary)
    await ready(dictionary.newTask)
    fireEvent.click(screen.getByRole('article', { name: row.title }))
    value.requestTask('removed' as TaskboardTask['id'])
    await screen.findByText(dictionary.taskMissing)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(value.navigation.getSnapshot().requestedTaskId).toBeUndefined()
    expect(value.props.createTask).not.toHaveBeenCalled()
    expect(value.props.startWork).not.toHaveBeenCalled()
  })

  it.each([en, zh])('discards a creation draft on Cancel without changing saved tasks', async (dictionary) => {
    const row = task()
    const value = mountBoard([row], dictionary)
    await ready(dictionary.newTask)
    fireEvent.click(button(dictionary.newTask))
    const dialog = screen.getByRole('dialog', { name: dictionary.newTask })
    expect(within(dialog).queryByRole('button', { name: dictionary.archive })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: dictionary.deleteTask })).toBeNull()
    change(dictionary.taskTitle, 'Discarded task')
    change(dictionary.description, 'Discarded instructions')
    change(dictionary.prompt, 'Do not submit')
    fireEvent.click(button(dictionary.cancel))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual([row.title])
    for (const operation of ['createTask', 'updateTask', 'archiveTask', 'deleteTask', 'connectTask', 'startWork'] as const) {
      expect(value.props[operation]).not.toHaveBeenCalled()
    }
    fireEvent.click(button(dictionary.newTask))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: dictionary.taskTitle }).value).toBe('')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: dictionary.description }).value).toBe('')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: dictionary.prompt }).value).toBe('')
  })

  it.each([en, zh])('creates and closes without opening edit actions on Save and Close', async (dictionary) => {
    const value = mountBoard([], dictionary)
    await ready(dictionary.newTask)
    fireEvent.click(button(dictionary.newTask))
    const actions = within(screen.getByRole('dialog', { name: dictionary.newTask })).getAllByRole('button')
    expect(actions[actions.indexOf(button(dictionary.saveAndClose)) + 1]).toBe(button(dictionary.save))
    change(dictionary.taskTitle, 'Saved and closed')
    fireEvent.click(button(dictionary.saveAndClose))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(value.props.createTask).toHaveBeenCalledOnce()
    const card = screen.getByRole('article', { name: 'Saved and closed' })
    expect(card.closest('section')?.dataset.status).toBe('todo')
    expect(value.props.startWork).not.toHaveBeenCalled()
    fireEvent.click(card)
    screen.getByRole('dialog', { name: dictionary.taskDetails })
    expect(button(dictionary.archive).disabled).toBe(false)
    expect(button(dictionary.deleteTask).disabled).toBe(false)
  })

  it('does not close another task when an earlier Save and Close finishes after removal', async () => {
    const row = task()
    const next = task({ id: 'next' as TaskboardTask['id'], title: 'Another task' })
    const gate = Promise.withResolvers<undefined>()
    const value = mountBoard([row, next])
    vi.mocked(value.props.updateTask).mockReturnValueOnce(gate.promise)
    await ready()
    fireEvent.click(screen.getByRole('article', { name: row.title }))
    try {
      fireEvent.click(button(en.saveAndClose))
      value.replace({ tasks: [next] })
      await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
      fireEvent.click(screen.getByRole('article', { name: next.title }))
      await act(async () => { gate.resolve(undefined) })
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).value).toBe(next.title)
    } finally { await act(async () => { gate.resolve(undefined) }) }
  })

  it.each([new Error('Move rejected'), 'Move rejected'])('surfaces a rejected drop into an empty planning column: %s', async (reason) => {
    const row = task({ status: 'in_progress' })
    const value = mountBoard([row], en, {}, { sessions: selectedSessions() })
    vi.mocked(value.props.moveTask).mockRejectedValueOnce(reason)
    await ready()
    const target = screen.getByText(en.inReview).closest('section')?.lastElementChild
    if (target === undefined || target === null) throw new Error('Planning column is missing')
    const dataTransfer = dragData()
    fireEvent.dragStart(screen.getByRole('article'), { dataTransfer })
    fireEvent.dragOver(target, { dataTransfer })
    fireEvent.drop(target, { dataTransfer })
    await screen.findByText(translate()('error', { message: 'Move rejected' }))
    expect(value.props.moveTask).toHaveBeenCalledWith(row, 'in_review', undefined)
  })

  it.each(['column', 'header', 'empty', 'card'] as const)('changes task status when dropped on the destination %s', async (target) => {
    const row = task()
    const anchor = task({ id: 'anchor' as TaskboardTask['id'], title: 'Done task', status: 'done' })
    const others = target === 'card' ? [anchor] : []
    const value = mountBoard([row, ...others])
    vi.mocked(value.props.moveTask).mockImplementation(async (_task, status) => {
      value.replace({ tasks: [task({ ...row, status, revision: row.revision + 1 }), ...others] })
    })
    await ready()
    const column = value.container.querySelector<HTMLElement>('section[data-status="done"]')
    if (column === null) throw new Error('Done column is missing')
    const dataTransfer = dragData()
    fireEvent.dragStart(screen.getByRole('article', { name: row.title }), { dataTransfer })
    const destination = target === 'header' ? within(column).getByText(en.done)
      : target === 'empty' ? within(column).getByText(en.empty)
        : target === 'card' ? within(column).getByRole('article', { name: anchor.title }) : column
    expect(fireEvent.dragOver(destination, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(destination, { dataTransfer })
    await waitFor(() => {
      expect(screen.getByRole('article', { name: row.title }).closest('section')?.dataset.status).toBe('done')
    })
    expect(value.props.moveTask).toHaveBeenCalledExactlyOnceWith(row, 'done', undefined)
    expect(value.props.startWork).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('article', { name: row.title }))
    expect(button(en.done).getAttribute('aria-pressed')).toBe('true')
  })

  it.each(['succeeds', 'fails'] as const)('waits for a dropped task to save and allows another drag after it %s', async (outcome) => {
    const row = task()
    const value = mountBoard([row])
    const gate = Promise.withResolvers<undefined>()
    const moved = task({ ...row, status: 'done', revision: row.revision + 1 })
    vi.mocked(value.props.moveTask).mockImplementationOnce(async () => {
      await gate.promise
      value.replace({ tasks: [moved] })
    })
    await ready()
    const card = screen.getByRole('article', { name: row.title })
    const done = value.container.querySelector<HTMLElement>('section[data-status="done"]')
    const review = value.container.querySelector<HTMLElement>('section[data-status="in_review"]')
    if (done === null || review === null) throw new Error('Destination columns are missing')
    const dataTransfer = dragData()
    try {
      fireEvent.dragStart(card, { dataTransfer })
      fireEvent.drop(done, { dataTransfer })
      expect(card.closest('section')?.dataset.status).toBe('todo')
      expect(card.getAttribute('aria-busy')).toBe('true')
      expect(card.draggable).toBe(false)
      fireEvent.dragStart(card, { dataTransfer })
      fireEvent.drop(review, { dataTransfer })
      expect(value.props.moveTask).toHaveBeenCalledExactlyOnceWith(row, 'done', undefined)
      await act(async () => {
        if (outcome === 'fails') gate.reject(new Error('Move rejected'))
        else gate.resolve(undefined)
      })
      const savedCard = screen.getByRole('article', { name: row.title })
      expect(savedCard.getAttribute('aria-busy')).toBeNull()
      expect(savedCard.draggable).toBe(true)
      expect(savedCard.closest('section')?.dataset.status).toBe(outcome === 'fails' ? 'todo' : 'done')
      if (outcome === 'fails') expect(screen.getByRole('alert').textContent).toContain('Move rejected')
      else expect(screen.queryByRole('alert')).toBeNull()
      fireEvent.dragStart(savedCard, { dataTransfer })
      fireEvent.drop(review, { dataTransfer })
      await waitFor(() => {
        expect(value.props.moveTask).toHaveBeenLastCalledWith(outcome === 'fails' ? row : moved, 'in_review', undefined)
      })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(value.props.moveTask).toHaveBeenCalledTimes(2)
      expect(value.props.startWork).not.toHaveBeenCalled()
    } finally {
      await act(async () => { gate.resolve(undefined) })
    }
  })

  it('highlights only the current destination and clears drag feedback when leaving or cancelling', async () => {
    const row = task()
    const anchor = task({ id: 'anchor' as TaskboardTask['id'], title: 'Done task', status: 'done' })
    const value = mountBoard([row, anchor])
    await ready()
    const card = screen.getByRole('article', { name: row.title })
    const targetCard = screen.getByRole('article', { name: anchor.title })
    const done = targetCard.closest('section')
    const review = value.container.querySelector<HTMLElement>('section[data-status="in_review"]')
    if (done === null || review === null) throw new Error('Destination columns are missing')
    const dataTransfer = dragData()
    expect(fireEvent.dragOver(done, { dataTransfer })).toBe(true)
    fireEvent.dragStart(card, { dataTransfer })
    expect(card.hasAttribute('data-dragging')).toBe(true)
    expect(dataTransfer.effectAllowed).toBe('move')
    fireEvent.dragOver(targetCard, { dataTransfer })
    expect(done.hasAttribute('data-drop-target')).toBe(true)
    // jsdom's generic drag event does not retain MouseEvent.relatedTarget.
    fireEvent(done, new MouseEvent('dragleave', { bubbles: true, relatedTarget: targetCard }))
    expect(done.hasAttribute('data-drop-target')).toBe(true)
    fireEvent.dragOver(review, { dataTransfer })
    fireEvent(done, new MouseEvent('dragleave', { bubbles: true, relatedTarget: review }))
    expect(done.hasAttribute('data-drop-target')).toBe(false)
    expect(review.hasAttribute('data-drop-target')).toBe(true)
    fireEvent.dragLeave(review)
    expect(review.hasAttribute('data-drop-target')).toBe(false)
    fireEvent.dragOver(done, { dataTransfer })
    fireEvent.dragEnd(card)
    expect(card.hasAttribute('data-dragging')).toBe(false)
    expect(done.hasAttribute('data-drop-target')).toBe(false)
    fireEvent.drop(done, { dataTransfer })
    expect(value.props.moveTask).not.toHaveBeenCalled()
  })

  it.each(['all', 'search', 'workspace'] as const)('appends within the same column only in an unfiltered Workspace: %s', async (filter) => {
    const row = task()
    const anchor = task({ id: 'anchor' as TaskboardTask['id'], title: 'Next task' })
    const value = mountBoard([row, anchor])
    await ready()
    if (filter !== 'all') {
      fireEvent.change(screen.getByRole('combobox', { name: en.workspace }), { target: { value: row.workspaceId } })
    }
    if (filter === 'search') fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: row.title } })
    const card = screen.getByRole('article', { name: row.title })
    const column = card.closest('section')
    if (column === null) throw new Error('Todo column is missing')
    const dataTransfer = dragData()
    fireEvent.dragStart(card, { dataTransfer })
    expect(fireEvent.dragOver(column, { dataTransfer })).toBe(filter !== 'workspace')
    fireEvent.drop(column, { dataTransfer })
    await waitFor(() => { expect(card.draggable).toBe(true) })
    if (filter === 'workspace') expect(value.props.moveTask).toHaveBeenCalledExactlyOnceWith(row, 'todo', undefined)
    else expect(value.props.moveTask).not.toHaveBeenCalled()
  })

  it.each(['filtered', 'archived', 'deleted'] as const)('ignores a drag whose source is %s before the drop', async (change) => {
    const row = task()
    const value = mountBoard([row])
    await ready()
    const column = value.container.querySelector<HTMLElement>('section[data-status="done"]')
    if (column === null) throw new Error('Done column is missing')
    const dataTransfer = dragData()
    fireEvent.dragStart(screen.getByRole('article', { name: row.title }), { dataTransfer })
    if (change === 'filtered') fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'Not visible' } })
    else value.replace({ tasks: change === 'deleted' ? [] : [task({ ...row, archivedAt: '2026-01-02' })] })
    expect(fireEvent.dragOver(column, { dataTransfer })).toBe(true)
    fireEvent.drop(column, { dataTransfer })
    expect(value.props.moveTask).not.toHaveBeenCalled()
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('rejects foreign, self and finished drag payloads while accepting the next local reorder', async () => {
    const row = task({ status: 'in_progress' })
    const other = task({ id: 'other' as TaskboardTask['id'], title: 'Next task', status: 'in_review' })
    const value = mountBoard([row, other], en, {}, { sessions: selectedSessions() })
    await ready()
    const first = screen.getByRole('article', { name: row.title })
    const second = screen.getByRole('article', { name: other.title })
    expect(first.getAttribute('draggable')).toBe('true')
    const dataTransfer = dragData()
    dataTransfer.setData('application/x-dsh-taskboard-task', row.id)
    fireEvent.drop(second, { dataTransfer })
    fireEvent.dragStart(first, { dataTransfer })
    dataTransfer.setData('application/x-dsh-taskboard-task', 'foreign-task')
    fireEvent.drop(second, { dataTransfer })
    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.drop(first, { dataTransfer })
    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.dragEnd(first)
    fireEvent.drop(second, { dataTransfer })
    expect(value.props.moveTask).not.toHaveBeenCalled()
    fireEvent.dragStart(first, { dataTransfer })
    fireEvent.drop(second, { dataTransfer })
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenCalledExactlyOnceWith(row, 'in_review', other.id) })
  })

  it('ignores a retired discovery failure and reports the next active discovery failure', async () => {
    const pending = Promise.withResolvers<undefined>()
    const row = task({ connection: copilot, executionSettings: { kind: 'copilot' } })
    const refresh = vi.fn<TaskboardSurfaceProps['refreshAgencyCopilot']>()
      .mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('Current discovery failed'))
    const value = mountBoard([row], en, {}, {}, { refreshAgencyCopilot: refresh })
    try {
      expect(refresh).toHaveBeenCalledOnce()
      value.replace({ tasks: [] })
      await act(async () => { pending.reject(new Error('Retired discovery failed')) })
      expect(screen.queryByText(translate()('error', { message: 'Retired discovery failed' }))).toBeNull()
      value.replace({ tasks: [row] })
      await screen.findByText(translate()('error', { message: 'Current discovery failed' }))
      expect(refresh).toHaveBeenCalledTimes(2)
    } finally { pending.resolve(undefined) }
  })

  it.each([false, true])('copies priority and handover while disabling retained scheduling or removing it: %s', async (removeSchedule) => {
    const handover = { goal: 'Copied goal', progress: 'Copied progress', next: 'Copied next', references: ['readme'],
      source: dsh, frozenAt: '2026-01-01T00:00:00Z' }
    const row = task({ priority: 'high', handover, schedule: { enabled: true, cron: '0 9 * * *', timeZone: 'UTC' } })
    const value = mountBoard([row])
    await ready()
    fireEvent.click(screen.getByRole('article'))
    if (removeSchedule) fireEvent.click(button(en.removeSchedule))
    fireEvent.click(button(removeSchedule ? en.editAsCopy : en.duplicate))
    screen.getByRole('dialog', { name: en.duplicate })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.priority }).value).toBe('high')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.goal }).value).toBe(handover.goal)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: en.scheduleEnabled }).checked).toBe(false)
    if (removeSchedule) expect(screen.queryByRole('button', { name: en.removeSchedule })).toBeNull()
    else screen.getByRole('button', { name: en.removeSchedule })
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(value.props.createTask).toHaveBeenCalledOnce() })
    const request = vi.mocked(value.props.createTask).mock.calls[0]?.[0]
    expect(request).toMatchObject({ priority: 'high', handover: { goal: handover.goal, references: handover.references } })
    if (removeSchedule) expect(request).not.toHaveProperty('schedule')
    else expect(request).toHaveProperty('schedule', { enabled: false, cron: '0 9 * * *', timeZone: 'UTC' })
    expect(request).not.toHaveProperty('connection')
    expect(request).not.toHaveProperty('permissionConfirmedAt')
    expect(value.props.archiveTask).not.toHaveBeenCalled()
  })

  it('starts in the current Session Workspace and removes stale selection when its data disappears', async () => {
    const row = task({ connection: dsh })
    const value = mountBoard([row], en, {}, { sessions: selectedSessions() })
    await ready()
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.workspace }).value).toBe(row.workspaceId)
    fireEvent.click(screen.getByRole('article'))
    value.replace({ tasks: [] })
    expect(screen.queryByRole('dialog')).toBeNull()
    value.replaceWorkspaces({ ...workspaces(), items: [] })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.workspace }).value).toBe('all')
    screen.getByText(en.noWorkspace)
    expect(button(en.newTask).disabled).toBe(true)
  })

  it('prioritizes task errors, then Workspace errors and loading, and counts live connections separately', async () => {
    const error = (message: string) => Object.assign(new Error(message), {
      isDSHRemoteError: true as const, code: 'gateway/internal' as const, details: {},
    })
    const first = task({ connection: dsh })
    const second = task({ id: 'second' as TaskboardTask['id'], title: 'Copilot task', connection: copilot,
      executionSettings: { kind: 'copilot' } })
    const value = mountBoard([first, second], en, { state: 'error', error: error('Task stream failed'),
      agencyByTask: { [second.id]: { taskId: second.id, sessionId: copilot.sessionId, status: 'in_use' } } },
    { workspaces: { ...workspaces(), state: 'error', error: error('Workspace stream failed') } })
    screen.getByText('Task stream failed')
    value.replace({ state: 'idle', error: null })
    screen.getByText('Workspace stream failed')
    value.replaceWorkspaces({ ...workspaces(), state: 'loading', phase: 'pending' })
    screen.getByText(en.loading)
    value.replaceWorkspaces(workspaces())
    const live = sessions()
    live.byId[dsh.sessionId] = { ...live.byId[dsh.sessionId]!, running: true }
    value.replaceSessions(live)
    screen.getByText(translate()('subtitle', { count: 2, running: 2 }))
    value.replace({ agencyState: 'error', agencyError: error('Discovery failed') })
    fireEvent.click(screen.getByRole('article', { name: second.title }))
    expect(within(screen.getByRole('dialog')).getByText(en.copilotUnavailable)).toBeTruthy()
  })

  it('forwards Run, connection changes, confirmation and archive through the selected current task', async () => {
    const row = task({ connection: dsh })
    const value = mountBoard([row])
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.startWork))
    await waitFor(() => { expect(button(en.startWork).disabled).toBe(false) })
    expect(value.props.startWork).toHaveBeenCalledOnce()
    fireEvent.click(button(en.disconnect))
    await waitFor(() => { expect(button(en.disconnect).disabled).toBe(false) })
    expect(value.props.disconnectTask).toHaveBeenCalledWith(row)
    const disconnected = task({ revision: 2 })
    value.replace({ tasks: [disconnected] })
    fireEvent.change(screen.getByRole('combobox', { name: en.linkedSession }), { target: { value: dsh.sessionId } })
    fireEvent.click(button(en.connect))
    await waitFor(() => { expect(value.props.connectTask).toHaveBeenCalledWith(disconnected, dsh, undefined) })
    const connected = { ...row, revision: 3 }
    value.replace({ tasks: [connected] })
    await waitFor(() => { expect(button(en.disconnect).disabled).toBe(false) })
    fireEvent.click(screen.getByRole('checkbox', { name: en.confirmPermissionCheck }))
    fireEvent.click(button(en.confirmPermissions))
    await waitFor(() => { expect(button(en.archive).disabled).toBe(false) })
    expect(value.props.confirmPermissions).toHaveBeenCalledWith(connected)
    fireEvent.click(button(en.archive))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(value.props.archiveTask).toHaveBeenCalledWith(connected)
  })

  it('reports active discovery failure, refreshes explicitly, and closes the surface', async () => {
    const value = mountBoard()
    vi.mocked(value.props.refreshAgencyCopilot).mockRejectedValueOnce('Discovery offline')
    const row = task({ connection: copilot, executionSettings: { kind: 'copilot' } })
    value.replace({ tasks: [row] })
    await screen.findByText(translate()('error', { message: 'Discovery offline' }))
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.refreshCopilot))
    await waitFor(() => { expect(value.props.refreshAgencyCopilot).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(within(screen.getByRole('dialog')).getByRole<HTMLButtonElement>('button', { name: en.close }).disabled).toBe(false) })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button(en.close))
    expect(value.props.closeSurface).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'reject'] as const)('ignores retired option and capability requests that later %s', async (outcome) => {
    const oldOptions = Promise.withResolvers<typeof options>()
    const oldCapability = Promise.withResolvers<boolean>()
    const row = task({ connection: copilot, executionSettings: { kind: 'copilot' } })
    const value = mountBoard([row], en, {}, {}, {
      executionOptions: vi.fn(() => oldOptions.promise), agencyCopilotCapability: vi.fn(() => oldCapability.promise),
    })
    try {
      value.rerender(<Taskboard {...value.props} executionOptions={vi.fn(async () => options)}
        agencyCopilotCapability={vi.fn(async () => false)} />)
      await ready()
      await act(async () => {
        if (outcome === 'resolve') {
          oldOptions.resolve({ ...options, presets: [{ id: 'stale', name: 'Stale preset', isDefault: true }] })
          oldCapability.resolve(true)
        } else {
          oldOptions.reject(new Error('Retired catalog failed'))
          oldCapability.reject(new Error('Retired capability failed'))
        }
      })
      expect(screen.queryByRole('alert')).toBeNull()
      fireEvent.click(screen.getByRole('article'))
      expect(button(en.openAgencyCopilot).disabled).toBe(true)
      fireEvent.keyDown(document, { key: 'Escape' })
      fireEvent.click(button(en.newTask))
      screen.getByRole('option', { name: 'Standard agent' })
      expect(screen.queryByRole('option', { name: 'Stale preset' })).toBeNull()
    } finally {
      await act(async () => { oldOptions.resolve(options); oldCapability.resolve(false) })
    }
  })

  it('shows opaque catalog failure and treats failed capability discovery as unavailable', async () => {
    const value = mountBoard([task({ connection: copilot, executionSettings: { kind: 'copilot' } })], en, {}, {}, {
      executionOptions: vi.fn<TaskboardSurfaceProps['executionOptions']>().mockRejectedValue('Catalog offline'),
      agencyCopilotCapability: vi.fn<TaskboardSurfaceProps['agencyCopilotCapability']>().mockRejectedValue(new Error('Capability offline')),
    })
    await screen.findByText(translate()('optionsError', { message: 'Catalog offline' }))
    fireEvent.click(screen.getByRole('article'))
    expect(button(en.openAgencyCopilot).disabled).toBe(true)
    expect(value.props.openAgencyCopilot).not.toHaveBeenCalled()
  })

  it.each([en, zh])('keeps the five-column layout and loads real execution options in the active locale', async (dictionary) => {
    const value = mountBoard([], dictionary)
    await ready(dictionary.newTask)
    const columns = value.container.querySelectorAll<HTMLElement>('section[data-status]')
    expect(columns).toHaveLength(5)
    for (const column of columns) expect(within(column).queryByRole('button')).toBeNull()
    expect(value.props.executionOptions).toHaveBeenCalledOnce()
    fireEvent.click(button(dictionary.newTask))
    const dialog = screen.getByRole('dialog', { name: dictionary.newTask })
    expect(within(dialog).getByRole('textbox', { name: dictionary.prompt })).toBeTruthy()
    expect(within(dialog).getByRole('option', { name: 'Standard agent' })).toBeTruthy()
    expect(within(dialog).queryByRole('combobox', { name: dictionary.copilotSession })).toBeNull()
    expect(value.props.listAgencyCopilotSessions).not.toHaveBeenCalled()
  })

  it.each([en, zh])('creates in Todo with separate prompt and description and keeps editing on Save without running', async (dictionary) => {
    const value = mountBoard([], dictionary)
    await ready(dictionary.newTask)
    fireEvent.click(button(dictionary.newTask))
    change(dictionary.taskTitle, 'New task')
    change(dictionary.description, 'Planning notes')
    change(dictionary.prompt, 'Run these instructions')
    fireEvent.change(screen.getByRole('combobox', { name: dictionary.linkedSession }), { target: { value: dsh.sessionId } })
    fireEvent.click(button(dictionary.save))
    await screen.findByRole('dialog', { name: dictionary.taskDetails })
    expect(value.props.createTask).toHaveBeenCalledExactlyOnceWith({
      workspaceId: task().workspaceId, title: 'New task', description: 'Planning notes', prompt: 'Run these instructions',
      status: 'todo', labels: [], executionSettings: { kind: 'dsh' }, connection: dsh,
    })
    expect(screen.getByRole('article', { name: 'New task' }).closest('section')?.dataset.status).toBe('todo')
    expect(value.props.startWork).not.toHaveBeenCalled()
    expect(value.props.openSession).not.toHaveBeenCalled()
    expect(value.props.connectTask).not.toHaveBeenCalled()
  })

  it('allows Todo drops to every other column and same-column reordering', async () => {
    const row = task()
    const anchor = task({ id: 'anchor' as TaskboardTask['id'], title: 'Todo anchor' })
    const value = mountBoard([row, anchor], en, {}, { sessions: selectedSessions() })
    await ready()
    const card = screen.getByRole('article', { name: row.title })
    const targetCard = screen.getByRole('article', { name: anchor.title })
    const dataTransfer = dragData()
    const dropColumn = async (status: TaskboardTask['status']) => {
      const column = value.container.querySelector<HTMLElement>(`section[data-status="${status}"]`)?.lastElementChild
      if (column === null || column === undefined) throw new Error('Planning column is missing')
      fireEvent.dragStart(card, { dataTransfer })
      fireEvent.dragOver(column, { dataTransfer })
      fireEvent.drop(column, { dataTransfer })
      await waitFor(() => { expect(card.draggable).toBe(true) })
    }
    for (const status of ['in_progress', 'in_review', 'done'] as const) await dropColumn(status)
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenCalledTimes(3) })
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(targetCard, { dataTransfer })
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenNthCalledWith(4, row, 'todo', anchor.id) })
    await waitFor(() => { expect(card.draggable).toBe(true) })
    await dropColumn('backlog')
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenLastCalledWith(row, 'backlog', undefined) })
    expect(value.props.moveTask).toHaveBeenCalledTimes(5)
    expect(value.props.startWork).not.toHaveBeenCalled()
  })

  it('switches exclusive provider pickers and discovers Copilot only when selected', async () => {
    const value = mountBoard()
    await ready()
    fireEvent.click(button(en.newTask))
    fireEvent.change(screen.getByRole('combobox', { name: en.linkedSession }), { target: { value: dsh.sessionId } })
    fireEvent.change(screen.getByRole('combobox', { name: en.connectionKind }), { target: { value: 'copilot' } })
    expect(screen.queryByRole('combobox', { name: en.linkedSession })).toBeNull()
    await screen.findByRole('option', { name: new RegExp(copilot.sessionId) })
    change(en.taskTitle, 'Copilot task')
    change(en.modelId, 'authoritative-user-model')
    fireEvent.change(screen.getByRole('combobox', { name: en.copilotSession }), { target: { value: copilot.sessionId } })
    fireEvent.click(button(en.save))
    await screen.findByRole('dialog', { name: en.taskDetails })
    expect(value.props.createTask).toHaveBeenCalledWith(expect.objectContaining({
      connection: copilot, executionSettings: { kind: 'copilot', permission: 'read-only', model: 'authoritative-user-model' },
    }))
    expect(value.props.startWork).not.toHaveBeenCalled()
    expect(value.props.openAgencyCopilot).not.toHaveBeenCalled()
  })

  it('retains invalid schedule inputs and server feedback until corrected', async () => {
    const value = mountBoard()
    vi.mocked(value.props.createTask).mockRejectedValueOnce(new Error('Invalid cron: requires 5 fields'))
    await ready()
    fireEvent.click(button(en.newTask))
    change(en.taskTitle, 'Scheduled')
    change(en.cron, 'bad')
    fireEvent.click(button(en.save))
    await screen.findByText(/Invalid cron/)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.cron }).value).toBe('bad')
    fireEvent.change(screen.getByRole('combobox', { name: en.schedulePreset }), { target: { value: 'every10' } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.scheduleEnabled }))
    fireEvent.click(button(en.save))
    await screen.findByRole('dialog', { name: en.taskDetails })
    expect(value.props.createTask).toHaveBeenLastCalledWith(expect.objectContaining({
      schedule: { enabled: true, cron: '*/10 * * * *', timeZone: options.timeZone },
    }))
  })

  it('does not duplicate creation when separately archiving an original fails', async () => {
    const source = task({ connection: dsh, executions: [execution('succeeded')], permissionConfirmedAt: '2026-01-01' })
    const value = mountBoard([source])
    vi.mocked(value.props.archiveTask).mockRejectedValueOnce(new Error('Revision conflict'))
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.duplicate))
    change(en.taskTitle, 'Editable copy')
    fireEvent.click(screen.getByRole('checkbox', { name: en.archiveOriginal }))
    fireEvent.click(button(en.save))
    await screen.findByText(/Copy created, but archiving the original failed: Revision conflict/)
    expect(value.props.createTask).toHaveBeenCalledOnce()
    const request = vi.mocked(value.props.createTask).mock.calls[0]?.[0]
    expect(request).not.toHaveProperty('connection')
    expect(request).not.toHaveProperty('executions')
    expect(request).not.toHaveProperty('permissionConfirmedAt')
    expect(request?.title).toBe('Editable copy')
    fireEvent.click(button(en.retryArchive))
    await screen.findByRole('dialog', { name: en.taskDetails })
    expect(value.props.createTask).toHaveBeenCalledOnce()
    expect(value.props.archiveTask).toHaveBeenCalledTimes(2)
  })

  it('restores archived tasks through the explicit action and preserves In Review', async () => {
    const row = task({ status: 'in_review', archivedAt: '2026-01-01' })
    const value = mountBoard([row])
    await ready()
    fireEvent.click(button('Archived (1)'))
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.restore))
    await waitFor(() =>{  expect(screen.queryByRole('dialog')).toBeNull() })
    expect(value.props.restoreTask).toHaveBeenCalledExactlyOnceWith(row)
    fireEvent.click(button(en.backToBoard))
    expect(within(screen.getByRole('article')).getByText(en.inReview)).toBeTruthy()
    expect(value.props.moveTask).not.toHaveBeenCalled()
  })

  it.each([en, zh])('honors disabled Host settings until an enabled observation arrives', async (dictionary) => {
    const value = mountBoard([], dictionary, { runtime: { ...runtime, settings: { ...runtime.settings, enabled: false } } })
    screen.getByText(dictionary.boardDisabled)
    expect(button(dictionary.newTask).disabled).toBe(true)
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    value.replace({ runtime })
    await ready(dictionary.newTask)
    expect(screen.queryByText(dictionary.boardDisabled)).toBeNull()
  })

  it('does not substitute browser settings before the Host baseline arrives', () => {
    mountBoard([], en, { runtime: undefined, phase: 'pending' })
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    expect(button(en.newTask).disabled).toBe(true)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it.each([en, zh])('displays execution-monitor errors on the disabled board', (dictionary) => {
    mountBoard([], dictionary, { runtime: {
      ...runtime, settings: { ...runtime.settings, enabled: false }, error: 'Ownership lease lost',
    } })
    expect(screen.getByRole('alert').textContent).toContain('Ownership lease lost')
  })

  it('retains failed option discovery and retries through the visible error control', async () => {
    const value = mountBoard()
    await ready()
    const failure = vi.fn(async () => { throw new Error('Catalog unavailable') })
    value.rerender(<Taskboard {...value.props} executionOptions={failure} />)
    await screen.findByText(/Could not load execution options: Catalog unavailable/)
    fireEvent.click(button(en.optionsRetry))
    await waitFor(() =>{  expect(failure).toHaveBeenCalledTimes(2) })
    expect(value.props.startWork).not.toHaveBeenCalled()
  })

  it.each([dsh, copilot].flatMap(connection =>
    (['succeeded', 'failed', 'cancelled'] as const).map(outcome => ({ connection, outcome }))))(
    'projects Host admission, attention, resumption and $outcome for $connection.kind without extra commands',
    async ({ connection, outcome }) => {
      const executionSettings: TaskboardTask['executionSettings'] = connection.kind === 'dsh' ? { kind: 'dsh' } : { kind: 'copilot' }
      const row = task({ connection, executionSettings })
      const value = mountBoard([row])
      const acknowledgement = Promise.withResolvers<undefined>()
      vi.mocked(value.props.startWork).mockReturnValue(acknowledgement.promise)
      await ready()
      const column = () => screen.getByRole('article', { name: row.title }).closest('section')?.dataset.status
      fireEvent.click(screen.getByRole('article'))
      try {
        fireEvent.click(button(en.startWork))
        expect(column()).toBe('todo')
        const pending = execution('pending', { connection, executionSettings })
        const admitted = task({ ...row, revision: 2, status: 'in_progress', executions: [pending] })
        value.replace({ tasks: [admitted] })
        expect(column()).toBe('in_progress')
        await act(async () => { acknowledgement.resolve(undefined) })
        expect(button(en.runAgain).disabled).toBe(true)
        const running = { ...pending, status: 'running' as const, startedAt: '2026-01-01T01:01:00.000Z' }
        const active = task({ ...admitted, revision: 3, executions: [running] })
        value.replace({ tasks: [active] })
        const waiting = task({ ...active, revision: 4, status: 'in_review' })
        value.replace({ tasks: [waiting] })
        expect(column()).toBe('in_review')
        expect(button(en.runAgain).disabled).toBe(true)
        expect(button(en.inReview).getAttribute('aria-pressed')).toBe('true')
        const resumed = task({ ...active, revision: 5 })
        value.replace({ tasks: [resumed] })
        expect(column()).toBe('in_progress')
        const settled = task({ ...resumed, revision: 6, status: outcome === 'succeeded' ? 'done' : 'in_review',
          executions: [{ ...running, status: outcome, endedAt: '2026-01-01T01:02:00.000Z',
            ...(outcome === 'succeeded' ? {} : { error: { code: outcome, message: `Run ${outcome}` } }) }] })
        value.replace({ tasks: [settled] })
        expect(column()).toBe(outcome === 'succeeded' ? 'done' : 'in_review')
        expect(button(en.runAgain).disabled).toBe(false)
        const dialog = screen.getByRole('dialog')
        within(dialog).getByText(en[`execution.${outcome}`])
        within(dialog).getByRole('button', { name: `${en[connection.kind]}: ${connection.sessionId}` })
        expect(value.props.startWork).toHaveBeenCalledOnce()
        expect(value.props.moveTask).not.toHaveBeenCalled()
        expect(value.props.connectTask).not.toHaveBeenCalled()
      } finally { await act(async () => { acknowledgement.resolve(undefined) }) }
    },
  )

  it.each(['backlog', 'in_progress', 'in_review', 'done'] as const)('keeps the explicit source column for a %s copy', async (status) => {
    const row = task({ status })
    const value = mountBoard([row])
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.duplicate))
    fireEvent.click(button(en.save))
    await screen.findByRole('dialog', { name: en.taskDetails })
    expect(value.props.createTask).toHaveBeenCalledWith(expect.objectContaining({ status }))
    expect(screen.getAllByRole('article').map(card => card.closest('section')?.dataset.status)).toEqual([status, status])
    expect(value.props.startWork).not.toHaveBeenCalled()
  })

  it.each([en, zh].flatMap(dictionary => ([
    ['launch-pending', dictionary.copilotLaunchPending],
    ['already-running', dictionary.copilotAlreadyRunning],
    ['resume-accepted', dictionary.copilotResumeAccepted],
  ] as const).map(([outcome, message]) => ({ dictionary, outcome, message }))))(
    'opens archived history by its saved identity and displays the exact Copilot terminal outcome',
    async ({ dictionary, outcome, message }) => {
      const history = execution('succeeded', { connection: copilot, executionSettings: { kind: 'copilot' } })
      const oldDsh = { ...dsh, sessionId: 'prior-dsh' as typeof dsh.sessionId }
      const row = task({ archivedAt: '2026-01-02', connection: dsh, executions: [
        history, execution('cancelled', { connection: oldDsh }),
      ] })
      const value = mountBoard([row], dictionary)
      vi.mocked(value.props.openAgencyCopilot).mockResolvedValue(outcome)
      await ready(dictionary.newTask)
      fireEvent.click(button(value.props.t('archivedCount', { count: 1 })))
      fireEvent.click(screen.getByRole('article', { name: row.title }))
      const dialog = screen.getByRole('dialog', { name: dictionary.taskDetails })
      fireEvent.click(within(dialog).getByRole('button', { name: `${dictionary.copilot}: ${copilot.sessionId}` }))
      await within(dialog).findByText(message)
      expect(value.props.openAgencyCopilot).toHaveBeenCalledExactlyOnceWith(row, history.id)
      fireEvent.click(within(dialog).getByRole('button', { name: `${dictionary.dsh}: ${oldDsh.sessionId}` }))
      expect(value.props.openSession).toHaveBeenCalledExactlyOnceWith(oldDsh.sessionId)
      expect(value.props.startWork).not.toHaveBeenCalled()
      expect(value.props.createTask).not.toHaveBeenCalled()
    })

  it('retains an exact missing Copilot conversation failure without creating, reconnecting, or submitting work', async () => {
    const row = task({ connection: copilot, executionSettings: { kind: 'copilot' } })
    const value = mountBoard([row])
    vi.mocked(value.props.openAgencyCopilot).mockRejectedValue(new Error('Exact Copilot conversation is missing'))
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.openAgencyCopilot))
    const dialog = screen.getByRole('dialog', { name: en.taskDetails })
    await within(dialog).findByText(/Exact Copilot conversation is missing/)
    expect(value.props.openAgencyCopilot).toHaveBeenCalledExactlyOnceWith(row, undefined)
    expect(value.props.createTask).not.toHaveBeenCalled()
    expect(value.props.connectTask).not.toHaveBeenCalled()
    expect(value.props.startWork).not.toHaveBeenCalled()
  })

  it('submits the captured draft revision rather than a newer incoming row revision', async () => {
    const row = task()
    const value = mountBoard([row])
    await ready()
    fireEvent.click(screen.getByRole('article'))
    change(en.description, 'Unsaved draft')
    value.replace({ tasks: [{ ...row, revision: 2, title: 'Changed remotely' }] })
    fireEvent.click(button(en.save))
    await waitFor(() => {
      expect(value.props.updateTask).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: row.id, revision: 1 }),
        expect.objectContaining({ title: row.title, description: 'Unsaved draft' }),
      )
    })
  })

  it('requires saving dirty inputs before either planning-status action and moves the saved revision', async () => {
    const row = task({ status: 'in_progress' })
    const saved = { ...row, description: 'Saved draft', revision: row.revision + 1 }
    const value = mountBoard([row])
    vi.mocked(value.props.updateTask).mockImplementation(async () => { value.replace({ tasks: [saved] }) })
    await ready()
    fireEvent.click(screen.getByRole('article'))
    change(en.description, saved.description)
    expect(button(en.inReview).disabled).toBe(true)
    expect(button(en.submitReview).disabled).toBe(true)
    fireEvent.click(button(en.inReview))
    fireEvent.click(button(en.submitReview))
    expect(value.props.moveTask).not.toHaveBeenCalled()
    fireEvent.click(button(en.save))
    await waitFor(() => { expect(button(en.submitReview).disabled).toBe(false) })
    expect(value.props.updateTask).toHaveBeenCalledExactlyOnceWith(row, expect.objectContaining({ description: saved.description }))
    fireEvent.click(button(en.submitReview))
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenCalledExactlyOnceWith(saved, 'in_review') })
  })

  it('starts the next edit at the current revision after reverting a draft and changing status', async () => {
    const row = task({ status: 'in_progress' })
    const moved = task({ ...row, status: 'in_review', revision: row.revision + 1 })
    const value = mountBoard([row])
    vi.mocked(value.props.moveTask).mockImplementation(async () => { value.replace({ tasks: [moved] }) })
    await ready()
    fireEvent.click(screen.getByRole('article'))
    change(en.description, 'Discarded local draft')
    change(en.description, row.description)
    expect(button(en.submitReview).disabled).toBe(false)
    fireEvent.click(button(en.submitReview))
    await waitFor(() => { expect(button(en.save).disabled).toBe(false) })
    change(en.description, 'New revision draft')
    fireEvent.click(button(en.save))
    await waitFor(() => {
      expect(value.props.updateTask).toHaveBeenCalledExactlyOnceWith(moved, expect.objectContaining({ description: 'New revision draft' }))
    })
  })

  it.each(['succeeded', 'failed'] as const)('keeps Details open during Save and allows dismissal after it %s', async (outcome) => {
    const row = task()
    const saved = { ...row, description: 'Pending save draft', revision: row.revision + 1 }
    const value = mountBoard([row])
    const gate = Promise.withResolvers<undefined>()
    vi.mocked(value.props.updateTask).mockImplementation(async () => {
      await gate.promise
      value.replace({ tasks: [saved] })
    })
    await ready()
    fireEvent.click(screen.getByRole('article'))
    change(en.description, saved.description)
    const dialog = screen.getByRole('dialog', { name: en.taskDetails })
    try {
      fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
      expect(value.props.updateTask).toHaveBeenCalledOnce()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.getByRole('dialog', { name: en.taskDetails })).toBe(dialog)
      clickMask(dialog)
      expect(screen.getByRole('dialog', { name: en.taskDetails })).toBe(dialog)
      fireEvent.click(within(dialog).getByRole('button', { name: en.close }))
      expect(screen.getByRole('dialog', { name: en.taskDetails })).toBe(dialog)
      await act(async () => {
        if (outcome === 'failed') gate.reject(new Error('Save rejected'))
        else gate.resolve(undefined)
      })
      expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: en.description }).value).toBe(saved.description)
      if (outcome === 'failed') expect(within(dialog).getByRole('alert').textContent).toContain('Save rejected')
      else expect(within(dialog).queryByRole('alert')).toBeNull()
      expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.close }).disabled).toBe(false)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      fireEvent.click(screen.getByRole('article'))
      const reopened = screen.getByRole('dialog', { name: en.taskDetails })
      expect(within(reopened).getByRole<HTMLTextAreaElement>('textbox', { name: en.description }).value)
        .toBe(outcome === 'failed' ? row.description : saved.description)
      expect(within(reopened).queryByRole('alert')).toBeNull()
      fireEvent.click(within(reopened).getByRole('button', { name: en.close }))
      expect(screen.queryByRole('dialog')).toBeNull()
    } finally {
      await act(async () => { gate.resolve(undefined) })
    }
  })

  it.each(['succeeded', 'failed'].flatMap(outcome => [false, true].map(closeAfterSave => ({ outcome, closeAfterSave }))))(
    'keeps New Task open while saving: %j', async ({ outcome, closeAfterSave }) => {
      const value = mountBoard()
      const gate = Promise.withResolvers<undefined>()
      const create = vi.mocked(value.props.createTask)
      const original = create.getMockImplementation()
      if (original === undefined) throw new Error('Create fixture is missing')
      create.mockImplementation(async (request) => { await gate.promise; return original(request) })
      await ready()
      fireEvent.click(button(en.newTask))
      change(en.taskTitle, 'Pending creation')
      change(en.prompt, 'Retained run instructions')
      const dialog = screen.getByRole('dialog', { name: en.newTask })
      try {
        fireEvent.click(within(dialog).getByRole('button', { name: closeAfterSave ? en.saveAndClose : en.save }))
        expect(create).toHaveBeenCalledOnce()
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.getByRole('dialog', { name: en.newTask })).toBe(dialog)
        clickMask(dialog)
        expect(screen.getByRole('dialog', { name: en.newTask })).toBe(dialog)
        fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
        expect(screen.getByRole('dialog', { name: en.newTask })).toBe(dialog)
        await act(async () => {
          if (outcome === 'failed') gate.reject(new Error('Create rejected'))
          else gate.resolve(undefined)
        })
        if (outcome === 'failed') {
          expect(within(dialog).getByRole('alert').textContent).toContain('Create rejected')
          expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).value).toBe('Pending creation')
          expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('Retained run instructions')
          fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
          expect(screen.queryByRole('dialog')).toBeNull()
          expect(screen.queryByRole('article')).toBeNull()
          fireEvent.click(button(en.newTask))
          const reopened = screen.getByRole('dialog', { name: en.newTask })
          expect(within(reopened).getByRole<HTMLInputElement>('textbox', { name: en.taskTitle }).value).toBe('')
          expect(within(reopened).queryByRole('alert')).toBeNull()
          fireEvent.keyDown(document, { key: 'Escape' })
        } else {
          expect(screen.queryByRole('dialog', { name: en.newTask })).toBeNull()
          expect(screen.queryByRole('dialog', { name: en.taskDetails }) !== null).toBe(!closeAfterSave)
          fireEvent.keyDown(document, { key: 'Escape' })
          expect(screen.queryByRole('dialog')).toBeNull()
          fireEvent.click(screen.getByRole('article', { name: 'Pending creation' }))
          const reopened = screen.getByRole('dialog', { name: en.taskDetails })
          expect(within(reopened).getByRole<HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('Retained run instructions')
          clickMask(reopened)
        }
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(create).toHaveBeenCalledOnce()
      } finally {
        await act(async () => { gate.resolve(undefined) })
      }
    })

  it('requires explicit delete confirmation and retains a failed deletion for retry', async () => {
    const row = task()
    const value = mountBoard([row])
    vi.mocked(value.props.deleteTask).mockRejectedValueOnce(new Error('Delete failed'))
    await ready()
    fireEvent.click(screen.getByRole('article'))
    fireEvent.click(button(en.deleteTask))
    fireEvent.click(button(en.deleteTask))
    await screen.findByText(/Delete failed/)
    expect(screen.getByRole('article')).toBeTruthy()
    fireEvent.click(button(en.deleteTask))
    await waitFor(() =>{  expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.queryByRole('article')).toBeNull()
  })

  it('filters by title, description and labels without moving tasks', async () => {
    const value = mountBoard([task({ labels: ['bug'] }), task({ id: 'other' as TaskboardTask['id'], title: 'Other', description: '' })])
    await ready()
    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'bug' } })
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(value.props.moveTask).not.toHaveBeenCalled()
    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: 'evidence' } })
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('changes status in aggregate and filtered views but reorders only within an unfiltered single Workspace', async () => {
    const row = task({ status: 'in_progress' })
    const anchor = task({ id: 'anchor' as TaskboardTask['id'], title: 'Review anchor', status: 'in_review' })
    const foreign = task({
      id: 'foreign' as TaskboardTask['id'], workspaceId: 'other' as TaskboardTask['workspaceId'],
      title: 'Other Workspace review', status: 'in_review',
    })
    const value = mountBoard([row, anchor, foreign])
    await ready()
    const card = screen.getByRole('article', { name: row.title })
    expect(card.draggable).toBe(true)
    const dataTransfer = dragData()
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(screen.getByRole('article', { name: foreign.title }), { dataTransfer })
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenLastCalledWith(row, 'in_review', undefined) })
    fireEvent.change(screen.getByRole('combobox', { name: en.workspace }), { target: { value: row.workspaceId } })
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(screen.getByRole('article', { name: anchor.title }), { dataTransfer })
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenLastCalledWith(row, 'in_review', anchor.id) })
    fireEvent.change(screen.getByPlaceholderText(en.search), { target: { value: row.title } })
    expect(card.draggable).toBe(true)
    const backlog = value.container.querySelector<HTMLElement>('section[data-status="backlog"]')?.lastElementChild
    if (backlog === null || backlog === undefined) throw new Error('Backlog column is missing')
    fireEvent.dragStart(card, { dataTransfer })
    fireEvent.drop(backlog, { dataTransfer })
    await waitFor(() => { expect(value.props.moveTask).toHaveBeenLastCalledWith(row, 'backlog', undefined) })
  })
})
