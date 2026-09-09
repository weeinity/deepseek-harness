import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceId as asWorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskboardService, {
  AgencyCopilotSessionId, TaskboardInputError, TaskboardMoveInvalidError, TaskboardRevisionConflictError,
  TaskboardSessionInvalidError, TaskboardTaskNotFoundError,
} from '../src/index.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

function workspace(id: string, sessions: string[] = []): Workspace {
  return {
    id: asWorkspaceId(id), path: '/fixture', title: id,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: sessions.map(SessionId),
    setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok',
  }
}

async function harness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaces = new Map<WorkspaceId, Workspace>()
  const first = workspace('w1', ['s1'])
  workspaces.set(first.id, first)
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => workspaces.get(id) } as never)
  await ctx.plugin(TaskboardService)
  return { ctx, pool, board: ctx.taskboard, workspaceId: first.id, workspace: first, facility }
}

describe('TaskboardService', () => {
  it('commits content and a validated existing Agency link together on create and edit', async () => {
    const { board, workspaceId, pool } = await harness()
    const first = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const second = AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80')
    const write = vi.spyOn(pool, 'consumeInjectedFailure')
    const task = await board.create({ workspaceId, title: 'Original', agencyCopilotSessionId: first, status: 'in_review' })
    expect(write).toHaveBeenCalledOnce()
    expect(task).toMatchObject({ revision: 1, agencyCopilotSessionId: first, status: 'in_review' })
    write.mockClear()
    const edited = await board.update({
      taskId: task.id, expectedRevision: task.revision,
      patch: { title: 'Edited', agencyCopilotSessionId: second, sessionId: SessionId('s1') },
    })
    expect(write).toHaveBeenCalledOnce()
    expect(edited).toMatchObject({ revision: 2, title: 'Edited', agencyCopilotSessionId: second, sessionId: 's1', status: 'in_review' })
    await expect(board.update({
      taskId: edited.id, expectedRevision: edited.revision, patch: { agencyCopilotSessionId: second },
    })).resolves.toEqual(edited)
    expect(write).toHaveBeenCalledOnce()
    const cleared = await board.update({
      taskId: edited.id, expectedRevision: edited.revision, patch: { agencyCopilotSessionId: null },
    })
    expect(cleared.agencyCopilotSessionId).toBeUndefined()
    expect(cleared.sessionId).toBe('s1')
  })

  it('rejects invalid durable Agency UUIDs without changing content', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Original' })
    const write = vi.spyOn(pool, 'consumeInjectedFailure')
    const invalid = AgencyCopilotSessionId('invalid')
    await expect(board.create({ workspaceId, title: 'Invalid', agencyCopilotSessionId: invalid })).rejects.toThrow()
    await expect(board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Invalid', agencyCopilotSessionId: invalid },
    })).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(board.list()).toEqual([task])
  })

  it('checks cancellation in the queued create and update slots before writing', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Original' })
    const write = vi.spyOn(pool, 'consumeInjectedFailure')
    const signal = new AbortController()
    const creating = board.create({ workspaceId, title: 'Cancelled' }, signal.signal)
    const updating = board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Cancelled' },
    }, signal.signal)
    signal.abort(new Error('Cancelled while queued'))
    await expect(creating).rejects.toThrow('Cancelled while queued')
    await expect(updating).rejects.toThrow('Cancelled while queued')
    expect(write).not.toHaveBeenCalled()
    expect(board.list()).toEqual([task])
  })

  it('creates five-column tasks and keeps deterministic rank order', async () => {
    const { board, workspaceId } = await harness()
    const first = await board.create({ workspaceId, title: 'First', status: 'todo', priority: 'high', labels: ['UI'] })
    const second = await board.create({ workspaceId, title: 'Second', status: 'todo' })
    expect(board.list(workspaceId).map(task => task.title)).toEqual(['First', 'Second'])
    const moved = await board.move({ taskId: second.id, expectedRevision: second.revision, status: 'todo', beforeTaskId: first.id })
    expect(moved.revision).toBe(2)
    expect(board.list(workspaceId).map(task => task.title)).toEqual(['Second', 'First'])
  })

  it('serializes revision CAS so exactly one concurrent edit commits', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Original' })
    const settled = await Promise.allSettled([
      board.update({ taskId: task.id, expectedRevision: 1, patch: { title: 'A' } }),
      board.update({ taskId: task.id, expectedRevision: 1, patch: { title: 'B' } }),
    ])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(result => result.status === 'rejected')
    const reason: unknown = rejected?.status === 'rejected' ? rejected.reason : undefined
    expect(reason).toBeInstanceOf(TaskboardRevisionConflictError)
    expect(board.get(task.id)?.revision).toBe(2)
  })

  it('bounds durable content and rejects a cross-column self anchor', async () => {
    const { board, workspaceId } = await harness()
    await expect(board.create({ workspaceId, title: 'Large', description: 'x'.repeat(32_769) }))
      .rejects.toBeInstanceOf(TaskboardInputError)
    await expect(board.create({
      workspaceId,
      title: 'Labels',
      labels: Array.from({ length: 13 }, (_, index) => 'label-' + String(index)),
    })).rejects.toBeInstanceOf(TaskboardInputError)
    const task = await board.create({ workspaceId, title: 'Move me', status: 'todo' })
    await expect(board.move({
      taskId: task.id, expectedRevision: task.revision, status: 'done', beforeTaskId: task.id,
    })).rejects.toBeInstanceOf(TaskboardMoveInvalidError)
  })

  it('validates Session linkage against Workspace membership and supports clearing', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Linked' })
    await expect(board.update({ taskId: task.id, expectedRevision: 1, patch: { sessionId: SessionId('missing') } }))
      .rejects.toBeInstanceOf(TaskboardSessionInvalidError)
    const linked = await board.update({ taskId: task.id, expectedRevision: 1, patch: { sessionId: SessionId('s1') } })
    expect(linked.sessionId).toBe('s1')
    const cleared = await board.update({ taskId: task.id, expectedRevision: linked.revision, patch: { sessionId: null } })
    expect(cleared.sessionId).toBeUndefined()
  })

  it('stores Agency Copilot identity independently and preserves it through ordinary edits', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Copilot' })
    const copilot = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const linked = await board.setAgencyCopilotSession({
      taskId: task.id, expectedRevision: task.revision, agencyCopilotSessionId: copilot,
    })
    expect(linked).toMatchObject({ revision: 2, agencyCopilotSessionId: copilot })
    const edited = await board.update({ taskId: task.id, expectedRevision: linked.revision, patch: { title: 'Edited' } })
    expect(edited).toMatchObject({ revision: 3, title: 'Edited', agencyCopilotSessionId: copilot })
    const native = await board.update({ taskId: task.id, expectedRevision: edited.revision, patch: { sessionId: SessionId('s1') } })
    expect(native).toMatchObject({ sessionId: 's1', agencyCopilotSessionId: copilot })
    const cleared = await board.setAgencyCopilotSession({
      taskId: task.id, expectedRevision: native.revision, agencyCopilotSessionId: null,
    })
    expect(cleared.agencyCopilotSessionId).toBeUndefined()
    expect(cleared.sessionId).toBe('s1')
  })

  it('checks Agency Copilot link revisions in the serialized mutation slot', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'CAS' })
    const first = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const second = AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80')
    const settled = await Promise.allSettled([
      board.setAgencyCopilotSession({ taskId: task.id, expectedRevision: 1, agencyCopilotSessionId: first }),
      board.setAgencyCopilotSession({ taskId: task.id, expectedRevision: 1, agencyCopilotSessionId: second }),
    ])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(result => result.status === 'rejected')
    const reason: unknown = rejected?.status === 'rejected' ? rejected.reason : undefined
    expect(reason).toBeInstanceOf(TaskboardRevisionConflictError)
  })

  it('archives without making archive a sixth status and survives restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const task = await first.board.create({ workspaceId: first.workspaceId, title: 'Durable', status: 'in_review' })
    const archived = await first.board.archive(task.id, task.revision)
    expect(archived.status).toBe('in_review')
    expect(typeof archived.archivedAt).toBe('string')
    expect(first.board.list()).toEqual([])
    await first.ctx.fiber.dispose()
    roots.splice(roots.indexOf(first.ctx), 1)
    const second = await harness(pool)
    expect(second.board.list(undefined, true)).toMatchObject([{ id: task.id, status: 'in_review' }])
  })

  it('preserves DSH and Agency session links when archiving a completed task across restart', async () => {
    const first = await harness()
    const task = await first.board.create({ workspaceId: first.workspaceId, title: 'Completed', status: 'done' })
    const native = await first.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { sessionId: SessionId('s1') },
    })
    const copilot = AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491')
    const linked = await first.board.setAgencyCopilotSession({
      taskId: native.id, expectedRevision: native.revision, agencyCopilotSessionId: copilot,
    })
    const archived = await first.board.archive(linked.id, linked.revision)
    expect(archived).toMatchObject({
      status: 'done', revision: linked.revision + 1, sessionId: SessionId('s1'), agencyCopilotSessionId: copilot,
    })
    expect(archived.archivedAt).toBe(archived.updatedAt)
    expect(first.board.list()).toEqual([])
    await expect(first.board.archive(archived.id, archived.revision)).resolves.toEqual(archived)
    await first.ctx.fiber.dispose()
    roots.splice(roots.indexOf(first.ctx), 1)
    const reopened = await harness(first.pool)
    expect(reopened.board.list()).toEqual([])
    expect(reopened.board.list(first.workspaceId, true)).toEqual([archived])
  })

  it.each([false, true])('deletes only the task record with linked Sessions retained (archived=%s)', async (archived) => {
    const b = await harness()
    const task = await b.board.create({
      workspaceId: b.workspaceId, title: 'Delete task only',
      agencyCopilotSessionId: AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
    })
    const linked = await b.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { sessionId: SessionId('s1') },
    })
    const current = archived ? await b.board.archive(linked.id, linked.revision) : linked
    const retained = await b.board.create({ workspaceId: b.workspaceId, title: 'Retained' })
    const detach = vi.spyOn(b.workspace, 'detachSession')
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    await expect(b.board.delete(current.id, current.revision)).resolves.toEqual({
      taskId: current.id, revision: Number.MAX_SAFE_INTEGER,
    })
    expect(write).toHaveBeenCalledOnce()
    expect(b.board.get(current.id)).toBeUndefined()
    expect(b.board.list(undefined, true)).toEqual([retained])
    expect(b.workspace.sessionIds).toEqual([SessionId('s1')])
    expect(detach).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
    roots.splice(roots.indexOf(b.ctx), 1)
    const reopened = await harness(b.pool)
    expect(reopened.board.list(undefined, true)).toEqual([retained])
    expect(reopened.board.get(current.id)).toBeUndefined()
  })

  it('rejects stale and missing deletes without writing or retrying', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Original' })
    const current = await b.board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { title: 'Changed' },
    })
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    await expect(b.board.delete(task.id, task.revision)).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    expect(write).not.toHaveBeenCalled()
    expect(b.board.get(task.id)).toEqual(current)
    await b.board.delete(current.id, current.revision)
    await expect(b.board.delete(current.id, current.revision)).rejects.toBeInstanceOf(TaskboardTaskNotFoundError)
    expect(write).toHaveBeenCalledOnce()
  })

  it('checks deletion CAS in its queue slot after a competing edit', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Original' })
    const editing = b.board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Edited' } })
    const deleting = b.board.delete(task.id, task.revision)
    await expect(deleting).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    expect(b.board.get(task.id)).toEqual(await editing)
  })

  it('retains the durable task on deletion failure and deletes only on explicit retry', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Retained after failure' })
    b.pool.failNextWrites = 1
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    await expect(b.board.delete(task.id, task.revision)).rejects.toThrow('injected write failure')
    expect(b.board.get(task.id)).toEqual(task)
    expect(write).toHaveBeenCalledOnce()
    await b.board.delete(task.id, task.revision)
    expect(b.board.get(task.id)).toBeUndefined()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('cancels a queued delete without modifying the record', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Retained' })
    const cancellation = new AbortController()
    const write = vi.spyOn(b.pool, 'consumeInjectedFailure')
    const deleting = b.board.delete(task.id, task.revision, cancellation.signal)
    cancellation.abort(new Error('Cancelled before deletion'))
    await expect(deleting).rejects.toThrow('Cancelled before deletion')
    expect(write).not.toHaveBeenCalled()
    expect(b.board.get(task.id)).toEqual(task)
  })

  it('settles an admitted durable delete even if its caller subsequently cancels', async () => {
    const b = await harness()
    const task = await b.board.create({ workspaceId: b.workspaceId, title: 'Submitted deletion' })
    const table = b.facility.get('taskboard')!.table('tasks')
    const remove = table.delete.bind(table)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    vi.spyOn(table, 'delete').mockImplementation(async (key) => {
      entered.resolve(undefined)
      await resume.promise
      return remove(key)
    })
    const cancellation = new AbortController()
    const deleting = b.board.delete(task.id, task.revision, cancellation.signal)
    await entered.promise
    cancellation.abort(new Error('Cancelled after submission'))
    resume.resolve(undefined)
    await expect(deleting).resolves.toEqual({ taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
    expect(b.board.get(task.id)).toBeUndefined()
  })

  it('allows reuse of a deleted maximum ordinal but never reuses the deleted task UUID', async () => {
    const b = await harness()
    const first = await b.board.create({ workspaceId: b.workspaceId, title: 'First' })
    const maximum = await b.board.create({ workspaceId: b.workspaceId, title: 'Maximum' })
    await b.board.delete(maximum.id, maximum.revision)
    const next = await b.board.create({ workspaceId: b.workspaceId, title: 'Next' })
    expect(next.ordinal).toBe(maximum.ordinal)
    expect(next.id).not.toBe(maximum.id)
    expect(b.board.list().map(task => task.ordinal)).toEqual([first.ordinal, next.ordinal])
  })
})
