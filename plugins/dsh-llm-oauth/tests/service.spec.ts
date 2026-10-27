import { describe, expect, it, beforeEach } from 'vitest'
import { OAuthController } from '../src/service.ts'
import { resetLoginWatches } from '../src/command.ts'
import type { OAuthControlAdapter } from '../src/command.ts'

function fakeAdapter(): OAuthControlAdapter {
  const auth = new Map<string, { type: 'oauth' } | undefined>([
    ['xai', { type: 'oauth' }],
    ['openrouter', undefined],
  ])
  return {
    authPath: () => '/tmp/pi-ai-oauth.json',
    catalogIds: () => ['xai', 'openrouter'],
    routeIds: () => ['xai', 'openrouter'],
    displayName: (id: string) => id === 'xai' ? 'xAI' : id,
    checkAuth: async (id: string) => auth.get(id),
    logout: async (id: string) => { auth.set(id, undefined) },
    login: async () => ({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 1 }),
  }
}

describe('OAuthController', () => {
  beforeEach(() => {
    resetLoginWatches()
  })

  it('reports enabled and login state per catalog row', async () => {
    const enabled = new Set<string>(['xai'])
    const controller = new OAuthController(fakeAdapter(), {
      listEnabled: () => [...enabled],
      enable: async (id) => { enabled.add(id) },
      disable: async (id) => { enabled.delete(id) },
    })

    const snap = await controller.status()
    expect(snap.authPath).toBe('/tmp/pi-ai-oauth.json')
    expect(snap.enabled).toEqual(['xai'])
    expect(snap.providers).toEqual([
      expect.objectContaining({ id: 'xai', name: 'xAI', enabled: true, loggedIn: true, authType: 'oauth' }),
      expect.objectContaining({ id: 'openrouter', enabled: false, loggedIn: false }),
    ])
  })

  it('enable/disable go through hooks', async () => {
    const enabled = new Set<string>()
    const controller = new OAuthController(fakeAdapter(), {
      listEnabled: () => [...enabled],
      enable: async (id) => { enabled.add(id) },
      disable: async (id) => { enabled.delete(id) },
    })
    await controller.enable('openrouter')
    expect(enabled.has('openrouter')).toBe(true)
    await controller.disable('openrouter')
    expect(enabled.has('openrouter')).toBe(false)
  })

  it('refuses unknown catalog ids', async () => {
    const controller = new OAuthController(fakeAdapter(), {
      listEnabled: () => [],
      enable: async () => undefined,
      disable: async () => undefined,
    })
    await expect(controller.enable('nope')).rejects.toThrow(/unknown catalog/)
  })
})
