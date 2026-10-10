import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TaskboardInputError, TaskboardMoveInvalidError, TaskboardRevisionConflictError, TaskboardSessionInvalidError,
  TaskboardTaskArchivedError, TaskboardTaskNotFoundError, TaskboardWorkspaceNotFoundError,
} from '@deepseek-ai/dsh-taskboard'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { cleanupControllerHarness, controllerHarness, initialRuntime, roots } from './controller-harness.ts'

afterEach(cleanupControllerHarness)
const harness = (pool = new MemoryMediaPool()) => controllerHarness({ pool })

describe('Taskboard archive feed', () => {
  it('moves Todo tasks to every other column through the Host API', async () => {
    const { controller, workspace } = await harness()
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      const { task } = await controller.create({ workspaceId: workspace.id, title: `Move to ${status}` })
      expect(task.allowedManualStatuses).toEqual(['backlog', 'in_progress', 'in_review', 'done'])
      const { task: moved } = await controller.move({ taskId: task.id, expectedRevision: task.revision, status })
      expect(moved.status).toBe(status)
      expect(moved.allowedManualStatuses).not.toContain(status)
    }
  })

  it('maps owned business failures to Error instances with namespaced codes and typed details', async () => {
    const { ctx, controller, workspace } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Failure mapping' })
    const sessionId = SessionId('missing')
    const cases = [
      [new TaskboardInputError('Invalid task'), 'taskboard/bad-request', {}],
      [new TaskboardTaskNotFoundError(task.id), 'taskboard/task-not-found', { taskId: task.id }],
      [new TaskboardTaskArchivedError(task.id), 'taskboard/task-archived', { taskId: task.id }],
      [new TaskboardWorkspaceNotFoundError(workspace.id), 'taskboard/workspace-not-found', { workspaceId: workspace.id }],
      [new TaskboardRevisionConflictError(task.id, 1, 2), 'taskboard/revision-conflict', {
        taskId: task.id, expectedRevision: 1, actualRevision: 2,
      }],
      [new TaskboardSessionInvalidError(workspace.id, sessionId), 'taskboard/session-invalid', {
        workspaceId: workspace.id, sessionId,
      }],
      [new TaskboardMoveInvalidError(task.id), 'taskboard/move-invalid', { beforeTaskId: task.id }],
    ] as const
    const create = vi.spyOn(ctx.taskboard, 'create')
    for (const [error, code, details] of cases) {
      create.mockRejectedValueOnce(error)
      const result = controller.create({ workspaceId: workspace.id, title: 'Rejected' })
      await expect(result).rejects.toBeInstanceOf(Error)
      const failure = remoteErrorOf(await result.catch((caught: unknown) => caught))
      expect(failure).toMatchObject({ code, message: error.message, details })
      expect(failure).not.toHaveProperty('failure')
    }
  })

  it('preserves a structurally marked Remote error from another module copy', async () => {
    const { ctx, controller, workspace } = await harness()
    const error = Object.assign(new Error('Provider refused the task'), {
      isDSHRemoteError: true as const, code: 'taskboard/bad-request' as const, details: {},
    })
    vi.spyOn(ctx.taskboard, 'create').mockRejectedValueOnce(error)
    await expect(controller.create({ workspaceId: workspace.id, title: 'Rejected' })).rejects.toBe(error)
  })

  it('queues an archive upsert after an in-flight active baseline and lists the archived record', async () => {
    const { ctx, controller, workspace, follow } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Review', status: 'in_review' })
    const stream = follow()
    const baseline = stream.next()
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    expect(await baseline).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [task], runtime: initialRuntime } } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task: archived } })
    expect(archived.status).toBe('in_review')
    expect(typeof archived.archivedAt).toBe('string')
    expect(ctx.taskboard.list()).toEqual([])
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived], runtime: initialRuntime })
    await expect(controller.list({ workspaceId: workspace.id })).resolves.toEqual({ tasks: [archived], runtime: initialRuntime })
    expect(await follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [archived], runtime: initialRuntime } },
    })
  })

  it('includes durable archived records after the Host projection reopens', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const { task } = await first.controller.create({ workspaceId: first.workspace.id, title: 'Durable archive' })
    const { task: archived } = await first.controller.archive({ taskId: task.id, expectedRevision: task.revision })
    await first.ctx.fiber.dispose()
    roots.splice(roots.indexOf(first.ctx), 1)
    const reopened = await harness(pool)
    await expect(reopened.controller.list({})).resolves.toEqual({ tasks: [archived], runtime: initialRuntime })
    expect(await reopened.follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [archived], runtime: initialRuntime } },
    })
  })

  it('rejects a stale archive without removing the task and releases the lock for the current revision', async () => {
    const { controller, workspace, follow } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Review', status: 'done' })
    const { task: updated } = await controller.update({
      taskId: task.id, expectedRevision: task.revision, patch: { description: 'Review complete' },
    })
    await expect(controller.archive({ taskId: task.id, expectedRevision: task.revision }))
      .rejects.toMatchObject({ code: 'taskboard/revision-conflict' })
    await expect(controller.list({})).resolves.toEqual({ tasks: [updated], runtime: initialRuntime })
    const stream = follow()
    expect(await stream.next()).toMatchObject({ value: { type: 'baseline', value: { tasks: [updated] } } })
    const { task: archived } = await controller.archive({ taskId: updated.id, expectedRevision: updated.revision })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task: archived } })
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived], runtime: initialRuntime })
  })

  it('removes both active and archived Workspace rows without affecting another Workspace', async () => {
    const { ctx, controller, workspace, follow } = await harness()
    const other = await ctx.workspaceRegistry.create(resolve('packages', 'api', 'taskboard-controller'))
    const { task: active } = await controller.create({ workspaceId: workspace.id, title: 'Active' })
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Archived' })
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    const { task: retained } = await controller.create({ workspaceId: other.id, title: 'Retained' })
    const stream = follow()
    expect(await stream.next()).toMatchObject({ value: { type: 'baseline', value: { tasks: [active, retained, archived] } } })
    await ctx.workspaceRegistry.delete(workspace.id)
    for (const row of [active, archived]) {
      expect(await stream.next()).toEqual({
        done: false, value: { type: 'remove', taskId: row.id, revision: Number.MAX_SAFE_INTEGER },
      })
    }
    await expect(controller.list({})).resolves.toEqual({ tasks: [retained], runtime: initialRuntime })
    await expect(controller.list({ workspaceId: workspace.id })).resolves.toEqual({ tasks: [], runtime: initialRuntime })
    expect(await follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [retained], runtime: initialRuntime } },
    })
    expect(ctx.taskboard.list(workspace.id, true)).toEqual([active, archived])
    await controller.update({ taskId: active.id, expectedRevision: active.revision, patch: { title: 'Late edit' } })
    expect(await stream.next()).toEqual({
      done: false, value: { type: 'remove', taskId: active.id, revision: Number.MAX_SAFE_INTEGER },
    })
  })

  it('publishes actual task-record deletion as a removal, not an archive upsert', async () => {
    const { facility, controller, workspace, follow } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Deleted' })
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    const stream = follow()
    expect(await stream.next()).toMatchObject({ value: { type: 'baseline', value: { tasks: [archived] } } })
    await facility.get('taskboard')!.table('tasks').delete(task.id)
    expect(await stream.next()).toEqual({
      done: false, value: { type: 'remove', taskId: task.id, revision: Number.MAX_SAFE_INTEGER },
    })
    await expect(controller.list({})).resolves.toEqual({ tasks: [], runtime: initialRuntime })
  })

  it.each([false, true])('publishes a delete receipt matching its feed tombstone and reconnects without the task (archived=%s)', async (archived) => {
    const b = await harness()
    const { task } = await b.controller.create({ workspaceId: b.workspace.id, title: 'Delete', status: 'in_review' })
    const current = archived
      ? (await b.controller.archive({ taskId: task.id, expectedRevision: task.revision })).task
      : task
    const stream = b.follow()
    const baseline = stream.next()
    const receipt = await b.controller.delete({ taskId: current.id, expectedRevision: current.revision })
    expect(await baseline).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [current], runtime: initialRuntime } } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'remove', ...receipt } })
    expect(receipt).toEqual({ taskId: current.id, revision: Number.MAX_SAFE_INTEGER })
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [], runtime: initialRuntime })
    expect(await b.follow().next()).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [], runtime: initialRuntime } } })
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness(b.pool)
    await expect(reopened.controller.list({})).resolves.toEqual({ tasks: [], runtime: initialRuntime })
    expect(await reopened.follow().next()).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [], runtime: initialRuntime } } })
    expect(reopened.ctx.workspaceRegistry.get(b.workspace.id)).toBeDefined()
  })

  it('publishes no removal for stale or failed deletion and permits an explicit successful retry', async () => {
    const b = await harness()
    const { task } = await b.controller.create({ workspaceId: b.workspace.id, title: 'Retain on failure' })
    const { task: edited } = await b.controller.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Current revision' },
    })
    const stream = b.follow()
    await stream.next()
    await expect(b.controller.delete({ taskId: task.id, expectedRevision: task.revision }))
      .rejects.toMatchObject({ code: 'taskboard/revision-conflict' })
    b.pool.failNextWrites = 1
    await expect(b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision }))
      .rejects.toThrow('injected write failure')
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [edited], runtime: initialRuntime })
    const changed = vi.fn()
    const next = stream.next()
    void next.then(changed)
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()
    const receipt = await b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision })
    expect(await next).toEqual({ done: false, value: { type: 'remove', ...receipt } })
    await expect(b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision }))
      .rejects.toMatchObject({ code: 'taskboard/task-not-found', details: { taskId: edited.id } })
  })

  it('publishes one committed tombstone before the next task change, without a duplicate unary removal', async () => {
    const b = await harness()
    const { task } = await b.controller.create({ workspaceId: b.workspace.id, title: 'Delete once' })
    const stream = b.follow()
    await stream.next()
    const receipt = await b.controller.delete({ taskId: task.id, expectedRevision: task.revision })
    const { task: next } = await b.controller.create({ workspaceId: b.workspace.id, title: 'Next change' })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'remove', ...receipt } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task: next } })
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [next], runtime: initialRuntime })
  })

  it('rejects ordinary mutations and ignores Agency inspection for archived records', async () => {
    const { controller, workspace } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Read only' })
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    await expect(controller.update({
      taskId: task.id, expectedRevision: archived.revision, patch: { title: 'Changed' },
    })).rejects.toMatchObject({ code: 'taskboard/task-archived' })
    await expect(controller.move({
      taskId: task.id, expectedRevision: archived.revision, status: 'done',
    })).rejects.toMatchObject({ code: 'taskboard/task-archived' })
    await expect(controller.disconnect({
      taskId: task.id, expectedRevision: archived.revision,
    })).rejects.toMatchObject({ code: 'taskboard/task-archived' })
    await expect(controller.inspectAgencyCopilot({
      taskIds: [task.id],
    }, new AbortController().signal)).resolves.toEqual({ observations: [] })
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived], runtime: initialRuntime })
  })

  it('orders runtime changes behind the captured baseline and includes the latest state on reconnect', async () => {
    const b = await harness()
    const stream = b.follow()
    const baseline = stream.next()
    const next = {
      ...initialRuntime,
      settings: { enabled: true, announceToAgent: true, preventIdleSleep: true },
      power: { ...initialRuntime.power, phase: 'active' as const, runningSessions: 2 },
      scheduler: { lastTickAt: '2026-09-09T00:00:00.000Z' },
    }
    b.runtime.emit(next)
    const { task } = await b.controller.create({ workspaceId: b.workspace.id, title: 'Queued after runtime' })
    expect(await baseline).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [], runtime: initialRuntime } } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'runtime', value: next } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task } })
    expect(await b.controller.list({})).toEqual({ tasks: [task], runtime: next })
    expect(await b.follow().next()).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [task], runtime: next } } })
    expect(b.runtime.run).not.toHaveBeenCalled()
  })

  it('unsubscribes runtime observations and completes waiting followers before Host disposal returns', async () => {
    const b = await harness()
    const stream = b.follow()
    await stream.next()
    const waiting = stream.next()
    const late = b.runtime.subscribe.mock.calls[0]![0]
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    expect(await waiting).toMatchObject({ done: true })
    expect(b.runtime.lifecycle).toEqual(['subscribe', 'unsubscribe', 'dispose'])
    expect(b.runtime.unsubscribe).toHaveBeenCalledOnce()
    expect(b.runtime.dispose).toHaveBeenCalledOnce()
    expect(b.runtime.listeners.size).toBe(0)
    b.runtime.emit({ ...initialRuntime, scheduler: { error: 'Late observation' } })
    late({ ...initialRuntime, error: 'Observation queued before unsubscribe' })
    expect(await stream.next()).toMatchObject({ done: true })
  })

  it('refuses cancelled generations and ends a slow generation rather than delivering an incomplete queue', async () => {
    const b = await harness()
    const cancelled = new AbortController()
    cancelled.abort(new Error('Generation cancelled'))
    await expect(b.controller.follow(cancelled.signal)[Symbol.asyncIterator]().next()).rejects.toThrow('Generation cancelled')
    const stream = b.follow()
    await stream.next()
    for (let runningSessions = 1; runningSessions <= 1_026; runningSessions++) {
      b.runtime.emit({ ...initialRuntime, power: { ...initialRuntime.power, runningSessions } })
    }
    expect(await stream.next()).toMatchObject({ done: true })
    expect(await b.follow().next()).toMatchObject({
      value: { type: 'baseline', value: { runtime: { power: { runningSessions: 1_026 } } } },
    })
  })
})
