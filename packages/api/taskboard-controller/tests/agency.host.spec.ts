import { EventEmitter } from 'node:events'
import { spawn as nativeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { AgencyCopilotSessionId } from '@deepseek-ai/dsh-taskboard'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { AgencyCopilotHost, AgencyCopilotLaunchError, AgencyCopilotUnavailableError } from '../src/agency.ts'

const AGENCY = 'C:\\Agency\\agency.exe'
const TERMINAL = 'C:\\WindowsApps\\wt.exe'
const REPO = 'Q:\\repo'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(nativeSpawn).mockReset()
})

function subprocess(
  stdout: string | string[],
  outcome: Awaited<SubprocessHandle['done']> = { exitCode: 0, signal: null },
) {
  const specs: SubprocessSpawnSpec[] = []
  const service = {
    resolveExecutable: vi.fn(async (
      command: string,
      _environment?: Readonly<Record<string, string>>,
      _signal?: AbortSignal,
    ): Promise<string> => command === 'agency.exe' ? AGENCY : TERMINAL),
    spawn: vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
      specs.push(spec)
      const text = typeof stdout === 'string' ? stdout : stdout.shift()!
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
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

function aliasHost(environment: Record<string, string>) {
  const ctx = new Context()
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]))
  const fake = subprocess(JSON.stringify({ sessions: [] }))
  fake.service.resolveExecutable.mockImplementation(async (command) => {
    if (command === 'agency.exe') return AGENCY
    throw new Error('fixture app execution alias resolution failure')
  })
  ctx.provide('subprocess', fake.service as never)
  const launches = broker()
  const fileSystem = {
    lstat: vi.fn(async () => ({ isSymbolicLink: (): boolean => true })),
    access: vi.fn(async () => {}),
    readlink: vi.fn(async () =>
      'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.24.11911.0_x64__8wekyb3d8bbwe\\wt.exe'),
  }
  const agency = new AgencyCopilotHost(ctx, {
    platform: 'win32', spawnBroker: launches.spawn, terminalAliasFileSystem: fileSystem,
  })
  return { agency, fake, launches, fileSystem }
}

describe('AgencyCopilotHost', () => {
  it('uses the actual platform when the Host does not override it', () => {
    const b = host('{}')
    const agency = new AgencyCopilotHost(b.ctx)
    expect(agency.nativeLaunchSupported()).toBe(process.platform === 'win32')
  })

  it('shares only process-origin environment with the SDK and detaches each returned copy', () => {
    const b = host('{}')
    const environment = b.agency.copilotSdkEnvironment()
    expect(environment).toMatchObject({ PATH: 'C:\\ProcessBin', USERPROFILE: 'C:\\User' })
    expect(environment).not.toHaveProperty('PROJECT_ONLY')
    environment.PATH = 'fixture mutation'
    expect(b.agency.copilotSdkEnvironment().PATH).toBe('C:\\ProcessBin')
    expect(b.fake.service.resolveExecutable).not.toHaveBeenCalled()
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })

  it('refuses SDK environment handoff on unsupported Agency platforms', () => {
    const b = host('{}')
    const agency = new AgencyCopilotHost(b.ctx, { platform: 'linux' })
    expect(() => agency.copilotSdkEnvironment()).toThrow(AgencyCopilotUnavailableError)
  })

  it('returns an empty exact-id query without requiring a subprocess service', async () => {
    const ctx = new Context()
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]))
    const agency = new AgencyCopilotHost(ctx, { platform: 'win32' })
    expect(await agency.inspect([], new AbortController().signal)).toEqual({ sessions: new Map(), complete: true })
    await expect(agency.list(new AbortController().signal)).rejects.toThrow('Agency Copilot integration is unavailable')
    expect(nativeSpawn).not.toHaveBeenCalled()
  })

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

  it.each([
    { exitCode: 1, signal: null },
    { exitCode: null, signal: 'SIGTERM' },
  ] satisfies Awaited<SubprocessHandle['done']>[])('rejects failed discovery completion (%#)', async (outcome) => {
    const b = host(JSON.stringify({ sessions: [] }))
    const spawn = b.fake.service.spawn.getMockImplementation()!
    b.fake.service.spawn.mockImplementation(spec => ({ ...spawn(spec), done: Promise.resolve(outcome) }))
    await expect(b.agency.list(new AbortController().signal)).rejects.toThrow('Agency Copilot status is unavailable')
    expect(b.launches.calls).toEqual([])
  })

  it('rejects a page whose deadline expires even when the child reports normal exit', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const deadline = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
    const spawn = b.fake.service.spawn.getMockImplementation()!
    b.fake.service.spawn.mockImplementation((spec) => {
      deadline.abort()
      return spawn(spec)
    })
    await expect(b.agency.list(new AbortController().signal)).rejects.toThrow('Agency Copilot status is unavailable')
    expect(b.fake.specs[0]?.signal?.aborted).toBe(true)
  })

  it.each(['missing-stdout', 'lossy-stdout', 'lossy-stderr'])('rejects unsafe discovery capture: %s', async (kind) => {
    const b = host(JSON.stringify({ sessions: [] }))
    const spawn = b.fake.service.spawn.getMockImplementation()!
    b.fake.service.spawn.mockImplementation((spec) => {
      const handle = spawn(spec)
      return {
        ...handle,
        collected: {
          ...(kind === 'missing-stdout' ? {} : {
            stdout: { readFrom: () => ({ text: '{"sessions":[]}', nextOffset: 15, lossy: kind === 'lossy-stdout' }) },
          }),
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: kind === 'lossy-stderr' }) },
        },
      }
    })
    await expect(b.agency.list(new AbortController().signal))
      .rejects.toThrow('Agency Copilot status output exceeded its safety bound')
  })

  it('accepts bounded stdout when the subprocess exposes no stderr reader', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const spawn = b.fake.service.spawn.getMockImplementation()!
    b.fake.service.spawn.mockImplementation((spec) => {
      const handle = spawn(spec)
      const collected = { ...handle.collected }
      delete collected.stderr
      return { ...handle, collected }
    })
    expect(await b.agency.list(new AbortController().signal)).toEqual({ sessions: new Map(), complete: true })
  })

  it('refuses terminal resume on an unsupported platform before resolving executables', async () => {
    const b = host('{}')
    const agency = new AgencyCopilotHost(b.ctx, { platform: 'linux', spawnBroker: b.launches.spawn })
    await expect(agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)).rejects.toThrow('Agency Copilot terminal launch requires Windows')
    expect(b.fake.service.resolveExecutable).not.toHaveBeenCalled()
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })

  it('awaits broker acceptance when using the default child-process spawner', async () => {
    const b = host('{}')
    const child = new EventEmitter() as ChildProcess
    const unref = vi.fn(() => child)
    child.unref = unref
    vi.mocked(nativeSpawn).mockReturnValueOnce(child)
    const agency = new AgencyCopilotHost(b.ctx, { platform: 'win32' })
    let accepted = false
    const resuming = agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal).then(() => { accepted = true })
    await vi.waitFor(() => { expect(nativeSpawn).toHaveBeenCalledOnce() })
    expect(accepted).toBe(false)
    expect(child.listenerCount('error')).toBe(1)
    child.emit('spawn')
    await resuming
    expect(unref).toHaveBeenCalledOnce()
    expect(child.listenerCount('error')).toBe(0)
    expect(nativeSpawn).toHaveBeenCalledWith(TERMINAL, expect.any(Array), {
      env: agency.copilotSdkEnvironment(), shell: false, stdio: 'ignore', windowsHide: false,
    })
  })

  it('reports broker startup errors without exposing their diagnostics', async () => {
    const b = host('{}')
    const child = new EventEmitter() as ChildProcess
    const unref = vi.fn(() => child)
    child.unref = unref
    b.launches.spawn.mockReturnValueOnce(child)
    const resuming = b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)
    await vi.waitFor(() => { expect(child.listenerCount('error')).toBe(1) })
    child.emit('error', new Error('fixture private broker diagnostic'))
    await expect(resuming).rejects.toThrow('Agency Copilot terminal launch failed')
    expect(unref).not.toHaveBeenCalled()
  })

  it('cancels terminal resume after executable resolution without starting a broker', async () => {
    const b = host('{}')
    const controller = new AbortController()
    b.fake.service.resolveExecutable.mockImplementation(async (command) => {
      if (command === 'agency.exe') controller.abort(new Error('fixture cancelled terminal launch'))
      return command === 'agency.exe' ? AGENCY : TERMINAL
    })
    await expect(b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      controller.signal)).rejects.toBe(controller.signal.reason)
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })

  it('opens the exact existing conversation without submitting a prompt', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const id = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const signal = new AbortController().signal
    await b.agency.resume(REPO, id, signal)
    expect(b.launches.calls).toHaveLength(1)
    const prefix = [
      '--window', 'new', 'new-tab', '--startingDirectory', REPO,
      '--title', 'Agency Copilot', '--suppressApplicationTitle', AGENCY, 'copilot',
    ]
    expect(b.launches.calls[0]).toMatchObject({
      command: TERMINAL,
      args: [...prefix, '--resume=' + id],
      options: { shell: false, stdio: 'ignore', windowsHide: false },
    })
  })

  it('escapes Windows Terminal command delimiters in Workspace paths', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const id = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    await b.agency.resume('Q:\\repo;with spaces', id, new AbortController().signal)

    expect(b.launches.calls[0]?.args).toEqual([
      '--window', 'new', 'new-tab', '--startingDirectory', 'Q:\\repo\\;with spaces',
      '--title', 'Agency Copilot', '--suppressApplicationTitle', AGENCY, 'copilot',
      '--resume=' + id,
    ])
  })

  it('preserves executable paths containing spaces through Windows Terminal reconstruction', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    const agency = 'C:\\Program Files\\Agency\\agency.exe'
    b.fake.service.resolveExecutable.mockImplementation(async command => command === 'agency.exe' ? agency : TERMINAL)
    await b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)
    expect(b.launches.calls[0]?.args).toContain(agency)
  })

  it('rejects an oversized Windows command line without opening a terminal or truncating the path', async () => {
    const b = host(JSON.stringify({ sessions: [] }))
    await expect(b.agency.resume(
      'Q:\\' + 'x'.repeat(32_767), AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal,
    )).rejects.toThrow('Agency terminal command exceeds the Windows command-line limit')
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

    await agency.resume(REPO, id, new AbortController().signal)

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

    await expect(agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'), new AbortController().signal))
      .rejects.toBeInstanceOf(AgencyCopilotLaunchError)
  })

  it.each([
    'missing-local-app-data', 'missing-program-files', 'missing-path',
    'relative-local-app-data', 'relative-program-files', 'alias-directory-not-on-path',
  ])('rejects an unavailable Windows Terminal alias location: %s', async (kind) => {
    const environment: Record<string, string> = {
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      PROGRAMFILES: 'C:\\Program Files',
      PATH: 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps',
    }
    switch (kind) {
      case 'missing-local-app-data': delete environment.LOCALAPPDATA; break
      case 'missing-program-files': delete environment.PROGRAMFILES; break
      case 'missing-path': delete environment.PATH; break
      case 'relative-local-app-data': environment.LOCALAPPDATA = 'relative'; break
      case 'relative-program-files': environment.PROGRAMFILES = 'relative'; break
      default: environment.PATH = 'C:\\Unrelated'; break
    }
    const b = aliasHost(environment)
    await expect(b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)).rejects.toThrow('Agency Copilot terminal launch failed')
    expect(b.fileSystem.lstat).not.toHaveBeenCalled()
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })

  it('does not accept a regular file as a Windows Terminal app execution alias', async () => {
    const b = aliasHost({
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files',
      PATH: 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps',
    })
    b.fileSystem.lstat.mockResolvedValue({ isSymbolicLink: () => false })
    await expect(b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)).rejects.toThrow('Agency Copilot terminal launch failed')
    expect(b.fileSystem.access).not.toHaveBeenCalled()
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })

  it.each([
    'relative\\wt.exe',
    'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.0_x64__8wekyb3d8bbwe\\other.exe',
    'C:\\Untrusted\\Microsoft.WindowsTerminal_1.0_x64__8wekyb3d8bbwe\\wt.exe',
    'C:\\Program Files\\WindowsApps\\Unknown_1.0_x64__8wekyb3d8bbwe\\wt.exe',
  ])('rejects an unsupported Windows Terminal alias target: %s', async (target) => {
    const b = aliasHost({
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files',
      PATH: 'C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps',
    })
    b.fileSystem.readlink.mockResolvedValue(target)
    await expect(b.agency.resume(REPO, AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
      new AbortController().signal)).rejects.toThrow('Agency Copilot terminal launch failed')
    expect(b.launches.spawn).not.toHaveBeenCalled()
  })
})
