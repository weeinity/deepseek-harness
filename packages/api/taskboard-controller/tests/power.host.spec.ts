/** OS inhibition is replaced at process creation; no test prevents host sleep. */
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTaskboardPowerHost, TaskboardPower,
  type TaskboardPowerDemand, type TaskboardPowerHost, type TaskboardPowerOptions, type TaskboardPowerProcess,
} from '../src/runtime/power.ts'
import type { TaskboardPowerState } from '../src/runtime-types.ts'

const READY = 'DSH_TASKBOARD_POWER_READY\n'
const BUSY: TaskboardPowerDemand = { enabled: true, runningSessions: 1, enabledSchedules: 0, sessionStateKnown: true }
const powers: TaskboardPower[] = []

class Clock {
  private now = 0
  private id = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  onCancel: ((milliseconds: number) => void) | undefined
  schedule = (callback: () => void, milliseconds: number): (() => void) => {
    const id = this.id++
    this.timers.set(id, { at: this.now + milliseconds, callback })
    return () => {
      if (this.timers.delete(id)) this.onCancel?.(milliseconds)
    }
  }
  advance(milliseconds: number): void {
    const end = this.now + milliseconds
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end)
      if (next === undefined) break
      this.now = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
    }
    this.now = end
  }
  get pending(): number { return this.timers.size }
  hasDueAfter(milliseconds: number): boolean {
    return [...this.timers.values()].some(timer => timer.at === this.now + milliseconds)
  }
}

function fakeChild(pid: number | undefined, onEnd: () => void, onWrite: (text: string) => void) {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => { onWrite(chunk.toString()); callback() },
    final: (callback) => { onEnd(); callback() },
  })
  const record = Object.assign(emitter, {
    ...(pid === undefined ? {} : { pid }),
    stdin, stdout, stderr, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  })
  const child = record
  let closed = false
  return {
    child, kill: record.kill,
    close: (code: number | null = 0, signal: NodeJS.Signals | null = null) => {
      if (closed) return
      closed = true
      record.exitCode = code
      record.signalCode = signal
      stdout.end()
      stderr.end()
      child.emit('exit', code, signal)
      child.emit('close', code, signal)
    },
  }
}

function harness(platform = 'linux', overrides: { maxRetries?: number; maxDiagnosticBytes?: number } = {}) {
  const clock = new Clock()
  const changes: TaskboardPowerState[] = []
  const callbacks = vi.fn()
  const children: ReturnType<typeof fakeChild>[] = []
  const specs: { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio }[] = []
  const controls = {
    closeOnEnd: true, closeOnKill: true, echo: false, throwSpawn: false,
    onChange: undefined as ((state: TaskboardPowerState) => void) | undefined,
  }
  const terminated: { child: TaskboardPowerProcess; force: boolean }[] = []
  const host: TaskboardPowerHost = {
    platform, parentPid: 91,
    environment: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Private', API_KEY: 'do-not-inherit', PATH: 'poisoned', NODE_OPTIONS: '--inspect' },
    schedule: clock.schedule,
    spawn: (command, args, options) => {
      if (controls.throwSpawn) throw new Error('spawn denied')
      specs.push({ command, args, options })
      const child = fakeChild(100 + children.length,
        () => { if (controls.closeOnEnd) child.close() },
        (text) => { if (controls.echo) queueMicrotask(() => { child.child.stdout.write(text) }) },
      )
      children.push(child)
      return child.child
    },
    terminate: (child, force) => {
      terminated.push({ child, force })
      if (controls.closeOnKill) children.find(entry => entry.child === child)!.close(null, force ? 'SIGKILL' : 'SIGTERM')
    },
  }
  const options: TaskboardPowerOptions = {
    readinessTimeoutMs: 100, shutdownTimeoutMs: 40, killTimeoutMs: 20,
    assertionPollMs: 10, retryDelayMs: 50, maxRetries: 0, maxDiagnosticBytes: 512,
    ...overrides,
    onChange: (state) => { changes.push(state); controls.onChange?.(state) }, onCallbackError: callbacks,
  }
  const power = new TaskboardPower(options, host)
  powers.push(power)
  return { power, clock, changes, callbacks, children, specs, controls, terminated, host, options }
}

async function acquiring(b: ReturnType<typeof harness>) {
  b.power.setDemand(BUSY)
  await vi.waitFor(() => { expect(b.children.length).toBeGreaterThan(0) })
}

async function activate(b: ReturnType<typeof harness>) {
  await acquiring(b)
  b.children[0]!.child.stdout.write(READY)
  await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('active') })
}

afterEach(async () => {
  await Promise.all(powers.splice(0).map(power => power.dispose()))
})

describe('TaskboardPower demand and process protocol', () => {
  it('constructs the native adapter without acquiring protection', async () => {
    const b = harness()
    const power = new TaskboardPower(b.options)
    powers.push(power)
    expect(power.snapshot()).toMatchObject({ phase: 'disabled', platform: process.platform })
    const native = createTaskboardPowerHost()
    const scheduled = new Promise<void>((resolve) => { native.schedule(resolve, 0) })
    const cancelled = vi.fn()
    native.schedule(cancelled, 60_000)()
    await scheduled
    expect(cancelled).not.toHaveBeenCalled()
  })

  it('terminates only the owned process group or Windows child', () => {
    const record = fakeChild(99, () => {}, () => {})
    const child = record.child
    const kill = vi.fn<typeof process.kill>(() => true)
    const posix = createTaskboardPowerHost({ platform: 'linux', pid: 1, env: {}, kill })
    posix.terminate(child, false)
    posix.terminate(child, true)
    expect(kill.mock.calls).toEqual([[-99, 'SIGTERM'], [-99, 'SIGKILL']])
    kill.mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    expect(() => { posix.terminate(child, true) }).not.toThrow()
    kill.mockImplementation(() => { throw new Error('denied') })
    expect(() => { posix.terminate(child, true) }).toThrow('denied')
    posix.terminate(fakeChild(undefined, () => {}, () => {}).child, true)
    const windows = createTaskboardPowerHost({ platform: 'win32', pid: 1, env: {}, kill })
    windows.terminate(child, false)
    windows.terminate(child, true)
    expect(record.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(record.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
  })

  it('keeps one inhibitor for DSH work, armed schedules, and unknown Session state', async () => {
    const b = harness()
    expect(b.power.snapshot().phase).toBe('disabled')
    b.power.setDemand({ ...BUSY, runningSessions: 0 })
    expect(b.power.snapshot().phase).toBe('idle')
    await activate(b)
    const active = b.power.snapshot()
    expect(Object.isFrozen(active)).toBe(true)
    const count = b.changes.length
    b.power.setDemand(BUSY)
    expect(b.power.snapshot()).toBe(active)
    expect(b.changes).toHaveLength(count)
    b.power.setDemand({ ...BUSY, runningSessions: 0, enabledSchedules: 2 })
    b.power.setDemand({ ...BUSY, runningSessions: 0, sessionStateKnown: false })
    expect(b.children).toHaveLength(1)
    expect(b.power.snapshot()).toMatchObject({ phase: 'active', sessionStateKnown: false })
    b.power.setDemand({ ...BUSY, runningSessions: 0 })
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('idle') })
    expect(b.children[0]!.child.exitCode).toBe(0)
    expect(active.runningSessions).toBe(1)
    expect(b.clock.pending).toBe(0)
  })

  it('requires an exact readiness line, not process spawn or partial output', async () => {
    const b = harness()
    await acquiring(b)
    b.children[0]!.child.emit('spawn')
    b.children[0]!.child.stdout.write(READY.slice(0, -1))
    expect(b.power.snapshot().phase).toBe('acquiring')
    b.children[0]!.child.stdout.write('\n')
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('active') })
    expect(b.specs[0]).toEqual({
      command: '/usr/bin/systemd-inhibit',
      args: ['--what=idle', '--mode=block', '--who=DeepSeek Harness', '--why=Taskboard sessions or armed schedules', '--no-ask-password', '--', '/bin/cat'],
      options: { shell: false, windowsHide: true, detached: true, env: { LANG: 'C', LC_ALL: 'C' } },
    })
  })

  it('uses native Windows system-idle flags on one thread without display or away-mode flags', async () => {
    const b = harness('win32')
    await acquiring(b)
    expect(b.specs[0]).toMatchObject({
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      options: { shell: false, windowsHide: true, detached: false, env: { LANG: 'C', LC_ALL: 'C', SystemRoot: 'C:\\Windows', TEMP: 'C:\\Private' } },
    })
    const args = b.specs[0]!.args
    expect(args.slice(0, -1)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(args.at(-1)).toContain('if (SetThreadExecutionState(0x80000001) == 0)')
    expect(args.at(-1)).toContain('finally')
    expect(args.at(-1)).toContain('SetThreadExecutionState(0x80000000)')
    expect(args.at(-1)).not.toContain('0x80000002')
    expect(args.at(-1)).not.toContain('0x80000040')
    b.children[0]!.child.stdout.write(READY.replace('\n', '\r\n'))
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('active') })
    await b.power.dispose()
    expect(b.children[0]!.child.exitCode).toBe(0)
  })

  it('requires macOS to report an assertion owned by the live caffeinate PID', async () => {
    const b = harness('darwin')
    await acquiring(b)
    expect(b.specs.map(spec => [spec.command, spec.args])).toEqual([
      ['/usr/bin/caffeinate', ['-i', '-w', '91']],
      ['/usr/bin/pmset', ['-g', 'assertions']],
    ])
    b.children[1]!.child.stdout.write('pid 999(caffeinate): [0x1] 00:00:01 PreventUserIdleSystemSleep named: unrelated\n')
    b.children[1]!.close()
    await vi.waitFor(() => { expect(b.clock.hasDueAfter(10)).toBe(true) })
    expect(b.power.snapshot().phase).toBe('acquiring')
    b.clock.advance(10)
    await vi.waitFor(() => { expect(b.children).toHaveLength(3) })
    b.children[2]!.child.stdout.write('pid 100(caffeinate): [0x1] 00:00:01 PreventUserIdleSystemSleep named: caffeinate command-line tool\n')
    b.children[2]!.close()
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('active') })
    expect(b.children[0]!.child.exitCode).toBeNull()
    await b.power.dispose()
    expect(b.terminated[0]?.force).toBe(false)
    expect(b.clock.pending).toBe(0)
  })

  it('does not spawn on unsupported platforms or after disposal', async () => {
    const b = harness('freebsd')
    b.power.setDemand(BUSY)
    expect(b.power.snapshot().phase).toBe('unsupported')
    expect(b.specs).toEqual([])
    await b.power.dispose()
    b.power.setDemand(BUSY)
    expect(b.power.snapshot().phase).toBe('disabled')
  })

  it.each([{}, { SystemRoot: 'relative' }])('rejects an unresolved Windows helper path without spawning (%#)', async (environment) => {
    const b = harness('win32', { maxRetries: 3 })
    const power = new TaskboardPower(b.options, { ...b.host, environment })
    powers.push(power)
    power.setDemand(BUSY)
    await vi.waitFor(() => {
      const state = power.snapshot()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('absolute Windows SystemRoot')
    })
    expect(b.children).toEqual([])
    expect(b.clock.pending).toBe(0)
  })

  it('cancels acquisition before the queued spawn and silences disposal notifications', async () => {
    const b = harness()
    b.power.setDemand(BUSY)
    const count = b.changes.length
    const disposal = b.power.dispose()
    expect(b.power.dispose()).toBe(disposal)
    await disposal
    expect(b.children).toHaveLength(0)
    expect(b.changes).toHaveLength(count)
    expect(b.clock.pending).toBe(0)
  })

  it('honors synchronous disposal by a demand observer', async () => {
    const b = harness()
    let disposal: Promise<void> | undefined
    b.controls.onChange = () => { disposal = b.power.dispose() }
    b.power.setDemand(BUSY)
    await disposal
    expect(b.children).toEqual([])
    expect(b.clock.pending).toBe(0)
  })

  it.each(['cancel', 'close'] as const)('does not publish active when readiness settlement races %s', async (race) => {
    const b = harness()
    await acquiring(b)
    b.clock.onCancel = (milliseconds) => {
      if (milliseconds !== 100) return
      if (race === 'cancel') b.power.setDemand({ ...BUSY, enabled: false })
      else b.children[0]!.close()
    }
    b.children[0]!.child.stdout.write(READY)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe(race === 'cancel' ? 'disabled' : 'error') })
    expect(b.changes.some(state => state.phase === 'active')).toBe(false)
    expect(b.clock.pending).toBe(0)
  })

  it('quiesces a live acquisition and ignores a late readiness frame', async () => {
    const b = harness()
    b.controls.closeOnEnd = false
    await acquiring(b)
    const count = b.changes.length
    const disposed = b.power.dispose()
    await vi.waitFor(() => { expect(b.children[0]!.child.stdin.writableEnded).toBe(true) })
    b.children[0]!.child.stdout.write(READY)
    b.children[0]!.close()
    await disposed
    expect(b.power.snapshot().phase).toBe('disabled')
    expect(b.changes).toHaveLength(count)
    expect(b.children[0]!.child.listenerCount('error')).toBe(0)
    expect(b.children[0]!.child.stdout.listenerCount('data')).toBe(0)
    expect(b.clock.pending).toBe(0)
  })

  it('does not reacquire until the preceding helper has closed', async () => {
    const b = harness()
    b.controls.closeOnEnd = false
    await activate(b)
    b.power.setDemand({ ...BUSY, enabled: false })
    await vi.waitFor(() => { expect(b.children[0]!.child.stdin.writableEnded).toBe(true) })
    b.power.setDemand(BUSY)
    expect(b.children).toHaveLength(1)
    b.children[0]!.close()
    await vi.waitFor(() => { expect(b.children).toHaveLength(2) })
    b.controls.closeOnEnd = true
  })

  it('waits for a macOS acquisition query to close on disposal', async () => {
    const b = harness('darwin')
    b.controls.closeOnEnd = false
    b.controls.closeOnKill = false
    await acquiring(b)
    const disposal = b.power.dispose()
    let settled = false
    void disposal.then(() => { settled = true })
    await vi.waitFor(() => { expect(b.terminated.some(entry => entry.child === b.children[1]!.child)).toBe(true) })
    expect(settled).toBe(false)
    b.children[1]!.close()
    await vi.waitFor(() => { expect(b.terminated.some(entry => entry.child === b.children[0]!.child)).toBe(true) })
    expect(settled).toBe(false)
    b.children[0]!.close()
    await disposal
    expect(b.clock.pending).toBe(0)
  })

  it('cancels between macOS query completion and the next assertion poll', async () => {
    const b = harness('darwin')
    await acquiring(b)
    b.clock.onCancel = (milliseconds) => {
      if (milliseconds === 100) b.power.setDemand({ ...BUSY, enabled: false })
    }
    b.children[1]!.close()
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('disabled') })
    expect(b.children).toHaveLength(2)
    expect(b.clock.pending).toBe(0)
  })

  it('uses a real owned subprocess for the readiness and EOF release protocol without inhibiting sleep', async () => {
    const active = Promise.withResolvers<undefined>()
    const closed = Promise.withResolvers<undefined>()
    const specs: string[] = []
    let child: ChildProcessWithoutNullStreams | undefined
    const power = new TaskboardPower({
      readinessTimeoutMs: 60_000, shutdownTimeoutMs: 10_000, killTimeoutMs: 10_000,
      assertionPollMs: 100, retryDelayMs: 1_000, maxRetries: 0, maxDiagnosticBytes: 512,
      onChange: (state) => {
        if (state.phase === 'active') active.resolve(undefined)
        if (state.phase === 'error') active.reject(new Error(state.error))
      },
      onCallbackError: (error) => { active.reject(error) },
    }, {
      platform: 'linux', parentPid: process.pid, environment: {},
      spawn: (command, _args, options) => {
        specs.push(command)
        child = spawn(process.execPath, [fileURLToPath(new URL('./power-process.fixture.ts', import.meta.url))], {
          ...options, detached: false, stdio: 'pipe',
        })
        child.once('close', () => { closed.resolve(undefined) })
        return child
      },
      terminate: (process, force) => { process.kill(force ? 'SIGKILL' : 'SIGTERM') },
      schedule: (callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds)
        return () => { clearTimeout(timer) }
      },
    })
    powers.push(power)
    power.setDemand(BUSY)
    await active.promise
    expect(specs).toEqual(['/usr/bin/systemd-inhibit'])
    expect(child?.exitCode).toBeNull()
    await power.dispose()
    await closed.promise
    expect(child?.signalCode).toBeNull()
    expect(child?.exitCode).toBe(0)
  })
})

describe('TaskboardPower failures and bounded retries', () => {
  it.each(['child', 'stdin', 'stdout', 'stderr'] as const)('reports %s errors and closes the process', async (target) => {
    const b = harness()
    await activate(b)
    const child = b.children[0]!.child
    const emitter = target === 'child' ? child : child[target]
    emitter.emit('error', new Error('helper pipe failed'))
    await vi.waitFor(() => {
      const state = b.power.snapshot()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('helper pipe failed')
    })
    expect(child.exitCode).toBe(0)
    expect(b.clock.pending).toBe(0)
  })

  it('reports exit during acquisition without ever publishing active', async () => {
    const b = harness()
    await acquiring(b)
    b.children[0]!.child.stderr.write('permission denied')
    b.children[0]!.close(1)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    expect(b.power.snapshot().error).toContain('permission denied')
    expect(b.changes.some(state => state.phase === 'active')).toBe(false)
  })

  it('reports readiness timeout and releases the pending inhibitor', async () => {
    const b = harness()
    await acquiring(b)
    b.clock.advance(100)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    expect(b.power.snapshot().error).toContain('readiness timed out')
    expect(b.children[0]!.child.exitCode).toBe(0)
    expect(b.clock.pending).toBe(0)
  })

  it('cancels a pending macOS query when the complete readiness deadline expires', async () => {
    const b = harness('darwin')
    await acquiring(b)
    b.clock.advance(100)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    expect(b.children.every(entry => entry.child.exitCode !== null || entry.child.signalCode !== null)).toBe(true)
    expect(b.clock.pending).toBe(0)
  })

  it('retries external failures only within the configured demand-interval budget', async () => {
    const b = harness('linux', { maxRetries: 1 })
    await activate(b)
    b.children[0]!.close(4)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    b.power.setDemand(BUSY)
    b.power.setDemand({ ...BUSY, runningSessions: 2 })
    expect(b.children).toHaveLength(1)
    b.clock.advance(49)
    expect(b.children).toHaveLength(1)
    b.clock.advance(1)
    await vi.waitFor(() => { expect(b.children).toHaveLength(2) })
    b.children[1]!.close(5)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    b.power.setDemand(BUSY)
    b.clock.advance(1_000)
    expect(b.children).toHaveLength(2)
    b.power.setDemand({ ...BUSY, enabled: false })
    b.power.setDemand(BUSY)
    await vi.waitFor(() => { expect(b.children).toHaveLength(3) })
  })

  it('cancels retry when disabled or disposed', async () => {
    const b = harness('linux', { maxRetries: 2 })
    await acquiring(b)
    b.children[0]!.close(1)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    b.power.setDemand({ ...BUSY, enabled: false })
    expect(b.clock.pending).toBe(0)
    b.power.setDemand(BUSY)
    await vi.waitFor(() => { expect(b.children).toHaveLength(2) })
    b.children[1]!.close(1)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    await b.power.dispose()
    b.clock.advance(1_000)
    expect(b.children).toHaveLength(2)
    expect(b.clock.pending).toBe(0)
  })

  it('cancels the retry when an error observer disposes synchronously', async () => {
    const b = harness('linux', { maxRetries: 1 })
    let disposal: Promise<void> | undefined
    b.controls.onChange = (state) => {
      if (state.phase === 'error') disposal = b.power.dispose()
    }
    await acquiring(b)
    b.children[0]!.close(1)
    await vi.waitFor(() => { expect(disposal).toBeDefined() })
    await disposal
    expect(b.clock.pending).toBe(0)
  })

  it('contains observer exceptions without losing ownership of the helper', async () => {
    const b = harness()
    b.controls.onChange = () => { throw new Error('observer rejected') }
    await activate(b)
    expect(b.callbacks).toHaveBeenCalledWith(expect.objectContaining({ message: 'observer rejected' }))
    await b.power.dispose()
    expect(b.children[0]!.child.exitCode).toBe(0)
  })

  it.each([
    { failure: 'reporter failed', message: 'reporter failed' },
    { failure: { code: 'reporter failed' }, message: "{ code: 'reporter failed' }" },
  ])('reports a failing observer error reporter without treating it as a retryable OS failure (%#)', async ({ failure, message }) => {
    const b = harness('linux', { maxRetries: 3 })
    b.controls.onChange = (state) => {
      if (state.phase === 'active') throw new Error('observer failed')
    }
    b.callbacks.mockImplementation(() => { throw failure })
    await acquiring(b)
    b.children[0]!.child.stdout.write(READY)
    await vi.waitFor(() => { expect(b.power.snapshot()).toMatchObject({ phase: 'error', error: message }) })
    b.power.setDemand(BUSY)
    expect(b.children).toHaveLength(1)
    expect(b.clock.pending).toBe(0)
  })

  it('bounds the complete UTF-8 diagnostic and reports synchronous spawn failures', async () => {
    const b = harness('linux', { maxDiagnosticBytes: 41 })
    b.controls.throwSpawn = true
    b.power.setDemand(BUSY)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    expect(Buffer.byteLength(b.power.snapshot().error!)).toBeLessThanOrEqual(41)
    expect(b.power.snapshot().error).toContain('could not start')
    expect(b.clock.pending).toBe(0)
  })

  it('escalates only after graceful teardown expires and waits for forced exit', async () => {
    const b = harness()
    b.controls.closeOnEnd = false
    b.controls.closeOnKill = false
    await activate(b)
    const disposal = b.power.dispose()
    await vi.waitFor(() => { expect(b.children[0]!.child.stdin.writableEnded).toBe(true) })
    b.clock.advance(39)
    expect(b.terminated).toEqual([])
    b.clock.advance(1)
    await vi.waitFor(() => { expect(b.terminated).toHaveLength(1) })
    expect(b.terminated[0]!.force).toBe(true)
    b.children[0]!.close(null, 'SIGKILL')
    await disposal
    expect(b.clock.pending).toBe(0)
  })

  it('rejects disposal when forced exit cannot be proven and never starts a replacement', async () => {
    const b = harness('linux', { maxRetries: 3 })
    b.controls.closeOnEnd = false
    b.controls.closeOnKill = false
    await activate(b)
    const disposal = b.power.dispose()
    const rejected = expect(disposal).rejects.toThrow('did not exit after termination')
    powers.splice(powers.indexOf(b.power), 1)
    await vi.waitFor(() => { expect(b.children[0]!.child.stdin.writableEnded).toBe(true) })
    b.clock.advance(40)
    await vi.waitFor(() => { expect(b.terminated).toHaveLength(1) })
    b.clock.advance(20)
    await rejected
    b.power.setDemand(BUSY)
    b.clock.advance(1_000)
    expect(b.children).toHaveLength(1)
    b.children[0]!.close()
    expect(b.children[0]!.child.listenerCount('error')).toBe(0)
    expect(b.clock.pending).toBe(0)
  })

  it('preserves macOS query teardown failure while releasing the main inhibitor', async () => {
    const b = harness('darwin', { maxRetries: 3 })
    b.controls.closeOnEnd = false
    b.controls.closeOnKill = false
    await acquiring(b)
    b.power.setDemand({ ...BUSY, enabled: false })
    await vi.waitFor(() => { expect(b.terminated).toHaveLength(1) })
    b.clock.advance(40)
    await vi.waitFor(() => { expect(b.terminated).toHaveLength(2) })
    b.clock.advance(20)
    await vi.waitFor(() => { expect(b.terminated).toHaveLength(3) })
    b.children[0]!.close()
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    b.power.setDemand(BUSY)
    expect(b.children).toHaveLength(2)
    powers.splice(powers.indexOf(b.power), 1)
    await expect(b.power.dispose()).rejects.toThrow('did not exit after termination')
    b.children[1]!.close()
    expect(b.clock.pending).toBe(0)
  })

  it('bounds multibyte stderr within the complete diagnostic', async () => {
    const b = harness('linux', { maxDiagnosticBytes: 83 })
    await acquiring(b)
    b.children[0]!.child.stderr.write('失敗'.repeat(10_000))
    b.children[0]!.close(1)
    await vi.waitFor(() => { expect(b.power.snapshot().phase).toBe('error') })
    expect(Buffer.byteLength(b.power.snapshot().error!)).toBeLessThanOrEqual(83)
    expect(b.power.snapshot().error).not.toContain('\uFFFD')
  })

  it('reports failed macOS assertion queries and quiesces the inhibitor', async () => {
    const b = harness('darwin')
    await acquiring(b)
    b.children[1]!.child.stderr.write('assertion query denied')
    b.children[1]!.close(1)
    await vi.waitFor(() => {
      const state = b.power.snapshot()
      expect(state.phase).toBe('error')
      expect(state.error).toContain('assertion query denied')
    })
    expect(b.children[0]!.child.exitCode).toBe(0)
    expect(b.clock.pending).toBe(0)
  })
})
