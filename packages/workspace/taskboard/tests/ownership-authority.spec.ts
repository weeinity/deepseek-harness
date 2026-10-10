import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { createTaskboardOwnershipCapability, nextTaskScheduleRun } from '../src/index.ts'
import { cleanup, dsh, harness, request, schedule } from './harness.ts'

afterEach(cleanup)

describe('Host write authority', () => {
  it.each([
    'create', 'update', 'move', 'archive', 'restore', 'confirm', 'delete',
    'duplicate', 'connect', 'disconnect', 'begin',
  ] as const)('rejects %s after ownership loss without changing durable planning state', async (command) => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Active', connection: dsh })
    const archived = await board.create({ workspaceId, title: 'Archived' })
    const hidden = await board.archive(archived.id, archived.revision)
    const lifetime = new AbortController()
    const capability = createTaskboardOwnershipCapability(board, async () => { lifetime.signal.throwIfAborted() })
    await capability.refresh()
    const before = board.list(undefined, true)
    const durable = structuredClone(pool.media.get('taskboard'))
    const lost = Object.assign(new Error('fixture ownership lost'), { code: 'ownership-lost' })
    const mutations = {
      create: () => board.create({ workspaceId, title: 'New task' }),
      update: () => board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Edited' } }),
      move: () => board.move({ taskId: task.id, expectedRevision: task.revision, status: 'backlog' }),
      archive: () => board.archive(task.id, task.revision),
      restore: () => board.restore(hidden.id, hidden.revision),
      confirm: () => board.confirmPermissions(task.id, task.revision),
      delete: () => board.delete(task.id, task.revision),
      duplicate: () => board.duplicate({ taskId: task.id, expectedRevision: task.revision }),
      connect: () => board.connect({ taskId: task.id, expectedRevision: task.revision, connection: dsh }),
      disconnect: () => board.disconnect(task.id, task.revision),
      begin: () => board.beginExecution(request(task)),
    }
    lifetime.abort(lost)
    await expect(mutations[command]()).rejects.toBe(lost)
    expect(board.list(undefined, true)).toEqual(before)
    expect(pool.media.get('taskboard')).toEqual(durable)
    await createTaskboardOwnershipCapability(board, async () => {}).refresh()
    await expect(mutations[command]()).resolves.toBeDefined()
  })

  it('fences receipts, diagnostics, outcomes and schedule advancement when the owner is lost', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Running task' })
    const scheduled = await board.create({ workspaceId, title: 'Scheduled task', schedule })
    const lifetime = new AbortController()
    await createTaskboardOwnershipCapability(board, async () => { lifetime.signal.throwIfAborted() }).refresh()
    const admitted = await board.beginExecution(request(task))
    const receipt = { kind: 'dsh' as const, afterSequence: 1 }
    const attached = await board.attachExecution({
      taskId: task.id, executionId: admitted.executionId, connection: dsh, receipt,
    })
    const durable = structuredClone(pool.media.get('taskboard'))
    const lost = new Error('owner lost while observing')
    lifetime.abort(lost)
    const identity = { taskId: task.id, executionId: admitted.executionId }
    const due = scheduled.schedule!.nextRunAt!
    await Promise.all([
      expect(board.attachExecution({ ...identity, connection: dsh, receipt })).rejects.toBe(lost),
      expect(board.advanceExecution(identity)).rejects.toBe(lost),
      expect(board.recordExecutionError({ ...identity, error: { code: 'uncertain', message: 'Observe again' } })).rejects.toBe(lost),
      expect(board.settleExecution({ ...identity, status: 'failed' })).rejects.toBe(lost),
      expect(board.rollForwardSchedule({
        taskId: scheduled.id, scheduledAt: due, nextRunAt: nextTaskScheduleRun(schedule, due), now: due,
      })).rejects.toBe(lost),
    ])
    expect(pool.media.get('taskboard')).toEqual(durable)
    expect(board.get(task.id)).toEqual(attached)
  })

  it.each([false, true])('replaces an aborted owner without consulting it (already drained: %s)', async (drained) => {
    const { board, workspaceId } = await harness()
    const lifetime = new AbortController()
    const verifyOld = vi.fn(async () => { lifetime.signal.throwIfAborted() })
    const oldOwner = createTaskboardOwnershipCapability(board, verifyOld)
    await oldOwner.refresh()
    const task = await board.create({ workspaceId, title: 'Original' })
    lifetime.abort(new Error('retired Runtime'))
    if (drained) await oldOwner.drain()
    const checks = verifyOld.mock.calls.length
    const verifyNew = vi.fn(async () => {})
    const newOwner = createTaskboardOwnershipCapability(board, verifyNew)
    await newOwner.refresh()
    expect(verifyOld).toHaveBeenCalledTimes(checks)
    expect(verifyNew).toHaveBeenCalledTimes(2)
    await expect(oldOwner.refresh()).rejects.toMatchObject({ code: 'ownership-lost' })
    await oldOwner.drain()
    const updated = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'New owner' },
    })
    expect(updated.title).toBe('New owner')
    expect(verifyOld).toHaveBeenCalledTimes(checks)
  })

  it('does not authorize an old queued caller with the successor verifier', async () => {
    const { board, workspaceId } = await harness()
    const oldOwner = createTaskboardOwnershipCapability(board, async () => {})
    await oldOwner.refresh()
    await oldOwner.drain()
    const successor = createTaskboardOwnershipCapability(board, async () => {})
    const refreshing = successor.refresh()
    const stale = board.create({ workspaceId, title: 'Queued under the retired owner' })
    await Promise.all([refreshing, expect(stale).rejects.toMatchObject({ code: 'ownership-lost' })])
    expect(board.list()).toEqual([])
    expect(await board.create({ workspaceId, title: 'Successor task' })).toMatchObject({ title: 'Successor task' })
  })

  it.each([false, true])('joins an in-flight backend put before drain completes (write failure: %s)', async (failWrite) => {
    const backend = new MemoryStorageBackend()
    const open = backend.kv.open.bind(backend.kv)
    let unit: KvUnit | undefined
    vi.spyOn(backend.kv, 'open').mockImplementation(async (descriptor) => {
      unit = await open(descriptor)
      return unit
    })
    const { board, workspaceId, pool } = await harness({ backend, pool: backend.pool })
    const task = await board.create({ workspaceId, title: 'Original' })
    const lifetime = new AbortController()
    const owner = createTaskboardOwnershipCapability(board, async () => { lifetime.signal.throwIfAborted() })
    await owner.refresh()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    const order: string[] = []
    const put = unit!.putRecord.bind(unit)
    vi.spyOn(unit!, 'putRecord').mockImplementationOnce(async (table, key, value) => {
      entered.resolve(undefined)
      await resume.promise
      try {
        await put(table, key, value)
      } finally {
        order.push('put settled')
      }
    })
    if (failWrite) pool.failNextWrites = 1
    const writing = board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Durably committed' },
    }, lifetime.signal)
    try {
      await Promise.race([entered.promise, writing])
      expect(board.get(task.id)).toEqual(task)
      lifetime.abort(new Error('Runtime shutdown'))
      const drainage = owner.drain()
      expect(owner.drain()).toBe(drainage)
      const drained = drainage.then(() => { order.push('drained') })
      const late = board.create({ workspaceId, title: 'After shutdown' })
      const completed = Promise.all([
        failWrite
          ? expect(writing).rejects.toThrow('injected write failure')
          : expect(writing).resolves.toMatchObject({ title: 'Durably committed' }),
        drained,
        expect(late).rejects.toMatchObject({ code: 'ownership-lost' }),
      ])
      resume.resolve(undefined)
      await completed
      expect(order).toEqual(['put settled', 'drained'])
      expect(board.list()).toHaveLength(1)
      expect(board.get(task.id)?.title).toBe(failWrite ? 'Original' : 'Durably committed')
      await expect(owner.refresh()).rejects.toMatchObject({ code: 'ownership-lost' })
    } finally {
      resume.resolve(undefined)
      await Promise.allSettled([writing])
    }
  })

  it('revokes a verifier still awaiting completion without starting its mutation', async () => {
    const { board, workspaceId } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    let block = false
    const owner = createTaskboardOwnershipCapability(board, async () => {
      if (block) {
        entered.resolve(undefined)
        await resume.promise
      }
    })
    await owner.refresh()
    block = true
    const writing = board.create({ workspaceId, title: 'Not admitted before shutdown' })
    try {
      await Promise.race([entered.promise, writing])
      const drainage = owner.drain()
      const completed = Promise.all([expect(writing).rejects.toMatchObject({ code: 'ownership-lost' }), drainage])
      resume.resolve(undefined)
      await completed
      expect(board.list()).toEqual([])
    } finally {
      resume.resolve(undefined)
      await Promise.allSettled([writing])
    }
  })

  it.each([1, 2])('revokes a refresh awaiting ownership check %s and leaves storage closed', async (pauseAt) => {
    const { board, facility } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    let checks = 0
    const owner = createTaskboardOwnershipCapability(board, async () => {
      if (++checks === pauseAt) {
        entered.resolve(undefined)
        await resume.promise
      }
    })
    const refreshing = owner.refresh()
    try {
      await Promise.race([entered.promise, refreshing])
      const drainage = owner.drain()
      const completed = Promise.all([expect(refreshing).rejects.toMatchObject({ code: 'ownership-lost' }), drainage])
      resume.resolve(undefined)
      await completed
      expect(facility.get('taskboard')).toBeUndefined()
      expect(() => board.list()).toThrow('not initialized')
    } finally {
      resume.resolve(undefined)
      await Promise.allSettled([refreshing])
    }
  })
})
