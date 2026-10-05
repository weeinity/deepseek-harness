#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { throws } from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { smokeProactiveInbox } from './proactive-smoke.mjs'
import { checkProactiveRecording, proactiveFixturePath } from './proactive-recording.mjs'
import {
  CALENDAR_MEMORY_ASSISTANT_TEXT,
  CALENDAR_MEMORY_ABSENT_NOTE,
  CALENDAR_MEMORY_EVENT_LOCATION,
  CALENDAR_MEMORY_EVENT_TITLE,
  CALENDAR_MEMORY_NOTE,
  CALENDAR_MEMORY_NOTE_TEXT,
  CALENDAR_MEMORY_PROJECT_NOTE,
  CALENDAR_MEMORY_RETAINED_PROJECT_NOTE,
  CALENDAR_MEMORY_RETAINED_PROJECT_NOTE_TEXT,
  CALENDAR_MEMORY_TITLE,
  CALENDAR_MEMORY_USER_TEXT,
  MEMORY_FAILURE_ASSISTANT_TEXT,
  MEMORY_FAILURE_TITLE,
  MEMORY_FAILURE_USER_TEXT,
  RECENT_ACTIVITY_ASSISTANT_TEXT,
  RECENT_ACTIVITY_TITLE,
  RECENT_ACTIVITY_USER_TEXT,
  seedCalendarMemorySession,
  seedMemoryWriteFailureSession,
  seedRecentActivitySession,
  seedSelectiveReactionSession,
  seedNonWebReactionSession,
  recordSelectiveReactionSession,
  seedWorkspace,
  readPersistedSessions,
} from './session-fixtures.mjs'

const root = resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const { values: options } = parseArgs({
  args: argv[0] === '--' ? argv.slice(1) : argv,
  options: { keep: { type: 'boolean' }, receipts: { type: 'boolean' }, proactive: { type: 'boolean' }, reuse: { type: 'string' }, 'record-reactions': { type: 'boolean' } },
})
const setupScript = join(root, 'scripts', 'setup-personal-assistant.mjs')
const smokeId = options.reuse === undefined ? randomUUID() : basename(options.reuse).slice('profile-smoke-'.length)
const base = join(root, '.test-tmp', `profile-smoke-${smokeId}`)
if (options.reuse !== undefined && (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u.test(smokeId) || resolve(options.reuse) !== base)) {
  throw new Error('--reuse must name a retained profile-smoke directory in this workspace')
}
const home = join(base, 'dsh-home')
const workspace = join(base, 'workspace')
const memoryRoot = join(workspace, 'memory')
const calendarPath = join(workspace, 'calendar.ics')
const profile = `wa-smoke-${smokeId.slice(0, 8)}`
const browserShots = join(base, 'browser-screenshots')
const scriptedModelRoot = join(base, 'scripted-model')
const scriptedModelLog = join(scriptedModelRoot, 'provider.jsonl')
const scriptedModelControl = join(scriptedModelRoot, 'control.json')
const scriptedProviderPackageRoot = join(import.meta.dirname, 'scripted-model-provider')
const scriptedProviderPackage = '@deepseek-ai/dsh-wa-profile-test-model'
const scriptedProvider = 'wa-profile-test'
const scriptedModel = 'wa-scripted-receipt'
const receiptRuntimePackages = [
  'dsh-client-ui-conversation',
  'dsh-client-ui-chat',
]
const retainedShotRoot = join(browserShots, 'assistant-layout')
const retainedFixtureShot = join(retainedShotRoot, 'synthetic-fixture-wide-layout.png')
const wideViewport = { width: 1280, height: 900 }
const smallViewport = { width: 390, height: 720 }
const startupUrlTimeoutMs = 60_000
const assistantPanelSelector = '[data-testid="wa-assistant-panel"]'
const assistantToggleSelector = '[data-testid="wa-assistant-toggle"]'
const composerSelector = '[data-composer-input]'
const composerSeatSelector = '[data-composer-seat]'
const conversationScrollSelector = '[data-conversation-scroll]'
const receiptSelector = '[data-testid="wa-message-receipt"]'
const assistantTabs = ['Timeline', 'Queue', 'Day', 'Memory', 'Inbox']
const waUiPackageName = '@deepseek-ai/dsh-wa-ui'
const calendarRequestText = 'Show my calendar for today. Use an explicit local time window and summarize conflicts only if the calendar data shows them.'
const memoryRequestText = 'Help me add one personal memory note. Ask me which single note to save before writing.'
const interactionId = randomUUID()
const briefingTriggerToken = randomUUID()
const receiptDuplicateText = `Receipt identity probe ${interactionId}`
const receiptClarifyText = `Receipt clarify cancel probe ${interactionId}`
const receiptPrepareCancelText = `Receipt prepare cancel probe ${interactionId}`
const receiptStreamHoldText = `Receipt queued hold probe ${interactionId}`
const receiptQueuedText = `Receipt queued no badge probe ${interactionId}`
const setupProfileArgs = [
  'run',
  'setup:profile',
  '--',
  '--home', home,
  '--profile', profile,
  '--workspace', workspace,
  '--memory-root', memoryRoot,
  '--calendar-file', calendarPath,
  '--owner-id', 'smoke',
  '--provider', scriptedProvider,
  '--model', scriptedModel,
  '--time-zone', 'UTC',
  '--cron', '0 9 * * *',
  '--demo-fixture',
]

try {
  if (options.reuse === undefined) {
    await assertDeploymentConfig()
    runRejected([setupScript, '--unknown'], 'Unknown option')
    runRejected([setupScript, '--home', home, '--home', home], 'Duplicate option --home')
    runRejected([
      setupScript,
      '--home', home,
      '--workspace', workspace,
      '--provider', 'deepseek-official',
      '--model', 'deepseek-v4-flash',
      '--time-zone', 'UTC',
      '--calendar-file', calendarPath,
      '--calendar-feed-credential-ref', 'calendar.feed',
      '--memory-root', memoryRoot,
    ], 'Use exactly one of --calendar-file or --calendar-feed-credential-ref')
    for (const enableSchedule of [false, true]) {
      for (const cron of ['99 99 * * *', '* * * * * *']) {
        runRejected([
          setupScript,
          '--home', home,
          '--workspace', workspace,
          '--provider', 'deepseek-official',
          '--model', 'deepseek-v4-flash',
          '--time-zone', 'UTC',
          '--demo-fixture',
          ...enableSchedule ? ['--enable-schedule'] : [],
          '--cron', cron,
        ], '--cron must be')
        if (existsSync(home)) throw new Error('Invalid cron must be rejected before creating a profile home')
      }
    }
    await mkdir(workspace, { recursive: true })
    const setup = runSetupProfile()
    assertIncludes(setup.stdout, '--port 3081')
    await installScriptedModelProvider(home)
    const dump = run(dshCommand(), ['--profile', profile, '--dump-config'], { env: { ...process.env, DSH_HOME: home }, capture: true }).stdout
    assertIncludes(dump, 'name: \'@deepseek-ai/dsh-wa-briefing\'')
    assertIncludes(dump, `name: '${scriptedProviderPackage}'`)
    assertIncludes(dump, `provider: ${scriptedProvider}`)
    assertIncludes(dump, `model: ${scriptedModel}`)
    assertIncludes(dump, 'default: personal-assistant')
    assertIncludes(dump, 'receipt:')
    assertIncludes(dump, 'style: thumbs-up')
    assertIncludes(dump, 'includeShippedRoot: false')
    assertIncludes(dump, 'mode: native')
    assertIncludes(dump, calendarPath)
    assertIncludes(dump, memoryRoot)
    for (const id of [
      'agent-instructions',
      'code-runtime',
      'tool-bash',
      'tool-fs',
      'tool-fs-search',
      'tool-goal',
      'tool-jobs',
      'tool-pwsh',
      'tool-ralph',
      'tool-skill',
      'tool-subagent',
      'tool-subagent-control',
      'tool-subagent-fork',
      'tool-subagent-list-agents',
      'tool-todo',
      'tool-web',
      'tool-workflow',
    ]) assertDisabled(dump, id)
    assertExcludes(dump, 'DSH_TOOLS_MODE')
    assertExcludes(dump, 'maxCalendarResults')
    assertExcludes(dump, 'maxConflictResults')
    if (!options.receipts) await assertManagedProfileRepair()
    await seedWorkspace({ dshHome: home, workspace })
  } else {
    await assertMarkerV1(join(home, 'profiles', profile, '.work-assistant-profile.json'))
    await writeFile(scriptedModelLog, '', 'utf8')
    await writeScriptedProviderPatch()
  }
  await assertHostPeerIdentity()
  await smokeWeb(home)
  console.log(options.receipts
    ? 'Receipt profile smoke passed: installed peers, admission, identity, questions, cancellation, queueing, replay, and display styles.'
    : 'Profile smoke passed: setup, repair/no-op, deployment configuration, installed peers, browser layout/navigation, and receipt behavior.')
} finally {
  if (options.keep || options.reuse !== undefined) console.log(`Retained profile diagnostics: ${base}`)
  else await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function assertHostPeerIdentity() {
  const host = createRequire(await realpath(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
  const profileRequire = createRequire(join(home, 'profiles', profile, 'package.json'))
  const preset = createRequire(profileRequire.resolve('@deepseek-ai/dsh-wa-preset'))
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-tools']) {
    if (preset.resolve(name) !== host.resolve(name)) {
      throw new Error(`Installed wa-preset must share the launcher's ${name} instance`)
    }
  }
}

async function assertDeploymentConfig() {
  const compose = await readFile(join(root, 'deployment', 'compose.yaml'), 'utf8')
  assertComposeMounts(compose)
  for (const path of ['data/dsh-home', 'workspace']) {
    throws(() => assertComposeMounts(compose.replace(`../${path}:`, `./${path}:`)), /documented workspace-root directory/u)
  }
  assertIncludes(compose, 'WA_MEMORY_ROOT: /workspace/memory')
  assertIncludes(compose, 'WA_CALENDAR_FILE: /workspace/calendar.ics')
  assertIncludes(compose, '"127.0.0.1:3081:3080"')
  assertExcludes(compose, '/data/memory')
  assertExcludes(compose, '/data/calendar')
  const entrypoint = await readFile(join(root, 'deployment', 'entrypoint.sh'))
  if (entrypoint.includes(Buffer.from('\r\n'))) throw new Error('deployment/entrypoint.sh must use LF line endings')
}

function assertComposeMounts(compose) {
  const mounts = [...compose.matchAll(/^\s+- (\.\.?\/[^:\r\n]+):(\/[^\s:]+)\s*$/gmu)]
  if (mounts.length !== 2 || new Set(mounts.map(match => match[2])).size !== 2) throw new Error('Expected exactly two distinct Compose bind mounts')
  const expected = new Map([
    ['/data/dsh-home', join(root, 'data', 'dsh-home')],
    ['/workspace', join(root, 'workspace')],
  ])
  for (const [, source, target] of mounts) {
    if (resolve(root, 'deployment', source) !== expected.get(target)) throw new Error(`Compose mount ${target} must use the documented workspace-root directory`)
  }
}

function run(command, args, options = {}) {
  const invocation = commandInvocation(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    shell: false,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${sanitize(result.stderr || result.stdout)}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function runRejected(args, expected) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status === 0) throw new Error(`Expected node ${args.join(' ')} to fail`)
  if (!String(result.stderr || result.stdout).includes(expected)) {
    throw new Error(`Expected failure to include ${expected}; got:\n${sanitize(result.stderr || result.stdout)}`)
  }
}

function runSetupProfile() {
  return run('pnpm', setupProfileArgs)
}

async function installScriptedModelProvider(dshHome) {
  await mkdir(scriptedModelRoot, { recursive: true })
  const tarball = join(scriptedModelRoot, 'dsh-wa-profile-test-model.tgz')
  run('pnpm', ['pack', '--out', tarball], { cwd: scriptedProviderPackageRoot })
  run(dshCommand(), ['plugin', '--profile', profile, 'add', tarball], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
  })
  await writeScriptedProviderPatch()
  await setReceiptStyle('thumbs-up')
}

async function writeScriptedProviderPatch() {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const current = await readFile(patchPath, 'utf8')
  const stripped = current.replace(/\n?# profile-smoke-scripted-start[\s\S]*?# profile-smoke-scripted-end\n?/u, '\n').trimEnd()
  await mkdir(dirname(scriptedModelLog), { recursive: true })
  const addition = [
    '# profile-smoke-scripted-start',
    '- id: wa-profile-test-model',
    '  config:',
    `    provider: ${yamlString(scriptedProvider)}`,
    `    model: ${yamlString(scriptedModel)}`,
    `    logPath: ${yamlString(scriptedModelLog)}`,
    `    controlPath: ${yamlString(scriptedModelControl)}`,
    `    briefingTriggerToken: ${yamlString(briefingTriggerToken)}`,
    ...(process.env.WA_PROACTIVE_RECORD === '1' ? [] : [`    briefingFixturePath: ${yamlString(proactiveFixturePath)}`]),
    '# profile-smoke-scripted-end',
    '',
  ].join('\n')
  await writeFile(patchPath, `${stripped}\n${addition}`, 'utf8')
  await assertSingleWaUiPatchEntry(patchPath)
}

async function setReceiptStyle(style) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const current = await readFile(patchPath, 'utf8')
  const next = updateWaUiReceiptStyle(current, style)
  await writeFile(patchPath, next, 'utf8')
  await assertSingleWaUiPatchEntry(patchPath)
}

function updateWaUiReceiptStyle(text, style) {
  const entryMatches = [...text.matchAll(/^- id: wa-ui$/gmu)]
  if (entryMatches.length !== 1) throw new Error(`profile smoke expected one wa-ui patch entry, found ${entryMatches.length}`)
  const start = entryMatches[0].index
  const tail = text.slice(start)
  const nextMatch = /\n- id: /u.exec(tail.slice(1))
  const end = nextMatch === null ? text.length : start + 1 + nextMatch.index
  const block = text.slice(start, end)
  const styleLine = /^(\s+style:\s*).+$/mu
  if (!styleLine.test(block)) throw new Error('profile smoke could not find setup-owned wa-ui receipt style to update')
  const updated = block.replace(styleLine, `$1${style}`)
  if (!/^\s+receipt:$/mu.test(updated)) throw new Error('profile smoke found wa-ui patch entry without receipt config')
  return `${text.slice(0, start)}${updated}${text.slice(end)}`
}

async function assertSingleWaUiPatchEntry(patchPath) {
  const patch = await readFile(patchPath, 'utf8')
  const entries = [...patch.matchAll(/^- id: wa-ui$/gmu)]
  if (entries.length !== 1) throw new Error(`profile smoke must not add duplicate wa-ui patch entries; found ${entries.length}`)
}

function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function runSetupProfileRejected(expected, label) {
  const invocation = commandInvocation('pnpm', setupProfileArgs)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: process.env,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status === 0) throw new Error(`Expected profile setup to reject ${label}`)
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`
  if (!output.includes(expected)) {
    throw new Error(`Expected profile setup rejection to include ${expected}; got:\n${sanitize(output)}`)
  }
}

async function assertManagedProfileRepair() {
  const paths = managedProfilePaths()
  await assertWaUiInstalled(paths, 'fresh setup')
  await mkdir(paths.sharedResolverCache, { recursive: true })
  await writeFile(paths.resolverCacheSentinel, 'profile-smoke shared resolver cache sentinel\n')
  await appendYamlComment(paths.patch, 'profile-smoke custom patch comment')
  await appendYamlComment(paths.preset, 'profile-smoke custom preset comment')
  await writeFile(paths.sentinelPackage, 'profile-smoke unrelated package archive sentinel\n')
  const protectedBytes = await snapshotBytes([
    paths.patch,
    paths.preset,
    paths.agentPreset,
    paths.marker,
    paths.resolverCacheSentinel,
    paths.sentinelPackage,
  ])

  run(dshCommand(), ['plugin', '--profile', profile, 'remove', waUiPackageName], {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: home },
    capture: true,
  })
  await assertWaUiRemovedFromManifest(paths)
  await assertMarkerV1(paths.marker)
  await assertSameBytes(protectedBytes, 'wa-ui removal')

  const repair = runSetupProfile()
  assertIncludes(repair.stdout, `Added missing work-assistant bundles to ${profile}: wa-ui.`)
  await assertWaUiInstalled(paths, 'managed repair')
  await assertSameBytes(protectedBytes, 'managed repair')

  const noOpBytes = await snapshotBytes([
    paths.manifest,
    paths.lockfile,
    paths.patch,
    paths.preset,
    paths.agentPreset,
    paths.marker,
    paths.resolverCacheSentinel,
    paths.sentinelPackage,
  ])
  const noOp = runSetupProfile()
  assertIncludes(noOp.stdout, `Profile ${profile} is already configured`)
  assertExcludes(noOp.stdout, 'Added missing work-assistant bundles')
  await assertWaUiInstalled(paths, 'managed no-op')
  await assertSameBytes(noOpBytes, 'managed no-op')
  await assertUnsupportedMarkerVersionRejected(paths)
  await assertExtraProfileRejected(paths)
}

function managedProfilePaths() {
  const profileDir = join(home, 'profiles', profile)
  const presetDir = join(home, '.agent-presets', 'personal-assistant')
  return {
    profileDir,
    manifest: join(profileDir, 'package.json'),
    lockfile: join(profileDir, 'pnpm-lock.yaml'),
    patch: join(profileDir, 'cordis.patch.yml'),
    marker: join(profileDir, '.work-assistant-profile.json'),
    installedManifest: join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-wa-ui', 'package.json'),
    sharedResolverCache: join(home, 'profiles', 'node_modules'),
    resolverCacheSentinel: join(home, 'profiles', 'node_modules', '.profile-smoke-cache-sentinel'),
    packagesDir: join(home, 'packages'),
    sentinelPackage: join(home, 'packages', 'profile-smoke-unrelated-package-archive.tgz'),
    preset: join(presetDir, 'preset.yml'),
    agentPreset: join(presetDir, 'agent.cordis.yml'),
  }
}

async function assertWaUiInstalled(paths, label) {
  const manifest = await readJson(paths.manifest)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.includes(waUiPackageName)) {
    throw new Error(`${label}: profile bundles do not include ${waUiPackageName}`)
  }
  if (manifest.dependencies?.[waUiPackageName] === undefined) {
    throw new Error(`${label}: profile dependencies do not include ${waUiPackageName}`)
  }
  if (!existsSync(paths.installedManifest)) throw new Error(`${label}: installed ${waUiPackageName} manifest is missing`)
  const installed = await readJson(paths.installedManifest)
  if (installed.name !== waUiPackageName) throw new Error(`${label}: installed manifest is ${String(installed.name)}, not ${waUiPackageName}`)
  const version = (await readJson(join(root, 'packages', 'wa-ui', 'package.json'))).version
  if (installed.version !== version) throw new Error(`${label}: installed wa-ui version does not match the packed source`)
  const archive = resolveProfileFileDependency(paths.profileDir, manifest.dependencies[waUiPackageName])
  if (!existsSync(archive)) throw new Error(`${label}: packed wa-ui archive is missing at ${archive}`)
  await assertReceiptRuntimeInstalled(paths, label)
}

async function assertReceiptRuntimeInstalled(paths, label) {
  const profileManifest = await readJson(paths.manifest)
  for (const pkg of receiptRuntimePackages) {
    const name = `@deepseek-ai/${pkg}`
    const dependency = profileManifest.dependencies?.[name]
    if (typeof dependency !== 'string') throw new Error(`${label}: profile dependencies do not include ${name}`)
    const archive = resolveProfileFileDependency(paths.profileDir, dependency)
    if (!existsSync(archive)) throw new Error(`${label}: receipt runtime dependency archive is missing at ${archive}`)
    const manifest = await readJson(join(paths.profileDir, 'node_modules', '@deepseek-ai', pkg, 'package.json'))
    if (manifest.dshReceiptRuntimePatch?.tag !== 'personal-assistant-receipts-alpha2-backport') {
      throw new Error(`${label}: installed ${pkg} is not the patched receipt runtime`)
    }
  }
}

function resolveProfileFileDependency(profileDir, dependency) {
  if (!dependency.startsWith('file:')) throw new Error(`receipt runtime dependency must be file-backed, got ${dependency}`)
  return resolve(profileDir, dependency.slice('file:'.length))
}

async function assertWaUiRemovedFromManifest(paths) {
  const manifest = await readJson(paths.manifest)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes(waUiPackageName)) throw new Error(`${waUiPackageName} stayed in profile bundles after supported removal`)
  if (manifest.dependencies?.[waUiPackageName] !== undefined) throw new Error(`${waUiPackageName} stayed in profile dependencies after supported removal`)
}

async function assertMarkerV1(path) {
  const marker = await readJson(path)
  if (marker.managedBy !== '@deepseek-ai/dsh-work-assistant' || marker.version !== 1) {
    throw new Error('work-assistant marker must stay intact at version 1 during managed repair')
  }
}

async function assertUnsupportedMarkerVersionRejected(paths) {
  const originalMarker = await readFile(paths.marker)
  const protectedBytes = await snapshotBytes([
    paths.manifest,
    paths.lockfile,
    paths.patch,
    paths.preset,
    paths.agentPreset,
    paths.resolverCacheSentinel,
    paths.sentinelPackage,
  ])
  const protectedArchives = await snapshotFileTree(paths.packagesDir)
  try {
    const marker = JSON.parse(originalMarker.toString('utf8'))
    marker.version = 99
    await writeFile(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    runSetupProfileRejected('unsupported work-assistant marker version', 'the unsupported marker version')
    await assertSameBytes(protectedBytes, 'unsupported marker rejection')
    await assertSameFileTree(protectedArchives, paths.packagesDir, 'unsupported marker rejection')
  } finally {
    await writeFile(paths.marker, originalMarker)
  }
  await assertSameBytes(new Map([[paths.marker, originalMarker]]), 'unsupported marker restoration')
  await assertMarkerV1(paths.marker)
}

async function assertExtraProfileRejected(paths) {
  const extraProfileDir = join(home, 'profiles', 'profile-smoke-other-profile')
  const extraProfileSentinel = join(extraProfileDir, 'sentinel.txt')
  await mkdir(extraProfileDir, { recursive: true })
  await writeFile(extraProfileSentinel, 'profile-smoke second profile sentinel\n')
  const protectedBytes = await snapshotBytes([
    paths.manifest,
    paths.lockfile,
    paths.patch,
    paths.preset,
    paths.agentPreset,
    paths.marker,
    paths.resolverCacheSentinel,
    paths.sentinelPackage,
  ])
  const protectedArchives = await snapshotFileTree(paths.packagesDir)
  const protectedExtraProfile = await snapshotFileTree(extraProfileDir)
  try {
    runSetupProfileRejected('--home must be dedicated to one personal-assistant profile', 'a second profile directory')
    await assertSameBytes(protectedBytes, 'second profile rejection')
    await assertSameFileTree(protectedArchives, paths.packagesDir, 'second profile rejection')
    await assertSameFileTree(protectedExtraProfile, extraProfileDir, 'second profile rejection')
  } finally {
    await rm(extraProfileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function appendYamlComment(path, comment) {
  const current = await readFile(path, 'utf8')
  await writeFile(path, `${current}${current.endsWith('\n') ? '' : '\n'}# ${comment}\n`, 'utf8')
}

async function snapshotBytes(paths) {
  const snapshots = new Map()
  for (const path of paths) snapshots.set(path, await readFile(path))
  return snapshots
}

async function assertSameBytes(snapshots, label) {
  for (const [path, expected] of snapshots) {
    const actual = await readFile(path)
    if (!expected.equals(actual)) throw new Error(`${label}: expected ${path} to stay byte-identical`)
  }
}

async function snapshotFileTree(rootDir) {
  const snapshots = new Map()
  for (const path of await listFiles(rootDir)) snapshots.set(relative(rootDir, path), await readFile(path))
  return snapshots
}

async function listFiles(rootDir, dir = rootDir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(rootDir, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

async function assertSameFileTree(expected, rootDir, label) {
  const actual = await snapshotFileTree(rootDir)
  const expectedNames = [...expected.keys()]
  const actualNames = [...actual.keys()]
  if (expectedNames.join('\n') !== actualNames.join('\n')) {
    throw new Error(`${label}: expected package archive files to stay unchanged; before=${JSON.stringify(expectedNames)}, after=${JSON.stringify(actualNames)}`)
  }
  for (const [name, bytes] of expected) {
    const actualBytes = actual.get(name)
    if (actualBytes === undefined || !bytes.equals(actualBytes)) {
      throw new Error(`${label}: expected package archive ${name} to stay byte-identical`)
    }
  }
}

async function smokeWeb(dshHome) {
  const chromium = await loadChromium()
  if (options.proactive) {
    await runProactiveSmoke(dshHome, chromium)
    return
  }
  if (!options.receipts && options.reuse === undefined) await smokeWebScenario(dshHome, chromium, smokeEmptyAssistantStartup, 'empty assistant startup')
  if (options.reuse === undefined) await seedRecentActivitySession({
    dshHome,
    workspace,
    id: `wa-smoke-recent-${smokeId}`,
    agentOptions: { provider: scriptedProvider, model: scriptedModel },
  })
  if (!options.receipts) await smokeWebScenario(dshHome, chromium, smokeRecentActivityStartup, 'recent activity startup')
  if (options.reuse === undefined) await seedCalendarMemorySession({
    dshHome,
    workspace,
    id: `wa-smoke-calendar-memory-${smokeId}`,
    createdAt: Date.now() - 30_000,
  })
  if (options.reuse === undefined) await seedMemoryWriteFailureSession({
    dshHome,
    workspace,
    id: `wa-smoke-memory-failure-${smokeId}`,
    createdAt: Date.now() - 20_000,
  })
  if (!options.receipts) await smokeWebScenario(dshHome, chromium, smokeCalendarMemoryStartup, 'calendar memory startup')
  await setReceiptStyle('thumbs-up')
  if (!options['record-reactions'] && options.reuse === undefined) {
    const recorded = await seedSelectiveReactionSession({ dshHome, workspace, id: `wa-smoke-reactions-${smokeId}` })
    await smokeWebScenario(dshHome, chromium, page => smokeRecordedReactions(page, recorded), 'recorded acknowledgement replies')
    const nonWeb = await seedNonWebReactionSession({ dshHome, workspace, id: `wa-smoke-non-web-reactions-${smokeId}` })
    await smokeWebScenario(dshHome, chromium, async page => {
      const panel = await visibleAssistantPanel(page, 'non-Web history', 30_000)
      await selectAssistantTab(panel, 'Timeline')
      await panel.getByRole('button', { name: new RegExp(`^Open ${escapeRegExp(nonWeb.title)}, updated`, 'u') }).click()
      await waitForConversationText(page, '👍', 'non-Web replies remain visible', { occurrence: 2 })
      await assertNoReceipts(page, 'non-Web acknowledgement history')
    }, 'non-Web acknowledgement history')
  }
  await smokeWebScenario(dshHome, chromium, smokeReceiptBrowserFlow, 'receipt browser flow')
  await setReceiptStyle('neutral')
  await smokeWebScenario(dshHome, chromium, smokeNeutralReceiptStartup, 'neutral receipt startup')
  await setReceiptStyle('off')
  await smokeWebScenario(dshHome, chromium, smokeOffReceiptStartup, 'off receipt startup')
  await runProactiveSmoke(dshHome, chromium)
}

async function runProactiveSmoke(dshHome, chromium) {
  const patchPath = join(home, 'profiles', profile, 'cordis.patch.yml')
  const text = await readFile(patchPath, 'utf8')
  const futureMonth = (new Date().getUTCMonth() + 6) % 12 + 1
  const next = text.replace(/(- id: wa-briefing\r?\n  config:\r?\n    enabled:) false/u, '$1 true')
    .replace(/(\n    cron:) '[^']+'/u, '$1 ' + yamlString('0 0 1 ' + futureMonth + ' *'))
    .replace(/(- id: wa-ui\r?\n  config:\r?\n)/u, '$1    inboxRefreshIntervalMs: 1000\n')
  if (next === text) throw new Error('Cannot enable fixture briefing configuration')
  await writeFile(patchPath, next, 'utf8')
  await smokeProactiveInbox({
    token: briefingTriggerToken,
    scenario: (run, label) => smokeWebScenario(dshHome, chromium, run, label),
    startNewSession, seedDraft: seedComposerDraftIfEditable, assertDraft: assertComposerText,
    panel: page => visibleAssistantPanel(page, 'proactive inbox', 30_000),
    screenshot: (page, label) => page.screenshot({ path: join(browserShots, label + '.png'), fullPage: true }),
    conversationText: waitForConversationText, dialogs: dismissStartupDialogs,
    providerLog: readProviderLog, sessions: () => readPersistedSessions(home),
    control: writeProviderControl, waitProvider: waitForProviderLog,
    saveSession: async (session, webUrl) => {
      await mkdir(join(base, 'proactive-recording'), { recursive: true })
      await writeFile(join(base, 'proactive-recording', 'session.json'), JSON.stringify(session, null, 2) + '\n', 'utf8')
      const launcher = createRequire(await realpath(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')))
      const webPackage = launcher.resolve('@deepseek-ai/dsh-web-app/package.json')
      const sourceRoot = resolve(dirname(webPackage), '../../..') + (process.platform === 'win32' ? String.fromCharCode(92) : '/')
      await checkProactiveRecording(session, workspace, { sourceRoot, webUrl })
    },
  })
  await assertSameVersionUpdate()
}

async function assertSameVersionUpdate() {
  const paths = managedProfilePaths()
  const fixture = join(base, 'old-wa-ui')
  await mkdir(fixture, { recursive: true })
  for (const entry of ['cordis.patch.yml', 'lib']) await cp(join(root, 'packages', 'wa-ui', entry), join(fixture, entry), { recursive: true })
  await cp(paths.installedManifest, join(fixture, 'package.json'))
  const entryPath = join(fixture, 'lib', 'index.js')
  const original = await readFile(entryPath, 'utf8')
  await writeFile(entryPath, original + '\n// old same-version fixture artifact\n', 'utf8')
  const archive = join(base, 'old-wa-ui.tgz')
  run('pnpm', ['pack', '--out', archive], { cwd: fixture })
  run(dshCommand(), ['plugin', '--profile', profile, 'add', archive], { cwd: workspace, env: { ...process.env, DSH_HOME: home } })
  const installedPath = join(paths.profileDir, 'node_modules', '@deepseek-ai', 'dsh-wa-ui', 'lib', 'index.js')
  assertIncludes(await readFile(installedPath, 'utf8'), 'old same-version fixture artifact')
  const beforeVersion = (await readJson(paths.installedManifest)).version
  const oldDependency = (await readJson(paths.manifest)).dependencies[waUiPackageName]
  const protectedBytes = await snapshotBytes([paths.patch, paths.preset, paths.agentPreset, paths.marker])
  const sessions = await snapshotFileTree(join(home, 'sessions'))
  const dataFiles = (await listFiles(home)).filter(path => /[.](?:db|sqlite|sqlite3)$/u.test(path) && !path.includes('node_modules'))
  const data = await snapshotBytes(dataFiles)
  const result = run('pnpm', [...setupProfileArgs, '--update'], { cwd: root, capture: true })
  assertIncludes(result.stdout, 'Updated work-assistant bundles')
  await assertSameBytes(protectedBytes, 'same-version update preferences')
  await assertSameBytes(data, 'same-version update storage')
  await assertSameFileTree(sessions, join(home, 'sessions'), 'same-version update Sessions')
  if ((await readJson(paths.installedManifest)).version !== beforeVersion) throw new Error('same-version test changed the version')
  if ((await readJson(paths.manifest)).dependencies[waUiPackageName] === oldDependency) throw new Error('same-version update reused prior artifact dependency')
  if (await readFile(installedPath, 'utf8') !== original) throw new Error('same-version update did not install changed artifact bytes')
  await assertWaUiInstalled(paths, 'same-version explicit update')
}

async function smokeWebScenario(dshHome, chromium, scenario, label) {
  const invocation = commandInvocation(dshCommand(), ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'])
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { text: '' }
  const captureOutput = chunk => { output.text += chunk.toString() }
  child.stdout.on('data', captureOutput)
  child.stderr.on('data', captureOutput)
  const browserErrors = []
  const frames = []
  let browser
  let context
  let page
  let stopped = false
  const exited = new Promise(resolve => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  try {
    const startupUrl = await waitForStartupUrl(child, output, invocation, label)
    const unauthenticatedUrl = unauthenticatedStartupUrl(startupUrl)
    const response = await fetch(unauthenticatedUrl, { signal: AbortSignal.timeout(10_000) })
    if (!(response.ok || response.status === 401)) throw new Error(`Web server returned HTTP ${response.status}`)
    await mkdir(browserShots, { recursive: true })
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({
      viewport: wideViewport,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'dark',
    })
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(startupUrl).origin })
    page = await context.newPage()
    page.on('websocket', socket => {
      for (const event of ['framesent', 'framereceived']) {
        socket.on(event, frame => { frames.push(`${event}: ${sanitize(String(frame.payload))}`) })
      }
    })
    page.on('pageerror', error => browserErrors.push(sanitize(error.message)))
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(sanitize(message.text()))
    })
    await page.goto(startupUrl, { waitUntil: 'load' })
    await dismissStartupDialogs(page)
    await assertNoPluginBootFailure(page)
    await scenario(page)
  } catch (error) {
    if (page !== undefined) await saveDiagnosticScreenshot(page)
    await mkdir(browserShots, { recursive: true })
    await writeFile(join(browserShots, 'server.log'), sanitize(output.text), 'utf8')
    await writeFile(join(browserShots, 'browser-errors.json'), JSON.stringify(browserErrors, null, 2), 'utf8')
    await writeFile(join(browserShots, 'browser-frames.log'), frames.join('\n'), 'utf8')
    if (page !== undefined && !page.isClosed()) {
      await writeFile(join(browserShots, 'browser-state.txt'), sanitize(await page.locator('body').innerText()), 'utf8')
      const rows = await page.locator('[data-chat-flow-kind="user"]').evaluateAll(nodes => nodes.map(node => node.outerHTML))
      await writeFile(join(browserShots, 'user-rows.json'), JSON.stringify(rows, null, 2), 'utf8')
    }
    throw sanitizedError(error)
  } finally {
    try {
      try {
        if (context !== undefined) await context.close()
      } finally {
        if (browser !== undefined) await browser.close()
      }
    } finally {
      if (child.pid !== undefined && child.exitCode === null) {
        stopped = true
        stopProcessTree(child.pid)
        await exited
      }
      if (!stopped) await exited
    }
  }
}

async function waitForStartupUrl(child, output, invocation, label) {
  return new Promise((resolveUrl, reject) => {
    let settled = false
    const cleanup = () => {
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
      clearTimeout(timer)
    }
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const rejectWithDiagnostics = (reason, details = {}) => {
      void startupFailureMessage(child, output.text, invocation, label, reason, details)
        .then(message => { settle(reject, new Error(message)) })
        .catch(error => {
          const diagnosticError = error instanceof Error ? error.message : String(error)
          settle(reject, new Error(`${label}: Web server ${reason} before printing a localhost URL. Diagnostics failed: ${sanitize(diagnosticError)}. Output:\n${sanitize(output.text)}`))
        })
    }
    const onData = chunk => {
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s)]*)/mu.exec(output.text)
      if (match?.[1] !== undefined) settle(resolveUrl, match[1])
    }
    const onExit = (code, signal) => { rejectWithDiagnostics('exited', { code, signal }) }
    const onError = error => { rejectWithDiagnostics('failed to spawn', { error }) }
    const timer = setTimeout(() => { rejectWithDiagnostics('timed out') }, startupUrlTimeoutMs)
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function startupFailureMessage(child, output, invocation, label, reason, details) {
  const runtime = await childRuntimeSnapshot(child)
  return [
    `${label}: Web server ${reason} before printing a localhost URL.`,
    `Launch: ${sanitize(JSON.stringify({ command: invocation.command, args: invocation.args, cwd: workspace, dshHome: home }))}`,
    `Child: ${sanitize(JSON.stringify({
      pid: child.pid ?? null,
      exitCode: details.code ?? child.exitCode ?? null,
      signal: details.signal ?? child.signalCode ?? null,
      killed: child.killed,
      spawnError: details.error instanceof Error ? details.error.message : details.error === undefined ? null : String(details.error),
      alive: runtime.alive,
    }))}`,
    runtime.processTree === '' ? undefined : `Process tree: ${sanitize(runtime.processTree)}`,
    runtime.listeners === '' ? undefined : `Listeners: ${sanitize(runtime.listeners)}`,
    `Output:\n${sanitize(output)}`,
  ].filter((line) => line !== undefined).join('\n')
}

async function childRuntimeSnapshot(child) {
  const alive = isProcessAlive(child.pid)
  if (process.platform !== 'win32' || child.pid === undefined || !alive) return { alive, processTree: '', listeners: '' }
  return {
    alive,
    processTree: runPowerShellDiagnostic(processTreeScript(child.pid)),
    listeners: runPowerShellDiagnostic(listenerScript(child.pid)),
  }
}

function isProcessAlive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function runPowerShellDiagnostic(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function processTreeScript(pid) {
  return [
    `$rootPid = ${pid}`,
    '$queue = [System.Collections.Generic.Queue[int]]::new()',
    '$seen = [System.Collections.Generic.HashSet[int]]::new()',
    '$queue.Enqueue($rootPid)',
    'while ($queue.Count -gt 0) {',
    '  $current = $queue.Dequeue()',
    '  if (-not $seen.Add($current)) { continue }',
    '  Get-CimInstance Win32_Process -Filter "ProcessId=$current" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }',
    '}',
  ].join('; ')
}

function listenerScript(pid) {
  return [
    `$rootPid = ${pid}`,
    '$pids = @($rootPid)',
    '$queue = [System.Collections.Generic.Queue[int]]::new()',
    '$seen = [System.Collections.Generic.HashSet[int]]::new()',
    '$queue.Enqueue($rootPid)',
    'while ($queue.Count -gt 0) {',
    '  $current = $queue.Dequeue()',
    '  if (-not $seen.Add($current)) { continue }',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" | ForEach-Object { $pids += [int]$_.ProcessId; $queue.Enqueue([int]$_.ProcessId) }',
    '}',
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
  ].join('; ')
}

async function smokeEmptyAssistantStartup(page) {
  await visibleAssistantPanel(page, 'empty startup', 30_000)
  await assertAssistantPanel(page, 'wide-open')
  await panelShot(page, 'wide-open')
  await (await visibleAssistantPanel(page, 'wide-open')).getByRole('button', { name: 'Hide assistant panel', exact: true }).click()
  await waitForAssistantPanelHidden(page, 'wide-collapsed')
  const toggle = await visibleAssistantToggle(page, 'wide-collapsed')
  await assertComposerUsable(page, 'wide-collapsed')
  await assertNoDocumentOverflow(page, 'wide-collapsed')
  await toggle.click()
  await visibleAssistantPanel(page, 'wide-reopened')
  await assertAssistantPanel(page, 'wide-reopened')
  await page.setViewportSize(smallViewport)
  await assertAssistantPanel(page, 'small-open', { sideBySide: false })
  await panelShot(page, 'small-open')
  await (await visibleAssistantPanel(page, 'small-open')).getByRole('button', { name: 'Hide assistant panel', exact: true }).click()
  await waitForAssistantPanelHidden(page, 'small-collapsed')
  await assertComposerUsable(page, 'small-collapsed')
  await assertNoDocumentOverflow(page, 'small-collapsed')
  await (await visibleAssistantToggle(page, 'small-collapsed')).click()
  await assertAssistantPanel(page, 'small-reopened', { sideBySide: false })
  await (await visibleAssistantPanel(page, 'small-reopened')).getByRole('button', { name: 'Hide assistant panel', exact: true }).click()
  await waitForAssistantPanelHidden(page, 'small-reclosed')
  await page.setViewportSize(wideViewport)
  await assertAssistantPanelHidden(page, 'wide-after-small-manual-close')
  await assertComposerUsable(page, 'wide-after-small-manual-close')
  await assertNoDocumentOverflow(page, 'wide-after-small-manual-close')
}

async function smokeRecentActivityStartup(page) {
  await visibleAssistantPanel(page, 'recent startup', 30_000)
  await assertAssistantPanel(page, 'recent-wide-open', { activity: 'recent' })
  await panelShot(page, 'recent-wide-open')
  await page.setViewportSize(smallViewport)
  await assertAssistantPanel(page, 'recent-small-open', { activity: 'recent', sideBySide: false })
  await panelShot(page, 'recent-small-open')
  await page.setViewportSize(wideViewport)
  await assertAssistantPanel(page, 'recent-wide-before-navigation', { activity: 'recent' })
  await retainFixtureLayoutScreenshot(page)
  await exerciseRecentActivityNavigation(page)
}

async function smokeCalendarMemoryStartup(page) {
  const panel = await visibleAssistantPanel(page, 'calendar memory startup', 30_000)
  await assertAssistantPanelChrome(panel, { requireTabs: true })
  await assertAssistantTabs(panel)
  await assertAssistantTabKeyboard(panel)
  await assertCompactNavigationAccessible(page)
  await openCalendarMemoryConversation(page)
  const openedPanel = await visibleAssistantPanel(page, 'calendar memory opened')
  await selectAssistantTab(openedPanel, 'Queue')
  await assertQueueEmpty(openedPanel)
  await selectAssistantTab(openedPanel, 'Day')
  await assertCalendarDayTab(openedPanel)
  await selectAssistantTab(openedPanel, 'Memory')
  await assertMemoryTab(await visibleAssistantPanel(page, 'calendar memory data'))
  await retainFixtureLayoutScreenshot(page)
  await assertColorSchemeKeepsCalendarMemoryState(page, 'light')
  await assertColorSchemeKeepsCalendarMemoryState(page, 'dark')
  await openMemoryFailureConversation(page)
  const failurePanel = await visibleAssistantPanel(page, 'memory failure data')
  await selectAssistantTab(failurePanel, 'Memory')
  await assertMemoryFailureTab(failurePanel)
  await openCalendarMemoryConversation(page)
  const restoredPanel = await visibleAssistantPanel(page, 'calendar memory restored')
  await selectAssistantTab(restoredPanel, 'Day')
  await assertCalendarDayTab(restoredPanel)
  await assertCalendarQuickActionCopiesOnly(page, restoredPanel)
  const reopenedPanel = await visibleAssistantPanel(page, 'calendar memory reopened after quick action')
  await selectAssistantTab(reopenedPanel, 'Day')
  await assertCalendarDayTab(reopenedPanel)
  await page.setViewportSize(smallViewport)
  await assertAssistantPanelChrome(await visibleAssistantPanel(page, 'calendar memory small'), { requireTabs: true })
  await assertNoDocumentOverflow(page, 'calendar-memory-small')
  await page.setViewportSize(wideViewport)
  await retainFixtureLayoutScreenshot(page)
}

async function smokeReceiptBrowserFlow(page) {
  await visibleAssistantPanel(page, 'receipt startup', 30_000)
  await assertNoReceipts(page, 'receipt startup')
  await startNewSession(page, 'receipt active workspace')
  await assertNoReceipts(page, 'receipt blank session')

  await writeProviderControl({ prepareHoldOnce: true })
  await submitComposerMessage(page, receiptPrepareCancelText, 'prepare cancellation')
  await waitForProviderLog(entry => entry.type === 'prepare-hold-start', 'prepare hold start')
  await assertNoReceipts(page, 'prepare cancellation before admission')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
  await waitForProviderLog(entry => entry.type === 'prepare-hold-abort', 'prepare hold abort')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden' })
  await waitForPersistedUserMessages(receiptPrepareCancelText, 0, 'prepare cancellation persistence')
  await clearComposer(page, 'prepare cancellation cleanup')

  await submitComposerMessage(page, `Greeting probe ${interactionId}`, 'normal greeting')
  await waitForConversationText(page, 'Hi! How can I help?', 'normal greeting answer')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden' })
  await assertNoReceipts(page, 'ordinary answer is not an automatic receipt')

  await submitComposerMessage(page, receiptDuplicateText, 'first receipt')
  const firstReceipts = await waitForReceiptCount(page, 1, 'first receipt')
  assertReceiptPresentation(firstReceipts, { style: 'thumbs-up', label: 'first receipt' })
  await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText], 'first receipt')
  await page.screenshot({ path: join(browserShots, 'receipt-attached-dark.png'), fullPage: true })
  const firstMessage = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: receiptDuplicateText }).first()
  await firstMessage.getByRole('button', { name: 'Copy', exact: true }).click()
  await assertClipboardText(page, receiptDuplicateText, 'receipt does not enter copied message text')
  await assertNoDuplicateReactionReply(page, 'first reaction replaces the emoji reply')

  await submitComposerMessage(page, receiptDuplicateText, 'same input with a text reply')
  await waitForConversationText(page, "You're welcome.", 'model chose words')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden' })
  await waitForReceiptCount(page, 1, 'same input does not force a reaction')

  await submitComposerMessage(page, receiptDuplicateText, 'second reaction')
  const duplicateReceipts = await waitForReceiptCount(page, 2, 'duplicate receipts')
  assertReceiptPresentation(duplicateReceipts, { style: 'thumbs-up', label: 'duplicate receipts' })
  const duplicateIds = duplicateReceipts.map(receipt => receipt.messageId)
  if (new Set(duplicateIds).size !== 2) throw new Error(`duplicate receipts must keep separate message IDs: ${JSON.stringify(duplicateIds)}`)
  const persistedDuplicateMessages = await waitForPersistedUserMessages(receiptDuplicateText, 3, 'duplicate receipt persistence')
  assertReceiptIdsMatchPersistedMessages(duplicateReceipts, [persistedDuplicateMessages[0], persistedDuplicateMessages[2]], 'duplicate receipts')
  await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText, receiptDuplicateText], 'duplicate receipts')
  await assertNoDuplicateReactionReply(page, 'committed emoji-only replies')
  if (options['record-reactions']) await recordSelectiveReactionSession(home, receiptDuplicateText)

  await submitComposerMessage(page, `Mixed acknowledgement probe ${interactionId}`, 'mixed emoji and text')
  await waitForConversationText(page, '👍 Here is a written reply.', 'mixed reply remains a message')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden' })
  await waitForReceiptCount(page, 2, 'mixed reply does not create a reaction')

  await submitComposerMessage(page, receiptClarifyText, 'clarify cancel')
  await waitForConversationText(page, 'Save this memory note?', 'clarify question')
  await page.getByRole('button', { name: 'Dismiss all questions', exact: true }).click()
  await waitForConversationText(page, 'Question cancelled. No memory write was made.', 'clarify cancellation answer')
  await assertConversationTextAbsent(page, 'memory_write', 'clarify cancellation')
  const afterQuestionReceipts = await waitForReceiptCount(page, 2, 'question does not create a reaction')
  assertReceiptPresentation(afterQuestionReceipts, { style: 'thumbs-up', label: 'clarify receipt' })
  await waitForPersistedUserMessages(receiptClarifyText, 1, 'clarify persistence')
  await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText, receiptDuplicateText], 'clarify receipt')

  const receiptIdsBeforeReload = afterQuestionReceipts.map(receipt => receipt.messageId)
  await page.reload({ waitUntil: 'load' })
  await dismissStartupDialogs(page)
  const reloadedReceipts = await waitForReceiptCount(page, 2, 'receipt reload')
  assertReceiptPresentation(reloadedReceipts, { style: 'thumbs-up', label: 'receipt reload' })
  assertSameSet(reloadedReceipts.map(receipt => receipt.messageId), receiptIdsBeforeReload, 'receipt reload IDs')
  await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText, receiptDuplicateText], 'receipt reload')
  await assertNoDuplicateReactionReply(page, 'replayed emoji-only replies')

  await submitComposerMessage(page, receiptStreamHoldText, 'stream hold')
  await waitForProviderLog(entry => entry.type === 'stream-hold-start', 'stream hold start')
  await page.locator('[data-chat-flow-kind="assistant-step"]').getByText('👍', { exact: true }).waitFor({ state: 'visible' })
  const holdReceipts = await waitForReceiptCount(page, 2, 'partial emoji must not create a reaction')
  assertReceiptPresentation(holdReceipts, { style: 'thumbs-up', label: 'stream hold receipt' })
  await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText, receiptDuplicateText], 'stream hold receipt')
  await submitComposerMessage(page, receiptQueuedText, 'queued receipt probe', /^Queue message$/u)
  await waitForComposerText(page, '', 'queued input accepted')
  await waitForPersistedUserMessages(receiptQueuedText, 0, 'queued message before admission')
  const queuedReceipts = await visibleReceiptData(page)
  if (queuedReceipts.length !== 2) throw new Error(`queued input must not receive a reaction; got ${queuedReceipts.length}`)
  await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
  await waitForProviderLog(entry => entry.type === 'stream-hold-abort', 'stream hold abort')
  await page.getByRole('button', { name: 'Stop generating', exact: true }).waitFor({ state: 'hidden' })
  await waitForPersistedUserMessages(receiptQueuedText, 0, 'queued message after stream cancellation')
  const cancelledHoldReceipts = await waitForReceiptCount(page, 2, 'cancelled emoji must not create a reaction')
  assertReceiptPresentation(cancelledHoldReceipts, { style: 'thumbs-up', label: 'stream hold cancellation receipt' })
  assertSameSet(cancelledHoldReceipts.map(receipt => receipt.messageId), holdReceipts.map(receipt => receipt.messageId), 'stream hold cancellation receipt IDs')

  await (await visibleAssistantPanel(page, 'receipt layout')).getByRole('button', { name: 'Hide assistant panel', exact: true }).click()
  await waitForAssistantPanelHidden(page, 'receipt layout')
  for (const [colorScheme, viewport] of [['light', wideViewport], ['light', smallViewport], ['dark', smallViewport]]) {
    const label = `receipt ${colorScheme} ${viewport.width}`
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize(viewport)
    await assertNoDocumentOverflow(page, label)
    assertReceiptPresentation(await waitForReceiptCount(page, 2, label), { style: 'thumbs-up', label })
    await assertReceiptRowsFollowUserMessages(page, [receiptDuplicateText, receiptDuplicateText], label)
    await page.screenshot({ path: join(browserShots, `receipt-${colorScheme}-${viewport.width}.png`), fullPage: true })
  }
}

async function smokeRecordedReactions(page, recorded) {
  if (typeof recorded.title !== 'string') throw new Error('recorded reaction fixture has no title')
  const before = (await readFile(scriptedModelLog, 'utf8')).split('\n').filter(line => line.includes('"type":"request"')).length
  const panel = await visibleAssistantPanel(page, 'recorded reaction startup', 30_000)
  await selectAssistantTab(panel, 'Timeline')
  await panel.getByRole('button', { name: new RegExp(`^Open ${escapeRegExp(recorded.title)}, updated`, 'u') }).click()
  await waitForConversationText(page, 'Hi! How can I help?', 'recorded normal greeting')
  await waitForConversationText(page, "You're welcome.", 'recorded normal answer')
  const reactions = await waitForReceiptCount(page, 2, 'recorded model acknowledgements')
  const expected = []
  let previous
  for (const event of recorded.events) {
    if (event.type === 'user/message' && event.data.source?.kind === 'user') previous = event.data
    if (event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === '👍')) {
      expected.push({ userId: previous?.id, assistantId: event.data.message.id })
    }
  }
  if (expected.length !== 2) throw new Error('recorded reaction fixture must contain two acknowledgements')
  for (let index = 0; index < expected.length; index += 1) {
    if (reactions[index].messageId !== expected[index].userId || reactions[index].assistantMessageId !== expected[index].assistantId) {
      throw new Error('recorded acknowledgement attached to the wrong durable message')
    }
  }
  await assertNoDuplicateReactionReply(page, 'recorded emoji replies')
  await page.reload({ waitUntil: 'load' })
  await dismissStartupDialogs(page)
  assertSameSet((await waitForReceiptCount(page, 2, 'recorded reload')).map(item => item.messageId), reactions.map(item => item.messageId), 'recorded reload')
  const after = (await readFile(scriptedModelLog, 'utf8')).split('\n').filter(line => line.includes('"type":"request"')).length
  if (after !== before) throw new Error('recorded reactions caused a model request during history replay')
}

async function smokeNeutralReceiptStartup(page) {
  await visibleAssistantPanel(page, 'neutral receipt startup', 30_000)
  await startNewSession(page, 'neutral receipt')
  const text = `Neutral receipt probe ${interactionId}`
  await submitComposerMessage(page, text, 'neutral receipt')
  const receipts = await waitForReceiptCount(page, 1, 'neutral receipt')
  assertReceiptPresentation(receipts, { style: 'neutral', label: 'neutral receipt' })
  await assertReceiptRowsFollowUserMessages(page, [text], 'neutral receipt')
  await waitForPersistedUserMessages(text, 1, 'neutral receipt persistence')
  await assertNoDuplicateReactionReply(page, 'neutral reaction replaces the emoji reply')
}

async function smokeOffReceiptStartup(page) {
  await visibleAssistantPanel(page, 'off receipt startup', 30_000)
  await startNewSession(page, 'off receipt')
  const text = `Off receipt probe ${interactionId}`
  await submitComposerMessage(page, text, 'off receipt')
  await waitForConversationText(page, '👍', 'disabled reactions retain the assistant reply')
  await waitForPersistedUserMessages(text, 1, 'off receipt persistence')
  await assertNoReceipts(page, 'off receipt')
}

async function assertNoDuplicateReactionReply(page, label) {
  const replies = page.locator('[data-chat-flow-kind="assistant-step"]').getByText('👍', { exact: true })
  if (await replies.count() !== 0) throw new Error(`${label}: reaction also appeared as a separate assistant reply`)
}

async function loadChromium() {
  try {
    return (await import('playwright')).chromium
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error([
      'Playwright is required for the profile browser smoke.',
      'Add "playwright": "1.61.1" to work-assistant/package.json devDependencies and run pnpm install; do not import it from apps/web.',
      `Import failed: ${reason}`,
    ].join(' '))
  }
}

function unauthenticatedStartupUrl(startupUrl) {
  const parsed = new URL(startupUrl)
  if (parsed.hostname !== '127.0.0.1') throw new Error(`Web server printed a non-loopback URL: ${sanitize(startupUrl)}`)
  if (!parsed.searchParams.has('token')) throw new Error(`Web server URL omitted the process token: ${sanitize(startupUrl)}`)
  parsed.searchParams.delete('token')
  return parsed
}

async function visibleAssistantPanel(page, label, timeout = 10_000) {
  return uniqueOwnedVisibleLocator(page, assistantPanelSelector, `${label} assistant panel`, timeout)
}

async function visibleAssistantToggle(page, label, timeout = 10_000) {
  return uniqueOwnedVisibleLocator(page, assistantToggleSelector, `${label} assistant toggle`, timeout)
}

async function visibleComposer(page, label, timeout = 10_000) {
  return visiblePrimaryLocator(page, composerSelector, `${label} composer`, timeout)
}

async function visibleConversationScroll(page, label, timeout = 10_000) {
  return uniqueVisibleLocator(page, conversationScrollSelector, `${label} conversation scroll`, timeout)
}

async function dismissStartupDialogs(page) {
  const actions = [
    { title: 'Internal Testing Notice', button: 'Continue' },
    { title: 'Add an API key to get started', button: 'Configure later' },
  ]
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const action = await visibleStartupDialogAction(page, actions, attempt === 0 ? 5_000 : 2_000)
    if (action === undefined) break
    await action.dialog.getByRole('button', { name: action.button, exact: true }).click()
    await action.dialog.waitFor({ state: 'hidden', timeout: 10_000 })
  }
  const dialogs = page.getByRole('dialog')
  const count = await dialogs.count()
  if (count > 0) throw new Error(`Startup left ${count} modal dialog(s) visible before layout assertions`)
}

async function assertNoPluginBootFailure(page) {
  const boot = page.locator('[data-dsh-boot]')
  if (await boot.count() === 0) return
  const text = normalizeText(await boot.first().innerText())
  if (text.includes('Failed to load plugins')) throw new Error(`Web app failed to load plugins: ${text}`)
}

async function visibleStartupDialogAction(page, actions, timeout) {
  const deadline = Date.now() + timeout
  do {
    for (const action of actions) {
      const dialog = page.getByRole('dialog', { name: action.title, exact: true })
      if (await dialog.count() > 0 && await dialog.first().isVisible()) {
        return { dialog: dialog.first(), button: action.button }
      }
    }
    if (timeout === 0) break
    await page.waitForTimeout(50)
  } while (Date.now() <= deadline)
  return undefined
}

async function uniqueOwnedVisibleLocator(page, selector, label, timeout) {
  const deadline = Date.now() + timeout
  let last = { total: 0, visible: 0 }
  while (Date.now() <= deadline) {
    last = await locatorCounts(page, selector)
    if (last.total > 1) throw new Error(`${label}: expected exactly one DOM match, got ${last.total}`)
    if (last.visible > 1) throw new Error(`${label}: expected exactly one visible match, got ${last.visible}`)
    if (last.total === 1 && last.visible === 1) return page.locator(selector)
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: expected one DOM match and one visible match; got ${last.total} DOM and ${last.visible} visible`)
}

async function uniqueVisibleLocator(page, selector, label, timeout) {
  const locator = page.locator(`${selector}:visible`)
  await locator.first().waitFor({ state: 'visible', timeout })
  const count = await locator.count()
  if (count !== 1) throw new Error(`${label}: expected exactly one visible match, got ${count}`)
  return locator.nth(0)
}

async function assertAssistantPanelHidden(page, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await waitForOwnedHiddenLocator(page, assistantPanelSelector, `${label} assistant panel`, 1)
}

async function waitForAssistantPanelHidden(page, label, timeout = 10_000) {
  await waitForOwnedHiddenLocator(page, assistantPanelSelector, `${label} assistant panel`, timeout)
}

async function waitForOwnedHiddenLocator(page, selector, label, timeout) {
  const deadline = Date.now() + timeout
  let last = { total: 0, visible: 0 }
  while (Date.now() <= deadline) {
    last = await locatorCounts(page, selector)
    if (last.total > 1) throw new Error(`${label}: expected at most one DOM match while hidden, got ${last.total}`)
    if (last.visible > 1) throw new Error(`${label}: expected at most one visible match while hidden, got ${last.visible}`)
    if (last.visible === 0) return
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: stayed visible; got ${last.total} DOM and ${last.visible} visible`)
}

async function locatorCounts(page, selector) {
  const total = await page.locator(selector).count()
  const visible = await page.locator(`${selector}:visible`).count()
  return { total, visible }
}

async function visiblePrimaryLocator(page, selector, label, timeout) {
  const deadline = Date.now() + timeout
  const locator = page.locator(`${selector}:visible`)
  let lastCount = 0
  while (Date.now() <= deadline) {
    lastCount = await locator.count()
    const index = await largestVisibleBoxIndex(locator, lastCount)
    if (index !== undefined) return locator.nth(index)
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: expected at least one visible usable match, got ${lastCount}`)
}

async function largestVisibleBoxIndex(locator, count) {
  let best
  for (let index = 0; index < count; index += 1) {
    const box = await locator.nth(index).boundingBox()
    if (box === null || box.width <= 0 || box.height <= 0) continue
    const area = box.width * box.height
    if (best === undefined || area > best.area) best = { index, area }
  }
  return best?.index
}

function recentActivityButtonName() {
  return new RegExp(`^Open ${escapeRegExp(RECENT_ACTIVITY_TITLE)}, updated .+`, 'u')
}

function calendarMemoryButtonName() {
  return new RegExp(`^Open ${escapeRegExp(CALENDAR_MEMORY_TITLE)}, updated .+`, 'u')
}

function memoryFailureButtonName() {
  return new RegExp(`^Open ${escapeRegExp(MEMORY_FAILURE_TITLE)}, updated .+`, 'u')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function assertAssistantPanel(page, label, options = {}) {
  const { activity = 'empty', sideBySide = true } = options
  const panel = await visibleAssistantPanel(page, label)
  await assertAssistantPanelChrome(panel)
  if (activity === 'empty') await assertHonestEmptyActivity(panel)
  else if (activity === 'recent') await assertRecentActivitySummary(panel)
  else throw new Error(`Unknown assistant panel activity assertion: ${String(activity)}`)
  if (sideBySide) await assertPanelAndComposerLayout(page, panel, label)
  else await assertNarrowPanelLayout(page, panel, label)
}

async function assertAssistantPanelChrome(panel, { requireTabs = false } = {}) {
  const harnessHeading = panel.getByRole('heading', { name: 'Harness', exact: true })
  const personalHeading = panel.getByRole('heading', { name: 'Personal assistant', exact: true })
  if (requireTabs) await harnessHeading.waitFor({ state: 'visible', timeout: 10_000 })
  else if (await harnessHeading.count() > 0) await harnessHeading.first().waitFor({ state: 'visible', timeout: 10_000 })
  else await personalHeading.waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('Calendar and memory', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await assertConnectionLabel(panel)
  await panel.getByRole('button', { name: 'Hide assistant panel', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (requireTabs) await assertAssistantTabs(panel)
}

async function assertAssistantTabs(panel) {
  await panel.getByRole('tablist', { name: 'Assistant views', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  for (const name of assistantTabs) await assistantTab(panel, name)
}

async function assertAssistantTabKeyboard(panel) {
  const timeline = await assistantTab(panel, 'Timeline')
  await timeline.focus()
  await timeline.press('ArrowRight')
  await assertAssistantTabSelected(panel, 'Queue')
  await (await assistantTab(panel, 'Queue')).press('End')
  await assertAssistantTabSelected(panel, 'Inbox')
  await (await assistantTab(panel, 'Inbox')).press('Home')
  await assertAssistantTabSelected(panel, 'Timeline')
}

async function hasAssistantTabs(panel) {
  return await panel.getByRole('tab', { name: 'Timeline', exact: true }).count() > 0
}

async function assistantTab(panel, name) {
  const tab = panel.getByRole('tab', { name, exact: true })
  await tab.first().waitFor({ state: 'visible', timeout: 10_000 })
  return tab.first()
}

async function selectAssistantTab(panel, name) {
  const control = await assistantTab(panel, name)
  await control.click()
  await panel.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await assertAssistantTabSelected(panel, name)
}

async function assertAssistantTabSelected(panel, name) {
  const control = await assistantTab(panel, name)
  const selected = await control.getAttribute('aria-selected')
  if (selected !== 'true') throw new Error(`Assistant tab ${name} did not expose aria-selected="true"`)
  for (const other of assistantTabs.filter(tab => tab !== name)) {
    const otherSelected = await (await assistantTab(panel, other)).getAttribute('aria-selected')
    if (otherSelected !== 'false') throw new Error(`Inactive assistant tab ${other} did not expose aria-selected="false"`)
  }
}

async function assertCompactNavigationAccessible(page) {
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: 'New session', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
}

async function assertConnectionLabel(panel) {
  await panel.getByText('Connected to DSH', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  const lines = await panelTextLines(panel)
  const misleading = lines.find(line => /\b(connected|authenticated|authentication)\b/iu.test(line) && line !== 'Connected to DSH')
  if (misleading !== undefined) throw new Error(`Assistant panel connection label must not describe model authentication: ${sanitize(misleading)}`)
}

async function openCalendarMemoryConversation(page) {
  const panel = await visibleAssistantPanel(page, 'calendar memory navigation')
  await selectAssistantTab(panel, 'Timeline')
  await panel.getByRole('button', { name: calendarMemoryButtonName() }).click()
  const conversation = await visibleConversationScroll(page, 'calendar memory navigation', 15_000)
  await conversation.getByText(CALENDAR_MEMORY_USER_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await conversation.getByText(CALENDAR_MEMORY_ASSISTANT_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await assertNoDocumentOverflow(page, 'calendar-memory-opened')
}

async function openMemoryFailureConversation(page) {
  const panel = await visibleAssistantPanel(page, 'memory failure navigation')
  await selectAssistantTab(panel, 'Timeline')
  await panel.getByRole('button', { name: memoryFailureButtonName() }).click()
  const conversation = await visibleConversationScroll(page, 'memory failure navigation', 15_000)
  await conversation.getByText(MEMORY_FAILURE_USER_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await conversation.getByText(MEMORY_FAILURE_ASSISTANT_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await assertNoDocumentOverflow(page, 'memory-failure-opened')
}

async function assertCalendarDayTab(panel) {
  await panel.getByRole('heading', { name: 'Day', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('America/Los_Angeles', { exact: false }).first().waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_EVENT_TITLE, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(new RegExp(escapeRegExp(CALENDAR_MEMORY_EVENT_LOCATION), 'u')).first().waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(/10:00/u).first().waitFor({ state: 'visible', timeout: 10_000 })
}

async function assertMemoryTab(panel) {
  await panel.getByRole('heading', { name: 'Memory', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_NOTE, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_PROJECT_NOTE, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_RETAINED_PROJECT_NOTE, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_ABSENT_NOTE, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  const absentLabels = panel.getByText('Absent', { exact: true })
  await absentLabels.first().waitFor({ state: 'visible', timeout: 10_000 })
  const [firstLine, secondLine] = CALENDAR_MEMORY_NOTE_TEXT.trim().split('\n')
  await panel.getByText(firstLine, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText(CALENDAR_MEMORY_RETAINED_PROJECT_NOTE_TEXT.trim(), { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('The memory tool reported more notes were omitted by its configured limit.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (await panel.getByText(secondLine, { exact: true }).count() > 0) throw new Error('Memory panel exposed more than the read-note summary line')
}

async function assertMemoryFailureTab(panel) {
  await panel.getByRole('heading', { name: 'Memory', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('The memory tool failed in this conversation.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByRole('button', { name: 'Open transcript', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (await panel.getByText(CALENDAR_MEMORY_NOTE, { exact: true }).count() > 0) throw new Error('Failed memory_write did not clear the older memory read row')
  if (await panel.getByText(CALENDAR_MEMORY_NOTE_TEXT.trim().split('\n')[0], { exact: true }).count() > 0) throw new Error('Failed memory_write exposed stale memory read content')
}

async function assertQueueEmpty(panel) {
  await panel.getByRole('heading', { name: 'Queue', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByRole('heading', { name: 'Waiting on you', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('Nothing is waiting on you.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByRole('heading', { name: 'Running now', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('No personal-assistant conversations are running.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (await panel.getByRole('button', { name: /^Review /u }).count() > 0) throw new Error('Queue empty state rendered a review action')
}

async function assertCalendarQuickActionCopiesOnly(page, panel) {
  const preservedComposerText = await seedComposerDraftIfEditable(page, 'Keep this unsent draft', 'quick action preservation')
  await panel.getByTestId('wa-assistant-request').getByText(calendarRequestText, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByRole('button', { name: 'Copy calendar request', exact: true }).click()
  await panel.getByText('Request copied. Paste it into chat, review it, and send when ready.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await assertClipboardText(page, calendarRequestText, 'calendar quick action copy')
  await assertComposerText(page, preservedComposerText, 'calendar quick action preserved composer')
  await assertConversationTextAbsent(page, calendarRequestText, 'calendar quick action')
  await assertConversationStillOpen(page, 'calendar quick action')

  const quickPanel = await visibleAssistantPanel(page, 'memory quick action')
  await selectAssistantTab(quickPanel, 'Memory')
  await quickPanel.getByTestId('wa-assistant-request').getByText(memoryRequestText, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await quickPanel.getByRole('button', { name: 'Copy memory request', exact: true }).click()
  await quickPanel.getByText('Request copied. Paste it into chat, review it, and send when ready.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await assertClipboardText(page, memoryRequestText, 'memory quick action copy')
  await assertComposerText(page, preservedComposerText, 'memory quick action preserved composer')
  await assertConversationTextAbsent(page, memoryRequestText, 'memory quick action')
  await assertConversationStillOpen(page, 'memory quick action')
}

async function assertColorSchemeKeepsCalendarMemoryState(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme })
  const panel = await visibleAssistantPanel(page, `calendar memory ${scheme} scheme`)
  await assertAssistantPanelChrome(panel, { requireTabs: true })
  await selectAssistantTab(panel, 'Memory')
  await assertMemoryTab(panel)
  await assertNoDocumentOverflow(page, `calendar-memory-${scheme}-scheme`)
}

async function assertHonestEmptyActivity(panel) {
  if (await hasAssistantTabs(panel)) {
    await selectAssistantTab(panel, 'Timeline')
    await panel.getByRole('heading', { name: 'Timeline', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  } else await panel.getByRole('heading', { name: 'Recent conversations', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByText('No recent personal-assistant conversations yet.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  if (await panel.getByRole('list').count() > 0) throw new Error('Empty assistant panel must not render a recent-conversation list')
}

async function assertRecentActivitySummary(panel) {
  if (await hasAssistantTabs(panel)) {
    await selectAssistantTab(panel, 'Timeline')
    await panel.getByRole('heading', { name: 'Timeline', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  } else await panel.getByRole('heading', { name: 'Recent conversations', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  await panel.getByRole('button', { name: recentActivityButtonName() }).waitFor({ state: 'visible', timeout: 10_000 })
  if (await panel.getByText('No recent personal-assistant conversations yet.', { exact: true }).count() > 0) {
    throw new Error('Recent assistant panel rendered both fixture activity and the empty state')
  }
}

async function panelTextLines(panel) {
  return (await panel.innerText()).split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
}

async function exerciseRecentActivityNavigation(page) {
  const panel = await visibleAssistantPanel(page, 'recent activity navigation')
  const preOpenConversations = page.locator(`${conversationScrollSelector}:visible`)
  const preOpenCount = await preOpenConversations.count()
  if (preOpenCount > 1) throw new Error(`recent activity navigation: expected at most one visible conversation before navigation, got ${preOpenCount}`)
  if (preOpenCount === 1 && await preOpenConversations.nth(0).getByText(RECENT_ACTIVITY_ASSISTANT_TEXT, { exact: true }).count() > 0) {
    throw new Error('recent activity fixture was already open before panel navigation')
  }
  await panel.getByRole('button', { name: recentActivityButtonName() }).click()
  const conversation = await visibleConversationScroll(page, 'recent activity navigation', 15_000)
  await conversation.getByText(RECENT_ACTIVITY_USER_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await conversation.getByText(RECENT_ACTIVITY_ASSISTANT_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await assertNoReceipts(page, 'non-Web historic fixture')
  await assertNoDocumentOverflow(page, 'recent-activity-opened')
}

async function assertPanelAndComposerLayout(page, panel, label) {
  const composer = await visibleComposer(page, label)
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  const [panelBox, composerBox] = await stableBoxes(page, [panel, composer], label)
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error(`${label}: page has no viewport`)
  assertInViewport(panelBox, viewport, `${label} assistant panel`)
  assertInViewport(composerBox, viewport, `${label} composer`)
  if (panelBox.x + 1 < composerBox.x + composerBox.width) {
    throw new Error(`${label}: assistant panel is not laid out to the right of the composer`)
  }
  if (intersectionArea(panelBox, composerBox) > 1) {
    throw new Error(`${label}: assistant panel overlaps the composer`)
  }
  await assertComposerUsable(page, label)
  await assertNoDocumentOverflow(page, label)
}

async function assertNarrowPanelLayout(page, panel, label) {
  const [panelBox] = await stableBoxes(page, [panel], label)
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error(`${label}: page has no viewport`)
  assertInViewport(panelBox, viewport, `${label} assistant panel`)
  await assertNoDocumentOverflow(page, label)
}

async function assertComposerUsable(page, label) {
  const composer = await visibleComposer(page, label)
  await composer.waitFor({ state: 'visible', timeout: 10_000 })
  const receivesPointer = await composer.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return hit !== null && node.contains(hit)
  })
  if (!receivesPointer) throw new Error(`${label}: composer is hidden behind another element`)
}

async function startNewSession(page, label) {
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await visibleComposer(page, `${label} new session`, 15_000)
  await ensureWorkspaceSelected(page, `${label} new session`)
  await assertNoDocumentOverflow(page, `${label} new session`)
}

async function ensureWorkspaceSelected(page, label) {
  const initial = await composerState(page, label)
  if (initial.contentEditable === 'true' && initial.ariaDisabled !== 'true') return
  if (initial.placeholder !== 'Choose a workspace to start') return
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).first().click()
  await page.getByRole('menuitem', { name: basename(workspace), exact: true }).click()
  await waitForComposerEditable(page, label)
}

async function submitComposerMessage(page, text, label, buttonName = /^Send message$/u) {
  const composer = await visibleComposer(page, label, 15_000)
  await composer.fill(text)
  await waitForComposerText(page, text, `${label} draft`)
  await page.getByRole('button', { name: buttonName }).click()
}

async function clearComposer(page, label) {
  const composer = await visibleComposer(page, label, 15_000)
  if ((await composerState(page, label)).contentEditable !== 'true') return
  await composer.fill('')
  await waitForComposerText(page, '', `${label} cleared`)
}

async function waitForConversationText(page, text, label, { timeout = 20_000, occurrence = 1 } = {}) {
  const conversation = await visibleConversationScroll(page, label, timeout)
  await conversation.getByText(text, { exact: true }).nth(occurrence - 1).waitFor({ state: 'visible', timeout })
}

async function seedComposerDraftIfEditable(page, draft, label) {
  const state = await composerState(page, label)
  if (state.contentEditable !== 'true' || state.ariaDisabled === 'true') return normalizeText(state.text)
  const composer = await visibleComposer(page, label)
  await composer.fill(draft)
  await waitForComposerText(page, draft, `${label} seeded draft`)
  return draft
}

async function waitForComposerText(page, expected, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let actual = ''
  let state
  while (Date.now() <= deadline) {
    actual = await readComposerText(page, label)
    if (actual === expected) return
    state = await composerState(page, label)
    await page.waitForTimeout(50)
  }

  throw new Error(`${label}: expected composer draft ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; composer=${JSON.stringify(state)}`)
}

async function waitForComposerEditable(page, label, timeout = 10_000) {
  const deadline = Date.now() + timeout
  let state
  while (Date.now() <= deadline) {
    state = await composerState(page, label)
    if (state.contentEditable === 'true' && state.ariaDisabled !== 'true') return
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: expected composer to become editable after workspace selection; composer=${JSON.stringify(state)}`)
}

async function assertComposerText(page, expected, label) {
  const actual = await readComposerText(page, label)
  if (actual !== expected) {
    const state = await composerState(page, label)
    throw new Error(`${label}: expected composer text ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; composer=${JSON.stringify(state)}`)
  }
}

async function readComposerText(page, label) {
  const composer = await visibleComposer(page, label)
  return normalizeText(await composer.evaluate(node => node.textContent ?? ''))
}

async function composerState(page, label) {
  const composer = await visibleComposer(page, label)
  return composer.evaluate(node => ({
    text: node.textContent ?? '',
    ariaDisabled: node.getAttribute('aria-disabled'),
    contentEditable: node.getAttribute('contenteditable'),
    placeholder: node.getAttribute('data-placeholder'),
  }))
}

async function assertNoReceipts(page, label) {
  const receipts = await visibleReceiptData(page)
  if (receipts.length > 0) throw new Error(`${label}: expected no visible message receipts, got ${JSON.stringify(receipts)}`)
  const heights = await page.locator('[data-slot="conversation.chat.user-badges"]').evaluateAll(nodes =>
    nodes.map(node => node.parentElement.getBoundingClientRect().height))
  if (heights.some(height => height !== 0)) throw new Error(`${label}: inactive receipt rows must not reserve vertical space: ${JSON.stringify(heights)}`)
  const gaps = await page.locator('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]').evaluateAll(nodes =>
    nodes.flatMap(node => {
      const body = node.querySelector('[data-user-message-body]')?.getBoundingClientRect()
      const actions = node.querySelector('[data-message-actions]')?.getBoundingClientRect()
      return body?.height > 0 && actions?.height > 0 ? [actions.top - body.bottom] : []
    }))
  if (gaps.some(gap => Math.abs(gap - 6) > 1)) throw new Error(`${label}: inactive receipts changed the ordinary message spacing: ${JSON.stringify(gaps)}`)
}

async function waitForReceiptCount(page, expected, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let receipts = []
  while (Date.now() <= deadline) {
    receipts = await visibleReceiptData(page)
    if (receipts.length === expected) return receipts
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: expected ${expected} visible receipts, got ${receipts.length}: ${JSON.stringify(receipts)}`)
}

async function visibleReceiptData(page) {
  return page.locator(receiptSelector).evaluateAll(nodes => nodes
    .filter(node => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    .map(node => ({
      messageId: node.getAttribute('data-message-id') ?? '',
      assistantMessageId: node.getAttribute('data-assistant-message-id') ?? '',
      role: node.getAttribute('role'),
      ariaLabel: node.getAttribute('aria-label'),
      title: node.getAttribute('title'),
      text: node.textContent ?? '',
      ariaLive: node.getAttribute('aria-live'),
      tabIndex: node.tabIndex,
      animationName: getComputedStyle(node).animationName,
      closestButton: node.closest('button,[role="button"]') !== null,
      statusRole: node.getAttribute('role') === 'status' || node.closest('[role="status"]') !== null,
    })))
}

function assertReceiptPresentation(receipts, { style, label }) {
  for (const receipt of receipts) {
    if (receipt.messageId === '') throw new Error(`${label}: receipt must expose data-message-id`)
    if (receipt.assistantMessageId === '') throw new Error(`${label}: reaction must identify the assistant reply`)
    if (receipt.role !== 'img') throw new Error(`${label}: receipt role must be img: ${JSON.stringify(receipt)}`)
    if (receipt.ariaLabel !== 'Assistant acknowledged your message.') throw new Error(`${label}: receipt accessible name mismatch: ${JSON.stringify(receipt)}`)
    if (receipt.title !== 'Assistant acknowledged your message.') throw new Error(`${label}: receipt title mismatch: ${JSON.stringify(receipt)}`)
    if (receipt.ariaLive !== null) throw new Error(`${label}: receipt must not be a live region: ${JSON.stringify(receipt)}`)
    if (receipt.tabIndex !== -1 || receipt.animationName !== 'none') throw new Error(`${label}: receipt must not take keyboard focus or animate: ${JSON.stringify(receipt)}`)
    if (receipt.closestButton || receipt.statusRole) throw new Error(`${label}: receipt must not be interactive or status UI: ${JSON.stringify(receipt)}`)
    if (style === 'thumbs-up' && !receipt.text.includes('👍')) throw new Error(`${label}: thumbs-up receipt missing visible glyph: ${JSON.stringify(receipt)}`)
    if (style === 'neutral' && normalizeText(receipt.text) !== 'Received') throw new Error(`${label}: neutral receipt must show Received: ${JSON.stringify(receipt)}`)
    if (style === 'off') throw new Error(`${label}: off style must not render receipts`)
  }
}

async function assertReceiptRowsFollowUserMessages(page, expectedMessages, label) {
  const rows = await page.locator(receiptSelector).evaluateAll(nodes => nodes.map(node => {
    const flow = node.closest('[data-chat-flow-kind]')
    const message = flow?.querySelector('[data-user-message-body]')
    const actions = flow?.querySelector('[data-message-actions]')
    const receiptRect = node.getBoundingClientRect()
    const messageRect = message?.getBoundingClientRect()
    return {
      messageText: message?.textContent ?? '',
      receipt: receiptRect.toJSON(),
      message: messageRect?.toJSON() ?? null,
      actions: actions?.getBoundingClientRect().toJSON() ?? null,
    }
  }))
  if (rows.length !== expectedMessages.length) {
    throw new Error(`${label}: expected ${expectedMessages.length} receipt rows, got ${rows.length}: ${JSON.stringify(rows)}`)
  }
  rows.forEach((row, index) => {
    const expected = expectedMessages[index]
    if (row.message === null || row.actions === null) throw new Error(`${label}: receipt ${index} is missing its message or controls: ${JSON.stringify(row)}`)
    if (!normalizeText(row.messageText).includes(expected)) {
      throw new Error(`${label}: receipt ${index} is not under expected user text ${JSON.stringify(expected)}: ${JSON.stringify(row)}`)
    }
    if (row.receipt.top >= row.message.bottom || row.receipt.bottom <= row.message.bottom) {
      throw new Error(`${label}: reaction ${index} must straddle the message's lower edge: ${JSON.stringify(row)}`)
    }
    if (Math.abs(row.message.right - row.receipt.right - 8) > 2) {
      throw new Error(`${label}: reaction ${index} must attach to the lower-right corner: ${JSON.stringify(row)}`)
    }
    if (row.actions.top < row.receipt.bottom + 4) {
      throw new Error(`${label}: reaction ${index} must leave copy/time controls unobstructed: ${JSON.stringify(row)}`)
    }
    if (row.receipt.width < 48 || row.receipt.height < 36) {
      throw new Error(`${label}: reaction ${index} must use the readable chip dimensions: ${JSON.stringify(row)}`)
    }
  })
}

function assertReceiptIdsMatchPersistedMessages(receipts, messages, label) {
  const receiptIds = receipts.map(receipt => receipt.messageId)
  const messageIds = messages.map(message => message.id)
  assertSameSet(receiptIds, messageIds, label)
  for (const message of messages) {
    if (message.agentPreset !== 'personal-assistant') {
      throw new Error(`${label}: persisted message did not run in the personal-assistant preset: ${JSON.stringify(message)}`)
    }
    if (message.source?.kind !== 'user' || typeof message.source.rpcId !== 'string' || message.source.rpcId === '') {
      throw new Error(`${label}: persisted message lacks trusted Web rpcId provenance: ${JSON.stringify(message)}`)
    }
  }
}

function assertSameSet(actual, expected, label) {
  const left = [...actual].sort()
  const right = [...expected].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label}: expected IDs ${JSON.stringify(right)}, got ${JSON.stringify(left)}`)
}

async function assertConversationTextAbsent(page, text, label) {
  const conversations = page.locator(`${conversationScrollSelector}:visible`)
  const count = await conversations.count()
  if (count > 1) throw new Error(`${label}: expected at most one visible conversation, got ${count}`)
  if (count === 0) return
  const transcriptNodes = conversations.nth(0).locator(`:scope > :not(${composerSeatSelector})`)
  if (await transcriptNodes.getByText(text, { exact: true }).count() > 0) {
    throw new Error(`${label}: unexpected transcript text ${JSON.stringify(text)}`)
  }
}

async function assertClipboardText(page, expected, label) {
  const actual = await page.evaluate(async () => navigator.clipboard.readText())
  if (actual !== expected) throw new Error(`${label}: expected clipboard ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

async function assertConversationStillOpen(page, label) {
  const conversation = await visibleConversationScroll(page, label, 15_000)
  await conversation.getByText(CALENDAR_MEMORY_USER_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  await conversation.getByText(CALENDAR_MEMORY_ASSISTANT_TEXT, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

async function writeProviderControl(value) {
  await mkdir(dirname(scriptedModelControl), { recursive: true })
  await writeFile(scriptedModelControl, `${JSON.stringify(value)}\n`, 'utf8')
}

async function waitForProviderLog(predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  let entries = []
  while (Date.now() <= deadline) {
    entries = await readProviderLog()
    const match = entries.find(predicate)
    if (match !== undefined) return match
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label}: scripted provider log entry did not appear; observed=${JSON.stringify(entries.slice(-10))}`)
}

async function readProviderLog() {
  if (!existsSync(scriptedModelLog)) return []
  const text = await readFile(scriptedModelLog, 'utf8')
  return text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
}

async function waitForPersistedUserMessages(text, expected, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let messages = []
  while (Date.now() <= deadline) {
    messages = await persistedUserMessages(text)
    if (messages.length === expected) return messages
    if (expected === 0) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`${label}: expected ${expected} persisted user messages for ${JSON.stringify(text)}, got ${messages.length}: ${JSON.stringify(messages)}`)
}

async function persistedUserMessages(text) {
  const messages = []
  for (const { header, events } of await readPersistedSessions(home)) {
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const messageText = (event.data?.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (messageText === text) messages.push({
        id: event.data.id,
        seq: event.seq,
        source: event.data.source,
        agentPreset: header.agentPreset,
        sessionId: header.id,
      })
    }
  }
  return messages.sort((a, b) => a.seq - b.seq)
}

function normalizeText(text) {
  return text.replace(/\u200b/gu, '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim()
}

async function assertNoDocumentOverflow(page, label) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    return {
      viewport: window.innerWidth,
      width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0),
    }
  })
  if (overflow.width > overflow.viewport + 1) {
    throw new Error(`${label}: document has horizontal overflow ${overflow.width}px > ${overflow.viewport}px`)
  }
}

async function stableBoxes(page, locators, label) {
  let last = ''
  let steady = 0
  let stable
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const boxes = []
    for (const locator of locators) {
      const box = await locator.boundingBox()
      if (box === null || box.width <= 0 || box.height <= 0) {
        stable = undefined
        break
      }
      boxes.push(box)
    }
    if (boxes.length === locators.length) {
      const key = boxes.map(box => [box.x, box.y, box.width, box.height].map(value => Math.round(value)).join(',')).join('|')
      stable = boxes
      steady = key === last ? steady + 1 : 0
      if (steady >= 2) return boxes
      last = key
    }
    await page.waitForTimeout(50)
  }
  throw new Error(`${label}: layout did not settle${stable === undefined ? '' : `; last boxes were ${JSON.stringify(stable)}`}`)
}

function assertInViewport(box, viewport, label) {
  const left = box.x
  const top = box.y
  const right = box.x + box.width
  const bottom = box.y + box.height
  if (left < -1 || top < -1 || right > viewport.width + 1 || bottom > viewport.height + 1) {
    throw new Error(`${label} is outside the viewport: ${JSON.stringify({ left, top, right, bottom, viewport })}`)
  }
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

async function panelShot(page, name) {
  await (await visibleAssistantPanel(page, name)).screenshot({ path: join(browserShots, `assistant-panel-${name}.png`) })
}

async function retainFixtureLayoutScreenshot(page) {
  await mkdir(retainedShotRoot, { recursive: true })
  await page.screenshot({ path: retainedFixtureShot, fullPage: false })
}

async function saveDiagnosticScreenshot(page) {
  await mkdir(browserShots, { recursive: true })
  try {
    await page.screenshot({ path: join(browserShots, 'assistant-panel-failure.png'), fullPage: true })
  } catch {
    // Best-effort local diagnostic: screenshot failure must not mask the assertion error.
  }
}

function sanitizedError(error) {
  if (!(error instanceof Error)) return new Error(sanitize(String(error)))
  const sanitized = new Error(sanitize(error.message))
  sanitized.name = error.name
  if (error.stack !== undefined) sanitized.stack = sanitize(error.stack)
  return sanitized
}

function dshCommand() {
  return process.platform === 'win32' ? join(root, 'node_modules', '.bin', 'dsh.cmd') : join(root, 'node_modules', '.bin', 'dsh')
}

function stopProcessTree(pid) {
  if (process.platform !== 'win32') {
    process.kill(pid)
    return
  }
  const script = [
    `$rootPid = ${pid}`,
    '$queue = [System.Collections.Generic.Queue[int]]::new()',
    '$all = [System.Collections.Generic.List[int]]::new()',
    '$queue.Enqueue($rootPid)',
    'while ($queue.Count -gt 0) {',
    '  $current = $queue.Dequeue()',
    '  $all.Add($current)',
    '  Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" | ForEach-Object { $queue.Enqueue([int]$_.ProcessId) }',
    '}',
    '$all | Sort-Object -Descending -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
  ].join('; ')
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
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

function assertIncludes(text, expected) {
  if (!text.includes(expected)) throw new Error(`Expected config to include ${expected}`)
}

function assertExcludes(text, unexpected) {
  if (text.includes(unexpected)) throw new Error(`Expected config to omit ${unexpected}`)
}

function assertDisabled(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (!new RegExp(`- id: ${escaped}\\r?\\n(?:  .+\\r?\\n)*  disabled: true`, 'u').test(text)) {
    throw new Error(`Expected ${id} to be disabled`)
  }
}

function sanitize(text) {
  return text
    .replace(/([?&]token=)[^&\s)]+/giu, '$1[redacted]')
    .replace(/http:\/\/(?:127\.0\.0\.1|localhost|[0-9.]+):\d+\/\S*/giu, 'http://127.0.0.1:[port]/[redacted]')
    .replace(/[A-Za-z0-9_=-]{24,}/gu, '[redacted]')
}
