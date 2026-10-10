/**
 * Host-only idle-sleep inhibition. Readiness requires an OS acknowledgement:
 * systemd starts cat after acquiring its fd, Windows checks the native return,
 * and macOS queries the assertion belonging to the live caffeinate process.
 */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { win32 } from 'node:path'
import { format } from 'node:util'
import type { TaskboardPowerState } from '../runtime-types.ts'

const READY = 'DSH_TASKBOARD_POWER_READY\n'
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DSHTaskboardPower {
  [DllImport("kernel32.dll")]
  private static extern uint SetThreadExecutionState(uint flags);
  public static void Hold() {
    if (SetThreadExecutionState(0x80000001) == 0)
      throw new InvalidOperationException("SetThreadExecutionState failed");
    try {
      Console.Out.WriteLine("DSH_TASKBOARD_POWER_READY");
      Console.Out.Flush();
      while (Console.In.Read() != -1) {}
    } finally {
      if (SetThreadExecutionState(0x80000000) == 0)
        throw new InvalidOperationException("SetThreadExecutionState release failed");
    }
  }
}
'@
[DSHTaskboardPower]::Hold()
`

/** Complete workload observation; unknown Session state conservatively requires protection. */
export interface TaskboardPowerDemand {
  readonly enabled: boolean
  readonly runningSessions: number
  readonly enabledSchedules: number
  readonly sessionStateKnown: boolean
}

/** Deployment-resolved deadlines, output limits, and bounded external-helper retry policy. */
export interface TaskboardPowerOptions {
  readonly readinessTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly killTimeoutMs: number
  readonly retryDelayMs: number
  /** Retries after helper failures per uninterrupted demand interval; zero disables retries. */
  readonly maxRetries: number
  /** Includes the complete diagnostic message, not just retained stderr. */
  readonly maxDiagnosticBytes: number
  /** macOS assertion observation interval, within the overall readiness deadline. */
  readonly assertionPollMs: number
  readonly onChange: (state: TaskboardPowerState) => void
  readonly onCallbackError: (error: unknown) => void
}

/** Process operations used by the idle-sleep adapter. */
export type TaskboardPowerProcess =
  & Pick<ChildProcessWithoutNullStreams, 'pid' | 'stdin' | 'stdout' | 'stderr' | 'exitCode' | 'kill'>
  & Pick<EventEmitter, 'on' | 'once' | 'off'>

/** Instance-local OS and clock operations; test adapters must never invoke real inhibitors. */
export interface TaskboardPowerHost {
  readonly platform: string
  readonly parentPid: number
  readonly environment: Readonly<NodeJS.ProcessEnv>
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => TaskboardPowerProcess
  readonly terminate: (child: TaskboardPowerProcess, force: boolean) => void
  /** @returns cancellation of this one scheduled callback. */
  readonly schedule: (callback: () => void, milliseconds: number) => () => void
}

interface ProcessOperation {
  readonly child: TaskboardPowerProcess
  readonly closed: Promise<void>
  readonly failure: Promise<never>
  readonly diagnostic: () => string
  readonly output: () => string
  readonly onOutput: (callback: () => void) => () => void
  readonly isClosed: () => boolean
  readonly detach: () => void
}

class HelperFailure extends Error {}
class TeardownFailure extends Error {}

/**
 * Resolve native Host operations without starting an inhibitor.
 * @param os - process identity, environment, and signal operation; injectable without global mutation.
 * @returns the shell-free process adapter and cancellable native clock.
 */
export function createTaskboardPowerHost(
  os: Pick<NodeJS.Process, 'platform' | 'pid' | 'env' | 'kill'> = process,
): TaskboardPowerHost {
  return {
    platform: os.platform,
    parentPid: os.pid,
    environment: os.env,
    spawn: (command, args, options) => spawn(command, [...args], options),
    terminate: (child, force) => {
      if (os.platform === 'win32') {
        child.kill(force ? 'SIGKILL' : 'SIGTERM')
      } else if (child.pid !== undefined) {
        try {
          os.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        }
      }
    },
    schedule: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds)
      timer.unref()
      return () => { clearTimeout(timer) }
    },
  }
}

function bounded(text: string, limit: number): string {
  const bytes = Buffer.from(text)
  if (bytes.length <= limit) return text
  return bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '')
}

function approvedEnvironment(host: TaskboardPowerHost): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C' }
  if (host.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
      const match = Object.entries(host.environment).find(([name]) => name.toLowerCase() === key.toLowerCase())
      if (match?.[1] !== undefined) env[key] = match[1]
    }
  }
  return env
}

/** One inhibitor across all demanded Sessions and armed schedules, with asynchronous quiescent disposal. */
export class TaskboardPower {
  private demand: TaskboardPowerDemand = { enabled: false, runningSessions: 0, enabledSchedules: 0, sessionStateKnown: false }
  private state: TaskboardPowerState
  private operation: { controller: AbortController; done: Promise<void> } | undefined
  private retry: (() => void) | undefined
  private failures = 0
  private disposed = false
  private teardownError: Error | undefined
  private disposal: Promise<void> | undefined
  private readonly options: TaskboardPowerOptions
  private readonly host: TaskboardPowerHost

  /**
   * Construct an inactive protector; no process starts until demand requires one.
   * @param options - resolved deadlines, retry bounds, and contained observers.
   * @param host - native platform by default; injectable process and clock operations.
   */
  constructor(options: TaskboardPowerOptions, host: TaskboardPowerHost = createTaskboardPowerHost()) {
    this.options = options
    this.host = host
    this.state = Object.freeze({ phase: 'disabled', platform: host.platform, runningSessions: 0, enabledSchedules: 0, sessionStateKnown: false })
  }

  /**
   * Read the immutable latest observation; `active` never means display protection or wake scheduling.
   * @returns the same snapshot until an observed field changes.
   */
  snapshot(): TaskboardPowerState { return this.state }

  /**
   * Replace the workload observation; duplicate demand never spawns or resets retry bounds.
   * @param demand - all running DSH Sessions, owned external work, and nonarchived armed schedules.
   */
  setDemand(demand: TaskboardPowerDemand): void {
    if (this.disposed) return
    this.demand = { ...demand }
    this.publish(this.state.phase, this.state.error)
    this.reconcile()
  }

  /**
   * Silence observers, cancel retries, and await helper exit; repeated calls share completion.
   * @returns quiescent completion, rejecting when bounded forced teardown cannot prove exit.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.retry?.()
    this.retry = undefined
    this.operation?.controller.abort()
    this.disposal = (async () => {
      await this.operation?.done
      if (this.teardownError !== undefined) {
        this.publish('error', this.teardownError.message)
        throw this.teardownError
      }
      this.state = Object.freeze({ ...this.state, phase: 'disabled' })
    })()
    return this.disposal
  }

  private wanted(): boolean {
    return this.demand.enabled && (!this.demand.sessionStateKnown
      || this.demand.runningSessions > 0 || this.demand.enabledSchedules > 0)
  }

  private publish(phase: TaskboardPowerState['phase'], error?: string): void {
    const next: TaskboardPowerState = Object.freeze({
      phase, platform: this.host.platform,
      runningSessions: this.demand.runningSessions,
      enabledSchedules: this.demand.enabledSchedules,
      sessionStateKnown: this.demand.sessionStateKnown,
      ...(error === undefined ? {} : { error: bounded(error, this.options.maxDiagnosticBytes) }),
    })
    if (Object.keys(next).length === Object.keys(this.state).length
      && Object.entries(next).every(([key, value]) => this.state[key as keyof TaskboardPowerState] === value)) return
    this.state = next
    if (this.disposed) return
    try {
      this.options.onChange(next)
    } catch (callbackError) {
      this.options.onCallbackError(callbackError)
    }
  }

  private reconcile(): void {
    if (this.disposed || this.teardownError !== undefined) return
    if (!this.wanted()) {
      this.retry?.()
      this.retry = undefined
      this.failures = 0
      if (this.operation !== undefined) this.operation.controller.abort()
      else this.publish(this.demand.enabled ? 'idle' : 'disabled')
      return
    }
    if (this.operation !== undefined || this.retry !== undefined || this.failures > this.options.maxRetries) return
    if (!['darwin', 'linux', 'win32'].includes(this.host.platform)) {
      this.publish('unsupported')
      return
    }
    const controller = new AbortController()
    const done = Promise.resolve().then(async () => {
      let failure: unknown
      try {
        await this.protect(controller)
      } catch (error) {
        failure = error
        if (error instanceof TeardownFailure) this.teardownError = error
      }
      this.operation = undefined
      if (this.disposed) return
      if (failure !== undefined) {
        this.failures = failure instanceof HelperFailure ? this.failures + 1 : this.options.maxRetries + 1
        if (failure instanceof HelperFailure && this.wanted() && this.failures <= this.options.maxRetries) {
          this.retry = this.host.schedule(() => {
            this.retry = undefined
            this.reconcile()
          }, this.options.retryDelayMs)
        }
        this.publish('error', failure instanceof Error ? failure.message : format('%s', failure))
      } else {
        this.reconcile()
      }
    })
    this.operation = { controller, done }
    this.publish('acquiring')
  }

  private start(command: string, args: readonly string[]): ProcessOperation {
    let child: TaskboardPowerProcess
    try {
      child = this.host.spawn(command, args, {
        shell: false, windowsHide: true, detached: this.host.platform !== 'win32',
        env: approvedEnvironment(this.host),
      })
    } catch (error) {
      throw new HelperFailure(`Idle-sleep helper could not start: ${String(error)}`)
    }
    let output = ''
    let diagnostic = ''
    let closed = false
    const subscribers = new Set<() => void>()
    const done = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<never>()
    // Failures can precede a consumer's first await (for example spawn ENOENT).
    void failed.promise.catch(() => {})
    const fail = (error: Error): void => {
      failed.reject(new HelperFailure(`Idle-sleep helper failed: ${error.message}`))
    }
    const stdout = (chunk: Buffer): void => {
      output = bounded(output + chunk.toString('utf8'), this.options.maxDiagnosticBytes)
      for (const callback of subscribers) callback()
    }
    const stderr = (chunk: Buffer): void => {
      diagnostic = bounded(diagnostic + chunk.toString('utf8'), this.options.maxDiagnosticBytes)
    }
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      closed = true
      detach()
      done.resolve()
      failed.reject(new HelperFailure(`Idle-sleep helper exited (code ${String(code)}, signal ${String(signal)})${diagnostic ? `: ${diagnostic}` : ''}`))
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stderr.on('error', fail)
    child.stdout.on('data', stdout)
    child.stderr.on('data', stderr)
    child.once('close', close)
    function detach(): void {
      child.off('error', fail)
      child.stdin.off('error', fail)
      child.stdout.off('error', fail)
      child.stderr.off('error', fail)
      child.stdout.off('data', stdout)
      child.stderr.off('data', stderr)
      child.off('close', close)
      subscribers.clear()
    }
    return {
      child, closed: done.promise, failure: failed.promise, diagnostic: () => diagnostic,
      output: () => output, isClosed: () => closed,
      onOutput: (callback) => { subscribers.add(callback); return () => { subscribers.delete(callback) } },
      detach,
    }
  }

  private async deadline<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
    const expiry = Promise.withResolvers<never>()
    const cancel = this.host.schedule(() => { expiry.reject(new HelperFailure(message)) }, milliseconds)
    try {
      return await Promise.race([work, expiry.promise])
    } finally {
      cancel()
    }
  }

  private async stop(operation: ProcessOperation): Promise<void> {
    if (operation.isClosed()) { operation.detach(); return }
    try {
      operation.child.stdin.end()
      if (this.host.platform === 'darwin') this.host.terminate(operation.child, false)
      try {
        await this.deadline(operation.closed, this.options.shutdownTimeoutMs, 'Idle-sleep helper did not release')
      } catch {
        this.host.terminate(operation.child, true)
        await this.deadline(operation.closed, this.options.killTimeoutMs, 'Idle-sleep helper did not exit after termination')
      }
    } catch (error) {
      throw new TeardownFailure(`Idle-sleep helper teardown failed: ${String(error)}`)
    } finally {
      if (operation.isClosed()) operation.detach()
    }
  }

  private async protect(controller: AbortController): Promise<void> {
    const signal = controller.signal
    const isAborted = (): boolean => controller.signal.aborted
    if (isAborted()) return
    const cancelled = Promise.withResolvers<never>()
    void cancelled.promise.catch(() => {})
    const abort = (): void => { cancelled.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    let operation: ProcessOperation | undefined
    let acquired: Promise<void> | undefined
    try {
      const platform = this.host.platform
      if (platform === 'linux') {
        operation = this.start('/usr/bin/systemd-inhibit', [
          '--what=idle', '--mode=block', '--who=DeepSeek Harness',
          '--why=Taskboard sessions or armed schedules', '--no-ask-password', '--', '/bin/cat',
        ])
      } else if (platform === 'darwin') {
        operation = this.start('/usr/bin/caffeinate', ['-i', '-w', String(this.host.parentPid)])
      } else {
        const root = approvedEnvironment(this.host).SystemRoot
        if (root === undefined || !win32.isAbsolute(root)) throw new Error('Idle-sleep protection requires an absolute Windows SystemRoot')
        operation = this.start(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT,
        ])
      }
      acquired = platform === 'darwin'
        ? this.observeAssertion(operation, signal, cancelled.promise)
        : this.observeReadiness(operation, platform === 'linux', cancelled.promise)
      await this.deadline(
        Promise.race([acquired, cancelled.promise, operation.failure]),
        this.options.readinessTimeoutMs, 'Idle-sleep helper readiness timed out',
      )
      if (isAborted()) return
      if (operation.isClosed()) await operation.failure
      this.publish('active')
      await Promise.race([cancelled.promise, operation.failure])
    } catch (error) {
      if (!isAborted()) throw error
    } finally {
      controller.abort()
      try {
        // Acquisition owns its query process and listeners until they quiesce.
        await acquired?.catch((error: unknown) => {
          if (error instanceof TeardownFailure) throw error
        })
      } finally {
        signal.removeEventListener('abort', abort)
        if (operation !== undefined) await this.stop(operation)
      }
    }
  }

  private async observeReadiness(operation: ProcessOperation, echo: boolean, cancelled: Promise<never>): Promise<void> {
    const ready = Promise.withResolvers<void>()
    const inspect = (): void => {
      if (operation.output().replace(/\r\n/gu, '\n') === READY) ready.resolve()
    }
    const detach = operation.onOutput(inspect)
    inspect()
    if (echo) operation.child.stdin.write(READY)
    try {
      await Promise.race([ready.promise, operation.failure, cancelled])
    } finally {
      detach()
    }
  }

  private async observeAssertion(inhibitor: ProcessOperation, signal: AbortSignal, cancelled: Promise<never>): Promise<void> {
    while (!signal.aborted && !inhibitor.isClosed()) {
      const query = this.start('/usr/bin/pmset', ['-g', 'assertions'])
      try {
        await this.deadline(
          Promise.race([query.closed, query.failure, cancelled]),
          this.options.readinessTimeoutMs, 'Idle-sleep assertion query timed out',
        )
        if (query.child.exitCode !== 0) throw new HelperFailure(`Idle-sleep assertion query failed: ${query.diagnostic()}`)
        const pattern = new RegExp(`^\\s*pid ${String(inhibitor.child.pid)}\\(caffeinate\\):.*\\bPreventUserIdleSystemSleep\\b`, 'mu')
        if (pattern.test(query.output())) return
      } finally {
        await this.stop(query)
      }
      await new Promise<void>((resolve) => {
        const cancel = this.host.schedule(finish, this.options.assertionPollMs)
        function finish(): void { cancel(); signal.removeEventListener('abort', finish); resolve() }
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }
  }
}
