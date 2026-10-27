import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as OAuth from '../src/index.ts'

it('persists live provider toggles, restores them at restart, and disposes routes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'oauth-settings-'))
  const contexts: Context[] = []
  try {
    const dir = join(home, 'profiles', 'test')
    await initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    await mkdir(bundle, { recursive: true })
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    await writeFile(join(home, 'package.json'), '{"name":"oauth-test"}\n')
    await writeFile(join(bundle, 'package.json'), JSON.stringify({
      name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'llm', name: 'cordis:llm' },
      { id: 'provider-directory', name: 'cordis:directory' },
      { id: 'subscription', name: 'cordis:oauth', config: {
        catalog: ['github-copilot'], providers: {}, authPath: join(home, 'unused-auth.json'),
      } },
    ] }]))
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = async () => {
      const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), ctx => {
        ctx.provide('profileContext', profile)
        ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, llm: LlmRuntime, oauth: OAuth })
        ctx.loader.builtins.directory = {
          inject: ['llm'],
          apply(ctx: Context) {
            ctx.llm.registerConfigurableProviders([{
              provider: 'github-copilot', displayName: 'GitHub Copilot',
              settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'github-copilot'],
            }])
          },
        }
      })
      contexts.push(ctx)
      return ctx
    }
    const ctx = await start()
    const entry = [...ctx.loader.entries()].find(row => row.options.id === 'subscription')
    const fiber = entry?.fiber
    expect(fiber).toBeDefined()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.settings.describe().find(row => row.ns === 'subscription')).toMatchObject({
      autoGenerate: false, value: { providers: {} },
    })
    const before = await readFile(profile.patchPath, 'utf8')
    await expect(ctx.settings.update('subscription', { providers: { openrouter: {} } })).rejects.toThrow('not in catalog')
    expect(await readFile(profile.patchPath, 'utf8')).toBe(before)
    await ctx.settings.mutate('subscription', [{ op: 'set', path: ['providers', 'github-copilot'], value: {} }])
    expect(ctx.llm.listProviders().map(row => row.id)).toEqual(['github-copilot'])
    expect(ctx.llm.listConfigurableProviders()).toMatchObject([{ provider: 'github-copilot', settingsNs: 'llm-pi-ai' }])
    expect(entry?.fiber).toBe(fiber)
    await ctx.settings.mutate('subscription', [{ op: 'unset', path: ['providers', 'github-copilot'] }])
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.settings.mutate('subscription', [{ op: 'set', path: ['providers', 'github-copilot'], value: {} }])
    await ctx.fiber.dispose()
    const restored = await start()
    expect(restored.llm.listProviders().map(row => row.id)).toEqual(['github-copilot'])
    const restoredEntry = [...restored.loader.entries()].find(row => row.options.id === 'subscription')
    await restoredEntry?.fiber?.dispose()
    expect(restored.llm.listProviders()).toEqual([])
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
