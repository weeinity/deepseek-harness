// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorEntry, ConnectorMutationReceipt, ConnectorSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ConnectorsSection } from '../src/client/ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from '../src/client/contract.ts'
import { ConnectorRequestError } from '../src/client/request-error.ts'
import { en, zh } from '../src/client/locales.ts'
import { entry, pending, props, revision, SNAPSHOT } from './fixtures.client.ts'

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
  it('groups configured servers, draws connector icons, and does not equate enablement with connectivity', async () => {
    const { calls } = await ready()
    const enabled = screen.getByRole('region', { name: 'Enabled (2)' })
    const disabled = screen.getByRole('region', { name: 'Disabled (1)' })
    expect(within(enabled).getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    expect(within(disabled).getByRole('switch', { name: 'Enable Obsidian' }).getAttribute('aria-checked')).toBe('false')
    expect(within(enabled).getByText(en['phase.failed'], { exact: false })).toBeTruthy()
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

  it('searches names, identities and transports case-insensitively across both groups', async () => {
    await ready()
    const search = screen.getByRole('searchbox', { name: en.search })
    fireEvent.change(search, { target: { value: '  OBSIDIAN  ' } })
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getByRole('switch', { name: 'Enable Obsidian' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: /^Enabled/ })).toBeNull()
    fireEvent.change(search, { target: { value: 'root/mcp-workiq' } })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'streamable-http' } })
    expect(screen.getByRole('switch', { name: 'Enable Obsidian' })).toBeTruthy()
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toBe(en.noMatches)
    fireEvent.change(search, { target: { value: '   ' } })
    expect(screen.getAllByRole('switch')).toHaveLength(3)
  })

  it('distinguishes an unanswered read from an empty configured directory', async () => {
    const read = pending<ConnectorSnapshot>()
    const calls = operations()
    calls.list.mockReturnValueOnce(read.promise)
    render(<ConnectorsSection {...props(calls)} />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
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

  it('waits for Host acknowledgment and uses the returned revision when disabling and re-enabling', async () => {
    const { calls } = await ready()
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    expect(calls.setEnabled).toHaveBeenLastCalledWith({
      id: SNAPSHOT.entries[0]!.id, enabled: false, expectedRevision: SNAPSHOT.revision,
    })
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    for (const control of screen.getAllByRole<HTMLButtonElement>('switch')) expect(control.disabled).toBe(true)
    expect(screen.getByRole('listitem', { name: 'WorkIQ' }).querySelector('svg[width="12"]')).toBeNull()
    expect(screen.getByRole('listitem', { name: 'WorkIQ' }).querySelector('[data-connector-mark="workiq"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.refresh }).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(en.saving)

    const updated: ConnectorSnapshot = {
      ...SNAPSHOT,
      revision: revision('revision-2'),
      entries: SNAPSHOT.entries.map(row => row.serverName === 'WorkIQ' ? { ...row, enabled: false, fiberPhase: null } : row),
    }
    await act(async () => { write.resolve({ persisted: true, applied: true, restartRequired: false, snapshot: updated }) })
    const disabled = screen.getByRole('region', { name: 'Disabled (2)' })
    expect(within(disabled).getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('false')
    expect(within(disabled).getByRole('listitem', { name: 'WorkIQ' }).querySelector('[data-connector-mark="workiq"]')).not.toBeNull()
    calls.setEnabled.mockResolvedValueOnce({ persisted: true, applied: true, restartRequired: false, snapshot: SNAPSHOT })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(calls.setEnabled).toHaveBeenLastCalledWith({
        id: SNAPSHOT.entries[0]!.id, enabled: true, expectedRevision: updated.revision,
      })
      expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    })
  })

  it.each([
    [new Error('offline'), en.saveFailed],
    [new ConnectorRequestError('connectors/conflict'), en.conflict],
  ])('preserves the last confirmed value after a rejected write (%s)', async (error, message) => {
    const { calls } = await ready()
    calls.setEnabled.mockRejectedValueOnce(error)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(calls.list).toHaveBeenCalledTimes(2) })
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports persistence and failed activation separately', async () => {
    const { calls } = await ready()
    calls.setEnabled.mockResolvedValueOnce({
      persisted: true, applied: false, restartRequired: true, snapshot: SNAPSHOT,
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.restartRequired)
    expect(screen.getByRole('switch', { name: 'Enable WorkIQ' }).getAttribute('aria-checked')).toBe('true')
  })

  it('keeps read-only profiles inert even when an entry claims it can be toggled', async () => {
    const { calls } = await ready({ ...SNAPSHOT, capability: 'read-only' })
    expect(screen.getByText(en['blocked.unsupported-context'])).toBeTruthy()
    for (const control of screen.getAllByRole<HTMLButtonElement>('switch')) {
      expect(control.disabled).toBe(true)
      expect(control.getAttribute('aria-disabled')).toBe('true')
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
    ['higher-precedence', en['blocked.higher-precedence']],
    ['local-only', en['blocked.local-only']],
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

  it.each([false, true])('restores switch focus unless the user moves it (moved: %s)', async (moveFocus) => {
    const { calls } = await ready()
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    const control = screen.getByRole('switch', { name: 'Enable WorkIQ' })
    control.focus()
    fireEvent.click(control)
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    const search = screen.getByRole('searchbox', { name: en.search })
    if (moveFocus) search.focus()
    await act(async () => {
      write.resolve({
        persisted: true, applied: true, restartRequired: false,
        snapshot: {
          ...SNAPSHOT,
          entries: SNAPSHOT.entries.map(row => row.serverName === 'WorkIQ' ? { ...row, enabled: false } : row),
        },
      })
    })
    expect(document.activeElement).toBe(moveFocus ? search : screen.getByRole('switch', { name: 'Enable WorkIQ' }))
  })

  it('ignores an older read when a newer operation source replaces it', async () => {
    const old = pending<ConnectorSnapshot>()
    const calls = operations()
    calls.list.mockReturnValueOnce(old.promise)
    const view = render(<ConnectorsSection {...props(calls)} />)
    const current = operations({ ...SNAPSHOT, entries: [entry('Current', true)] })
    view.rerender(<ConnectorsSection {...props(current)} />)
    await screen.findByRole('switch', { name: 'Enable Current' })
    await act(async () => { old.resolve(SNAPSHOT) })
    expect(screen.queryByRole('switch', { name: 'Enable WorkIQ' })).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('contains a %s settlement after the page unmounts', async (settle) => {
    const { calls, view } = await ready()
    const write = pending<ConnectorMutationReceipt>()
    calls.setEnabled.mockReturnValueOnce(write.promise)
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(calls.setEnabled).toHaveBeenCalledOnce() })
    view.unmount()
    await act(async () => {
      if (settle === 'resolve') write.resolve({ persisted: true, applied: true, restartRequired: false, snapshot: SNAPSHOT })
      else write.reject(new Error('settled after unmount'))
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('localizes the heading, search, groups, toggles and transport labels', async () => {
    render(<ConnectorsSection {...props(operations())} t={makeTranslate(zh)} />)
    await screen.findByRole('switch', { name: '启用 WorkIQ' })
    expect(screen.getByRole('heading', { name: zh.title })).toBeTruthy()
    expect(screen.getByRole('searchbox', { name: zh.search })).toBeTruthy()
    expect(screen.getByRole('region', { name: '已启用（2）' })).toBeTruthy()
    expect(screen.getByRole('region', { name: '已禁用（1）' })).toBeTruthy()
    expect(screen.getAllByRole('listitem')[0]!.textContent).toContain(`${zh.stdio} · ${zh['phase.active']}`)
  })
})
