// @vitest-environment jsdom
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangeResult, PluginInfo, PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { ConnectorsSection } from '../src/client/ConnectorsSection.tsx'
import { en, zh } from '../src/client/locales.ts'
import { pending, SNAPSHOT } from './fixtures.client.ts'

usePinnedBrowserLanguages('en-US')

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function bench() {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const rows: PluginInfo[] = SNAPSHOT.entries.map(row => ({
    entryId: row.id, moduleName: '@deepseek-ai/dsh-mcp-client', enabled: row.enabled, fiberPhase: row.fiberPhase,
    patchId: row.id, connector: { serverName: row.serverName, transport: row.transport },
  }))
  const list = vi.fn<() => Promise<Reply<PluginInventorySnapshot>>>()
    .mockResolvedValue({ ok: true, value: { entries: rows, managementAvailable: true } })
  const listPlugins = vi.fn<() => Promise<Reply<PluginInfo[]>>>().mockResolvedValue({ ok: true, value: rows })
  const setEnabled = vi.fn<(id: PluginInfo['entryId'], enabled: boolean) => Promise<Reply<ChangeResult>>>()
    .mockResolvedValue({ ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'mcp' } })
  runtime.remote.provideNamespaces({
    pluginInventory: { list },
    pluginManager: { listPlugins, setPluginEnabled: setEnabled },
  })
  return { runtime, locale, list, listPlugins, rows, setEnabled }
}

describe('Connectors browser plugin', () => {
  it('keeps the Host half inert', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.pluginInventory', 'remote.pluginManager'])
  })

  it('registers lazily and releases its section and dictionaries across declaration lifetimes', async () => {
    const { runtime, locale, list } = await bench()
    const feature = await runtime.mount({ inject: [...inject], apply })
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    const declare = () => runtime.root.declare({ 'settings.section': { kind: 'list', scope: 'root' } }, () => null)
    await declare()
    await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })
    const entry = runtime.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ConnectorsSection)
    expect(entry.options).toMatchObject({ id: 'connectors', order: 14 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Connectors')
    expect(list).not.toHaveBeenCalled()
    locale.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe('连接器')
    runtime.root.release()
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    await declare()
    await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })
    await feature.dispose()
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    expect(() => { locale.register('settings.connectors', { en, zh })() }).not.toThrow()
  })

  it('adapts Remote reads, successful writes, and refused writes without exposing error details', async () => {
    const { runtime, list, setEnabled } = await bench()
    list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'private host detail' } })
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    runtime.renderSlot('shell.overlay', {})
    expect((await screen.findByRole('alert')).textContent).toContain(en.loadFailed)
    expect(screen.queryByText('private host detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith(SNAPSHOT.entries[0]!.id, false)
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    })
    setEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'private configuration' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.saveFailed) })
    expect(screen.queryByText('private configuration')).toBeNull()
  })

  it('retains a read-only directory without a profile manager and excludes non-MCP entries', async () => {
    const { runtime, list, listPlugins, rows } = await bench()
    list.mockResolvedValue({ ok: true, value: { entries: [...rows, {
      entryId: rows[0]!.entryId, moduleName: 'unrelated', enabled: true, fiberPhase: 'active',
    }] } })
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    expect(screen.getAllByRole('switch')).toHaveLength(3)
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(true)
    expect(listPlugins).not.toHaveBeenCalled()
  })

  it.each(['failed', 'overridden', 'restart-required'] as const)('reports a saved but %s change', async (application) => {
    const { runtime, setEnabled } = await bench()
    setEnabled.mockResolvedValue({ ok: true, value: { changed: true, application, stage: 'enable', target: 'mcp' } })
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    runtime.renderSlot('shell.overlay', {})
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable WorkIQ' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.restartRequired)
  })

  it('reports an unchanged failed write without inventing persistence', async () => {
    const { runtime, setEnabled } = await bench()
    setEnabled.mockResolvedValue({ ok: true, value: { changed: false, application: 'failed', stage: 'enable', target: 'mcp' } })
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    runtime.renderSlot('shell.overlay', {})
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable WorkIQ' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.saveFailed)
  })

  it.each(['saved', 'saveFailed'] as const)('reports %s after the Settings section closes, then dismisses the notice', async (kind) => {
    const { runtime, setEnabled } = await bench()
    const result = pending<Reply<ChangeResult>>()
    setEnabled.mockReturnValueOnce(result.promise)
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    const section = runtime.renderSlot('settings.section', { close: () => {} })
    runtime.renderSlot('shell.overlay', {})
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledOnce() })
    section.update({ close: () => {} }, { only: 'closed' })
    expect(screen.queryByRole('switch')).toBeNull()
    await act(async () => {
      result.resolve(kind === 'saved'
        ? { ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'mcp' } }
        : { ok: false, error: { code: 'REMOTE_ERROR', message: 'private detail' } })
    })
    expect((await screen.findByRole('alert')).textContent).toBe(en[kind])
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() }, { timeout: 6000 })
  })

  it('removes the overlay and suppresses pending write notices after disposal', async () => {
    const { runtime, setEnabled } = await bench()
    const result = pending<Reply<ChangeResult>>()
    setEnabled.mockReturnValueOnce(result.promise)
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' }, 'shell.overlay': { kind: 'list', scope: 'root' } })
    const feature = await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    runtime.renderSlot('shell.overlay', {})
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => { expect(setEnabled).toHaveBeenCalledOnce() })
    await feature.dispose()
    await act(async () => {
      result.resolve({ ok: true, value: { changed: true, application: 'applied', stage: 'enable', target: 'mcp' } })
    })
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
