/** Build and install this fork's Web extensions without importing another machine's profile data. */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  initProfile, readProfilePlugins, resolveProfileDir, writeProfileBundles,
} from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** Ordered bundle selections; package sources are pinned and local sources build from this checkout. */
export const WEB_FEATURES = [
  { name: '@deepseek-ai/dsh-base', source: 'builtin' },
  { name: '@deepseek-ai/dsh-web-app', source: 'builtin' },
  { name: 'dsh-llm-oauth', source: 'local' },
  { name: 'my-app', source: 'package', spec: 'github:thebiggavin/marketingdashboard#f793de6f9f9874c120585cd6f6b293333067fa46' },
  { name: 'dsh-dashboard', source: 'local' },
  { name: '@tt-a1i/archify-dsh', source: 'package', spec: '@tt-a1i/archify-dsh@0.1.0' },
  { name: 'dsh-better-sidebar', source: 'package', spec: 'dsh-better-sidebar@0.28.0' },
  { name: '@linxin666/dsh-client-ui-skill-explorer', source: 'package', spec: '@linxin666/dsh-client-ui-skill-explorer@0.4.4' },
  { name: 'dsh-context', source: 'package', spec: 'dsh-context@0.41.3' },
  { name: '@xmanrui/dsh-im', source: 'package', spec: '@xmanrui/dsh-im@4.34.2' },
  { name: 'dshmarket', source: 'package', spec: 'dshmarket@1.66.8' },
  { name: '@deepseek-ai/dsh-experimental-agent-team-profile', source: 'builtin' },
  { name: 'dsh-stocks', source: 'local' },
  { name: '@wxg-prc-cpg/browser-skill-dsh-plugin', source: 'package', spec: '@wxg-prc-cpg/browser-skill-dsh-plugin@0.3.2' },
  { name: '@liustack/modsearch', source: 'package', spec: '@liustack/modsearch@5.10.6' },
  { name: '@deepseek-ai/dsh-experimental-plugin-market-bundle', source: 'builtin' },
] as const

/** Shell-free package operation, resolved only after the parent has selected its pnpm entrypoint. */
export type WebSetupRunner = (args: readonly string[], cwd: string) => Promise<void>

/**
 * Resolve profile install arguments without shell quoting or paths from the original machine.
 * @param root - absolute checkout directory.
 * @returns one argument per non-builtin dependency, preserving bundle order.
 */
export function webFeatureInstallSpecs(root: string): string[] {
  return WEB_FEATURES.flatMap((feature) => {
    switch (feature.source) {
      case 'builtin': return []
      case 'local': return [`link:${join(root, 'plugins', feature.name)}`]
      case 'package': return [feature.spec]
      default: return assertNever(feature)
    }
  })
}

/**
 * Select the managed bundles in their declared order and retain unrelated bundles afterward.
 * @param previous - current profile bundle list.
 * @returns the managed bundle list followed by existing unrelated selections in their original order.
 */
export function webFeatureBundles(previous: readonly string[]): string[] {
  const managed = WEB_FEATURES.map(feature => feature.name)
  const names = new Set<string>(managed)
  return [...managed, ...previous.filter(name => !names.has(name))]
}

/**
 * Initialize the default MoYu state using exclusive creation; existing bytes are never replaced.
 * @param home - resolved DSH data directory.
 * @returns true when setup created the file, false when it already existed.
 * @throws if the directory or a new state file cannot be written.
 */
export async function initializeMoYuState(home: string): Promise<boolean> {
  const directory = join(home, 'stocks')
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(join(directory, 'state.json'), JSON.stringify({
      version: 1, revision: 0, watchlist: [], alerts: [],
    }) + '\n', { flag: 'wx' })
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Build the core and local plugins, then use DSH's installer and lock the final bundle update.
 * Existing patches and credentials are untouched. A failure stops subsequent operations; successful
 * builds and package operations are retained so the user can correct the error and rerun setup.
 * @param options - checkout, profile, data root, package runner and progress sink.
 * @returns resolution after installation, activation ordering and initial MoYu state are complete.
 */
export async function setupWeb(options: {
  root: string
  profile: string
  home: string
  run: WebSetupRunner
  log: (message: string) => void
}): Promise<void> {
  const { root, profile, home, run, log } = options
  const profileDir = resolveProfileDir(profile, home)
  if (profile === 'desktop') throw new Error('setup:web configures Web profiles, not the reserved Desktop profile.')
  const locals = WEB_FEATURES.filter(feature => feature.source === 'local')
  for (const feature of locals) {
    const file = join(root, 'plugins', feature.name, 'package.json')
    const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || !('name' in manifest) || manifest.name !== feature.name) {
      throw new Error(`setup:web: ${file} must declare package ${feature.name}. Restore the plugin source and retry.`)
    }
  }

  log('Building DSH')
  await run(['run', 'build'], root)
  for (const feature of locals) {
    const directory = join(root, 'plugins', feature.name)
    log(`Installing, checking and building ${feature.name}`)
    await run(['install', '--frozen-lockfile'], directory)
    await run(['run', 'typecheck'], directory)
    await run(['run', 'build'], directory)
  }

  await mkdir(profileDir, { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  await withFileLock(manifestPath, () => {
    initProfile(profileDir, WEB_FEATURES.filter(feature => feature.source === 'builtin').map(feature => feature.name))
    return Promise.resolve()
  }, { waitMs: 120000 })

  log(`Installing pinned extensions into profile ${profile}`)
  await run(['dsh', 'plugin', '--profile', profile, 'add', '--save-exact', ...webFeatureInstallSpecs(root)], root)
  await withFileLock(manifestPath, () => {
    const { manifest, dependencies } = readProfilePlugins({
      binName: 'setup:web',
      profileDir,
      installAnchor: join(root, 'apps', 'cli', 'package.json'),
    })
    for (const feature of WEB_FEATURES) {
      if (feature.source !== 'builtin' && !dependencies.some(dependency => dependency.name === feature.name && dependency.bundle)) {
        throw new Error(`setup:web: ${feature.name} is missing or has no bundle declaration after installation. Restore the package and rerun setup.`)
      }
    }
    writeProfileBundles(profileDir, manifest, webFeatureBundles(manifest.dsh?.profile?.bundles ?? []))
    return Promise.resolve()
  }, { waitMs: 120000 })

  const created = await initializeMoYuState(home)
  log(created ? 'Created an empty MoYu watchlist' : 'Kept existing MoYu data')
  log(`Web extensions installed in ${profileDir}. Restart DSH; configure connector access, provider keys and OAuth sign-ins on this machine.`)
}

function runPnpm(environment: NodeJS.ProcessEnv): WebSetupRunner {
  return (args, cwd) => new Promise((resolveCommand, reject) => {
    const invocation = pnpmInvocation(args, environment)
    const child = spawn(invocation.command, invocation.args, { cwd, env: environment, stdio: 'inherit' })
    let launchError: Error | undefined
    child.once('error', (error) => { launchError = error })
    child.once('close', (code, signal) => {
      if (launchError !== undefined) reject(launchError)
      else if (signal !== null) reject(new Error(`pnpm ${args.join(' ')} was terminated by ${signal}.`))
      else if (code !== 0) reject(new Error(`pnpm ${args.join(' ')} failed with exit code ${String(code)}.`))
      else resolveCommand()
    })
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { profile: { type: 'string', default: 'web' } },
    allowPositionals: false,
  })
  const home = resolveDshHome()
  await setupWeb({
    root: resolve(import.meta.dirname, '..'),
    profile: values.profile,
    home,
    run: runPnpm({ ...process.env, DSH_HOME: home }),
    log: (message) => { console.log(`setup:web: ${message}`) },
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(`setup:web: ${String(error)}\nSetup stopped. Completed steps remain in place; correct the error above and rerun pnpm run setup:web.`)
    process.exitCode = 1
  })
}
