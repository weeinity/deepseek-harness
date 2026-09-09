import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import TaskboardService from '@deepseek-ai/dsh-taskboard'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskboardController from '../src/index.ts'

const roots: Context[] = []
const signals: AbortController[] = []
afterEach(async () => {
  for (const signal of signals.splice(0)) signal.abort()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [] } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TaskboardService)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose }, contexts: { configureHost: () => dispose },
  } as never)
  const controller = new TaskboardController(ctx)
  const workspace = await ctx.workspaceRegistry.create(process.cwd())
  const follow = () => {
    const signal = new AbortController()
    signals.push(signal)
    return controller.follow(signal.signal)[Symbol.asyncIterator]()
  }
  return { ctx, facility, controller, workspace, follow, pool }
}

describe('Taskboard archive feed', () => {
  it('queues an archive upsert after an in-flight active baseline and lists the archived record', async () => {
    const { ctx, controller, workspace, follow } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Review', status: 'in_review' })
    const stream = follow()
    const baseline = stream.next()
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    expect(await baseline).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [task] } } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task: archived } })
    expect(archived.status).toBe('in_review')
    expect(typeof archived.archivedAt).toBe('string')
    expect(ctx.taskboard.list()).toEqual([])
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived] })
    await expect(controller.list({ workspaceId: workspace.id })).resolves.toEqual({ tasks: [archived] })
    expect(await follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [archived] } },
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
    await expect(reopened.controller.list({})).resolves.toEqual({ tasks: [archived] })
    expect(await reopened.follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [archived] } },
    })
  })

  it('rejects a stale archive without removing the task and releases the lock for the current revision', async () => {
    const { controller, workspace, follow } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Review', status: 'done' })
    const { task: updated } = await controller.update({
      taskId: task.id, expectedRevision: task.revision, patch: { description: 'Review complete' },
    })
    await expect(controller.archive({ taskId: task.id, expectedRevision: task.revision }))
      .rejects.toMatchObject({ failure: { code: 'revision-conflict' } })
    await expect(controller.list({})).resolves.toEqual({ tasks: [updated] })
    const stream = follow()
    expect(await stream.next()).toMatchObject({ value: { type: 'baseline', value: { tasks: [updated] } } })
    const { task: archived } = await controller.archive({ taskId: updated.id, expectedRevision: updated.revision })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'upsert', task: archived } })
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived] })
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
    await expect(controller.list({})).resolves.toEqual({ tasks: [retained] })
    await expect(controller.list({ workspaceId: workspace.id })).resolves.toEqual({ tasks: [] })
    expect(await follow().next()).toEqual({
      done: false, value: { type: 'baseline', value: { tasks: [retained] } },
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
    await expect(controller.list({})).resolves.toEqual({ tasks: [] })
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
    expect(await baseline).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [current] } } })
    expect(await stream.next()).toEqual({ done: false, value: { type: 'remove', ...receipt } })
    expect(receipt).toEqual({ taskId: current.id, revision: Number.MAX_SAFE_INTEGER })
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [] })
    expect(await b.follow().next()).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [] } } })
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness(b.pool)
    await expect(reopened.controller.list({})).resolves.toEqual({ tasks: [] })
    expect(await reopened.follow().next()).toEqual({ done: false, value: { type: 'baseline', value: { tasks: [] } } })
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
      .rejects.toMatchObject({ failure: { code: 'revision-conflict' } })
    b.pool.failNextWrites = 1
    await expect(b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision }))
      .rejects.toThrow('injected write failure')
    await expect(b.controller.list({})).resolves.toEqual({ tasks: [edited] })
    const changed = vi.fn()
    const next = stream.next()
    void next.then(changed)
    await Promise.resolve()
    expect(changed).not.toHaveBeenCalled()
    const receipt = await b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision })
    expect(await next).toEqual({ done: false, value: { type: 'remove', ...receipt } })
    await expect(b.controller.delete({ taskId: edited.id, expectedRevision: edited.revision }))
      .rejects.toMatchObject({ failure: { code: 'task-not-found', details: { taskId: edited.id } } })
  })

  it('rejects ordinary mutations and ignores Agency inspection for archived records', async () => {
    const { controller, workspace } = await harness()
    const { task } = await controller.create({ workspaceId: workspace.id, title: 'Read only' })
    const { task: archived } = await controller.archive({ taskId: task.id, expectedRevision: task.revision })
    await expect(controller.update({
      taskId: task.id, expectedRevision: archived.revision, patch: { title: 'Changed' },
    })).rejects.toMatchObject({ failure: { code: 'task-archived' } })
    await expect(controller.move({
      taskId: task.id, expectedRevision: archived.revision, status: 'done',
    })).rejects.toMatchObject({ failure: { code: 'task-archived' } })
    await expect(controller.clearAgencyCopilot({
      taskId: task.id, expectedRevision: archived.revision,
    })).rejects.toMatchObject({ failure: { code: 'task-archived' } })
    await expect(controller.inspectAgencyCopilot({
      taskIds: [task.id],
    }, new AbortController().signal)).resolves.toEqual({ observations: [] })
    await expect(controller.list({})).resolves.toEqual({ tasks: [archived] })
  })
})
