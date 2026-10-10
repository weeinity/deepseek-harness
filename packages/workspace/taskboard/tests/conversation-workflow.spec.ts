import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createTaskboardOwnershipCapability, currentTaskRecord, TaskId,
} from '../src/index.ts'
import type { TaskboardOwnershipCapability, TaskboardTask } from '../src/index.ts'
import { cleanup, copilot, dsh, handover, harness, request, schedule } from './harness.ts'

afterEach(cleanup)

it.each([0, 2])('moves linked conversations through review, progress and done without changing %s settled attempts', async (historyLength) => {
  const first = await harness()
  let task = await first.board.create({
    workspaceId: first.workspaceId, title: 'Linked conversation', description: 'Keep planning choices',
    connection: dsh, prompt: 'Saved prompt', handover, schedule, labels: ['linked'], priority: 'high',
  })
  for (let index = 0; index < historyLength; index++) {
    const admitted = await first.board.beginExecution(request(task, `settled-${index}`))
    const identity = { taskId: task.id, executionId: admitted.executionId }
    await first.board.attachExecution({
      ...identity, connection: dsh, receipt: { kind: 'dsh', afterSequence: index, messageId: `message-${index}` },
    })
    await first.board.advanceExecution(identity)
    task = await first.board.settleExecution({ ...identity, status: 'succeeded' })
    task = await first.board.move({ taskId: task.id, expectedRevision: task.revision, status: 'todo' })
  }
  await first.ctx.fiber.dispose()
  const { board, ctx, workspaceId, facility } = await harness({
    pool: first.pool, config: { executionHistoryLimit: 1, requestDeduplicationLimit: 1 },
  })
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const statuses = ['in_review', 'in_progress', 'done'] as const
  const tails = new Map<string, number>()
  for (const status of statuses) {
    const tail = await board.create({ workspaceId, title: `${status} tail`, status })
    tails.set(status, tail.rank)
    const archived = await board.create({ workspaceId, title: 'Archived tail', status })
    await board.archive(archived.id, archived.revision)
    await board.create({ workspaceId: WorkspaceId('w2'), title: 'Other Workspace', status })
    await board.create({ workspaceId: WorkspaceId('w2'), title: 'Other Workspace tail', status })
  }
  const table = facility.get('taskboard')!.table('tasks')
  const original = currentTaskRecord.parse(table.get(task.id))
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    for (const [index, status] of statuses.entries()) {
      const now = `2030-01-01T00:00:0${index}.000Z`
      vi.setSystemTime(new Date(now))
      await expect(owner.advanceConversation(board.get(task.id)!, status)).resolves.toBe(true)
      expect(table.get(task.id)).toEqual({
        ...original, status, rank: tails.get(status)! + 1024, revision: original.revision + index + 1, updatedAt: now,
      })
      expect(board.get(task.id)?.executions).toEqual(task.executions)
      expect(changes).toHaveBeenCalledTimes(index + 1)
    }
  } finally {
    vi.useRealTimers()
  }
})

it('acknowledges an identical column without repositioning, writing, revising or notifying', async () => {
  const { board, workspaceId, pool, ctx, facility } = await harness()
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'First in review', connection: dsh, status: 'in_review' })
  await board.create({ workspaceId, title: 'Later in review', status: 'in_review' })
  const stored = structuredClone(pool.media.get('taskboard'))
  const put = vi.spyOn(facility.get('taskboard')!.table('tasks'), 'put')
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  await expect(owner.advanceConversation(task, 'in_review')).resolves.toBe(true)
  await expect(owner.advanceConversation(task, 'in_review')).resolves.toBe(true)
  expect(board.get(task.id)).toEqual(task)
  expect(pool.media.get('taskboard')).toEqual(stored)
  expect(put).not.toHaveBeenCalled()
  expect(changes).not.toHaveBeenCalled()
})

it.each([
  'missing', 'deleted', 'archived', 'revision', 'Workspace', 'connection', 'provider', 'unlinked', 'pending', 'running',
] as const)('refuses a superseded %s observation without writing', async (reason) => {
  const { board, workspaceId, pool, ctx, facility } = await harness()
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const task = await board.create({
    workspaceId, title: 'Observed task', ...(reason === 'unlinked' ? {} : { connection: dsh }),
  })
  let observed = task
  switch (reason) {
    case 'missing': observed = { ...task, id: TaskId('absent') }; break
    case 'deleted': await board.delete(task.id, task.revision); break
    case 'archived': observed = await board.archive(task.id, task.revision); break
    case 'revision':
      await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Newer task' } })
      break
    case 'Workspace': observed = { ...task, workspaceId: WorkspaceId('w2') }; break
    case 'connection': observed = { ...task, connection: { kind: 'dsh', sessionId: SessionId('s2') } }; break
    case 'provider': observed = { ...task, connection: copilot }; break
    case 'unlinked': break
    case 'pending':
    case 'running': {
      const admitted = await board.beginExecution(request(task))
      observed = admitted.task
      if (reason === 'running') {
        const identity = { taskId: task.id, executionId: admitted.executionId }
        await board.attachExecution({ ...identity, connection: dsh, receipt: { kind: 'dsh', afterSequence: 1 } })
        observed = await board.advanceExecution(identity)
      }
      break
    }
  }
  const before = board.list(undefined, true)
  const stored = structuredClone(pool.media.get('taskboard'))
  const put = vi.spyOn(facility.get('taskboard')!.table('tasks'), 'put')
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  await expect(owner.advanceConversation(observed, 'in_progress')).resolves.toBe(false)
  expect(board.list(undefined, true)).toEqual(before)
  expect(pool.media.get('taskboard')).toEqual(stored)
  expect(put).not.toHaveBeenCalled()
  expect(changes).not.toHaveBeenCalled()
})

it('captures the observed identity, revision, Workspace and nested connection before waiting in the queue', async () => {
  const { board, workspaceId } = await harness()
  const task = await board.create({ workspaceId, title: 'Observed', connection: dsh })
  let other = await board.create({
    workspaceId: WorkspaceId('w2'), title: 'Other', connection: { kind: 'dsh', sessionId: SessionId('s3') },
  })
  other = await board.update({ taskId: other.id, expectedRevision: other.revision, patch: { title: 'Updated other' } })
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let paused = false
  const owner = createTaskboardOwnershipCapability(board, async () => {
    if (paused) {
      entered.resolve(undefined)
      await resume.promise
    }
  })
  await owner.refresh()
  paused = true
  const observed = board.get(task.id)!
  const advancing = owner.advanceConversation(observed, 'in_review')
  try {
    await Promise.race([entered.promise, advancing])
    Object.assign(observed.connection!, other.connection)
    Object.assign(observed, { id: other.id, revision: other.revision, workspaceId: other.workspaceId })
    resume.resolve(undefined)
    await expect(advancing).resolves.toBe(true)
    expect(board.get(task.id)).toMatchObject({
      revision: task.revision + 1, status: 'in_review', workspaceId, connection: dsh, executions: [],
    })
    expect(board.get(other.id)).toEqual(other)
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([advancing])
  }
})

it.each(['disconnect', 'rebind', 'admit'] as const)('refuses a queued observation superseded by %s', async (mutation) => {
  const { board, workspaceId, facility, ctx } = await harness()
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'Queued observation', connection: dsh })
  const disconnected = mutation === 'rebind' ? await board.disconnect(task.id, task.revision) : undefined
  const table = facility.get('taskboard')!.table('tasks')
  const put = table.put.bind(table)
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  vi.spyOn(table, 'put').mockImplementationOnce(async (id, value) => {
    entered.resolve(undefined)
    await resume.promise
    return put(id, value)
  })
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  const writing = mutation === 'admit'
    ? board.beginExecution(request(task)).then(value => value.task)
    : mutation === 'disconnect'
      ? board.disconnect(task.id, task.revision)
      : board.connect({
        taskId: task.id, expectedRevision: disconnected!.revision, connection: { kind: 'dsh', sessionId: SessionId('s2') },
      })
  let advancing: Promise<boolean> | undefined
  try {
    await Promise.race([entered.promise, writing])
    advancing = owner.advanceConversation(task, 'in_review')
    resume.resolve(undefined)
    const committed = await writing
    await expect(advancing).resolves.toBe(false)
    expect(board.get(task.id)).toEqual(committed)
    expect(changes).toHaveBeenCalledOnce()
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([writing, advancing])
  }
})

it('retains old reads and durable state after a failed conversation write and allows a retry', async () => {
  const { board, workspaceId, pool, ctx } = await harness()
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'Durable observation', connection: dsh })
  const stored = structuredClone(pool.media.get('taskboard'))
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  pool.failNextWrites = 1
  await expect(owner.advanceConversation(task, 'in_review')).rejects.toThrow('injected write failure')
  expect(board.get(task.id)).toEqual(task)
  expect(pool.media.get('taskboard')).toEqual(stored)
  expect(changes).not.toHaveBeenCalled()
  await expect(owner.advanceConversation(task, 'in_review')).resolves.toBe(true)
  expect(board.get(task.id)).toMatchObject({ revision: task.revision + 1, status: 'in_review', executions: [] })
  expect(changes).toHaveBeenCalledOnce()
  await expect(owner.advanceConversation(task, 'in_review')).resolves.toBe(false)
  await expect(owner.advanceConversation(board.get(task.id)!, 'in_review')).resolves.toBe(true)
  expect(changes).toHaveBeenCalledOnce()
})

it('requires the bound authority identity even when another capability shares its verifier', async () => {
  const { board, workspaceId, pool } = await harness()
  const task = await board.create({ workspaceId, title: 'Owned observation', connection: dsh })
  const verify = vi.fn(async () => {})
  const first = createTaskboardOwnershipCapability(board, verify)
  const second = createTaskboardOwnershipCapability(board, verify)
  const stored = structuredClone(pool.media.get('taskboard'))
  await expect(first.advanceConversation(task, 'in_review')).rejects.toMatchObject({ code: 'ownership-lost' })
  expect(verify).not.toHaveBeenCalled()
  await first.refresh()
  await expect(second.advanceConversation(task, 'in_review')).rejects.toMatchObject({ code: 'ownership-lost' })
  expect(verify).toHaveBeenCalledTimes(2)
  await second.refresh()
  await expect(first.advanceConversation(task, 'in_review')).rejects.toMatchObject({ code: 'ownership-lost' })
  expect(verify).toHaveBeenCalledTimes(4)
  await first.drain()
  expect(board.get(task.id)).toEqual(task)
  expect(pool.media.get('taskboard')).toEqual(stored)
  await expect(second.advanceConversation(task, 'in_review')).resolves.toBe(true)
})

it('rejects conversation writes after the kernel owner is lost', async () => {
  const { board, workspaceId, pool, ctx } = await harness()
  const lifetime = new AbortController()
  const owner = createTaskboardOwnershipCapability(board, async () => { lifetime.signal.throwIfAborted() })
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'Lost owner', connection: dsh })
  const stored = structuredClone(pool.media.get('taskboard'))
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  const lost = new Error('kernel owner lost')
  lifetime.abort(lost)
  await expect(owner.advanceConversation(task, 'in_review')).rejects.toBe(lost)
  expect(board.get(task.id)).toEqual(task)
  expect(pool.media.get('taskboard')).toEqual(stored)
  expect(changes).not.toHaveBeenCalled()
})

it.each([false, true])('drains an admitted conversation write before owner replacement (write failure: %s)', async (failWrite) => {
  const { board, workspaceId, facility, pool, ctx } = await harness()
  const owner = createTaskboardOwnershipCapability(board, async () => {})
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'Draining observation', connection: dsh })
  const stored = structuredClone(pool.media.get('taskboard'))
  const table = facility.get('taskboard')!.table('tasks')
  const put = table.put.bind(table)
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  const order: string[] = []
  vi.spyOn(table, 'put').mockImplementationOnce(async (id, value) => {
    entered.resolve(undefined)
    await resume.promise
    try {
      await put(id, value)
    } finally {
      order.push('write settled')
    }
  })
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  if (failWrite) pool.failNextWrites = 1
  const advancing = owner.advanceConversation(task, 'in_review')
  try {
    await Promise.race([entered.promise, advancing])
    expect(board.get(task.id)).toEqual(task)
    expect(pool.media.get('taskboard')).toEqual(stored)
    expect(changes).not.toHaveBeenCalled()
    const drainage = owner.drain()
    expect(owner.drain()).toBe(drainage)
    const completed = Promise.all([
      failWrite
        ? expect(advancing).rejects.toThrow('injected write failure')
        : expect(advancing).resolves.toBe(true),
      drainage.then(() => { order.push('drained') }),
      expect(owner.advanceConversation(task, 'done')).rejects.toMatchObject({ code: 'ownership-lost' }),
    ])
    resume.resolve(undefined)
    await completed
    expect(order).toEqual(['write settled', 'drained'])
    expect(changes).toHaveBeenCalledTimes(failWrite ? 0 : 1)
    expect(board.get(task.id)).toMatchObject({
      status: failWrite ? 'todo' : 'in_review', revision: task.revision + (failWrite ? 0 : 1),
    })
    const successor = createTaskboardOwnershipCapability(board, async () => {})
    await successor.refresh()
    await expect(successor.advanceConversation(board.get(task.id)!, 'done')).resolves.toBe(true)
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([advancing])
  }
})

it('revokes a conversation observation waiting for ownership verification before its write starts', async () => {
  const { board, workspaceId, pool } = await harness()
  const entered = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let paused = false
  const owner = createTaskboardOwnershipCapability(board, async () => {
    if (paused) {
      entered.resolve(undefined)
      await resume.promise
    }
  })
  await owner.refresh()
  const task = await board.create({ workspaceId, title: 'Unadmitted observation', connection: dsh })
  const stored = structuredClone(pool.media.get('taskboard'))
  paused = true
  const advancing = owner.advanceConversation(task, 'in_review')
  try {
    await Promise.race([entered.promise, advancing])
    const completed = Promise.all([
      expect(advancing).rejects.toMatchObject({ code: 'ownership-lost' }), owner.drain(),
    ])
    resume.resolve(undefined)
    await completed
    expect(board.get(task.id)).toEqual(task)
    expect(pool.media.get('taskboard')).toEqual(stored)
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([advancing])
  }
})

it('uses the owning storage from a consumer injecting only Taskboard and rejects after service disposal', async () => {
  const { ctx, workspaceId } = await harness({ scoped: true })
  let owner!: TaskboardOwnershipCapability
  let task!: TaskboardTask
  const consumer = await ctx.plugin({
    inject: ['taskboard'],
    async apply(target: Context) {
      expect(() => target.storageDomain).toThrow('without inject')
      expect(() => target.workspaceRegistry).toThrow('without inject')
      owner = createTaskboardOwnershipCapability(target.taskboard, async () => {})
      await owner.refresh()
      task = await target.taskboard.create({ workspaceId, title: 'Scoped conversation', connection: dsh })
      await expect(owner.advanceConversation(task, 'in_review')).resolves.toBe(true)
    },
  })
  expect(ctx.taskboard.get(task.id)).toMatchObject({ status: 'in_review', executions: [] })
  await consumer.dispose()
  await ctx.fiber.dispose()
  await expect(owner.advanceConversation(task, 'done')).rejects.toThrow('closing')
})
