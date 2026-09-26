import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { currentTaskRecord, TaskboardInputError } from '../src/index.ts'
import type { TaskStatus, TaskboardTask } from '../src/index.ts'
import { cleanup, dsh, harness, request } from './harness.ts'

afterEach(cleanup)

const destinations: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['todo', 'in_progress', 'in_review', 'done'],
  todo: ['backlog', 'in_progress', 'in_review', 'done'],
  in_progress: ['backlog', 'todo', 'in_review', 'done'],
  in_review: ['backlog', 'todo', 'in_progress', 'done'],
  done: ['backlog', 'todo', 'in_progress', 'in_review'],
}

it.each(Object.entries(destinations) as [TaskStatus, readonly TaskStatus[]][])(
  'projects and permits the manual destinations of %s without persisting them',
  async (status, allowed) => {
    const { board, workspaceId, facility } = await harness()
    for (const destination of allowed) {
      const task = await board.create({ workspaceId, title: 'Manual choice', status })
      expect(task.allowedManualStatuses).toEqual(allowed)
      expect(task.allowedManualStatuses).not.toContain(status)
      expect(facility.get('taskboard')!.table('tasks').get(task.id)).not.toHaveProperty('allowedManualStatuses')
      ;(task.allowedManualStatuses as TaskStatus[]).push(status)
      expect(board.get(task.id)?.allowedManualStatuses).toEqual(allowed)
      const moved = await board.move({ taskId: task.id, expectedRevision: task.revision, status: destination })
      expect(moved.status).toBe(destination)
      expect(moved.allowedManualStatuses).toEqual(destinations[destination])
    }
  },
)

it('commits execution state and tail placement together through waiting, resume and exact success', async () => {
  const { board, workspaceId, workspaces, ctx } = await harness()
  await board.create({ workspaceId, title: 'Active first', status: 'in_progress' })
  const activeTail = await board.create({ workspaceId, title: 'Active tail', status: 'in_progress' })
  const archived = await board.create({ workspaceId, title: 'Hidden active', status: 'in_progress' })
  await board.archive(archived.id, archived.revision)
  for (let index = 0; index < 4; index++) {
    await board.create({ workspaceId: WorkspaceId('w2'), title: `Other Workspace ${index}`, status: 'in_progress' })
  }
  const reviewTail = await board.create({ workspaceId, title: 'Review tail', status: 'in_review' })
  const doneTail = await board.create({ workspaceId, title: 'Done tail', status: 'done' })
  const task = await board.create({ workspaceId, title: 'Execute' })
  const observations: TaskboardTask[] = []
  ctx.on('domain/changed', () => { observations.push(board.get(task.id)!) })
  const input = request(task)
  const admitted = await board.beginExecution(input)
  expect(observations).toEqual([admitted.task])
  expect(admitted.task).toMatchObject({
    revision: task.revision + 1, status: 'in_progress', rank: activeTail.rank + 1024,
    executions: [{ id: admitted.executionId, status: 'pending' }],
  })
  const receipt = { kind: 'dsh' as const, afterSequence: 7, messageId: 'accepted' }
  const identity = { taskId: task.id, executionId: admitted.executionId }
  const attached = await board.attachExecution({ ...identity, connection: dsh, receipt })
  expect(attached.rank).toBe(admitted.task.rank)
  const running = await board.advanceExecution(identity)
  expect(running.status).toBe('in_progress')
  expect(running.rank).toBe(admitted.task.rank)
  await expect(board.advanceExecution(identity)).resolves.toEqual(running)
  workspaces.delete(workspaceId)
  const waiting = await board.advanceExecution({ ...identity, waitingForInput: true })
  expect(waiting).toMatchObject({
    revision: running.revision + 1, status: 'in_review', rank: reviewTail.rank + 1024,
    executions: [{ status: 'running', startedAt: running.executions[0]!.startedAt, receipt }],
  })
  await expect(board.advanceExecution({ ...identity, waitingForInput: true })).resolves.toEqual(waiting)
  const resumed = await board.advanceExecution({ ...identity, waitingForInput: false })
  expect(resumed).toMatchObject({ status: 'in_progress', rank: activeTail.rank + 1024 })
  expect(resumed.executions[0]).toEqual(running.executions[0])
  const settled = await board.settleExecution({ ...identity, status: 'succeeded' })
  expect(settled).toMatchObject({
    revision: resumed.revision + 1, status: 'done', rank: doneTail.rank + 1024,
    executions: [{ status: 'succeeded', startedAt: running.executions[0]!.startedAt, receipt }],
  })
  expect(observations).toEqual([admitted.task, attached, running, waiting, resumed, settled])
  const human = await board.move({ taskId: task.id, expectedRevision: settled.revision, status: 'todo' })
  await expect(board.settleExecution({ ...identity, status: 'succeeded' })).resolves.toEqual(human)
  expect(await board.beginExecution(input)).toEqual({ task: human, executionId: admitted.executionId, replayed: true })
  expect(observations.at(-1)).toEqual(human)
  expect(observations).toHaveLength(7)
})

it.each(['failed', 'cancelled'] as const)('places %s in review and preserves its later manual move on replay', async (status) => {
  const { board, workspaceId } = await harness()
  const tail = await board.create({ workspaceId, title: 'Existing review', status: 'in_review' })
  const task = await board.create({ workspaceId, title: 'Run' })
  const input = request(task)
  const run = await board.beginExecution(input)
  const identity = { taskId: task.id, executionId: run.executionId }
  const settled = await board.settleExecution({ ...identity, status, error: { code: status, message: 'Exact outcome' } })
  expect(settled).toMatchObject({
    status: 'in_review', rank: tail.rank + 1024, executions: [{ status, error: { code: status, message: 'Exact outcome' } }],
  })
  const human = await board.move({ taskId: task.id, expectedRevision: settled.revision, status: 'done' })
  await expect(board.settleExecution({ ...identity, status, error: { code: status, message: 'Exact outcome' } })).resolves.toEqual(human)
  expect((await board.beginExecution(input)).task).toEqual(human)
})

it('does not reposition tasks already in the execution column', async () => {
  const { board, workspaceId } = await harness()
  const task = await board.create({ workspaceId, title: 'First active', status: 'in_progress' })
  await board.create({ workspaceId, title: 'Later active', status: 'in_progress' })
  const review = await board.create({ workspaceId, title: 'Existing review', status: 'in_review' })
  const run = await board.beginExecution(request(task))
  expect(run.task.rank).toBe(task.rank)
  const placed = await board.move({
    taskId: task.id, expectedRevision: run.task.revision, status: 'in_review', beforeTaskId: review.id,
  })
  const settled = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'failed' })
  expect(settled.rank).toBe(placed.rank)
  expect(settled.status).toBe('in_review')
})

it.each(['begin', 'advance', 'settle'] as const)('rolls back the complete %s transition on storage failure', async (phase) => {
  const { board, workspaceId, pool, ctx } = await harness()
  const task = await board.create({ workspaceId, title: 'Atomic transition' })
  const input = request(task)
  let mutate: () => Promise<unknown> = () => board.beginExecution(input)
  if (phase !== 'begin') {
    const run = await board.beginExecution(input)
    const identity = { taskId: task.id, executionId: run.executionId }
    await board.attachExecution({ ...identity, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 } })
    mutate = phase === 'advance'
      ? () => board.advanceExecution({ ...identity, waitingForInput: true })
      : () => board.settleExecution({ ...identity, status: 'succeeded' })
  }
  const before = board.get(task.id)!
  const stored = structuredClone(pool.media.get('taskboard'))
  const changes = vi.fn()
  ctx.on('domain/changed', changes)
  pool.failNextWrites = 1
  await expect(mutate()).rejects.toThrow('injected write failure')
  expect(board.get(task.id)).toEqual(before)
  expect(pool.media.get('taskboard')).toEqual(stored)
  expect(changes).not.toHaveBeenCalled()
  await mutate()
  expect(board.get(task.id)).toMatchObject({
    revision: before.revision + 1,
    status: phase === 'begin' ? 'in_progress' : phase === 'advance' ? 'in_review' : 'done',
  })
  expect(changes).toHaveBeenCalledOnce()
  await mutate()
  expect(changes).toHaveBeenCalledOnce()
})

it('does not publish a pending attempt or its workflow placement before durability completes', async () => {
  const { board, workspaceId, facility, ctx } = await harness()
  const tail = await board.create({ workspaceId, title: 'Existing active', status: 'in_progress' })
  const task = await board.create({ workspaceId, title: 'Await commit' })
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
  const admission = board.beginExecution(request(task))
  try {
    await Promise.race([entered.promise, admission])
    expect(board.get(task.id)).toEqual(task)
    expect(changes).not.toHaveBeenCalled()
    resume.resolve(undefined)
    const committed = await admission
    expect(committed.task).toMatchObject({
      revision: 2, status: 'in_progress', rank: tail.rank + 1024, executions: [{ status: 'pending' }],
    })
    expect(changes).toHaveBeenCalledOnce()
  } finally {
    resume.resolve(undefined)
    await Promise.allSettled([admission])
  }
})

it('reads existing terminal records without deriving their columns from past attempts', async () => {
  const first = await harness()
  const task = await first.board.create({ workspaceId: first.workspaceId, title: 'Existing record' })
  const input = request(task)
  const run = await first.board.beginExecution(input)
  await first.board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
  const table = first.facility.get('taskboard')!.table('tasks')
  const record = currentTaskRecord.parse(table.get(task.id))
  await table.put(task.id, { ...record, status: 'backlog', rank: 123 })
  await first.ctx.fiber.dispose()
  const reopened = await harness({ pool: first.pool })
  const existing = reopened.board.get(task.id)!
  expect(existing).toMatchObject({ status: 'backlog', rank: 123, executions: [{ status: 'succeeded' }] })
  await expect(reopened.board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })).resolves.toEqual(existing)
  expect((await reopened.board.beginExecution(input)).task).toEqual(existing)
})

it('rejects an exhausted destination rank without committing an attempt or column change', async () => {
  const { board, workspaceId, facility, pool } = await harness()
  const task = await board.create({ workspaceId, title: 'Cannot append' })
  const tail = await board.create({ workspaceId, title: 'Unrepresentable successor', status: 'in_progress' })
  const table = facility.get('taskboard')!.table('tasks')
  const record = currentTaskRecord.parse(table.get(tail.id))
  await table.put(tail.id, { ...record, rank: Number.MAX_VALUE })
  const writes = vi.spyOn(pool, 'consumeInjectedFailure')
  await expect(board.beginExecution(request(task))).rejects.toBeInstanceOf(TaskboardInputError)
  expect(board.get(task.id)).toEqual(task)
  expect(writes).not.toHaveBeenCalled()
})
