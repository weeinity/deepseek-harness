// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskboardSnapshot, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type {
  TaskboardSessionActionProps, TaskboardSessionButtonOwnerProps, TaskboardSessionButtonProps,
} from '../src/client/contract.ts'
import { TaskSessionAction, TaskSessionButton } from '../src/client/TaskSessionAction.tsx'
import { createTaskboardNavigationStore } from '../src/client/navigation-store.ts'
import { en, zh } from '../src/client/locales.ts'
import { copilot, dsh, execution, runtime, task, translate } from './fixtures.client.ts'

afterEach(cleanup)

function mountButton(tasks: TaskboardSessionButtonOwnerProps['tasks'], dictionary: typeof en | typeof zh = en) {
  const navigation = createTaskboardNavigationStore().create()
  const props = {
    tasks, actions: navigation.actions, useStore: selector => selector(navigation.getSnapshot()),
    t: translate(dictionary), openSurface: vi.fn(),
  } satisfies Pick<TaskboardSessionButtonProps, 'tasks' | 'actions' | 'useStore' | 't' | 'openSurface'>
  const view = render(<TaskSessionButton {...props as TaskboardSessionButtonProps} />)
  return { ...view, props, navigation, replace: (next: TaskboardSessionButtonOwnerProps['tasks']) => {
    props.tasks = next
    view.rerender(<TaskSessionButton {...props as TaskboardSessionButtonProps} />)
  } }
}

describe('Session task navigation', () => {
  it('uses current DSH links for the bound Session, including archives but not legacy or historical links', () => {
    const linked = task({ connection: dsh })
    const archived = task({ id: 'archived' as TaskboardTask['id'], connection: dsh, archivedAt: '2026-01-02' })
    let snapshot: TaskboardSnapshot = {
      tasks: [linked, archived, task({ connection: copilot }), task({ unresolvedConnections: [dsh] }),
        task({ executions: [execution('succeeded')] }), task()],
      phase: 'ready', state: 'idle', error: null, runtime, agencyByTask: {}, agencyState: 'idle', agencyError: null,
    }
    const props = {
      sessionId: dsh.sessionId,
      useTaskboard: selector => selector(snapshot),
      renderSlot: vi.fn(() => <span data-testid="task-control" />),
    } satisfies Pick<TaskboardSessionActionProps, 'sessionId' | 'useTaskboard' | 'renderSlot'>
    const view = render(<TaskSessionAction {...props as TaskboardSessionActionProps} />)
    expect(props.renderSlot).toHaveBeenCalledExactlyOnceWith(
      'conversation.session.header.utilities.taskboard', { tasks: [linked, archived] },
    )
    props.renderSlot.mockClear()
    view.rerender(<TaskSessionAction {...props as TaskboardSessionActionProps} sessionId={'unlinked' as typeof dsh.sessionId} />)
    expect(screen.queryByTestId('task-control')).toBeNull()
    expect(props.renderSlot).not.toHaveBeenCalled()
    snapshot = { ...snapshot, tasks: [task({ executions: [execution('succeeded')], unresolvedConnections: [dsh] })] }
    view.rerender(<TaskSessionAction {...props as TaskboardSessionActionProps} />)
    expect(screen.queryByTestId('task-control')).toBeNull()
    expect(props.renderSlot).not.toHaveBeenCalled()
  })

  it.each([en, zh])('opens a single task directly with localized header copy', (dictionary) => {
    const row = task({ connection: dsh })
    const value = mountButton([row], dictionary)
    const button = screen.getByRole('button', { name: dictionary.openTask })
    expect(button.title).toBe(dictionary.openTaskHint)
    expect(button.hasAttribute('aria-haspopup')).toBe(false)
    expect(button.querySelector('[aria-hidden="true"] svg')).not.toBeNull()
    fireEvent.click(button)
    expect(value.navigation.getSnapshot().requestedTaskId).toBe(row.id)
    expect(value.props.openSurface).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each([en, zh])('lets the user choose the exact task when a Session has several current links', (dictionary) => {
    const first = task({ connection: dsh })
    const second = task({ id: 'second' as TaskboardTask['id'], ordinal: 2, title: first.title,
      connection: dsh, archivedAt: '2026-01-02' })
    const value = mountButton([first, second], dictionary)
    const button = screen.getByRole('button', { name: dictionary.openTask })
    expect(button.title).toBe(dictionary.chooseTask)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(value.props.openSurface).not.toHaveBeenCalled()
    const t = translate(dictionary)
    fireEvent.click(screen.getByRole('menuitem', {
      name: t('taskOption', { id: 'DSH-002', title: second.title }),
    }))
    expect(value.navigation.getSnapshot().requestedTaskId).toBe(second.id)
    expect(value.props.openSurface).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes the chooser on Escape and does not reopen it when associations change', () => {
    const first = task({ connection: dsh })
    const second = task({ id: 'second' as TaskboardTask['id'], ordinal: 2, connection: dsh })
    const value = mountButton([first, second])
    const button = screen.getByRole('button', { name: en.openTask })
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(button)
    value.replace([first])
    expect(screen.queryByRole('menu')).toBeNull()
    value.replace([first, second])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(value.props.openSurface).not.toHaveBeenCalled()
  })

  it('consumes only the handled request and isolates separate store lifetimes', () => {
    const handle = createTaskboardNavigationStore()
    const navigation = handle.create()
    const separate = handle.create()
    const first = task().id
    const second = 'second' as TaskboardTask['id']
    navigation.actions.openTask(first)
    navigation.actions.openTask(second)
    navigation.actions.completeTaskRequest(first)
    expect(navigation.getSnapshot().requestedTaskId).toBe(second)
    expect(separate.getSnapshot().requestedTaskId).toBeUndefined()
    navigation.actions.completeTaskRequest(second)
    expect(navigation.getSnapshot().requestedTaskId).toBeUndefined()
  })
})
