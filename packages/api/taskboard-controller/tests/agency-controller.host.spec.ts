import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgencyCopilotSessionId, TaskboardTask, TaskId } from '@deepseek-ai/dsh-taskboard/types'
import TaskboardController from '../src/index.ts'
import { AgencyCopilotHost } from '../src/agency.ts'

const taskId = 'task' as TaskId
const task: TaskboardTask = {
  id: taskId, revision: 1, ordinal: 1, workspaceId: 'workspace' as TaskboardTask['workspaceId'],
  title: 'Start Copilot', description: '', status: 'todo', rank: 0, labels: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

function bench(options: {
  failLaunch?: boolean
  failResolve?: boolean
  launchEnabled?: boolean
  platform?: NodeJS.Platform
  initialTask?: TaskboardTask
} = {}) {
  const ctx = new Context()
  const order: string[] = []
  let current = options.initialTask ?? task
  const setAgencyCopilotSession = vi.fn(async (input: {
    agencyCopilotSessionId: AgencyCopilotSessionId | null
  }) => {
    order.push('commit')
    current = {
      ...current,
      revision: current.revision + 1,
      ...(input.agencyCopilotSessionId === null ? {} : { agencyCopilotSessionId: input.agencyCopilotSessionId }),
    }
    return current
  })
  const move = vi.fn(async () => {
    current = { ...current, revision: current.revision + 1, status: 'in_progress' }
    return current
  })
  ctx.provide('taskboard', {
    get: (id: TaskId) => id === taskId ? current : undefined,
    list: () => [current],
    setAgencyCopilotSession,
    move,
    archive: vi.fn(),
  } as never)
  ctx.provide('workspaceRegistry', {
    get: () => ({ id: task.workspaceId, path: process.cwd() }),
  } as never)
  ctx.provide('subprocess', {
    resolveExecutable: vi.fn(async (command: string) => {
      if (options.failResolve === true) throw new Error('missing executable')
      return command === 'agency.exe' ? 'C:\\Agency\\agency.exe' : 'C:\\WindowsApps\\wt.exe'
    }),
  } as never)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose },
  } as never)
  const launch = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => {
    order.push('launch')
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn(() => child)
    queueMicrotask(() => {
      if (options.failLaunch === true) child.emit('error', new Error('broker failed'))
      else child.emit('spawn')
    })
    return child
  })
  const controller = new TaskboardController(
    ctx,
    { agencyCopilotLaunch: options.launchEnabled ?? true },
    { agency: { platform: options.platform ?? 'win32', spawnBroker: launch } },
  )
  return { controller, launch, order, setAgencyCopilotSession }
}

describe('TaskboardController Agency Copilot saga', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('commits the Host-generated UUID before the fixed terminal handoff', async () => {
    const b = bench()
    const result = await b.controller.startAgencyCopilot(
      { taskId, expectedRevision: 1 }, new AbortController().signal)
    expect(result.task.agencyCopilotSessionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(b.order).toEqual(['commit', 'launch'])
    const committed = b.setAgencyCopilotSession.mock.calls[0]?.[0].agencyCopilotSessionId
    expect(b.launch.mock.calls[0]?.[1]).toContain(committed)
    expect(b.launch.mock.calls[0]?.[1].slice(-2)).toEqual(['--interactive', task.title])
  })

  it('submits the persisted title and description as one initial user prompt', async () => {
    const b = bench({ initialTask: {
      ...task, title: 'Investigate the failure', description: 'Check the logs.\nKeep the existing behavior.',
    } })
    await b.controller.startAgencyCopilot({ taskId, expectedRevision: 1 }, new AbortController().signal)

    expect(b.launch.mock.calls[0]?.[1].slice(-2)).toMatchInlineSnapshot(`
      [
        "--interactive",
        "Investigate the failure

      Check the logs.
      Keep the existing behavior.",
      ]
    `)
  })

  it.each(['idle', 'in_use', 'missing', 'unknown'] as const)(
    'handles %s linked-session state without replaying work in existing sessions',
    async (status) => {
      const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
      const b = bench({ initialTask: { ...task, agencyCopilotSessionId: sessionId, description: 'Inspect the logs.' } })
      vi.spyOn(AgencyCopilotHost.prototype, 'inspect').mockResolvedValue({
        sessions: status === 'idle' || status === 'in_use'
          ? new Map([[sessionId, { sessionId, status, folder: process.cwd() }]])
          : new Map(),
        complete: status !== 'unknown',
      })
      const opening = b.controller.openAgencyCopilot({ taskId }, new AbortController().signal)
      switch (status) {
        case 'idle':
          await expect(opening).resolves.toEqual({ outcome: 'resume-accepted' })
          expect(b.launch.mock.calls[0]?.[1].slice(-2)).toEqual(['copilot', '--resume=' + sessionId])
          break
        case 'in_use':
          await expect(opening).resolves.toEqual({ outcome: 'already-running' })
          expect(b.launch).not.toHaveBeenCalled()
          break
        case 'missing':
          await expect(opening).resolves.toEqual({ outcome: 'create-retry-accepted' })
          expect(b.launch.mock.calls[0]?.[1].slice(-4)).toEqual([
            '--session-id', sessionId, '--interactive', 'Start Copilot\n\nInspect the logs.',
          ])
          break
        case 'unknown':
          await expect(opening).rejects.toMatchObject({ code: 'taskboard/agency-unavailable' })
          expect(b.launch).not.toHaveBeenCalled()
          break
      }
      expect(b.setAgencyCopilotSession).not.toHaveBeenCalled()
    },
  )

  it('coalesces an immediate Open after fresh Start without a second terminal', async () => {
    const b = bench()
    await b.controller.startAgencyCopilot({ taskId, expectedRevision: 1 }, new AbortController().signal)
    const opened = await b.controller.openAgencyCopilot({ taskId }, new AbortController().signal)
    expect(opened).toEqual({ outcome: 'launch-pending' })
    expect(b.launch).toHaveBeenCalledOnce()
  })

  it('rejects unsupported platforms and missing executables before durability', async () => {
    const cases = [
      { bench: bench({ platform: 'linux' }), code: 'taskboard/agency-local-only' },
      { bench: bench({ failResolve: true }), code: 'taskboard/agency-launch-failed' },
    ] as const
    for (const entry of cases) {
      await expect(entry.bench.controller.startAgencyCopilot(
        { taskId, expectedRevision: 1 }, new AbortController().signal,
      )).rejects.toMatchObject({ code: entry.code })
      expect(entry.bench.setAgencyCopilotSession).not.toHaveBeenCalled()
      expect(entry.bench.launch).not.toHaveBeenCalled()
    }
  })

  it('launches nothing for a stale revision', async () => {
    const b = bench()
    await expect(b.controller.startAgencyCopilot(
      { taskId, expectedRevision: 99 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'taskboard/revision-conflict' })
    expect(b.setAgencyCopilotSession).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('rejects Start and Open for archived tasks and excludes them from Agency inspection', async () => {
    const sessionId = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as AgencyCopilotSessionId
    const b = bench({ initialTask: {
      ...task, agencyCopilotSessionId: sessionId, archivedAt: '2026-01-02T00:00:00.000Z',
    } })
    const inspect = vi.spyOn(AgencyCopilotHost.prototype, 'inspect')
    await expect(b.controller.startAgencyCopilot(
      { taskId, expectedRevision: 1 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'taskboard/task-archived' })
    await expect(b.controller.openAgencyCopilot(
      { taskId }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'taskboard/task-archived' })
    await expect(b.controller.inspectAgencyCopilot(
      { taskIds: [taskId] }, new AbortController().signal,
    )).resolves.toEqual({ observations: [] })
    expect(inspect).toHaveBeenCalledWith([], expect.any(AbortSignal))
    expect(b.setAgencyCopilotSession).not.toHaveBeenCalled()
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('rejects native launch when the Host Web server is not loopback-bound', async () => {
    const b = bench({ launchEnabled: false })
    expect(b.controller.agencyCopilotCapability()).toEqual({ launch: false })
    await expect(b.controller.startAgencyCopilot(
      { taskId, expectedRevision: 1 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'taskboard/agency-local-only' })
    expect(b.launch).not.toHaveBeenCalled()
  })

  it('retains the committed UUID when terminal handoff fails', async () => {
    const b = bench({ failLaunch: true })
    await expect(b.controller.startAgencyCopilot(
      { taskId, expectedRevision: 1 }, new AbortController().signal,
    )).rejects.toMatchObject({ code: 'taskboard/agency-launch-failed' })
    expect(b.order).toEqual(['commit', 'launch'])
    expect(b.setAgencyCopilotSession).toHaveBeenCalledOnce()
  })
})
