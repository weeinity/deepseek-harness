// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectorMutationReceipt, ConnectorSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, type TestContext } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { ConnectorsSection } from '../src/client/ConnectorsSection.tsx'
import type { ConnectorsSectionInjected } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { SNAPSHOT } from './fixtures.client.ts'

usePinnedBrowserLanguages('en-US')

type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function bench(test: TestContext) {
  const runtime = await SlotTestRuntime.create()
  test.onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  class RemoteService extends Service {
    constructor(ctx: Context) { super(ctx, 'remote') }
  }
  new RemoteService(runtime.ctx)
  const list = vi.fn<() => Promise<Reply<ConnectorSnapshot>>>()
    .mockResolvedValue({ ok: true, value: SNAPSHOT })
  const setEnabled = vi.fn<(request: Parameters<ConnectorsSectionInjected['setEnabled']>[0]) => Promise<Reply<ConnectorMutationReceipt>>>()
    .mockResolvedValue({ ok: true, value: { persisted: true, applied: true, restartRequired: false, snapshot: SNAPSHOT } })
  runtime.ctx.provide('remote.connectors', { list, setEnabled })
  return { runtime, locale, list, setEnabled }
}

describe('Connectors browser plugin', () => {
  it('keeps the Host half inert', () => {
    expect(hostApply).not.toThrow()
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.connectors'])
  })

  it('registers lazily and releases its section and dictionaries across declaration lifetimes', async (test) => {
    const { runtime, locale, list } = await bench(test)
    const feature = await runtime.mount({ inject: [...inject], apply })
    expect(runtime.slots.entries('settings.section')).toHaveLength(0)
    const declare = () => runtime.root.declare({ 'settings.section': { kind: 'list', scope: 'root' } }, () => null)
    await declare()
    await waitFor(() => { expect(runtime.slots.entries('settings.section')).toHaveLength(1) })
    const entry = runtime.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(ConnectorsSection)
    expect(entry.options).toMatchObject({ id: 'connectors', order: 15 })
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

  it('adapts Remote reads, successful writes, and refused writes without exposing error details', async (test) => {
    const { runtime, list, setEnabled } = await bench(test)
    list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'private host detail' } })
    await runtime.declare({ 'settings.section': { kind: 'list', scope: 'root' } })
    await runtime.mount({ inject: [...inject], apply })
    runtime.renderSlot('settings.section', { close: () => {} })
    expect((await screen.findByRole('alert')).textContent).toContain(en.loadFailed)
    expect(screen.queryByText('private host detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await screen.findByRole('switch', { name: 'Enable WorkIQ' })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    await waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith({
        id: SNAPSHOT.entries[0]!.id, enabled: false, expectedRevision: SNAPSHOT.revision,
      })
      expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Enable WorkIQ' }).disabled).toBe(false)
    })
    setEnabled.mockResolvedValueOnce({ ok: false, error: { code: 'connectors/conflict', message: 'private configuration' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable WorkIQ' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.conflict)
    expect(screen.queryByText('private configuration')).toBeNull()
  })
})
