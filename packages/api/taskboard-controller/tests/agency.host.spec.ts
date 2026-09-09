import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AgencyCopilotSessionId } from '@deepseek-ai/dsh-taskboard'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { AgencyCopilotHost, AgencyCopilotLaunchError, AgencyCopilotUnavailableError } from '../src/agency.ts'

const AGENCY = 'C:\\Agency\\agency.exe'
const TERMINAL = 'C:\\WindowsApps\\wt.exe'
const REPO = 'Q:\\repo'

function subprocess(stdout: string | string[], outcome = { exitCode: 0, signal: null }) {
  const specs: SubprocessSpawnSpec[] = []
  const service = {
    resolveExecutable: vi.fn(async (
      command: string,
      _environment?: Readonly<Record<string, string>>,
      _signal?: AbortSignal,
    ) => command === 'agency.exe' ? AGENCY : TERMINAL),
    spawn: vi.fn((spec: SubprocessSpawnSpec) => {
      specs.push(spec)
      const text = typeof stdout === 'string' ? stdout : stdout.shift()!
      return {
        pid: 7,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve(outcome),
        terminate: () => {},
        waitForExit: () => Promise.resolve(true),
      } satisfies SubprocessHandle
    }),
  }
  return { service, specs }
}

function broker() {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args: [...args], options })
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn(() => child)
    queueMicrotask(() => { child.emit('spawn') })
    return child
  })
  return { calls, spawn }
}

function host(output: string | string[]) {
  const ctx = new Context()
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { PATH: 'C:\\ProcessBin', PATHEXT: '.EXE', USERPROFILE: 'C:\\User' } },
    { source: 'project-env', path: 'Q:\\repo\\.env', values: { PATH: 'Q:\\poison', PROJECT_ONLY: 'secret' } },
  ]))
  const fake = subprocess(output)
  ctx.provide('subprocess', fake.service as never)
  const launches = broker()
  return {
    ctx,
    fake,
    launches,
    agency: new AgencyCopilotHost(ctx, { platform: 'win32', spawnBroker: launches.spawn }),
  }
}

describe('AgencyCopilotHost', () => {
  it('reads bounded shell-free Agency JSON and returns only exact requested identities', async () => {
    const wanted = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const other = '2eb3dbf2-8b82-4863-b505-520708dcce80'
    const b = host(JSON.stringify({ sessions: [
      { session_id: wanted, status: 'idle', folder: REPO },
      { session_id: other, status: 'in_use', folder: 'Q:\\other' },
    ] }))
    const result = await b.agency.inspect([wanted], new AbortController().signal)
    expect([...result.sessions.values()]).toEqual([{ sessionId: wanted, status: 'idle', folder: REPO }])
    expect(result.complete).toBe(true)
    expect(b.fake.specs).toHaveLength(1)
    expect(b.fake.service.resolveExecutable).toHaveBeenCalledWith('agency.exe', expect.objectContaining({
      PATH: 'C:\\ProcessBin', PATHEXT: '.EXE', USERPROFILE: 'C:\\User',
    }), expect.any(AbortSignal))
    expect(b.fake.service.resolveExecutable.mock.calls[0]?.[1]).not.toHaveProperty('PROJECT_ONLY')
    expect(b.fake.specs[0]).toMatchObject({
      argv: [AGENCY, 'hub', 'list-local-sessions', '--json', '--limit', '100'],
      cwd: 'C:\\Agency',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    })
  })

  it('rejects malformed or unsupported Agency status data without exposing it', async () => {
    const b = host('{not json')
    await expect(b.agency.inspect(
      [AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')],
      new AbortController().signal,
    )).rejects.toBeInstanceOf(AgencyCopilotUnavailableError)
  })

  it('lists all bounded pages with validated optional summaries and statuses', async () => {
    const first = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const second = AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80')
    const b = host([
      JSON.stringify({ sessions: [{ session_id: first, folder: REPO, summary: 'Inspect logs', status: 'idle' }], next_cursor: 'page two' }),
      JSON.stringify({ sessions: [{ session_id: second, folder: REPO, summary: null, status: 'in_use' }], next_cursor: null }),
    ])
    const result = await b.agency.list(new AbortController().signal)
    expect([...result.sessions.values()]).toEqual([
      { sessionId: first, folder: REPO, summary: 'Inspect logs', status: 'idle' },
      { sessionId: second, folder: REPO, status: 'in_use' },
    ])
    expect(result.complete).toBe(true)
    expect(b.fake.specs.map(spec => spec.argv)).toEqual([
      [AGENCY, 'hub', 'list-local-sessions', '--json', '--limit', '100'],
      [AGENCY, 'hub', 'list-local-sessions', '--json', '--limit', '100', '--cursor', 'page two'],
    ])
    expect(b.launches.calls).toEqual([])
  })

  it('marks continued pages incomplete after ten reads instead of claiming absence', async () => {
    const b = host(JSON.stringify({ sessions: [], next_cursor: 'more' }))
    const result = await b.agency.list(new AbortController().signal)
    expect(result.complete).toBe(false)
    expect(result.sessions.size).toBe(0)
    expect(b.fake.specs).toHaveLength(10)
  })

  it.each([
    '{not json',
    JSON.stringify({ sessions: [{ session_id: 'not-a-uuid', status: 'idle' }] }),
    JSON.stringify({ sessions: [{ session_id: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491', status: 'running' }] }),
    JSON.stringify({ sessions: [{ session_id: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491', status: 'idle', summary: 1 }] }),
    JSON.stringify({ sessions: [{ session_id: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491', status: 'idle', summary: 'x'.repeat(4097) }] }),
  ])('rejects unsupported discovery data without returning partial success (%#)', async (output) => {
    const b = host(output)
    await expect(b.agency.list(new AbortController().signal)).rejects.toBeInstanceOf(AgencyCopilotUnavailableError)
    expect(b.launches.calls).toEqual([])
  })

  it('rejects unavailable discovery rather than reporting no sessions', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    b.fake.service.resolveExecutable.mockRejectedValue(new Error('not installed'))
    await expect(b.agency.list(new AbortController().signal)).rejects.toBeInstanceOf(AgencyCopilotUnavailableError)
    expect(b.fake.specs).toEqual([])
  })

  it('cancels before a read and after executable resolution without spawning', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled'))
    await expect(b.agency.list(cancelled.signal)).rejects.toBe(cancelled.signal.reason)
    expect(b.fake.service.resolveExecutable).not.toHaveBeenCalled()
    const pending = new AbortController()
    b.fake.service.resolveExecutable.mockImplementation(async () => {
      pending.abort(new Error('cancelled during resolution'))
      return AGENCY
    })
    await expect(b.agency.list(pending.signal)).rejects.toThrow('cancelled during resolution')
    expect(b.fake.specs).toEqual([])
  })

  it('propagates cancellation during an Agency page read', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const pending = new AbortController()
    const spawn = b.fake.service.spawn.getMockImplementation()!
    b.fake.service.spawn.mockImplementation((spec) => {
      pending.abort(new Error('cancelled during read'))
      expect(spec.signal?.aborted).toBe(true)
      return spawn(spec)
    })
    await expect(b.agency.list(pending.signal)).rejects.toThrow('cancelled during read')
  })

  it('submits the initial prompt for a fresh session and resumes without resubmitting it', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const id = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const signal = new AbortController().signal
    await b.agency.launchNew(REPO, id, 'Investigate the failure\n\nKeep the existing behavior.', signal)
    await b.agency.resume(REPO, id, signal)
    expect(b.launches.calls).toHaveLength(2)
    const prefix = [
      '--window', 'new', 'new-tab', '--startingDirectory', REPO,
      '--title', 'Agency Copilot', '--suppressApplicationTitle', AGENCY, 'copilot',
    ]
    expect(b.launches.calls[0]).toMatchObject({
      command: TERMINAL,
      args: [...prefix, '--session-id', id, '--interactive', 'Investigate the failure\n\nKeep the existing behavior.'],
      options: { shell: false, stdio: 'ignore', windowsHide: false },
    })
    expect(b.launches.calls[1]?.args).toEqual([...prefix, '--resume=' + id])
  })

  it('escapes Windows Terminal command delimiters in task content and Workspace paths', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const id = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const prompt = 'Keep "quotes"; $variables & pipes | literal\nPaths: Q:\\repo\\; ; new-tab'
    await b.agency.launchNew('Q:\\repo;with spaces', id, prompt, new AbortController().signal)

    expect(b.launches.calls[0]?.args).toEqual([
      '--window', 'new', 'new-tab', '--startingDirectory', 'Q:\\repo\\;with spaces',
      '--title', 'Agency Copilot', '--suppressApplicationTitle', AGENCY, 'copilot',
      '--session-id', id, '--interactive',
      'Keep \\"quotes\\"\\; $variables & pipes | literal\nPaths: Q:\\repo\\\\; \\; new-tab',
    ])
  })

  it.each([
    ['a"b', '"a\\"b"'],
    ['a\tb', '"a\tb"'],
    ['a b\\', 'a b\\\\'],
    ['a\\\\"b', '"a\\\\\\\\\\"b"'],
  ])('preserves %j through Windows Terminal command-line reconstruction', async (prompt, expected) => {
    const b = host(JSON.stringify({ sessions: [] }))
    await b.agency.launchNew(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'), prompt,
      new AbortController().signal)
    expect(b.launches.calls[0]?.args.at(-1)).toBe(expected)
  })

  it('rejects an oversized Windows command line without opening a terminal or truncating the prompt', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    await expect(b.agency.launchNew(
      REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'), 'x'.repeat(32_767),
      new AbortController().signal,
    )).rejects.toThrow('Task prompt exceeds the Windows command-line limit')
    expect(b.launches.calls).toHaveLength(0)
  })

  it('accepts the standard Windows Terminal app execution alias when stat resolution is denied', async () => {
    const localAppData = 'C:\\Users\\Test\\AppData\\Local'
    const alias = localAppData + '\\Microsoft\\WindowsApps\\wt.exe'
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: {
        PATH: 'C:\\ProcessBin;' + localAppData + '\\Microsoft\\WindowsApps',
        PATHEXT: '.EXE',
        LOCALAPPDATA: localAppData,
        PROGRAMFILES: 'C:\\Program Files',
      },
    }]))
    const fake = subprocess(JSON.stringify({ sessions: [] }))
    fake.service.resolveExecutable.mockImplementation(async (command) => {
      if (command === 'agency.exe') return AGENCY
      throw new Error('EACCES while following app execution alias')
    })
    ctx.provide('subprocess', fake.service as never)
    const launches = broker()
    const aliasFileSystem = {
      lstat: vi.fn(async () => ({ isSymbolicLink: () => true })),
      access: vi.fn(async () => {}),
      readlink: vi.fn(async () =>
        'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\\wt.exe'),
    }
    const agency = new AgencyCopilotHost(ctx, {
      platform: 'win32', spawnBroker: launches.spawn, terminalAliasFileSystem: aliasFileSystem,
    })
    const id = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')

    await agency.launchNew(REPO, id, 'Investigate the failure', new AbortController().signal)

    expect(aliasFileSystem.lstat).toHaveBeenCalledWith(alias)
    expect(aliasFileSystem.access).toHaveBeenCalledWith(alias, expect.any(Number))
    expect(launches.calls[0]?.command).toBe(alias)
  })

  it('rejects an app execution alias redirected outside a Windows Terminal package', async () => {
    const localAppData = 'C:\\Users\\Test\\AppData\\Local'
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{
      source: 'process',
      values: {
        PATH: localAppData + '\\Microsoft\\WindowsApps',
        PATHEXT: '.EXE',
        LOCALAPPDATA: localAppData,
        PROGRAMFILES: 'C:\\Program Files',
      },
    }]))
    const fake = subprocess(JSON.stringify({ sessions: [] }))
    fake.service.resolveExecutable.mockImplementation(async (command) => {
      if (command === 'agency.exe') return AGENCY
      throw new Error('EACCES while following app execution alias')
    })
    ctx.provide('subprocess', fake.service as never)
    const agency = new AgencyCopilotHost(ctx, {
      platform: 'win32',
      terminalAliasFileSystem: {
        lstat: async () => ({ isSymbolicLink: () => true }),
        access: async () => {},
        readlink: async () => 'C:\\Untrusted\\wt.exe',
      },
    })

    await expect(agency.preflight(new AbortController().signal))
      .rejects.toBeInstanceOf(AgencyCopilotLaunchError)
  })
})
