// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorEntry, ConnectorMutationReceipt, ConnectorSnapshot } from '../src/client/contract.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ConnectorsSection } from '../src/client/ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from '../src/client/contract.ts'
import { ConnectorRequestError } from '../src/client/request-error.ts'
import { en, zh } from '../src/client/locales.ts'
import { entry, pending, props, SNAPSHOT } from './fixtures.client.ts'

afterEach(cleanup)

function operations(snapshot = SNAPSHOT) {
  return {
    list: vi.fn<ConnectorsSectionInjected['list']>().mockResolvedValue(snapshot),
    setEnabled: vi.fn<ConnectorsSectionInjected['setEnabled']>().mockRejectedValue(new Error('Unexpected write')),
  }
}

async function ready(snapshot = SNAPSHOT) {
  const calls = operations(snapshot)
  const view = render(<ConnectorsSection {...props(calls)} />)
  await screen.findByRole('switch', { name: `Enable ${snapshot.entries[0]!.serverName}` })
  return { calls, view }
}

describe('Connectors settings', () => {
  it('lists servers in configured order and does not equate enablement with connectivity', async () => {
    const { calls } = await ready()
    const list = screen.getByRole('list')
    expect(within(list).getAllByRole('listitem').map(row => row.getAttribute('aria-label')))
      .toEqual(SNAPSHOT.entries.map(row => row.serverName))
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    expect(within(list).getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    expect(within(list).getByRole('switch', { name: 'Enable Obsidian' }).getAttribute('aria-checked')).toBe('false')
    expect(within(list).getByText(en['phase.failed'], { exact: false })).toBeTruthy()
    expect(screen.queryByText('Connected', { exact: true })).toBeNull()
    expect(screen.getByText(en.intro)).toBeTruthy()
    for (const row of screen.getAllByRole('listitem')) expect(row.querySelector('[data-connector-mark] > svg, [data-connector-mark] > img')).not.toBeNull()
    expect(calls.list).toHaveBeenCalledOnce()
    expect(calls.setEnabled).not.toHaveBeenCalled()
  })

  it('keeps identity marks for enabled, disabled and failed servers', async () => {
    await ready()
    for (const [name, mark, element] of [['WorkIQ', 'workiq', 'svg'], ['Obsidian', 'obsidian', 'img'], ['ECS', 'ecs', 'img']] as const) {
      expect(screen.getByRole('listitem', { name }).querySelector(`[data-connector-mark="${mark}"] ${element}`)).not.toBeNull()
    }
  })

  it('searches names, identities and transports without changing the matching entries order', async () => {
    await ready()
    const search = screen.getByRole('searchbox', { name: en.search })
    fireEvent.change(search, { target: { value: '  OBSIDIAN  ' } })
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Enable Obsidian' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'root/mcp-workiq' } })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'streamable-http' } })
    expect(screen.getByRole('switch', { name: 'Enable Obsidian' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(en.noMatches)
    fireEvent.change(search, { target: { value: '   ' } })
    expect(screen.getAllByRole('switch')).toHaveLength(3)
    expect(screen.getAllByRole('listitem').map(row => row.getAttribute('aria-label')))
      .toEqual(SNAPSHOT.entries.map(row => row.serverName))
  })

  it('distinguishes an unanswered read from an empty configured directory', async () => {
    const read = pending<ConnectorSnapshot>()
    const calls = operations()
    calls.list.mockReturnValueOnce(read.promise)
    render(<ConnectorsSection {...props(calls)} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
    expect(screen.queryByText(en.empty)).toBeNull()
    await act(async () => { read.resolve({ ...SNAPSHOT, entries: [] }) })
    expect(screen.getByRole('status').textContent).toBe(en.empty)
  })

  it('recovers an explicit read failure through Retry', async () => {
    const calls = operations()
    calls.list.mockRejectedValueOnce(new Error('offline'))
    render(<ConnectorsSection {...props(calls)} />)
    expect((await screen.findByRole('alert')).textContent).toContain(en.loadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(calls.list).toHaveBeenCalledTimes(2)
  })

  it('keeps rows in place while awaiting Host acknowledgment and after disabling and re-enabling', async () => {
    const { calls } = await ready()
    const rows = screen.getAllByRole('listitem')
    const control = screen.getByRole('switch', { name: 'Enable WorkIQ' })
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    fireEvent.click(control)
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    expect(calls.setEnabled).toHaveBeenLastCalledWith({
      id: SNAPSHOT.entries[0]!.id, enabled: false,
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    for (const control of screen.getAllByRole<HTMLButtonElement>('switch')) expect(control.disabled).toBe(true)
    expect(screen.getByRole('listitem', { name: 'WorkIQ' }).querySelector('svg[width="12"]')).toBeNull()
    expect(screen.getByRole('listitem', { name: 'WorkIQ' }).querySelector('[data-connector-mark="workiq"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.refresh }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(en.saving)
    for (const [index, row] of rows.entries()) expect(screen.getAllByRole('listitem')[index]).toBe(row)

    const updated: ConnectorSnapshot = {
      ...SNAPSHOT,
      entries: SNAPSHOT.entries.map(row => row.serverName === 'WorkIQ' ? { ...row, enabled: false, fiberPhase: null } : row),
    }
    await act(async () => { write.resolve({ applied: true, snapshot: updated }) })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' })).toBe(control)
    expect(control.getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('listitem', { name: 'WorkIQ' }).querySelector('[data-connector-mark="workiq"]')).not.toBeNull()
    for (const [index, row] of rows.entries()) expect(screen.getAllByRole('listitem')[index]).toBe(row)
    calls.setEnabled.mockResolvedValueOnce({ applied: true, snapshot: SNAPSHOT })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(calls.setEnabled).toHaveBeenLastCalledWith({
        id: SNAPSHOT.entries[0]!.id, enabled: true,
      })
      expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' })).toBe(control)
    for (const [index, row] of rows.entries()) expect(screen.getAllByRole('listitem')[index]).toBe(row)
  })

  it.each([
    new Error('offline'),
    new ConnectorRequestError('connectors/save-failed'),
  ])('preserves the last confirmed value after a rejected write (%s)', async (error) => {
    const { calls } = await ready()
    calls.setEnabled.mockRejectedValueOnce(error)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(calls.setEnabled).toHaveBeenCalledOnce()
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(calls.list).toHaveBeenCalledTimes(2) })
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the confirmed snapshot when a persisted change is not active', async () => {
    const { calls } = await ready()
    calls.setEnabled.mockResolvedValueOnce({
      applied: false, snapshot: SNAPSHOT,
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(calls.setEnabled).toHaveBeenCalledOnce()
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps read-only profiles inert even when an entry claims it can be toggled', async () => {
    const { calls } = await ready({ ...SNAPSHOT, capability: 'read-only' })
    expect(screen.getByText(en['blocked.unsupported-context'])).toBeTruthy()
    for (const control of screen.getAllByRole<HTMLButtonElement>('switch')) {
      expect(control.disabled).toBe(true)
      fireEvent.click(control)
    }
    for (const row of screen.getAllByRole('listitem')) {
      expect(row.querySelector('svg[width="12"]')?.getAttribute('aria-hidden')).toBe('true')
      expect(row.querySelector('[data-connector-mark] > svg, [data-connector-mark] > img')).not.toBeNull()
    }
    expect(calls.setEnabled).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported-context', en['blocked.unsupported-context']],
    ['unsupported-target', en['blocked.unsupported-target']],
  ] as const)('explains why %s entries cannot be changed', async (blockedReason, message) => {
    const { calls } = await ready({
      ...SNAPSHOT, entries: [entry('Restricted', true, { canToggle: false, blockedReason })],
    })
    const toggle = screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable Restricted' })
    expect(toggle.disabled).toBe(true)
    expect(toggle.title).toBe(message)
    expect(screen.getByText(message)).toBeTruthy()
    fireEvent.click(toggle)
    expect(calls.setEnabled).not.toHaveBeenCalled()
  })

  it('shows every observed lifecycle phase without inventing a transport', async () => {
    const phases: ConnectorEntry['fiberPhase'][] = ['pending', 'loading', 'active', 'failed', 'unloading', null]
    await ready({
      ...SNAPSHOT,
      entries: phases.map((fiberPhase, index) => entry(`Phase ${index}`, true, { fiberPhase, transport: null })),
    })
    for (const [index, phase] of phases.entries()) {
      expect(screen.getAllByRole('listitem')[index]!.textContent).toContain(`MCP · ${en[`phase.${phase ?? 'unobserved'}`]}`)
    }
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'MCP' } })
    expect(screen.getAllByRole('switch')).toHaveLength(phases.length)
  })

  it.each(['switch', 'search', 'body'] as const)('restores switch focus unless the user moves it to another control (focus: %s)', async (focus) => {
    const { calls } = await ready()
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    const control = screen.getByRole('switch', { name: 'Enable WorkIQ' })
    control.focus()
    fireEvent.click(control)
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    const search = screen.getByRole('searchbox', { name: en.search })
    if (focus === 'search') search.focus()
    else if (focus === 'body') control.blur()
    await act(async () => {
      write.resolve({
        applied: true,
        snapshot: {
          ...SNAPSHOT,
          entries: SNAPSHOT.entries.map(row => row.serverName === 'WorkIQ' ? { ...row, enabled: false } : row),
        },
      })
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' })).toBe(control)
    expect(document.activeElement).toBe(focus === 'search' ? search : control)
  })

  it.each(['refresh', 'switch'] as const)('does not claim focus from another %s control', async (kind) => {
    const { calls } = await ready()
    const focused = kind === 'refresh'
      ? screen.getByRole('button', { name: en.refresh })
      : screen.getByRole('switch', { name: 'Enable WorkIQ' })
    focused.focus()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Obsidian' }))
    await waitFor(() => {
      expect(calls.setEnabled).toHaveBeenCalledOnce()
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable Obsidian' }).disabled).toBe(false)
    })
    expect(document.activeElement).toBe(focused)
  })

  it.each(['resolve', 'reject'] as const)('ignores an older read that %ss after a newer operation source replaces it', async (settle) => {
    const old = pending<ConnectorSnapshot>()
    const calls = operations()
    calls.list.mockReturnValueOnce(old.promise)
    const view = render(<ConnectorsSection {...props(calls)} />)
    const current = operations({ ...SNAPSHOT, entries: [entry('Current', true)] })
    view.rerender(<ConnectorsSection {...props(current)} />)
    await screen.findByRole('switch', { name: 'Enable Current' })
    await act(async () => {
      if (settle === 'resolve') old.resolve(SNAPSHOT)
      else old.reject(new Error('older read failed'))
    })
    expect(screen.queryByRole('switch', { name: 'Enable WorkIQ' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable Current' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('contains a %s settlement after the page unmounts', async (settle) => {
    const { calls, view } = await ready()
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => {
      if (settle === 'resolve') write.resolve({ applied: true, snapshot: SNAPSHOT })
      else write.reject(new Error('settled after unmount'))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('localizes the heading, search, toggles and transport labels in one list', async () => {
    render(<ConnectorsSection {...props(operations())} t={makeTranslate(zh)} />)
    await screen.findByRole('switch', { name: '启用 WorkIQ' })
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: zh.search })).toBeTruthy()
    expect(screen.getAllByRole('list')).toHaveLength(1)
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain(`${zh.stdio} · ${zh['phase.active']}`)
    expect(screen.getByRole('listitem', { name: 'Obsidian' }).textContent).toContain(`${zh.http} · ${zh['phase.disabled']}`)
  })
})
