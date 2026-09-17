#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { throws } from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const setupScript = join(root, 'scripts', 'setup-personal-assistant.mjs')
const smokeId = randomUUID()
const base = join(root, '.test-tmp', `profile-smoke-${smokeId}`)
const home = join(base, 'dsh-home')
const workspace = join(base, 'workspace')
const memoryRoot = join(workspace, 'memory')
const calendarPath = join(workspace, 'calendar.ics')
const profile = `wa-smoke-${smokeId.slice(0, 8)}`

try {
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
  const setup = run('pnpm', [
    'run',
    'setup:profile',
    '--',
    '--home', home,
    '--profile', profile,
    '--workspace', workspace,
    '--memory-root', memoryRoot,
    '--calendar-file', calendarPath,
    '--owner-id', 'smoke',
    '--provider', 'deepseek-official',
    '--model', 'deepseek-v4-flash',
    '--time-zone', 'UTC',
    '--cron', '0 9 * * *',
    '--demo-fixture',
  ])
  assertIncludes(setup.stdout, '--port 3081')
  const dump = run(dshCommand(), ['--profile', profile, '--dump-config'], { env: { ...process.env, DSH_HOME: home }, capture: true }).stdout
  assertIncludes(dump, 'name: \'@deepseek-ai/dsh-wa-briefing\'')
  assertIncludes(dump, 'default: personal-assistant')
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
  await smokeWeb(home)
  console.log('Profile smoke passed: setup arguments, deployment config, config dump, and Web HTTP response succeeded.')
} finally {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
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
    cwd: root,
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

async function smokeWeb(dshHome) {
  const invocation = commandInvocation(dshCommand(), ['--profile', profile, '--no-open', '--host', '127.0.0.1', '--port', '0'])
  const child = spawn(invocation.command, invocation.args, {
    cwd: workspace,
    env: { ...process.env, DSH_HOME: dshHome },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let stopped = false
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    const port = await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error(`Web server did not print a localhost URL. Output:\n${sanitize(output)}`)), 20_000)
      const onData = chunk => {
        output += chunk.toString()
        const match = /http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)
        if (match?.[1] !== undefined) {
          clearTimeout(timer)
          resolvePort(match[1])
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`Web server exited early with ${code}. Output:\n${sanitize(output)}`))
      })
    })
    const response = await fetch(`http://127.0.0.1:${port}/`)
    if (!(response.ok || response.status === 401)) throw new Error(`Web server returned HTTP ${response.status}`)
  } finally {
    if (child.pid !== undefined && child.exitCode === null) {
      stopped = true
      stopProcessTree(child.pid)
      await exited
    }
    if (!stopped) await exited
  }
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
  return text.replace(/http:\/\/127\.0\.0\.1:\d+\/\S*/gu, 'http://127.0.0.1:[port]/[redacted]').replace(/[A-Za-z0-9_=-]{24,}/gu, '[redacted]')
}
