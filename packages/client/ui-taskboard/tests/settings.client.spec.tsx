// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskboardRuntimeState } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import { TaskboardSettings } from '../src/client/TaskboardSettings.tsx'
import { en } from '../src/client/locales.ts'
import { runtime, translate } from './fixtures.client.ts'

afterEach(cleanup)

describe('Taskboard settings feedback', () => {
  it.each(['enabled', 'announceToAgent', 'preventIdleSleep'] as const)('waits for Host %s state and preserves failed writes for retry', async (key) => {
    const gate = Promise.withResolvers<TaskboardRuntimeState>()
    const updated = { ...runtime, settings: { ...runtime.settings, [key]: !runtime.settings[key] } }
    const update = vi.fn(async () => gate.promise)
    const props = { runtime, t: translate(), updateSettings: update, onClose: vi.fn() }
    const view = render(<TaskboardSettings {...props} />)
    try {
      fireEvent.click(screen.getByRole('switch', { name: en[key] }))
      expect(update).toHaveBeenCalledExactlyOnceWith({ [key]: !runtime.settings[key] })
      expect(screen.getAllByRole<HTMLInputElement>('switch').every(input => input.disabled)).toBe(true)
      await act(async () => { gate.reject(new Error('Settings unavailable')) })
      expect(screen.getByRole('alert').textContent).toContain('Settings unavailable')
      expect(screen.getByRole<HTMLInputElement>('switch', { name: en[key] }).checked).toBe(runtime.settings[key])
      update.mockResolvedValue(updated)
      fireEvent.click(screen.getByRole('switch', { name: en[key] }))
      await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
      expect(screen.getByRole<HTMLInputElement>('switch', { name: en[key] }).checked).toBe(runtime.settings[key])
      view.rerender(<TaskboardSettings {...props} runtime={updated} />)
      expect(screen.getByRole<HTMLInputElement>('switch', { name: en[key] }).checked).toBe(!runtime.settings[key])
      fireEvent.click(screen.getByRole('button', { name: en.close }))
      expect(props.onClose).toHaveBeenCalledOnce()
    } finally { await act(async () => { gate.resolve(updated) }) }
  })

  it('shows scheduler and incomplete-session observations alongside an opaque write failure', async () => {
    const value = { ...runtime, power: { ...runtime.power, sessionStateKnown: false },
      scheduler: { error: 'Schedule recovery failed' } }
    const updateSettings = vi.fn<Parameters<typeof TaskboardSettings>[0]['updateSettings']>().mockRejectedValue('Storage unavailable')
    render(<TaskboardSettings runtime={value} t={translate()} updateSettings={updateSettings} onClose={vi.fn()} />)
    screen.getByText(en.sessionStateUnknown)
    screen.getByText(translate()('schedulerError', { message: 'Schedule recovery failed' }))
    fireEvent.click(screen.getByRole('switch', { name: en.enabled }))
    await screen.findByText(translate()('error', { message: 'Storage unavailable' }))
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })
})
