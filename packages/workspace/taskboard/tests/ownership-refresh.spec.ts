import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  createTaskboardOwnershipCapability, TaskboardRevisionConflictError, TaskboardTaskNotFoundError,
} from '../src/index.ts'
import { cleanup, harness, request } from './harness.ts'

const directories: string[] = []
afterEach(async () => {
  await cleanup()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('post-ownership materialization', () => {
  it('reloads SQLite commits and deletions made after a second Host materialized its old cache', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'packages', 'workspace', 'taskboard', '.taskboard-ownership-'))
    directories.push(directory)
    const path = join(directory, 'tasks.sqlite')
    const config = { executionHistoryLimit: 1, requestDeduplicationLimit: 3 }
    const first = await harness({ backend: new SqliteStorageBackend({ path, journalMode: 'delete' }), config })
    const initial = await first.board.create({ workspaceId: first.workspaceId, title: 'Initial', labels: ['retain'] })
    const deleted = await first.board.create({ workspaceId: first.workspaceId, title: 'Deleted before handoff' })
    const second = await harness({ backend: new SqliteStorageBackend({ path, journalMode: 'delete' }), config })
    expect(second.board.get(initial.id)).toEqual(initial)
    let latest = await first.board.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Committed after the second cache loaded' },
    })
    const originalRequest = request(latest, 'handoff-1')
    const original = await first.board.beginExecution(originalRequest)
    latest = await first.board.settleExecution({
      taskId: latest.id, executionId: original.executionId, status: 'failed',
    })
    const settled = await first.board.beginExecution(request(latest, 'handoff-2'))
    latest = await first.board.settleExecution({
      taskId: latest.id, executionId: settled.executionId, status: 'failed',
    })
    const pending = await first.board.beginExecution(request(latest, 'handoff-3'))
    latest = await first.board.attachExecution({
      taskId: latest.id, executionId: pending.executionId, connection: pending.task.connection!,
      receipt: { kind: 'dsh', afterSequence: 7, messageId: 'submitted-before-owner-exit' },
    })
    const added = await first.board.create({ workspaceId: first.workspaceId, title: 'Added before handoff' })
    await first.board.delete(deleted.id, deleted.revision)
    await first.ctx.fiber.dispose()
    expect(second.board.get(initial.id)).toEqual(initial)
    expect(second.board.getRunRequest(originalRequest)).toBeUndefined()
    expect(second.board.get(added.id)).toBeUndefined()
    expect(second.board.get(deleted.id)).toEqual(deleted)

    const verifyOwnership = vi.fn(async () => {})
    const changed = vi.fn()
    second.ctx.on('domain/changed', changed)
    await createTaskboardOwnershipCapability(second.board, verifyOwnership).refresh()
    expect(verifyOwnership).toHaveBeenCalledTimes(2)
    expect(changed).not.toHaveBeenCalled()
    expect(second.board.get(initial.id)).toEqual(latest)
    expect(latest.executions.map(execution => execution.id)).toEqual([settled.executionId, pending.executionId])
    expect(second.board.getRunRequest(originalRequest)).toEqual({
      task: latest, executionId: original.executionId, replayed: true,
    })
    expect(await second.board.beginExecution(originalRequest)).toEqual({
      task: latest, executionId: original.executionId, replayed: true,
    })
    expect(second.board.get(added.id)).toEqual(added)
    expect(second.board.get(deleted.id)).toBeUndefined()
    await expect(second.board.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { description: 'Stale writer' },
    })).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    await expect(second.board.update({
      taskId: deleted.id, expectedRevision: deleted.revision, patch: { title: 'Resurrect deleted task' },
    })).rejects.toBeInstanceOf(TaskboardTaskNotFoundError)
    const updated = await second.board.update({
      taskId: latest.id, expectedRevision: latest.revision, patch: { description: 'New owner' },
    })
    expect(updated).toMatchObject({ title: latest.title, labels: ['retain'], description: 'New owner' })
  })

  it('queues mutation CAS behind an in-progress fresh materialization instead of using the old table', async () => {
    const first = await harness()
    const initial = await first.board.create({ workspaceId: first.workspaceId, title: 'Initial' })
    const second = await harness({ pool: first.pool })
    const latest = await first.board.update({
      taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Latest committed title' },
    })
    await first.ctx.fiber.dispose()
    const open = second.facility.open.bind(second.facility)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    vi.spyOn(second.facility, 'open').mockImplementationOnce(async (spec) => {
      entered.resolve(undefined)
      await resume.promise
      return open(spec)
    })
    const refresh = createTaskboardOwnershipCapability(second.board, async () => {}).refresh()
    try {
      await Promise.race([entered.promise, refresh])
      expect(() => second.board.get(initial.id)).toThrow('not initialized')
      const editing = second.board.update({
        taskId: initial.id, expectedRevision: initial.revision, patch: { title: 'Stale edit' },
      })
      const completing = Promise.all([refresh, expect(editing).rejects.toBeInstanceOf(TaskboardRevisionConflictError)])
      resume.resolve(undefined)
      await completing
      expect(second.board.get(initial.id)).toEqual(latest)
    } finally {
      resume.resolve(undefined)
      await Promise.allSettled([refresh])
    }
  })

  it.each([1, 2])('fails closed when ownership verification %s rejects and permits a verified retry', async (failureAt) => {
    const { board, workspaceId, facility } = await harness()
    const task = await board.create({ workspaceId, title: 'Retained' })
    let calls = 0
    const { refresh } = createTaskboardOwnershipCapability(board, async () => {
      if (++calls === failureAt) throw new Error('ownership unavailable')
    })
    await expect(refresh()).rejects.toThrow('ownership unavailable')
    expect(facility.get('taskboard')).toBeUndefined()
    expect(() => board.get(task.id)).toThrow('not initialized')
    await expect(board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Unsafe' } }))
      .rejects.toThrow('not initialized')
    await refresh()
    expect(board.get(task.id)).toEqual(task)
  })

  it('refuses malformed fresh storage without exposing the previously cached record', async () => {
    const { board, workspaceId, pool, facility } = await harness()
    const task = await board.create({ workspaceId, title: 'Previously cached' })
    const records = pool.media.get('taskboard')!.tables.get('tasks')!
    const retained = records.get(task.id)
    records.set(task.id, { invalid: 'persisted data' })
    const { refresh } = createTaskboardOwnershipCapability(board, async () => {})
    await expect(refresh()).rejects.toThrow()
    expect(facility.get('taskboard')).toBeUndefined()
    expect(() => board.list()).toThrow('not initialized')
    expect(records.get(task.id)).toEqual({ invalid: 'persisted data' })
    records.set(task.id, retained)
    await refresh()
    expect(board.get(task.id)).toEqual(task)
  })

  it('closes the current reopened domain when the service is disposed', async () => {
    const { board, ctx, facility } = await harness()
    const initial = facility.get('taskboard')
    await createTaskboardOwnershipCapability(board, async () => {}).refresh()
    expect(facility.get('taskboard')).not.toBe(initial)
    await ctx.fiber.dispose()
    expect(facility.get('taskboard')).toBeUndefined()
  })

  it.each([1, 2])('drains startup cancelled during ownership verification %s without leaving a domain open', async (pauseAt) => {
    const { board, ctx, facility } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    let checks = 0
    const { refresh } = createTaskboardOwnershipCapability(board, async () => {
      if (++checks === pauseAt) {
        entered.resolve(undefined)
        await resume.promise
      }
    })
    const refreshing = refresh()
    try {
      await Promise.race([entered.promise, refreshing])
      const disposal = ctx.fiber.dispose()
      const completing = Promise.all([expect(refreshing).rejects.toThrow('closing'), disposal])
      resume.resolve(undefined)
      await completing
      expect(facility.get('taskboard')).toBeUndefined()
      await expect(refresh()).rejects.toThrow('closing')
    } finally {
      resume.resolve(undefined)
      await Promise.allSettled([refreshing])
    }
  })
})
