/** Portable Web setup ordering, failure containment, and machine-local data preservation. */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { readProfileManifest, resolveProfileDir, writeProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { initializeMoYuState, setupWeb, WEB_FEATURES, webFeatureBundles, webFeatureInstallSpecs, type WebSetupRunner } from './setup-web.ts'

const expectedBundles = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  'dsh-llm-oauth',
  'my-app',
  'dsh-dashboard',
  '@tt-a1i/archify-dsh',
  'dsh-better-sidebar',
  '@linxin666/dsh-client-ui-skill-explorer',
  'dsh-context',
  '@xmanrui/dsh-im',
  'dshmarket',
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  'dsh-stocks',
  '@wxg-prc-cpg/browser-skill-dsh-plugin',
  '@liustack/modsearch',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
]

async function fixture(profile = 'web') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-web-setup-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const root = join(directory, 'checkout with spaces')
  const home = join(directory, 'machine-local home')
  const profileDir = resolveProfileDir(profile, home)
  for (const feature of WEB_FEATURES) {
    if (feature.source !== 'local') continue
    const packageDir = join(root, 'plugins', feature.name)
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: feature.name }))
  }
  const run = vi.fn<WebSetupRunner>(async (args) => {
    if (args[0] !== 'dsh') return
    const manifest = readProfileManifest('setup-web fixture', profileDir)
    const dependencies = { ...manifest.dependencies }
    for (const feature of WEB_FEATURES) {
      if (feature.source === 'builtin') continue
      dependencies[feature.name] = 'fixture-installed'
      const packageDir = join(profileDir, 'node_modules', feature.name)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({
        name: feature.name,
        version: '0.0.0',
        exports: { './package.json': './package.json' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
      }))
      await writeFile(join(packageDir, 'cordis.patch.yml'), '[]\n')
    }
    writeProfileManifest(profileDir, { ...manifest, dependencies })
  })
  const log = vi.fn<(message: string) => void>()
  return { root, home, profile, profileDir, run, log }
}

describe('portable Web feature selections', () => {
  it('pins every external source and retains the complete feature order', () => {
    const root = join(tmpdir(), 'checkout with spaces')
    expect(WEB_FEATURES.map(feature => feature.name)).toEqual(expectedBundles)
    expect(webFeatureInstallSpecs(root)).toEqual([
      `link:${join(root, 'plugins', 'dsh-llm-oauth')}`,
      'github:thebiggavin/marketingdashboard#f793de6f9f9874c120585cd6f6b293333067fa46',
      `link:${join(root, 'plugins', 'dsh-dashboard')}`,
      '@tt-a1i/archify-dsh@0.1.0',
      'dsh-better-sidebar@0.28.0',
      '@linxin666/dsh-client-ui-skill-explorer@0.4.4',
      'dsh-context@0.41.3',
      '@xmanrui/dsh-im@4.34.2',
      'dshmarket@1.66.8',
      `link:${join(root, 'plugins', 'dsh-stocks')}`,
      '@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.2',
      '@liustack/modsearch@5.10.6',
    ])
  })

  it('orders managed bundles once and preserves unrelated selections in their relative order', () => {
    expect(webFeatureBundles(['custom-first', 'dsh-stocks', 'custom-last', 'dsh-stocks'])).toEqual([
      ...expectedBundles, 'custom-first', 'custom-last',
    ])
  })
})

describe('portable Web setup', () => {
  it('builds the core and local plugins before installing through the supported CLI', async () => {
    const f = await fixture('portable-web')
    await setupWeb(f)
    expect(f.run.mock.calls).toEqual([
      [['run', 'build'], f.root],
      [['install', '--frozen-lockfile'], join(f.root, 'plugins', 'dsh-llm-oauth')],
      [['run', 'typecheck'], join(f.root, 'plugins', 'dsh-llm-oauth')],
      [['run', 'build'], join(f.root, 'plugins', 'dsh-llm-oauth')],
      [['install', '--frozen-lockfile'], join(f.root, 'plugins', 'dsh-dashboard')],
      [['run', 'typecheck'], join(f.root, 'plugins', 'dsh-dashboard')],
      [['run', 'build'], join(f.root, 'plugins', 'dsh-dashboard')],
      [['install', '--frozen-lockfile'], join(f.root, 'plugins', 'dsh-stocks')],
      [['run', 'typecheck'], join(f.root, 'plugins', 'dsh-stocks')],
      [['run', 'build'], join(f.root, 'plugins', 'dsh-stocks')],
      [['dsh', 'plugin', '--profile', 'portable-web', 'add', '--save-exact', ...webFeatureInstallSpecs(f.root)], f.root],
    ])
    expect(readProfileManifest('fixture', f.profileDir).dsh?.profile?.bundles).toEqual(expectedBundles)
    expect(JSON.parse(await readFile(join(f.home, 'stocks', 'state.json'), 'utf8'))).toEqual({
      version: 1, revision: 0, watchlist: [], alerts: [],
    })
    await expect(access(join(f.profileDir, 'package.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves profile metadata, unrelated dependencies, patch files and existing personal data on repeated setup', async () => {
    const f = await fixture()
    await mkdir(f.profileDir, { recursive: true })
    writeProfileManifest(f.profileDir, {
      name: 'my-existing-profile',
      private: true,
      dependencies: { 'unrelated-package': '1.2.3' },
      dsh: { profile: { bundles: ['custom-first', 'dsh-stocks', 'custom-last'] } },
    })
    const localFiles = [
      [join(f.profileDir, 'cordis.patch.yml'), '[] # machine-specific profile\n'],
      [join(f.home, 'cordis.patch.yml'), '[] # machine-specific home\n'],
      [join(f.home, 'pi-ai-oauth.json'), '{"fixture":"machine-local-sign-in"}\n'],
      [join(f.home, 'stocks', 'state.json'), '{"version":1,"revision":7,"watchlist":["FIXTURE"],"alerts":[]}\n'],
    ] as const
    for (const [file, contents] of localFiles) {
      if (file === join(f.home, 'stocks', 'state.json')) await mkdir(join(f.home, 'stocks'), { recursive: true })
      await writeFile(file, contents)
    }
    await setupWeb(f)
    const first = await readFile(join(f.profileDir, 'package.json'), 'utf8')
    await setupWeb(f)
    expect(await readFile(join(f.profileDir, 'package.json'), 'utf8')).toBe(first)
    const manifest = readProfileManifest('fixture', f.profileDir)
    expect(manifest.name).toBe('my-existing-profile')
    expect(manifest.private).toBe(true)
    expect(manifest.dependencies?.['unrelated-package']).toBe('1.2.3')
    expect(manifest.dsh?.profile?.bundles).toEqual([...expectedBundles, 'custom-first', 'custom-last'])
    for (const [file, contents] of localFiles) expect(await readFile(file, 'utf8')).toBe(contents)
    expect(f.log).toHaveBeenCalledWith('Kept existing MoYu data')
  })

  it.each(['../web', 'nested\\web', '', 'desktop'])('rejects profile %j before any package operation', async (profile) => {
    const f = await fixture()
    await expect(setupWeb({ ...f, profile })).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['missing', 'wrong-name', 'invalid-json'])('rejects %s local source before building', async (failure) => {
    const f = await fixture()
    const file = join(f.root, 'plugins', 'dsh-dashboard', 'package.json')
    if (failure === 'missing') await rm(file)
    else await writeFile(file, failure === 'wrong-name' ? '{"name":"different-package"}' : '{')
    await expect(setupWeb(f)).rejects.toThrow()
    expect(f.run).not.toHaveBeenCalled()
    await expect(access(f.profileDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([0, 2, 6, 10])('stops dependent work after command %i fails', async (failureIndex) => {
    const f = await fixture()
    const install = f.run.getMockImplementation()!
    const failure = new Error('fixture command failed')
    let index = 0
    f.run.mockImplementation((args, cwd) => index++ === failureIndex ? Promise.reject(failure) : install(args, cwd))
    await expect(setupWeb(f)).rejects.toBe(failure)
    expect(f.run).toHaveBeenCalledTimes(failureIndex + 1)
    await expect(access(join(f.home, 'stocks', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.log.mock.calls.some(([message]) => message.includes('Web extensions installed'))).toBe(false)
  })

  it.each(['dependency', 'bundle'])('does not activate a missing %s after the package operation', async (missing) => {
    const f = await fixture()
    const install = f.run.getMockImplementation()!
    f.run.mockImplementation(async (args, cwd) => {
      await install(args, cwd)
      if (args[0] !== 'dsh') return
      if (missing === 'dependency') {
        const manifest = readProfileManifest('fixture', f.profileDir)
        delete manifest.dependencies!['dsh-stocks']
        writeProfileManifest(f.profileDir, manifest)
      } else {
        await writeFile(join(f.profileDir, 'node_modules', 'dsh-stocks', 'package.json'), '{"name":"dsh-stocks"}')
      }
    })
    await expect(setupWeb(f)).rejects.toThrow(/dsh-stocks is missing or has no bundle declaration/)
    expect(readProfileManifest('fixture', f.profileDir).dsh?.profile?.bundles).not.toContain('dsh-stocks')
    await expect(access(join(f.home, 'stocks', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(f.profileDir, 'package.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('sets up independent homes concurrently without sharing profile or state paths', async () => {
    const first = await fixture()
    const second = await fixture()
    await Promise.all([setupWeb(first), setupWeb(second)])
    for (const f of [first, second]) {
      expect(readProfileManifest('fixture', f.profileDir).dsh?.profile?.bundles).toEqual(expectedBundles)
      await expect(access(join(f.home, 'stocks', 'state.json'))).resolves.toBeUndefined()
    }
    expect(first.run.mock.calls.at(-1)?.[0]).not.toEqual(second.run.mock.calls.at(-1)?.[0])
  })
})

describe('MoYu state initialization', () => {
  it('exclusively creates one empty state during concurrent initialization', async () => {
    const f = await fixture()
    expect((await Promise.all([initializeMoYuState(f.home), initializeMoYuState(f.home)])).sort()).toEqual([false, true])
    expect(await readFile(join(f.home, 'stocks', 'state.json'), 'utf8')).toBe(
      '{"version":1,"revision":0,"watchlist":[],"alerts":[]}\n',
    )
  })

  it('preserves malformed existing bytes rather than replacing or repairing them', async () => {
    const f = await fixture()
    await mkdir(join(f.home, 'stocks'), { recursive: true })
    const file = join(f.home, 'stocks', 'state.json')
    await writeFile(file, 'malformed fixture state\n')
    await expect(initializeMoYuState(f.home)).resolves.toBe(false)
    expect(await readFile(file, 'utf8')).toBe('malformed fixture state\n')
  })

  it('reports an unwritable state directory without claiming initialization', async () => {
    const f = await fixture()
    await mkdir(f.home, { recursive: true })
    await writeFile(join(f.home, 'stocks'), 'fixture file blocks the directory\n')
    await expect(initializeMoYuState(f.home)).rejects.toThrow()
    expect(await readFile(join(f.home, 'stocks'), 'utf8')).toBe('fixture file blocks the directory\n')
  })
})
