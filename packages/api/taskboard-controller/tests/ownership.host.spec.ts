/** Kernel locks use atomically allocated repository-local roots, never real DSH homes. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join, resolve, toNamespacedPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireTaskboardOwnership, createTaskboardOwnershipHost,
  type TaskboardOwnership, type TaskboardOwnershipHost, type TaskboardOwnershipPlatform, type TaskboardWindowsLockApi,
} from '../src/runtime/ownership.ts'

const owners: TaskboardOwnership[] = []
const roots: string[] = []
const children: { child: ChildProcessWithoutNullStreams; done: Promise<void> }[] = []
const fixture = fileURLToPath(new URL('./ownership-process.fixture.ts', import.meta.url))

async function location() {
  const root = await mkdtemp(resolve('.taskboard-ownership-'))
  roots.push(root)
  const lockDirectory = join(root, 'execution')
  return { root, lockDirectory, lockFile: join(lockDirectory, 'owner.lock') }
}

function options(lockDirectory: string) {
  return { lockDirectory, updateMs: 1_000, maxAcquireAttempts: 3, onCompromised: vi.fn(), onCallbackError: vi.fn() }
}

function participant(lockDirectory: string) {
  const child = spawn(process.execPath, [fixture, lockDirectory], {
    stdio: 'pipe', shell: false, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => /^(systemroot|windir|path|pathext|home|userprofile|temp|tmp)$/iu.test(key))),
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', () => { resolve() })
  })
  children.push({ child, done })
  const waitFor = async (text: string): Promise<void> => {
    if (stdout.includes(text)) return
    await new Promise<void>((resolve, reject) => {
      const inspect = (): void => {
        if (!stdout.includes(text)) return
        detach()
        resolve()
      }
      const ended = (): void => { detach(); reject(new Error(`Lock participant exited before ${text}: ${stderr}`)) }
      const failed = (error: Error): void => { detach(); reject(error) }
      function detach(): void {
        child.stdout.off('data', inspect)
        child.off('close', ended)
        child.off('error', failed)
      }
      child.stdout.on('data', inspect)
      child.once('close', ended)
      child.once('error', failed)
    })
  }
  return { child, done, waitFor, stdout: () => stdout, stderr: () => stderr }
}

function lifecycle() {
  const verify = vi.fn(async () => true)
  const close = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ verify, close }))
  const timers = new Set<() => void>()
  const schedule = vi.fn((callback: () => void) => {
    timers.add(callback)
    return () => { timers.delete(callback) }
  })
  const host: TaskboardOwnershipHost = { acquire, schedule }
  return {
    host, acquire, verify, close, schedule, timers,
    tick: () => {
      for (const timer of [...timers]) { timers.delete(timer); timer() }
    },
  }
}

function platform(kind = 'linux') {
  const file = {
    fd: 17,
    stat: vi.fn(async () => ({ ino: 9n, dev: 3n })),
    close: vi.fn(async () => {}),
  }
  const openFile = vi.fn(async () => file)
  const statFile = vi.fn(async () => ({ ino: 9n, dev: 3n }))
  const flock = vi.fn(async () => {})
  const windowsApi = {
    createFile: vi.fn<TaskboardWindowsLockApi['createFile']>(() => 15),
    closeHandle: vi.fn(() => 1),
    getLastError: vi.fn(() => 32),
  }
  const windows = vi.fn(async () => windowsApi)
  const io: TaskboardOwnershipPlatform = {
    platform: kind, open: openFile,
    stat: statFile, flock, windows,
  }
  return { host: createTaskboardOwnershipHost(io), io, file, openFile, statFile, flock, windows, windowsApi }
}

afterEach(async () => {
  for (const { child } of children) child.stdin.end()
  await Promise.all(children.splice(0).map(async ({ child, done }) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
  }))
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Taskboard execution kernel ownership', () => {
  it('excludes independent processes and reuses the permanent file after release', async () => {
    const { root, lockDirectory, lockFile } = await location()
    const committed = join(root, 'session.v3.jsonl')
    await writeFile(committed, '{"existing":"session"}\n', { flag: 'wx' })
    const first = participant(lockDirectory)
    await first.waitFor('OWNED\n')
    const contenders = [participant(lockDirectory), participant(lockDirectory)]
    await Promise.all(contenders.map(async (other) => {
      await other.done
      expect(other.child.signalCode, other.stderr()).toBeNull()
      expect(other.child.exitCode, other.stderr()).toBe(0)
      expect(other.stdout()).toBe('LOCKED\n')
    }))
    first.child.stdin.end()
    await first.done
    expect(first.child.signalCode, first.stderr()).toBeNull()
    expect(first.child.exitCode, first.stderr()).toBe(0)
    expect(first.stdout()).toBe('OWNED\nRELEASED\n')
    expect((await stat(lockFile)).isFile()).toBe(true)
    const next = participant(lockDirectory)
    await next.waitFor('OWNED\n')
    next.child.stdin.end()
    await next.done
    expect(next.child.signalCode, next.stderr()).toBeNull()
    expect(next.child.exitCode, next.stderr()).toBe(0)
    expect(await readFile(committed, 'utf8')).toBe('{"existing":"session"}\n')
  })

  it('admits a successor immediately after a holder is killed without running disposal', async () => {
    const { lockDirectory, lockFile } = await location()
    const first = participant(lockDirectory)
    await first.waitFor('OWNED\n')
    expect(first.child.kill('SIGKILL')).toBe(true)
    await first.done
    expect(first.child.signalCode).toBe('SIGKILL')
    expect(first.stdout()).toBe('OWNED\n')
    expect((await stat(lockFile)).isFile()).toBe(true)
    const successor = participant(lockDirectory)
    await successor.waitFor('OWNED\n')
    successor.child.stdin.end()
    await successor.done
    expect(successor.child.signalCode, successor.stderr()).toBeNull()
    expect(successor.child.exitCode, successor.stderr()).toBe(0)
  })

  it('never truncates lock-file contents or steals a live lock based on its age', async () => {
    const { lockDirectory, lockFile } = await location()
    await mkdir(lockDirectory)
    await writeFile(lockFile, 'existing lock-file bytes', { flag: 'wx' })
    await utimes(lockFile, new Date(0), new Date(0))
    const owner = await acquireTaskboardOwnership(options(lockDirectory))
    owners.push(owner)
    await expect(acquireTaskboardOwnership(options(lockDirectory))).rejects.toHaveProperty('code', 'ELOCKED')
    expect(await owner.check()).toBe(true)
    await owner.dispose()
    expect(await readFile(lockFile, 'utf8')).toBe('existing lock-file bytes')
  })

  // Windows sharing denies replacement; POSIX detects external removal through inode identity.
  it.skipIf(process.platform === 'win32')('revokes ownership when its live POSIX inode is replaced', async () => {
    const { lockDirectory, lockFile } = await location()
    const opts = options(lockDirectory)
    const owner = await acquireTaskboardOwnership(opts)
    owners.push(owner)
    await unlink(lockFile)
    await writeFile(lockFile, 'replacement')
    expect(await owner.check()).toBe(false)
    expect(opts.onCompromised).toHaveBeenCalledWith(expect.objectContaining({ code: 'ECOMPROMISED' }))
    await owner.dispose()
    expect(await readFile(lockFile, 'utf8')).toBe('replacement')
  })

  it.skipIf(process.platform !== 'win32')('denies deletion of a held Windows lock file', async () => {
    const { lockDirectory, lockFile } = await location()
    const owner = await acquireTaskboardOwnership(options(lockDirectory))
    owners.push(owner)
    await expect(unlink(lockFile)).rejects.toThrow()
    expect(await owner.check()).toBe(true)
  })
})

describe('Taskboard ownership lifecycle', () => {
  it('revokes before the compromise observer and closes only its own descriptor once', async () => {
    const { lockDirectory, lockFile } = await location()
    const b = lifecycle()
    const opts = options(lockDirectory)
    const owner = await acquireTaskboardOwnership(opts, b.host)
    owners.push(owner)
    expect(b.acquire).toHaveBeenCalledWith(lockFile, 3)
    opts.onCompromised.mockImplementation(() => {
      expect(owner.owned).toBe(false)
      throw new Error('observer failed')
    })
    b.verify.mockResolvedValue(false)
    expect(await owner.check()).toBe(false)
    expect(await owner.check()).toBe(false)
    expect(opts.onCompromised).toHaveBeenCalledOnce()
    expect(opts.onCallbackError).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer failed' }))
    const disposal = owner.dispose()
    expect(owner.dispose()).toBe(disposal)
    await disposal
    expect(b.close).toHaveBeenCalledOnce()
    expect(b.timers.size).toBe(0)
  })

  it('serializes observations and waits for in-flight verification before closing', async () => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    const opts = options(lockDirectory)
    const pending = Promise.withResolvers<boolean>()
    b.verify.mockImplementation(() => pending.promise)
    const owner = await acquireTaskboardOwnership(opts, b.host)
    owners.push(owner)
    const first = owner.check()
    expect(owner.check()).toBe(first)
    const disposal = owner.dispose()
    expect(owner.owned).toBe(false)
    expect(b.close).not.toHaveBeenCalled()
    pending.resolve(false)
    expect(await first).toBe(false)
    await disposal
    expect(opts.onCompromised).not.toHaveBeenCalled()
    expect(b.close).toHaveBeenCalledOnce()
    expect(await owner.check()).toBe(false)
    expect(b.timers.size).toBe(0)
  })

  it('checks on the configured interval and stops after an I/O failure', async () => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    const opts = options(lockDirectory)
    const owner = await acquireTaskboardOwnership(opts, b.host)
    owners.push(owner)
    expect(b.schedule).toHaveBeenCalledWith(expect.any(Function), 1_000)
    b.tick()
    await vi.waitFor(() => { expect(b.schedule).toHaveBeenCalledTimes(2) })
    b.verify.mockRejectedValue('device disconnected')
    b.tick()
    await vi.waitFor(() => { expect(owner.owned).toBe(false) })
    expect(opts.onCompromised).toHaveBeenCalledWith(expect.objectContaining({ message: 'device disconnected' }))
    expect(b.timers.size).toBe(0)
  })

  it('rolls back acquisition when observation scheduling fails', async () => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    b.schedule.mockImplementation(() => { throw new Error('clock unavailable') })
    await expect(acquireTaskboardOwnership(options(lockDirectory), b.host)).rejects.toThrow('clock unavailable')
    expect(b.close).toHaveBeenCalledOnce()
  })

  it('reports observation rescheduling failure without an unhandled rejection', async () => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    const opts = options(lockDirectory)
    const owner = await acquireTaskboardOwnership(opts, b.host)
    owners.push(owner)
    b.schedule.mockImplementation(() => { throw new Error('clock unavailable') })
    b.tick()
    await vi.waitFor(() => { expect(owner.owned).toBe(false) })
    expect(opts.onCompromised).toHaveBeenCalledWith(expect.objectContaining({ message: 'clock unavailable' }))
  })

  it('propagates descriptor-close failure rather than reporting successful cleanup', async () => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    const failure = new Error('close denied')
    b.close.mockRejectedValue(failure)
    const owner = await acquireTaskboardOwnership(options(lockDirectory), b.host)
    const disposal = owner.dispose()
    expect(owner.dispose()).toBe(disposal)
    expect(owner.owned).toBe(false)
    await expect(disposal).rejects.toBe(failure)
    expect(b.close).toHaveBeenCalledOnce()
    expect(b.timers.size).toBe(0)
  })

  it.each([
    { lockDirectory: 'relative' },
    { updateMs: 0 },
    { updateMs: 0x80000000 },
    { maxAcquireAttempts: 0 },
  ])('rejects unresolved lock options before acquisition (%#)', async (invalid) => {
    const { lockDirectory } = await location()
    const b = lifecycle()
    await expect(acquireTaskboardOwnership({ ...options(lockDirectory), ...invalid }, b.host)).rejects.toThrow()
    expect(b.acquire).not.toHaveBeenCalled()
  })
})

describe('Taskboard native lock operations', () => {
  it('cancels native observation timers without retaining an event-loop handle', async () => {
    const b = platform()
    const completed = Promise.withResolvers<undefined>()
    const cancelled = vi.fn()
    b.host.schedule(cancelled, 60_000)()
    const cancel = b.host.schedule(() => { completed.resolve(undefined) }, 0)
    await completed.promise
    cancel()
    expect(cancelled).not.toHaveBeenCalled()
  })

  it.each(['linux', 'darwin'])('uses nontruncating POSIX opens and verifies the held inode on %s', async (kind) => {
    const { lockFile } = await location()
    const b = platform(kind)
    const lock = await b.host.acquire(lockFile, 2)
    expect(b.openFile).toHaveBeenCalledWith(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    expect(b.flock).toHaveBeenCalledWith(17)
    expect(await lock.verify!()).toBe(true)
    b.statFile.mockResolvedValue({ ino: 10n, dev: 3n })
    expect(await lock.verify!()).toBe(false)
    await lock.close()
    expect(b.file.close).toHaveBeenCalledOnce()
  })

  it.each(['EAGAIN', 'EWOULDBLOCK', 'EACCES'])('closes on flock refusal and never retries a held lock (%s)', async (code) => {
    const b = platform()
    const failure = Object.assign(new Error(code), { code })
    b.flock.mockRejectedValue(failure)
    await expect(b.host.acquire(resolve('owner.lock'), 3))
      .rejects.toHaveProperty('code', code === 'EACCES' ? 'EACCES' : 'ELOCKED')
    expect(b.openFile).toHaveBeenCalledOnce()
    expect(b.file.close).toHaveBeenCalledOnce()
  })

  it('reopens a missing or replaced inode only within the acquisition bound', async () => {
    const b = platform()
    b.statFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const lock = await b.host.acquire(resolve('owner.lock'), 2)
    expect(b.openFile).toHaveBeenCalledTimes(2)
    expect(b.file.close).toHaveBeenCalledOnce()
    await lock.close()
    b.statFile.mockResolvedValue({ ino: 11n, dev: 3n })
    await expect(b.host.acquire(resolve('owner.lock'), 2)).rejects.toHaveProperty('code', 'ECOMPROMISED')
    expect(b.file.close).toHaveBeenCalledTimes(4)
  })

  it('closes after a non-contention stat error', async () => {
    const b = platform()
    b.statFile.mockRejectedValue(new Error('stat failed'))
    await expect(b.host.acquire(resolve('owner.lock'), 3)).rejects.toThrow('stat failed')
    expect(b.file.close).toHaveBeenCalledOnce()
  })

  it('uses Windows OPEN_ALWAYS, a non-inheritable handle, and no write/delete sharing', async () => {
    const { lockDirectory, lockFile } = await location()
    const b = platform('win32')
    const owner = await acquireTaskboardOwnership(options(lockDirectory), b.host)
    owners.push(owner)
    expect(b.windowsApi.createFile).toHaveBeenCalledWith(toNamespacedPath(lockFile), 0xc0000000, 1, null, 4, 0x80, null)
    expect(await owner.check()).toBe(true)
    const checking = owner.check()
    await owner.dispose()
    expect(await checking).toBe(false)
    expect(b.windowsApi.closeHandle).toHaveBeenCalledWith(15)
    expect(b.openFile).not.toHaveBeenCalled()
  })

  it.each([[32, 'ELOCKED'], [5, 'EACCES'], [123, 'EIO']] as const)('reports Windows open error %s as %s', async (code, expected) => {
    const b = platform('win32')
    b.windowsApi.createFile.mockReturnValue(-1)
    b.windowsApi.getLastError.mockReturnValue(code)
    await expect(b.host.acquire(resolve('owner.lock'), 3)).rejects.toMatchObject({ code: expected, win32Code: code })
    expect(b.windowsApi.closeHandle).not.toHaveBeenCalled()
  })

  it('reports Windows CloseHandle failure', async () => {
    const b = platform('win32')
    const lock = await b.host.acquire(resolve('owner.lock'), 3)
    b.windowsApi.closeHandle.mockReturnValue(0)
    b.windowsApi.getLastError.mockReturnValue(6)
    await expect(lock.close()).rejects.toMatchObject({ code: 'EIO', win32Code: 6 })
  })

  it('does not grant ownership when native bindings cannot be loaded', async () => {
    const b = platform('win32')
    b.windows.mockRejectedValue(new Error('native bindings unavailable'))
    await expect(b.host.acquire(resolve('owner.lock'), 3)).rejects.toThrow('native bindings unavailable')
    expect(b.windowsApi.createFile).not.toHaveBeenCalled()
  })

  it('fails closed on unsupported platforms', async () => {
    const b = platform('freebsd')
    await expect(b.host.acquire(resolve('owner.lock'), 3)).rejects.toHaveProperty('code', 'ERR_TASKBOARD_LOCK_UNSUPPORTED')
    expect(b.openFile).not.toHaveBeenCalled()
    expect(b.windows).not.toHaveBeenCalled()
  })
})
