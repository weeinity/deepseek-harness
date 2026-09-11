// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TaskboardListAgencyCopilotSessionsValue } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import { CopilotSessionPicker } from '../src/client/CopilotSessionPicker.tsx'
import { en, zh } from '../src/client/locales.ts'

type Props = ComponentProps<typeof CopilotSessionPicker>
const workspaceId = 'workspace' as Props['workspaceId']
const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as NonNullable<Props['value']>
const available: TaskboardListAgencyCopilotSessionsValue = {
  sessions: [{ sessionId, summary: 'Investigation', status: 'in_use' }], truncated: false,
}

function props(dictionary: typeof en | typeof zh = en): Props {
  const locale = new LocaleRuntime(new Context())
  locale.register('taskboard', { en: dictionary, zh: dictionary })
  return {
    workspaceId, value: undefined, disabled: false,
    t: locale.bind('taskboard'),
    listSessions: vi.fn(async () => available),
    onChange: vi.fn(),
  }
}

afterEach(cleanup)

describe('CopilotSessionPicker', () => {
  it.each([en, zh])('lists session summaries and live ownership using localized copy', async (dictionary) => {
    const value = props(dictionary)
    render(<CopilotSessionPicker {...value} />)
    screen.getByText(dictionary.copilotSessionsLoading)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: dictionary.copilotSessionsRefresh }).disabled).toBe(true)
    const option = await screen.findByRole('option', { name: new RegExp(dictionary.copilotRunning) })
    expect(option.textContent).toContain('Investigation')
    expect(option.textContent).toContain(sessionId.slice(0, 8))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: sessionId } })
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(value.listSessions).toHaveBeenCalledExactlyOnceWith(workspaceId)
    screen.getByText(dictionary.copilotSessionHint)
  })

  it('shows discovery failure rather than an empty list and retries only on request', async () => {
    const value = props()
    vi.mocked(value.listSessions).mockRejectedValueOnce(new Error('Agency unavailable'))
    render(<CopilotSessionPicker {...value} />)
    const error = await screen.findByRole('alert')
    expect(error.textContent).toBe('Could not load Copilot sessions: Agency unavailable')
    expect(screen.queryByText(en.copilotSessionsEmpty)).toBeNull()
    expect(value.listSessions).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: en.copilotSessionsRefresh }))
    await screen.findByRole('option', { name: /Investigation/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(value.listSessions).toHaveBeenCalledTimes(2)
    expect(value.onChange).not.toHaveBeenCalled()
  })

  it('ignores a delayed result from another Workspace', async () => {
    const value = props()
    const old = Promise.withResolvers<TaskboardListAgencyCopilotSessionsValue>()
    vi.mocked(value.listSessions).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ sessions: [], truncated: false })
    const view = render(<CopilotSessionPicker {...value} />)
    const other = 'other' as Props['workspaceId']
    view.rerender(<CopilotSessionPicker {...value} workspaceId={other} />)
    await screen.findByText(en.copilotSessionsEmpty)
    await act(async () => { old.resolve(available) })
    expect(screen.queryByRole('option', { name: /Investigation/ })).toBeNull()
    expect(value.listSessions).toHaveBeenLastCalledWith(other)
    expect(value.onChange).not.toHaveBeenCalled()
  })

  it('keeps an existing link visible during discovery failure and allows clearing it', async () => {
    const value = { ...props(), value: sessionId }
    vi.mocked(value.listSessions).mockRejectedValueOnce(new Error('Offline'))
    render(<CopilotSessionPicker {...value} />)
    await screen.findByRole('alert')
    const select = screen.getByRole<HTMLSelectElement>('combobox')
    expect(select.value).toBe(sessionId)
    expect(value.onChange).not.toHaveBeenCalled()
    fireEvent.change(select, { target: { value: '' } })
    expect(value.onChange).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('reports an incomplete catalog and preserves selection when refreshing it', async () => {
    const value = { ...props(), value: sessionId }
    vi.mocked(value.listSessions).mockResolvedValue({ ...available, truncated: true })
    render(<CopilotSessionPicker {...value} />)
    await screen.findByText(en.copilotSessionsTruncated)
    fireEvent.click(screen.getByRole('button', { name: en.copilotSessionsRefresh }))
    await waitFor(() => { expect(value.listSessions).toHaveBeenCalledTimes(2) })
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(sessionId)
    expect(value.onChange).not.toHaveBeenCalled()
  })

  it('disables selection and refresh while a task write is pending', async () => {
    render(<CopilotSessionPicker {...props()} disabled />)
    await screen.findByRole('option', { name: /Investigation/ })
    expect(screen.getByRole<HTMLSelectElement>('combobox').disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.copilotSessionsRefresh }).disabled).toBe(true)
  })

  it('ignores a failed retired discovery and renders opaque errors from the active request', async () => {
    const value = props()
    const retired = Promise.withResolvers<TaskboardListAgencyCopilotSessionsValue>()
    vi.mocked(value.listSessions).mockReturnValueOnce(retired.promise).mockRejectedValueOnce('Connection unavailable')
    const view = render(<CopilotSessionPicker {...value} />)
    try {
      view.rerender(<CopilotSessionPicker {...value} workspaceId={'next-workspace' as Props['workspaceId']} />)
      await screen.findByText('Could not load Copilot sessions: Connection unavailable')
      await act(async () => { retired.reject(new Error('Retired discovery failed')) })
      expect(screen.queryByText(/Retired discovery failed/)).toBeNull()
      expect(screen.getByRole('alert').textContent).toContain('Connection unavailable')
    } finally { await act(async () => { retired.resolve(available) }) }
  })
})
