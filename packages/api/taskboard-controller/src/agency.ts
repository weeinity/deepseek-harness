/** Host-only Agency Copilot CLI discovery and Windows Terminal handoff. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, readlink } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { quoteArg } from '@deepseek-ai/dsh-win32-process'
import { AgencyCopilotSessionId } from '@deepseek-ai/dsh-taskboard'
import type { AgencyCopilotSessionId as AgencyCopilotSessionIdValue } from '@deepseek-ai/dsh-taskboard/types'
import { z } from 'zod'

const PAGE_SIZE = 100
const MAX_PAGES = 10
const STDOUT_MAX_BYTES = 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const COMMAND_TIMEOUT_MS = 8_000
const TERMINATE_GRACE_MS = 1_000

const optionalText = (maximum: number) => z.string().max(maximum).nullable().optional()
const localSession = z.object({
  session_id: z.uuid(),
  status: z.enum(['idle', 'in_use']),
  folder: optionalText(32_768),
  summary: optionalText(4_096),
  repository: optionalText(4_096),
  host_type: optionalText(128),
  created_at: optionalText(128),
  updated_at: optionalText(128),
  user_named: z.boolean().optional(),
  synced: z.boolean().optional(),
  device_id: optionalText(128),
  device_name: optionalText(512),
  platform: optionalText(128),
})
const localPage = z.object({
  sessions: z.array(localSession).max(PAGE_SIZE),
  next_cursor: z.string().max(4_096).nullable().optional(),
})

/** One current local Agency Copilot row needed by Taskboard status projection. */
export interface AgencyCopilotLocalSession {
  readonly sessionId: AgencyCopilotSessionIdValue
  readonly status: 'idle' | 'in_use'
  readonly folder?: string
  readonly summary?: string
}

/** Bounded exact-id scan result. Incomplete absence is unknown, never missing. */
export interface AgencyCopilotScan {
  readonly sessions: ReadonlyMap<AgencyCopilotSessionIdValue, AgencyCopilotLocalSession>
  readonly complete: boolean
}

/** Injected process boundary used by Host tests; production starts Windows Terminal directly. */
export type AgencyBrokerSpawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

interface TerminalAliasFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  access(path: string, mode?: number): Promise<void>
  readlink(path: string): Promise<string>
}

/** Test seams and platform override for the Host-only adapter. */
export interface AgencyCopilotHostInternals {
  readonly platform?: NodeJS.Platform
  readonly spawnBroker?: AgencyBrokerSpawner
  readonly terminalAliasFileSystem?: TerminalAliasFileSystem
}

/** Agency discovery or parsing was unavailable without exposing raw vendor output. */
export class AgencyCopilotUnavailableError extends Error {
  override readonly name = 'AgencyCopilotUnavailableError'
}

/** Windows Terminal rejected a fixed Agency launch handoff. */
export class AgencyCopilotLaunchError extends Error {
  override readonly name = 'AgencyCopilotLaunchError'
}

/** Narrow Host adapter for fixed Agency CLI reads and user-owned terminal launch. */
export class AgencyCopilotHost {
  private readonly platform: NodeJS.Platform
  private readonly spawnBroker: AgencyBrokerSpawner
  private readonly terminalAliasFileSystem: TerminalAliasFileSystem
  private readonly environment: Record<string, string>

  /** @param ctx - Host context where local subprocess capability may be mounted. */
  constructor(private readonly ctx: Context, internals: AgencyCopilotHostInternals = {}) {
    this.platform = internals.platform ?? process.platform
    this.spawnBroker = internals.spawnBroker ?? ((command, args, options) => spawn(command, [...args], options))
    this.terminalAliasFileSystem = internals.terminalAliasFileSystem ?? { lstat, access, readlink }
    this.environment = agencyEnvironment(ctx)
  }

  /** Return whether this Host platform can open a visible Agency terminal.
   * @returns true only on the supported Windows host platform.
   */
  nativeLaunchSupported(): boolean { return this.platform === 'win32' }

  /**
   * Supply the SDK runtime with the same process-origin data home as Agency.
   * @returns a detached environment without project credentials or Agency bootstrap.
   */
  copilotSdkEnvironment(): Record<string, string> {
    if (!this.nativeLaunchSupported()) throw new AgencyCopilotUnavailableError('Native Copilot execution requires Windows')
    return { ...this.environment }
  }

  /**
   * Scan bounded Agency pages for exact session identities.
   * @param ids - Exact linked or user-selected identities to inspect.
   * @param signal - Caller cancellation and command lifetime.
   * @returns found local rows plus whether absence is authoritative.
   */
  async inspect(ids: readonly AgencyCopilotSessionIdValue[], signal: AbortSignal): Promise<AgencyCopilotScan> {
    return this.scan(signal, new Set(ids))
  }

  /**
   * Discover local Agency sessions without launching or resuming Copilot.
   * @param signal - Caller cancellation for the bounded page scan.
   * @returns validated local rows and whether every page was read.
   */
  list(signal: AbortSignal): Promise<AgencyCopilotScan> {
    return this.scan(signal)
  }

  private async scan(
    signal: AbortSignal,
    wanted?: Set<AgencyCopilotSessionIdValue>,
  ): Promise<AgencyCopilotScan> {
    signal.throwIfAborted()
    const sessions = new Map<AgencyCopilotSessionIdValue, AgencyCopilotLocalSession>()
    if (wanted?.size === 0) return { sessions, complete: true }
    let cursor: string | undefined
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page = await this.listPage(cursor, signal)
      for (const row of page.sessions) {
        const sessionId = AgencyCopilotSessionId(row.session_id)
        if (wanted !== undefined && !wanted.has(sessionId)) continue
        sessions.set(sessionId, {
          sessionId,
          status: row.status,
          ...(row.folder === undefined || row.folder === null ? {} : { folder: row.folder }),
          ...(row.summary === undefined || row.summary === null ? {} : { summary: row.summary }),
        })
        wanted?.delete(sessionId)
      }
      cursor = page.next_cursor ?? undefined
      if (wanted?.size === 0 || cursor === undefined) break
    }
    return { sessions, complete: cursor === undefined }
  }

  private subprocess(): SubprocessRuntime {
    const subprocess: SubprocessRuntime | undefined = this.ctx.get('subprocess')
    if (subprocess === undefined) throw new AgencyCopilotUnavailableError('Agency Copilot integration is unavailable')
    return subprocess
  }

  private async listPage(cursor: string | undefined, signal: AbortSignal): Promise<z.infer<typeof localPage>> {
    signal.throwIfAborted()
    const subprocess = this.subprocess()
    const deadline = AbortSignal.timeout(COMMAND_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, deadline])
    try {
      const executable = await subprocess.resolveExecutable('agency.exe', this.environment, combined)
      combined.throwIfAborted()
      const argv = [executable, 'hub', 'list-local-sessions', '--json', '--limit', String(PAGE_SIZE)]
      if (cursor !== undefined) argv.push('--cursor', cursor)
      const handle = subprocess.spawn({
        argv,
        cwd: dirname(executable),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal: combined,
        env: this.environment,
      })
      const outcome = await handle.done
      signal.throwIfAborted()
      if (deadline.aborted || outcome.exitCode !== 0 || outcome.signal !== null) {
        throw new AgencyCopilotUnavailableError('Agency Copilot status is unavailable')
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      if (stdout === undefined || stdout.lossy || stderr?.lossy === true) {
        throw new AgencyCopilotUnavailableError('Agency Copilot status output exceeded its safety bound')
      }
      let decoded: unknown
      try { decoded = JSON.parse(stdout.text) }
      catch { throw new AgencyCopilotUnavailableError('Agency Copilot returned invalid status data') }
      const parsed = localPage.safeParse(decoded)
      if (!parsed.success) throw new AgencyCopilotUnavailableError('Agency Copilot returned unsupported status data')
      return parsed.data
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (error instanceof AgencyCopilotUnavailableError) throw error
      throw new AgencyCopilotUnavailableError('Agency Copilot integration is unavailable')
    }
  }

  private async launchExecutables(signal: AbortSignal): Promise<{ agency: string; terminal: string }> {
    signal.throwIfAborted()
    const subprocess = this.subprocess()
    const [agency, terminal] = await Promise.all([
      subprocess.resolveExecutable('agency.exe', this.environment, signal),
      this.resolveWindowsTerminal(subprocess, signal),
    ])
    return { agency, terminal }
  }

  private async resolveWindowsTerminal(subprocess: SubprocessRuntime, signal: AbortSignal): Promise<string> {
    try { return await subprocess.resolveExecutable('wt.exe', this.environment, signal) }
    catch (resolveError: unknown) {
      signal.throwIfAborted()
      try { return await this.resolveWindowsTerminalAlias(signal) }
      catch { throw resolveError }
    }
  }

  private async resolveWindowsTerminalAlias(signal: AbortSignal): Promise<string> {
    const localAppData = this.environment.LOCALAPPDATA
    const programFiles = this.environment.PROGRAMFILES
    const path = this.environment.PATH
    if (localAppData === undefined || programFiles === undefined || path === undefined
      || !win32.isAbsolute(localAppData) || !win32.isAbsolute(programFiles)) {
      throw new Error('Windows Terminal app alias location is unavailable')
    }
    const directory = win32.join(localAppData, 'Microsoft', 'WindowsApps')
    const directoryKey = windowsPathKey(directory)
    if (!path.split(';').some(entry => windowsPathKey(entry) === directoryKey)) {
      throw new Error('Windows Terminal app alias is not on PATH')
    }
    const candidate = win32.join(directory, 'wt.exe')
    signal.throwIfAborted()
    const info = await this.terminalAliasFileSystem.lstat(candidate)
    if (!info.isSymbolicLink()) throw new Error('Windows Terminal app alias is not a symbolic link')
    await this.terminalAliasFileSystem.access(candidate, constants.X_OK)
    const target = await this.terminalAliasFileSystem.readlink(candidate)
    signal.throwIfAborted()
    const packageName = win32.basename(win32.dirname(target))
    const packageRoot = win32.dirname(win32.dirname(target))
    if (!win32.isAbsolute(target)
      || win32.basename(target).toLowerCase() !== 'wt.exe'
      || windowsPathKey(packageRoot) !== windowsPathKey(win32.join(programFiles, 'WindowsApps'))
      || !/^Microsoft\.WindowsTerminal(?:Preview)?_.+__8wekyb3d8bbwe$/i.test(packageName)) {
      throw new Error('Windows Terminal app alias target is unsupported')
    }
    return candidate
  }

  /**
   * Open an existing idle conversation without submitting input.
   * @param workspacePath - Canonical task Workspace path supplied by the Host.
   * @param sessionId - Validated existing Copilot conversation identity.
   * @param signal - Caller cancellation before broker acceptance.
   */
  async resume(workspacePath: string, sessionId: AgencyCopilotSessionIdValue, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.platform !== 'win32') throw new AgencyCopilotLaunchError('Agency Copilot terminal launch requires Windows')
    try {
      const { agency, terminal } = await this.launchExecutables(signal)
      signal.throwIfAborted()
      const args = [
        '--window', 'new', 'new-tab', '--startingDirectory', workspacePath,
        '--title', 'Agency Copilot', '--suppressApplicationTitle',
        ...[agency, 'copilot', '--resume=' + sessionId].map(windowsTerminalCommandArgument),
      ]
      // Windows Terminal parses semicolon-separated commands even without a shell.
      const escapedArgs = args.map(value => value.replaceAll(';', '\\;'))
      if ([terminal, ...escapedArgs].map(quoteArg).join(' ').length >= 32_767) {
        throw new AgencyCopilotLaunchError('Agency terminal command exceeds the Windows command-line limit')
      }
      await launchAccepted(this.spawnBroker, terminal, escapedArgs, this.environment)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      if (error instanceof AgencyCopilotLaunchError) throw error
      throw new AgencyCopilotLaunchError('Agency Copilot terminal launch failed')
    }
  }
}

function windowsTerminalCommandArgument(value: string): string {
  const quoted = quoteArg(value)
  // Windows Terminal adds its own outer quotes only to command arguments containing spaces.
  return value.includes(' ') ? quoted.slice(1, -1) : quoted
}

const ALLOWED_ENVIRONMENT_NAMES = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'COPILOT_HOME',
] as const

function windowsPathKey(path: string): string {
  return win32.normalize(path).replace(/[\\/]$/, '').toLowerCase()
}

function agencyEnvironment(ctx: Context): Record<string, string> {
  const launch = launchEnvironmentOf(ctx)
  const environment: Record<string, string> = {}
  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    const entry = launch.getFrom(name, ['process'])
    if (entry !== undefined) environment[name] = entry.value
  }
  environment.AGENCY_NO_UPDATE_CHECK = '1'
  environment.AGENCY_NO_AUTO_UPDATE = '1'
  environment.AGENCY_NO_PROTOCOL_HANDLER = '1'
  return environment
}

function launchAccepted(
  spawner: AgencyBrokerSpawner,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawner(command, args, {
      env: environment,
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    })
    const failed = (error: Error): void => { reject(error) }
    child.once('error', failed)
    child.once('spawn', () => {
      child.off('error', failed)
      child.unref()
      resolve()
    })
  })
}
