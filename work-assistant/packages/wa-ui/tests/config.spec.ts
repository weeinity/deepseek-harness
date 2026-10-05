import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { CLIENT_CONFIG_KEY, resolveClientConfig } from '../src/config.ts'

describe('public assistant configuration', () => {
  it('resolves explicit disabled defaults without forwarding unknown Host fields', () => {
    expect(resolveClientConfig({ privateHostField: 'not-for-the-browser' })).toEqual({
      maxActivities: 6, inboxRefreshIntervalMs: 15000, inboxRequestTimeoutMs: 10000, defaultTab: 'timeline', receipt: null,
    })
  })

  it('publishes the configured policy and disposes its boot contribution', async () => {
    const ctx = new Context()
    const ids = ['personal-assistant']
    const fiber = ctx.plugin({ Config, apply }, {
      maxActivities: 3,
      defaultTab: 'memory',
      receipt: { presetIds: ids, style: 'neutral' },
    })
    try {
      await fiber.await()
      ids.push('another-preset')
      const rows: IndexInjection[] = []
      ctx.emit('webserver/index-inject', rows)
      expect(rows).toEqual([{
        kind: 'global',
        name: CLIENT_CONFIG_KEY,
        value: { maxActivities: 3, inboxRefreshIntervalMs: 15000, inboxRequestTimeoutMs: 10000, defaultTab: 'memory', receipt: { presetIds: ['personal-assistant'], style: 'neutral' } },
      }])
    } finally {
      await fiber.dispose()
    }
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toEqual([])
    await ctx.fiber.dispose()
  })

  it('validates bounded refresh intervals and admits the Inbox tab', () => {
    expect(resolveClientConfig({ defaultTab: 'inbox', inboxRefreshIntervalMs: 1000 })).toMatchObject({ defaultTab: 'inbox', inboxRefreshIntervalMs: 1000 })
    expect(resolveClientConfig({ inboxRefreshIntervalMs: 300000 })).toMatchObject({ inboxRefreshIntervalMs: 300000 })
    expect(() => resolveClientConfig({ inboxRefreshIntervalMs: 999 })).toThrow()
    expect(() => resolveClientConfig({ inboxRefreshIntervalMs: 300001 })).toThrow()
    expect(resolveClientConfig({ inboxRequestTimeoutMs: 100 })).toMatchObject({ inboxRequestTimeoutMs: 100 })
    expect(resolveClientConfig({ inboxRequestTimeoutMs: 120000 })).toMatchObject({ inboxRequestTimeoutMs: 120000 })
    expect(() => resolveClientConfig({ inboxRequestTimeoutMs: 99 })).toThrow()
    expect(() => resolveClientConfig({ inboxRequestTimeoutMs: 120001 })).toThrow()
  })

  it('rejects invalid receipt targets at configuration admission', () => {
    expect(() => resolveClientConfig({ receipt: { presetIds: [''], style: 'thumbs-up' } })).toThrow()
    expect(() => resolveClientConfig({ receipt: { presetIds: ['personal-assistant'] } })).toThrow()
  })
})
