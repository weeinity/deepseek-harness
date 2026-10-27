import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FileCredentialStore } from '../src/store.ts'
import { defaultAuthPath, expandHomePath, resolveDshHome } from '../src/home.ts'

describe('home paths', () => {
  it('expands a tilde prefix', () => {
    expect(expandHomePath('~')).toMatch(/[\\/]/)
    expect(expandHomePath('~/oauth')).toMatch(/oauth$/)
  })

  it('prefers DSH_HOME over the default', () => {
    const home = resolveDshHome(undefined, { DSH_HOME: 'C:/tmp/dsh-home' })
    expect(home.replaceAll('\\', '/')).toMatch(/tmp\/dsh-home$/)
  })

  it('places the auth file under the home', () => {
    expect(defaultAuthPath('C:/tmp/dsh-home').replaceAll('\\', '/')).toBe('C:/tmp/dsh-home/pi-ai-oauth.json')
  })
})

describe('FileCredentialStore', () => {
  it('round-trips an OAuth credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-oauth-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const store = new FileCredentialStore(join(dir, 'pi-ai-oauth.json'))
    const credential = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60_000,
    }
    await store.modify('xai', async () => credential)
    expect(await store.read('xai')).toEqual(credential)
    expect(await store.list()).toEqual([{ providerId: 'xai', type: 'oauth' }])
    const raw = await readFile(store.path, 'utf8')
    expect(JSON.parse(raw).xai.access).toBe('access-token')
    await store.delete('xai')
    expect(await store.read('xai')).toBeUndefined()
  })

  it('serializes concurrent modify calls per provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-oauth-'))
    onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const store = new FileCredentialStore(join(dir, 'pi-ai-oauth.json'))
    await Promise.all([
      store.modify('xai', async () => ({
        type: 'oauth', access: 'a', refresh: 'r', expires: 1,
      })),
      store.modify('xai', async current => {
        assert(current?.type === 'oauth')
        return { type: 'oauth', access: `${current.access}-b`, refresh: 'r', expires: 2 }
      }),
    ])
    const saved = await store.read('xai')
    expect(saved?.type).toBe('oauth')
    expect(saved && 'access' in saved ? saved.access : '').toMatch(/b$/)
  })
})
