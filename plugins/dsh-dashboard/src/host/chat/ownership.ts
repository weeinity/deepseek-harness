/** Kernel ownership of the Dashboard mapping; process death releases ownership without expiry. */
import { constants } from 'node:fs'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, toNamespacedPath } from 'node:path'
import { DashboardChatError } from './capture.ts'

/** Permanent lock files must never be removed while a Dashboard Host can run. */
export interface DashboardChatOwnership {
  /** Verify the held path before a mapping write or model dispatch. */
  check(): Promise<void>
  /** Release the kernel handle after all owned work and storage writes drain. */
  dispose(): Promise<void>
}

/**
 * Exclusively own one private mapping location. Contention fails without takeover.
 * @param directory - stable directory under the authenticated user's DSH_HOME.
 * @returns a process-owned kernel lock; neither acquisition nor disposal deletes its file.
 */
export async function acquireOwnership(directory: string): Promise<DashboardChatOwnership> {
  if (!isAbsolute(directory)) throw new DashboardChatError('INVALID_CONFIG', 'Dashboard lock directory must be absolute.')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(await realpath(directory), 'owner.lock')
  let closed = false
  let disposal: Promise<void> | undefined
  const assertOpen = (): void => {
    if (closed) throw new DashboardChatError('OWNER_CLOSED', 'Dashboard chat writer is closed.')
  }
  if (process.platform === 'win32') {
    const { extendWin32ProcessBindings } = await import('@deepseek-ai/dsh-win32-process')
    const api = extendWin32ProcessBindings(({ kernel32, bind }) => ({
      createFile: bind(kernel32, 'CreateFileW', 'intptr', [
        'str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*',
      ]) as (path: string, access: number, share: number, security: null, disposition: number,
        attributes: number, template: null) => number,
      closeFile: bind(kernel32, 'CloseHandle', 'int', ['intptr']) as (handle: number) => number,
    }))
    // OPEN_ALWAYS preserves bytes; FILE_SHARE_READ excludes other writers and deletion.
    const handle = api.createFile(toNamespacedPath(path), 0xc0000000, 1, null, 4, 0x80, null)
    if (handle === -1) {
      throw new DashboardChatError('OWNER_UNAVAILABLE', 'Dashboard chat writer lock cannot be acquired.')
    }
    return {
      check: async () => { assertOpen() },
      dispose: () => disposal ??= Promise.resolve().then(() => {
        closed = true
        if (api.closeFile(handle) === 0) {
          throw new DashboardChatError('OWNER_RELEASE_FAILED', 'Dashboard chat writer lock could not be released.')
        }
      }),
    }
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new DashboardChatError('OWNER_UNSUPPORTED', 'Dashboard chat requires a supported kernel writer lock.')
  }
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  const check = async (): Promise<void> => {
    assertOpen()
    const held = await handle.stat({ bigint: true })
    const current = await stat(path, { bigint: true })
    if (held.ino !== current.ino || held.dev !== current.dev) {
      closed = true
      throw new DashboardChatError('OWNER_COMPROMISED', 'Dashboard chat writer lock path was replaced.')
    }
  }
  try {
    const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
    await tryLockExclusive(handle.fd)
    await check()
  } catch {
    await handle.close()
    throw new DashboardChatError('OWNER_UNAVAILABLE', 'Dashboard chat writer lock cannot be acquired.')
  }
  return {
    check,
    dispose: () => disposal ??= Promise.resolve().then(async () => {
      closed = true
      await handle.close()
    }),
  }
}
