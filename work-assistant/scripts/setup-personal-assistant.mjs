#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, cpSync, writeFileSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs as parseNodeArgs } from 'node:util'
import { CronPattern } from 'croner'
import { buildReceiptRuntime } from './build-receipt-runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['wa-gateway', 'wa-calendar', 'wa-memory', 'wa-preset', 'wa-briefing', 'wa-ui']
const MANAGED_BY = '@deepseek-ai/dsh-work-assistant'

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function main(argv) {
  const args = parseArgs(argv)
  const profile = args.profile ?? 'personal-assistant'
  const home = requireAbsolute(args.home, '--home')
  const workspace = requireAbsolute(args.workspace, '--workspace')
  const ownerId = args['owner-id'] ?? 'personal'
  const provider = requireValue(args.provider, '--provider')
  const model = requireValue(args.model, '--model')
  const timeZone = requireValue(args['time-zone'], '--time-zone')
  const scheduleEnabled = args['enable-schedule'] === true
  const cron = scheduleEnabled ? requireValue(args.cron, '--cron') : args.cron
  const demoFixture = args['demo-fixture'] === true
  let calendar = resolveCalendar(args, home, demoFixture)
  let memoryRoot = args['memory-root']
  if (demoFixture && memoryRoot === undefined) memoryRoot = join(home, 'data', 'demo-memory')
  memoryRoot = requireAbsolute(memoryRoot, '--memory-root')

  assertIdentifier(profile, '--profile')
  assertIdentifier(ownerId, '--owner-id')
  assertTimeZone(timeZone)
  if (cron !== undefined) assertFiveFieldCron(cron, timeZone)
  await assertDirectory(workspace, '--workspace')
  await assertDedicatedHome(home, profile)
  await ensureDemoFixture({ enabled: demoFixture, calendar, memoryRoot })
  await assertDirectory(memoryRoot, '--memory-root')
  await assertMemoryRepo(memoryRoot)

  const requested = { profile, workspace, ownerId, provider, model, timeZone, scheduleEnabled, cron: cron ?? null, calendar, memoryRoot }
  const markerPath = join(home, 'profiles', profile, '.work-assistant-profile.json')
  if (existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    if (marker.managedBy !== MANAGED_BY) throw new Error(`Profile ${profile} is not managed by work-assistant`)
    if (marker.version !== 1) throw new Error(`Profile ${profile} has an unsupported work-assistant marker version`)
    if (marker.configHash !== configHash(requested)) throw new Error(`Profile ${profile} already exists with different work-assistant inputs`)
    if (args.update === true) {
      const runtime = await buildReceiptRuntime(join(home, 'packages'))
      installPackages([...runtime, ...await packBundles(PACKAGES, home)], requested, home)
      console.log(`Updated work-assistant bundles in ${profile}; existing patches, preset assets, and saved state were preserved. Restart this profile and refresh its existing URL.`)
      return
    }
    const missing = missingBundles(join(home, 'profiles', profile))
    if (missing.length > 0) {
      const runtime = missing.includes('wa-ui') ? await buildReceiptRuntime(join(home, 'packages')) : []
      installPackages([...runtime, ...await packBundles(missing, home)], requested, home)
      console.log(`Added missing work-assistant bundles to ${profile}: ${missing.join(', ')}.`)
      return
    }
    console.log(`Profile ${profile} is already configured in ${home}.`)
    return
  }

  if (args.update === true) throw new Error('--update requires an existing managed work-assistant profile')
  await mkdir(home, { recursive: true })
  const tarballs = await packBundles(PACKAGES, home)
  const runtime = await buildReceiptRuntime(join(home, 'packages'))

  run(dshCommand(), ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { cwd: workspace, env: { ...process.env, DSH_HOME: home }, silent: true })
  const profileDir = join(home, 'profiles', profile)
  installPackages([...runtime, ...tarballs], requested, home)
  copyPresetAssets(home)
  const receiptPatch = `- id: wa-ui
  config:
    receipt:
      presetIds: [personal-assistant]
      style: thumbs-up
`
  writeFileSync(join(profileDir, 'cordis.patch.yml'), renderPatch(requested) + receiptPatch, 'utf8')
  const packageJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  packageJson.packageManager = 'pnpm@11.7.0'
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
  run('pnpm', ['install', '--frozen-lockfile'], { cwd: profileDir })
  writeFileSync(markerPath, `${JSON.stringify({ managedBy: MANAGED_BY, version: 1, configHash: configHash(requested), profile }, null, 2)}\n`, 'utf8')
  console.log(`Configured ${profile} in ${home}. Start it with:`)
  console.log(`  $env:DSH_HOME='${home}'; dsh --profile ${profile} --no-open --host 127.0.0.1 --port 3081`)
}

function parseArgs(argv) {
  const parsed = parseNodeArgs({
    args: argv[0] === '--' ? argv.slice(1) : argv,
    allowPositionals: true,
    strict: true,
    tokens: true,
    options: {
      home: { type: 'string' },
      profile: { type: 'string' },
      workspace: { type: 'string' },
      'owner-id': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'time-zone': { type: 'string' },
      cron: { type: 'string' },
      'calendar-file': { type: 'string' },
      'calendar-feed-credential-ref': { type: 'string' },
      'memory-root': { type: 'string' },
      'enable-schedule': { type: 'boolean' },
      update: { type: 'boolean' },
      'demo-fixture': { type: 'boolean' },
    },
  })
  if (parsed.positionals.length > 0) throw new Error(`Unexpected positional argument: ${parsed.positionals[0]}`)
  const counts = new Map()
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue
    counts.set(token.name, (counts.get(token.name) ?? 0) + 1)
  }
  for (const [name, count] of counts) {
    if (count > 1) throw new Error(`Duplicate option --${name}`)
  }
  return parsed.values
}

function requireValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

function requireAbsolute(value, label) {
  const text = requireValue(value, label)
  if (!isAbsolute(text)) throw new Error(`${label} must be an absolute path`)
  return resolve(text)
}

function resolveCalendar(parsed, homePath, demo) {
  if (parsed['calendar-file'] !== undefined && parsed['calendar-feed-credential-ref'] !== undefined) {
    throw new Error('Use exactly one of --calendar-file or --calendar-feed-credential-ref')
  }
  if (demo && parsed['calendar-file'] === undefined && parsed['calendar-feed-credential-ref'] === undefined) {
    return { kind: 'file', path: join(homePath, 'data', 'demo-calendar.ics') }
  }
  if (parsed['calendar-file'] !== undefined) return { kind: 'file', path: requireAbsolute(parsed['calendar-file'], '--calendar-file') }
  if (parsed['calendar-feed-credential-ref'] !== undefined) return { kind: 'feed', urlCredentialRef: requireValue(parsed['calendar-feed-credential-ref'], '--calendar-feed-credential-ref') }
  throw new Error('Use --calendar-file or --calendar-feed-credential-ref')
}

async function assertDedicatedHome(homePath, profileName) {
  if (!existsSync(homePath)) return
  const entries = readdirSync(homePath, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.'))
  if (entries.length === 0) return
  const profiles = join(homePath, 'profiles')
  const marker = join(profiles, profileName, '.work-assistant-profile.json')
  if (existsSync(marker)) {
    // DSH's shared resolver cache lives beside the profile directories.
    const names = existsSync(profiles) ? readdirSync(profiles).filter(name => name !== profileName && name !== 'node_modules') : []
    if (names.length > 0) throw new Error('--home must be dedicated to one personal-assistant profile')
    return
  }
  throw new Error('--home must be a new empty dedicated DSH_HOME or an existing managed work-assistant home')
}

async function ensureDemoFixture({ enabled, calendar, memoryRoot }) {
  if (!enabled) return
  if (calendar.kind === 'file') {
    await mkdir(dirname(calendar.path), { recursive: true })
    if (!existsSync(calendar.path)) await writeFile(calendar.path, demoCalendar(), 'utf8')
  }
  await mkdir(memoryRoot, { recursive: true })
  if (!existsSync(join(memoryRoot, '.git'))) {
    run('git', ['init', '-b', 'main'], { cwd: memoryRoot })
    run('git', ['-c', 'commit.gpgSign=false', '-c', 'user.name=Work Assistant Demo', '-c', 'user.email=demo@example.invalid', 'commit', '--allow-empty', '--no-verify', '-m', 'initial demo memory'], { cwd: memoryRoot })
  }
}

async function assertDirectory(path, label) {
  const stats = await lstat(path)
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} must be a real directory`)
}

async function assertMemoryRepo(root) {
  await assertDirectory(join(root, '.git'), '--memory-root .git')
  const remotes = run('git', ['remote'], { cwd: root, capture: true }).stdout.trim()
  if (remotes !== '') throw new Error('--memory-root must not define Git remotes')
}

function assertIdentifier(value, label) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error(`${label} must be a nonempty identifier of at most 80 characters`)
}

function assertTimeZone(value) {
  try { Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)) }
  catch { throw new Error('--time-zone must be an IANA time zone') }
}

function assertFiveFieldCron(value, timeZone) {
  if (value.trim().split(/\s+/u).length !== 5) throw new Error('--cron must be a five-field expression')
  try {
    new CronPattern(value, timeZone, { mode: '5-part' })
  } catch {
    throw new Error('--cron must be a valid five-field expression')
  }
}

function missingBundles(profileDir) {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`Profile ${profileDir} must declare dsh.profile.bundles`)
  return PACKAGES.filter(pkg => {
    const name = `@deepseek-ai/dsh-${pkg}`
    return !bundles.includes(name)
      || manifest.dependencies?.[name] === undefined
      || !existsSync(join(profileDir, 'node_modules', name, 'package.json'))
  })
}

async function packBundles(packages, homePath) {
  const filters = packages.flatMap(pkg => ['--filter', `@deepseek-ai/dsh-${pkg}...`])
  run('pnpm', ['-r', ...filters, 'run', 'build'], { cwd: ROOT })
  const artifactDir = join(homePath, 'packages')
  await mkdir(artifactDir, { recursive: true })
  const scratch = await mkdtemp(join(artifactDir, '.assistant-pack-'))
  try {
    const archives = []
    for (const pkg of packages) {
      const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8'))
      const basename = 'deepseek-ai-dsh-' + pkg + '-' + manifest.version
      const tarball = join(scratch, basename + '.tgz')
      run('pnpm', ['--filter', '@deepseek-ai/dsh-' + pkg, 'pack', '--out', tarball], { cwd: ROOT })
      const digest = createHash('sha256').update(await readFile(tarball)).digest('hex')
      const target = join(artifactDir, basename + '-sha256-' + digest + '.tgz')
      try {
        await link(tarball, target)
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        if (createHash('sha256').update(await readFile(target)).digest('hex') !== digest) {
          throw new Error('Assistant archive does not match its digest: ' + target)
        }
      }
      archives.push(target)
    }
    return archives
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function installPackages(tarballs, { profile, workspace }, home) {
  for (const tarball of tarballs) {
    run(dshCommand(), ['plugin', '--profile', profile, 'add', tarball], { cwd: workspace, env: { ...process.env, DSH_HOME: home } })
  }
}

function copyPresetAssets(homePath) {
  const targetRoot = join(homePath, '.agent-presets')
  const target = join(targetRoot, 'personal-assistant')
  if (existsSync(target)) throw new Error('The personal-assistant preset already exists in the target DSH_HOME')
  mkdirSync(targetRoot, { recursive: true })
  cpSync(join(ROOT, 'packages', 'wa-preset', 'presets', 'personal-assistant'), target, { recursive: true, errorOnExist: true, force: false })
}

function renderPatch(config) {
  const calendarConfig = config.calendar.kind === 'file'
    ? `source:\n      kind: file\n      path: ${yaml(config.calendar.path)}`
    : `source:\n      kind: feed\n      urlCredentialRef: ${yaml(config.calendar.urlCredentialRef)}`
  return `# Managed by ${MANAGED_BY}. Do not add corporate MCP/global patches to this dedicated profile.\n- id: system-prompt\n  config:\n    personaPrefix: ''\n    personaSuffix: ''\n- id: tools\n  config:\n    mode: native\n- id: agent-default-model\n  config:\n    provider: ${yaml(config.provider)}\n    model: ${yaml(config.model)}\n- id: agent-presets\n  config:\n    default: personal-assistant\n    includeShippedRoot: false\n    includeUserRoot: true\n- id: wa-gateway\n  config:\n    ownerId: ${yaml(config.ownerId)}\n- id: wa-calendar\n  config:\n    ${calendarConfig}\n- id: wa-memory\n  config:\n    root: ${yaml(config.memoryRoot)}\n- id: wa-briefing\n  config:\n    enabled: ${config.scheduleEnabled ? 'true' : 'false'}\n    cron: ${yaml(config.cron ?? '0 9 * * *')}\n    timeZone: ${yaml(config.timeZone)}\n    workspace: ${yaml(config.workspace)}\n    provider: ${yaml(config.provider)}\n    model: ${yaml(config.model)}\n    includeMemory: true\n    lookAheadMinutes: 1440\n- id: tool-bash\n  disabled: true\n- id: tool-pwsh\n  disabled: true\n- id: tool-jobs\n  disabled: true\n- id: tool-fs\n  disabled: true\n- id: tool-fs-search\n  disabled: true\n- id: agent-instructions\n  disabled: true\n- id: tool-web\n  disabled: true\n- id: web\n  disabled: true\n- id: web-search-deepseek\n  disabled: true\n- id: web-fetch-http\n  disabled: true\n- id: tool-skill\n  disabled: true\n- id: skill\n  disabled: true\n- id: skill-filesystem\n  disabled: true\n- id: skill-badge\n  disabled: true\n- id: subagent\n  disabled: true\n- id: subagent-spawn-in-process\n  disabled: true\n- id: subagent-fork-in-process\n  disabled: true\n- id: tool-subagent\n  disabled: true\n- id: tool-subagent-fork\n  disabled: true\n- id: tool-subagent-control\n  disabled: true\n- id: tool-subagent-list-agents\n  disabled: true\n- id: workflow-worker-thread\n  disabled: true\n- id: tool-workflow\n  disabled: true\n- id: tool-todo\n  disabled: true\n- id: tool-goal\n  disabled: true\n- id: goal\n  disabled: true\n- id: goal-round-driver\n  disabled: true\n- id: command-goal\n  disabled: true\n- id: plan-mode\n  disabled: true\n- id: code-runtime\n  disabled: true\n- id: tool-ralph\n  disabled: true\n`
}

function yaml(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function run(command, args, options = {}) {
  const invocation = commandInvocation(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    shell: false,
    encoding: 'utf8',
    stdio: options.capture || options.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.status !== 0) {
    const detail = options.capture || options.silent ? `\n${result.stderr || result.stdout}` : ''
    throw new Error(`${command} ${args.join(' ')} failed${detail}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function commandInvocation(command, args) {
  if (process.platform !== 'win32') return { command, args }
  if (command === 'pnpm' || command.endsWith('.cmd')) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', command, ...args],
    }
  }
  return { command, args }
}

function dshCommand() {
  return process.platform === 'win32' ? join(ROOT, 'node_modules', '.bin', 'dsh.cmd') : join(ROOT, 'node_modules', '.bin', 'dsh')
}

function configHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function demoCalendar() {
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//DSH Work Assistant Demo//EN\nBEGIN:VEVENT\nUID:demo@example.invalid\nSUMMARY:Synthetic demo planning block\nDTSTAMP:20260101T000000Z\nDTSTART:20260102T170000Z\nDTEND:20260102T173000Z\nEND:VEVENT\nEND:VCALENDAR\n`
}
