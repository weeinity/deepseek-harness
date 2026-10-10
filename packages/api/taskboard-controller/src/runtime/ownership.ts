/**
 * Kernel-owned Taskboard execution exclusion, released on descriptor close or
 * process death. The private lock file is never removed or truncated.
 * POSIX uses the Session backend's native flock primitive and inode check;
 * Windows denies other writers and deletion through CreateFileW sharing.
 */
import { constants } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import { isAbsolute, join, toNamespacedPath } from 'node:path'
import { extendWin32ProcessBindings } from '@deepseek-ai/dsh-win32-process'

/** Private lock location and bounded inode-verification policy. */
export interface TaskboardOwnershipOptions {
  /** Private directory containing the permanent `owner.lock` file; never remove it while a Host may own it. */
  readonly lockDirectory: string
  /** POSIX path-identity interval in ms (1–2,147,483,647); it never authorizes takeover. */
  readonly updateMs: number
  /** Attempts to reopen an inode replaced during acquisition, not retries of a held kernel lock. */
  readonly maxAcquireAttempts: number
  /** Stop admitting work synchronously; ownership cannot recover after compromise. */
  readonly onCompromised: (error: Error) => void
  /** Report exceptions from the compromise observer; this reporter must not throw. */
  readonly onCallbackError: (error: unknown) => void
}

/** One kernel-held operation; only POSIX requires path-identity observations. */
export interface TaskboardKernelLock {
  readonly verify?: () => Promise<boolean>
  readonly close: () => Promise<void>
}

/** Instance-local acquisition and timer operations for lifecycle tests. */
export interface TaskboardOwnershipHost {
  readonly acquire: (path: string, maxAttempts: number) => Promise<TaskboardKernelLock>
  readonly schedule: (callback: () => void, milliseconds: number) => () => void
}

/** Minimal native Windows file operations, injectable without loading Windows DLLs. */
export interface TaskboardWindowsLockApi {
  readonly createFile: (
    path: string, access: number, sharing: number, security: null,
    disposition: number, attributes: number, template: null,
  ) => number
  readonly closeHandle: (handle: number) => number
  readonly getLastError: () => number
}

/** Native syscall and filesystem inputs used by the kernel-lock adapter. */
export interface TaskboardOwnershipPlatform {
  readonly platform: string
  readonly open: (
    path: string, flags: number, mode: number,
  ) => Promise<{
    readonly fd: number
    stat(options: { bigint: true }): Promise<{ readonly ino: bigint; readonly dev: bigint }>
    close(): Promise<void>
  }>
  readonly stat: (
    path: string, options: { bigint: true },
  ) => Promise<{ readonly ino: bigint; readonly dev: bigint }>
  readonly flock: (fd: number) => Promise<void>
  readonly windows: () => TaskboardWindowsLockApi | Promise<TaskboardWindowsLockApi>
}

/** An owner revoked before compromise notification or descriptor release begins. */
export interface TaskboardOwnership {
  readonly owned: boolean
  /**
   * Verify ownership before admitting work; concurrent observations share one operation.
   * @returns false after disposal, a replaced POSIX lock path, or verification failure.
   */
  check(): Promise<boolean>
  /**
   * Stop observations, await in-flight verification, and close the held descriptor.
   * @returns quiescent release; repeated calls share completion and release errors.
   */
  dispose(): Promise<void>
}

function ownershipError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/* v8 ignore start -- native Windows process tests exercise DLL loading; injected APIs cover file-lock decisions on other hosts */
function loadWindows(): TaskboardWindowsLockApi {
  return extendWin32ProcessBindings(({ kernel32, bind }) => ({
    createFile: bind(kernel32, 'CreateFileW', 'intptr', [
      'str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*',
    ]) as TaskboardWindowsLockApi['createFile'],
    closeHandle: bind(kernel32, 'CloseHandle', 'int', ['intptr']) as TaskboardWindowsLockApi['closeHandle'],
  }))
}
/* v8 ignore stop */

function windowsError(api: TaskboardWindowsLockApi, operation: string): Error {
  const win32Code = api.getLastError()
  const code = win32Code === 32 ? 'ELOCKED' : win32Code === 5 ? 'EACCES' : 'EIO'
  return Object.assign(new Error(`Taskboard ${operation} failed (Win32 ${String(win32Code)})`), { code, win32Code })
}

function acquireWindows(path: string, api: TaskboardWindowsLockApi): TaskboardKernelLock {
  // OPEN_ALWAYS preserves existing bytes. FILE_SHARE_READ permits inspection
  // but denies competing writers and delete/rename until this handle closes.
  // NULL security makes the handle non-inheritable by dispatched children.
  const handle = api.createFile(toNamespacedPath(path), 0xc0000000, 1, null, 4, 0x80, null)
  if (handle === -1) throw windowsError(api, 'CreateFileW')
  return {
    close: () => Promise.resolve().then(() => {
      if (api.closeHandle(handle) === 0) throw windowsError(api, 'CloseHandle')
    }),
  }
}

async function matchesPath(
  handle: Awaited<ReturnType<TaskboardOwnershipPlatform['open']>>,
  path: string,
  io: TaskboardOwnershipPlatform,
): Promise<boolean> {
  const held = await handle.stat({ bigint: true })
  let current
  try {
    current = await io.stat(path, { bigint: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
  return current.ino === held.ino && current.dev === held.dev
}

async function acquirePosix(path: string, maxAttempts: number, io: TaskboardOwnershipPlatform): Promise<TaskboardKernelLock> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const handle = await io.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      await io.flock(handle.fd)
      if (await matchesPath(handle, path, io)) {
        return { verify: () => matchesPath(handle, path, io), close: () => handle.close() }
      }
    } catch (error) {
      await handle.close()
      if (errorCode(error) === 'EAGAIN' || errorCode(error) === 'EWOULDBLOCK') {
        throw ownershipError('ELOCKED', 'Taskboard execution is held by another Host')
      }
      throw error
    }
    await handle.close()
  }
  throw ownershipError('ECOMPROMISED', 'Taskboard lock path changed during acquisition')
}

/**
 * Resolve kernel lock operations without acquiring a lock or loading native code.
 * @param platform - injectable syscalls; defaults use the Session backend's native flock and shared Win32 bindings.
 * @returns the kernel acquisition adapter and cancellable observation clock.
 */
export function createTaskboardOwnershipHost(platform: TaskboardOwnershipPlatform = {
  platform: process.platform,
  open,
  stat,
  // v8 ignore next -- native POSIX process tests exercise this lazy addon entry; Windows exercises injected flock outcomes
  flock: async fd => (await import('@deepseek-ai/node-addon-system/flock')).tryLockExclusive(fd),
  windows: loadWindows,
}): TaskboardOwnershipHost {
  return {
    acquire: async (path, maxAttempts) => {
      if (platform.platform === 'win32') return acquireWindows(path, await platform.windows())
      if (platform.platform === 'linux' || platform.platform === 'darwin') return acquirePosix(path, maxAttempts, platform)
      throw ownershipError('ERR_TASKBOARD_LOCK_UNSUPPORTED', `Taskboard kernel ownership is unavailable on ${platform.platform}`)
    },
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      timer.unref()
      return () => { clearTimeout(timer) }
    },
  }
}

/**
 * Acquire execution ownership without expiring or deleting another owner's lock.
 * Process death releases the kernel lock immediately; a successor reuses the
 * permanent file. A stalled live Host remains the owner regardless of age.
 * @param options - private location, inode-check bounds, and contained observers.
 * @param host - injectable kernel acquisition and observation operations.
 * @returns the owner; live contention rejects with `ELOCKED`.
 */
export async function acquireTaskboardOwnership(
  options: TaskboardOwnershipOptions,
  host: TaskboardOwnershipHost = createTaskboardOwnershipHost(),
): Promise<TaskboardOwnership> {
  if (!isAbsolute(options.lockDirectory)) throw new Error('Taskboard lock directory must be absolute')
  if (!Number.isSafeInteger(options.updateMs) || options.updateMs < 1 || options.updateMs > 0x7fffffff
    || !Number.isSafeInteger(options.maxAcquireAttempts) || options.maxAcquireAttempts < 1) {
    throw new Error('Taskboard lock requires updateMs between 1 and 2147483647 and positive integer maxAcquireAttempts')
  }
  await mkdir(options.lockDirectory, { recursive: true, mode: 0o700 })
  const held = await host.acquire(join(options.lockDirectory, 'owner.lock'), options.maxAcquireAttempts)
  let state: 'owned' | 'compromised' | 'disposed' = 'owned'
  let scheduled: (() => void) | undefined
  let observation: Promise<boolean> | undefined
  let disposal: Promise<void> | undefined
  const isOwned = (): boolean => state === 'owned'

  const compromise = (error: unknown): void => {
    if (!isOwned()) return
    state = 'compromised'
    scheduled?.()
    scheduled = undefined
    try {
      options.onCompromised(error instanceof Error ? error : new Error(String(error)))
    } catch (callbackError) {
      options.onCallbackError(callbackError)
    }
  }
  const check = (): Promise<boolean> => {
    if (!isOwned()) return Promise.resolve(false)
    if (observation !== undefined) return observation
    observation = (async () => {
      try {
        if (await held.verify?.() === false) {
          compromise(ownershipError('ECOMPROMISED', 'Taskboard lock file was removed or replaced'))
        }
      } catch (error) {
        compromise(error)
      }
      return isOwned()
    })().finally(() => { observation = undefined })
    return observation
  }
  const schedule = (): void => {
    if (held.verify === undefined || !isOwned()) return
    scheduled = host.schedule(() => {
      scheduled = undefined
      void check().then(() => { schedule() }).catch(compromise)
    }, options.updateMs)
  }
  try {
    schedule()
  } catch (error) {
    state = 'disposed'
    await held.close()
    throw error
  }
  return {
    get owned() { return isOwned() },
    check,
    dispose: () => {
      if (disposal !== undefined) return disposal
      state = 'disposed'
      scheduled?.()
      scheduled = undefined
      disposal = (async () => {
        await observation
        await held.close()
      })()
      return disposal
    },
  }
}
