import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import {
  Config, TaskboardService, TaskExecutionId, TaskId, TaskRunRequestId, TaskboardInputError,
  TaskboardMoveInvalidError, TaskboardRevisionConflictError, TaskboardSessionInvalidError,
  TaskboardTaskArchivedError, TaskboardTaskNotFoundError, TaskboardWorkspaceNotFoundError,
  currentTaskRecord, requiresPermissionConfirmation, taskRecord,
} from '../src/index.ts'
import type { TaskboardTask, TaskboardUpdatePatch, TaskExecutionSettings } from '../src/index.ts'
import { cleanup, copilot, dsh, handover, harness, request, roots, schedule } from './harness.ts'
import { taskExecutionPrompt } from '../src/prompt.ts'

afterEach(cleanup)

describe('planning and connections', () => {
  it('defaults new tasks to Todo without changing explicit Backlog choices or existing records', async () => {
    const { board, workspaceId } = await harness()
    const backlog = await board.create({ workspaceId, title: 'Deferred work', status: 'backlog' })
    const task = await board.create({ workspaceId, title: 'New work' })
    expect(task.status).toBe('todo')
    expect(board.get(backlog.id)).toEqual(backlog)
    expect(backlog.status).toBe('backlog')
    expect(board.list(workspaceId).map(item => item.id)).toEqual([backlog.id, task.id])
  })

  it('creates explicit DSH defaults while preserving priority, labels and deterministic ordering', async () => {
    const { board, workspaceId } = await harness()
    const first = await board.create({ workspaceId, title: '  First  ', status: 'todo', priority: 'high', labels: [' UI ', 'UI', ''] })
    const second = await board.create({ workspaceId, title: 'Second', status: 'todo' })
    expect(first).toMatchObject({ title: 'First', status: 'todo', labels: ['UI'], priority: 'high', prompt: '', executionSettings: { kind: 'dsh' }, executions: [] })
    expect(first).not.toHaveProperty('connection')
    expect(first).not.toHaveProperty('requests')
    expect(first).not.toHaveProperty('format')
    expect(first).not.toHaveProperty('sessionId')
    expect(first).not.toHaveProperty('agencyCopilotSessionId')
    expect(board.list(workspaceId).map(task => task.id)).toEqual([first.id, second.id])
    const moved = await board.move({ taskId: second.id, expectedRevision: 1, status: 'todo', beforeTaskId: first.id })
    expect(moved.revision).toBe(2)
    expect(board.list(workspaceId).map(task => task.id)).toEqual([second.id, first.id])
    await expect(board.move({ taskId: second.id, expectedRevision: 2, status: 'todo', beforeTaskId: second.id })).resolves.toEqual(moved)
    await expect(board.move({ taskId: first.id, expectedRevision: 1, status: 'todo' })).resolves.toEqual(first)
  })

  it.each([
    { title: '' }, { title: 'x'.repeat(241) }, { title: 'x', description: 'x'.repeat(32_769) },
    { title: 'x', labels: ['x'.repeat(41)] },
    { title: 'x', labels: Array.from({ length: 13 }, (_, index) => String(index)) },
  ])('rejects invalid planning content before storage writes: %j', async (input) => {
    const { board, workspaceId, pool } = await harness()
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    await expect(board.create({ workspaceId, ...input })).rejects.toBeInstanceOf(TaskboardInputError)
    expect(writes).not.toHaveBeenCalled()
  })

  it('checks bounds through edits and rejects missing Workspace and task identities', async () => {
    const { board, workspaceId } = await harness()
    await expect(board.create({ workspaceId: WorkspaceId('missing'), title: 'x' })).rejects.toBeInstanceOf(TaskboardWorkspaceNotFoundError)
    await expect(board.update({ taskId: TaskId('missing'), expectedRevision: 1, patch: {} })).rejects.toBeInstanceOf(TaskboardTaskNotFoundError)
    expect(board.get(TaskId('missing'))).toBeUndefined()
    const task = await board.create({ workspaceId, title: 'Original', priority: 'low', labels: ['a'] })
    await expect(board.update({ taskId: task.id, expectedRevision: 1, patch: { title: ' ' } })).rejects.toBeInstanceOf(TaskboardInputError)
    const edited = await board.update({
      taskId: task.id, expectedRevision: 1,
      patch: { title: 'Edited', description: 'Details', priority: null, labels: [] },
    })
    expect(edited).not.toHaveProperty('priority')
    expect(edited).toMatchObject({ title: 'Edited', description: 'Details', labels: [] })
    await expect(board.update({ taskId: task.id, expectedRevision: edited.revision, patch: {} })).resolves.toEqual(edited)
  })

  it('places middle ranks and rejects cross-column, self-column and missing anchors', async () => {
    const { board, workspaceId } = await harness()
    const tasks = await Promise.all(['A', 'B', 'C'].map(title => board.create({ workspaceId, title, status: 'todo' })))
    const [a, b, c] = tasks as [TaskboardTask, TaskboardTask, TaskboardTask]
    await board.move({ taskId: c.id, expectedRevision: c.revision, status: 'todo', beforeTaskId: b.id })
    expect(board.list().map(task => task.title)).toEqual(['A', 'C', 'B'])
    await expect(board.move({ taskId: a.id, expectedRevision: a.revision, status: 'backlog', beforeTaskId: a.id })).rejects.toBeInstanceOf(TaskboardMoveInvalidError)
    await expect(board.move({ taskId: a.id, expectedRevision: a.revision, status: 'backlog', beforeTaskId: b.id })).rejects.toBeInstanceOf(TaskboardMoveInvalidError)
    await expect(board.move({ taskId: a.id, expectedRevision: a.revision, status: 'todo', beforeTaskId: TaskId('missing') })).rejects.toBeInstanceOf(TaskboardMoveInvalidError)
    const deferred = await board.move({ taskId: a.id, expectedRevision: a.revision, status: 'backlog' })
    await board.move({ taskId: a.id, expectedRevision: deferred.revision, status: 'done' })
    expect(board.list().map(task => task.title)).toEqual(['C', 'B', 'A'])
  })

  it('orders imported equal ranks by ordinal then UUID and rejects exhausted rank gaps', async () => {
    const { board, workspaceId, facility } = await harness()
    const original = await board.create({ workspaceId, title: 'Original', status: 'todo' })
    const table = facility.get('taskboard')!.table('tasks')
    const base = currentTaskRecord.parse(table.get(original.id))
    await table.delete(original.id)
    await table.put('c', { ...base, ordinal: 2, rank: 0 })
    await table.put('b', { ...base, ordinal: 1, rank: 0 })
    await table.put('a', { ...base, ordinal: 1, rank: 0 })
    expect(board.list().map(task => task.id)).toEqual(['a', 'b', 'c'])
    for (const [previous, next] of [[0, Number.MIN_VALUE], [1, 1 + Number.EPSILON], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
      await table.put('a', { ...base, ordinal: 1, rank: previous })
      await table.put('b', { ...base, ordinal: 2, rank: next })
      await expect(board.move({ taskId: TaskId('c'), expectedRevision: 1, status: 'todo', beforeTaskId: TaskId('b') }))
        .rejects.toBeInstanceOf(TaskboardMoveInvalidError)
    }
  })

  it('serializes overlapping CAS with a durability barrier and publishes only the committed write', async () => {
    const { board, workspaceId, facility, ctx } = await harness()
    const task = await board.create({ workspaceId, title: 'Original' })
    const table = facility.get('taskboard')!.table('tasks')
    const originalPut = table.put.bind(table)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    const changes = vi.fn()
    ctx.on('domain/changed', changes)
    vi.spyOn(table, 'put').mockImplementationOnce(async (id, record) => {
      entered.resolve(undefined)
      await resume.promise
      return originalPut(id, record)
    })
    const a = board.update({ taskId: task.id, expectedRevision: 1, patch: { title: 'A' } })
    await entered.promise
    const b = board.update({ taskId: task.id, expectedRevision: 1, patch: { title: 'B' } })
    const rejected = expect(b).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    expect(board.get(task.id)).toEqual(task)
    expect(changes).not.toHaveBeenCalled()
    resume.resolve(undefined)
    await a
    await rejected
    expect(changes).toHaveBeenCalledOnce()
    expect(board.get(task.id)).toMatchObject({ revision: 2, title: 'A' })
  })

  it('validates DSH membership and requires disconnect for connection identity, provider, Workspace or preset changes', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Connected', executionSettings: { kind: 'dsh', presetId: 'basic' } })
    await expect(board.connect({ taskId: task.id, expectedRevision: 1, connection: { kind: 'dsh', sessionId: SessionId('s3') } })).rejects.toBeInstanceOf(TaskboardSessionInvalidError)
    await expect(board.connect({ taskId: task.id, expectedRevision: 1, connection: copilot })).rejects.toMatchObject({ code: 'settings-conflict' })
    task = await board.connect({ taskId: task.id, expectedRevision: 1, connection: dsh })
    await expect(board.connect({ taskId: task.id, expectedRevision: task.revision, connection: { kind: 'dsh', sessionId: SessionId('s2') } })).rejects.toMatchObject({ code: 'connection-conflict' })
    await expect(board.connect({ taskId: task.id, expectedRevision: task.revision, connection: dsh, executionSettings: { kind: 'dsh', presetId: 'other' } })).rejects.toMatchObject({ code: 'connection-conflict' })
    await expect(board.connect({ taskId: task.id, expectedRevision: task.revision, connection: { sessionId: SessionId('s1'), kind: 'dsh' } })).resolves.toEqual(task)
    for (const patch of [
      { workspaceId: WorkspaceId('w2') }, { executionSettings: { kind: 'copilot' } },
      { executionSettings: { kind: 'dsh', presetId: 'other' } },
    ] satisfies TaskboardUpdatePatch[]) {
      await expect(board.update({ taskId: task.id, expectedRevision: task.revision, patch })).rejects.toMatchObject({ code: 'connection-conflict' })
    }
    task = await board.disconnect(task.id, task.revision)
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { executionSettings: { kind: 'copilot' }, workspaceId: WorkspaceId('w2') } })
    task = await board.connect({ taskId: task.id, expectedRevision: task.revision, connection: copilot })
    expect(task.connection).toEqual(copilot)
    expect(task.executionSettings).toEqual({ kind: 'copilot' })
  })

  it('updates next-run model and permissions while idle and invalidates only relevant confirmation', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Permissions', executionSettings: { kind: 'copilot', permission: 'full-access' }, handover })
    task = await board.confirmPermissions(task.id, task.revision)
    const confirmedAt = task.permissionConfirmedAt
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'New title', priority: 'urgent' } })
    expect(task.permissionConfirmedAt).toBe(confirmedAt)
    expect(task.handover).toEqual(handover)
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { executionSettings: { kind: 'copilot', permission: 'full-access', model: 'next-model' } } })
    expect(task.permissionConfirmedAt).toBe(confirmedAt)
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { handover: { ...handover, next: 'Review' } } })
    expect(task.permissionConfirmedAt).toBeUndefined()
    task = await board.confirmPermissions(task.id, task.revision)
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { handover: null } })
    expect(task).not.toHaveProperty('handover')
    expect(task).not.toHaveProperty('permissionConfirmedAt')
    task = await board.confirmPermissions(task.id, task.revision)
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { executionSettings: { kind: 'copilot', permission: 'workspace-write' } } })
    expect(task.permissionConfirmedAt).toBeUndefined()
  })

  it('archives, restores and duplicates without mutating provider Sessions or re-enabling schedules', async () => {
    const { board, workspaceId, workspace } = await harness()
    const detach = vi.spyOn(workspace, 'detachSession')
    let task = await board.create({ workspaceId, title: 'Original', status: 'in_review', priority: 'urgent', labels: ['Keep'], schedule, handover })
    task = await board.connect({ taskId: task.id, expectedRevision: task.revision, connection: dsh })
    task = await board.confirmPermissions(task.id, task.revision)
    const admitted = await board.beginExecution(request(task))
    task = await board.settleExecution({ taskId: task.id, executionId: admitted.executionId, status: 'failed', error: { code: 'provider', message: 'No response' } })
    task = await board.archive(task.id, task.revision)
    expect(board.list()).toEqual([])
    expect(board.list(undefined, true)).toEqual([task])
    expect(task).toMatchObject({ status: 'in_review', connection: dsh, schedule: { enabled: false } })
    expect(task.archivedAt).toBe(task.updatedAt)
    await expect(board.archive(task.id, task.revision)).resolves.toEqual(task)
    await expect(board.update({ taskId: task.id, expectedRevision: task.revision, patch: {} }))
      .rejects.toBeInstanceOf(TaskboardTaskArchivedError)
    const copy = await board.duplicate({ taskId: task.id, expectedRevision: task.revision, title: 'Copy' })
    expect(copy).toMatchObject({ revision: 1, title: 'Copy', priority: 'urgent', labels: ['Keep'], status: 'in_review', executions: [], schedule: { enabled: false }, handover })
    expect(copy.id).not.toBe(task.id)
    expect(copy).not.toHaveProperty('connection')
    expect(copy).not.toHaveProperty('permissionConfirmedAt')
    expect(copy).not.toHaveProperty('archivedAt')
    expect(board.get(task.id)).toEqual(task)
    task = await board.restore(task.id, task.revision)
    expect(task.schedule?.enabled).toBe(false)
    await expect(board.restore(task.id, task.revision)).resolves.toEqual(task)
    const receipt = await board.delete(task.id, task.revision)
    expect(receipt).toEqual({ taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
    expect(board.get(task.id)).toBeUndefined()
    expect(detach).not.toHaveBeenCalled()
    expect(workspace.sessionIds).toEqual([SessionId('s1'), SessionId('s2')])
    await expect(board.delete(task.id, task.revision)).rejects.toBeInstanceOf(TaskboardTaskNotFoundError)
  })

  it('checks archive, restore, duplicate, connect, disconnect, confirm and delete CAS', async () => {
    const { board, workspaceId } = await harness()
    const original = await board.create({ workspaceId, title: 'Original' })
    const task = await board.update({ taskId: original.id, expectedRevision: 1, patch: { title: 'Edited' } })
    for (const mutation of [
      () => board.archive(task.id, 1), () => board.restore(task.id, 1),
      () => board.duplicate({ taskId: task.id, expectedRevision: 1 }),
      () => board.connect({ taskId: task.id, expectedRevision: 1, connection: dsh }),
      () => board.disconnect(task.id, 1), () => board.confirmPermissions(task.id, 1), () => board.delete(task.id, 1),
    ]) await expect(mutation()).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    expect(board.get(task.id)).toEqual(task)
  })
})

describe('admission, retention and lifecycle', () => {
  it.each([
    { prompt: '', description: 'Detailed instructions', expected: 'Title\n\nDetailed instructions' },
    { prompt: ' \t\n', description: '  First line\nSecond line\n', expected: 'Title\n\n  First line\nSecond line\n' },
    { prompt: '', description: '', expected: 'Title' },
    { prompt: '', description: ' \t\n', expected: 'Title' },
    { prompt: '  Exact prompt\n', description: 'Do not append this', expected: '  Exact prompt\n' },
  ])('resolves the submitted prompt from saved fields: %j', async ({ prompt, description, expected }) => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Title', description, prompt })
    const admitted = await board.beginExecution(request(task))
    expect(admitted.task.executions[0]?.prompt).toBe(expected)
    expect(admitted.task.prompt).toBe(prompt)
    expect(admitted.task.description).toBe(description)
  })

  it('uses edited title and description only for a new attempt, not an open attempt or replay', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Original title', description: 'Original description' })
    const input = request(task)
    const first = await board.beginExecution(input)
    const frozen = first.task.executions[0]!
    expect(frozen.prompt).toBe('Original title\n\nOriginal description')
    task = await board.update({
      taskId: task.id, expectedRevision: first.task.revision,
      patch: { title: 'Edited title', description: 'Edited description' },
    })
    expect(task.executions[0]).toEqual(frozen)
    const replay = await board.beginExecution(input)
    expect(replay).toMatchObject({ executionId: first.executionId, replayed: true })
    expect(replay.task.executions[0]).toEqual(frozen)
    task = await board.settleExecution({ taskId: task.id, executionId: first.executionId, status: 'succeeded' })
    const settled = task.executions[0]
    const again = await board.beginExecution(request(task, 'again'))
    expect(again.task.executions[0]).toEqual(settled)
    expect(again.task.executions[1]?.prompt).toBe('Edited title\n\nEdited description')
    expect(again.task.executions[1]?.connection).toEqual(frozen.connection)
  })

  it('snapshots effective prompt/settings/handover before dispatch and reuses the connection for Run Again', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Title', description: 'Detailed instructions', handover, status: 'todo' })
    const settings: TaskExecutionSettings = { kind: 'dsh', presetId: 'default', permission: 'workspace-write', model: { provider: 'deepseek', model: 'chat', reasoningEffort: ReasoningEffortId('high') } }
    const admitted = await board.beginExecution({ ...request(task), executionSettings: settings })
    expect(admitted).toMatchObject({ replayed: false, task: { status: 'in_progress', executionSettings: task.executionSettings } })
    expect(admitted.task.executions[0]).toMatchObject({
      id: admitted.executionId, status: 'pending', prompt: taskExecutionPrompt('Title\n\nDetailed instructions', handover),
      workspaceId, executionSettings: settings, handover,
    })
    const attached = await board.attachExecution({ taskId: task.id, executionId: admitted.executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 7 } })
    const running = await board.advanceExecution({ taskId: task.id, executionId: admitted.executionId, receipt: { kind: 'dsh', afterSequence: 7, messageId: 'm1' } })
    expect(running.executions[0]).toMatchObject({ status: 'running', connection: dsh, receipt: { kind: 'dsh', afterSequence: 7, messageId: 'm1' } })
    expect(attached.connection).toEqual(dsh)
    const planned = await board.move({ taskId: task.id, expectedRevision: running.revision, status: 'in_review' })
    const settled = await board.settleExecution({ taskId: task.id, executionId: admitted.executionId, status: 'succeeded' })
    expect(settled.status).toBe('done')
    expect(settled.revision).toBe(planned.revision + 1)
    const again = await board.beginExecution({ ...request(settled, 'again'), executionSettings: settings })
    expect(again.task.status).toBe('in_progress')
    await expect(board.settleExecution({ taskId: task.id, executionId: admitted.executionId, status: 'succeeded' })).resolves.toEqual(again.task)
    expect(again.task.executions[1]).toMatchObject({ status: 'pending', connection: dsh, executionSettings: settings })
    await expect(board.attachExecution({ taskId: task.id, executionId: again.executionId, connection: { kind: 'dsh', sessionId: SessionId('s2') } })).rejects.toMatchObject({ code: 'connection-conflict' })
    await expect(board.attachExecution({ taskId: task.id, executionId: again.executionId, connection: copilot })).rejects.toMatchObject({ code: 'connection-conflict' })
  })

  it('freezes the complete submitted prompt and never re-renders a matching retry', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Title', prompt: 'Exact prompt', handover })
    const input = request(task)
    const run = await board.beginExecution(input)
    const submitted = run.task.executions[0]!.prompt
    expect(submitted).toBe(taskExecutionPrompt('Exact prompt', handover))
    expect(run.task.prompt).toBe('Exact prompt')
    task = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    task = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { prompt: 'Different prompt', handover: null },
    })
    const replay = await board.beginExecution(input)
    expect(replay.executionId).toBe(run.executionId)
    expect(replay.task.executions[0]!.prompt).toBe(submitted)
    expect(replay.task.handover).toBeUndefined()
    expect(task.executionSettings).toEqual({ kind: 'dsh' })
  })

  it('bounds the complete serialized prompt before publishing an attempt', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Large', prompt: 'x'.repeat(65_536), handover })
    await expect(board.beginExecution(request(task))).rejects.toThrow()
    expect(board.get(task.id)).toEqual(task)
  })

  it.each(['succeeded', 'failed', 'cancelled'] as const)('settles %s into its workflow column', async (status) => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Task', status: 'in_review', prompt: 'Actual instructions' })
    const run = await board.beginExecution(request(task))
    const result = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status })
    expect(result).toMatchObject({ status: status === 'succeeded' ? 'done' : 'in_review', executions: [{ status, prompt: 'Actual instructions' }] })
    expect(result.executions[0]?.endedAt).toBeDefined()
    await expect(board.settleExecution({ taskId: task.id, executionId: run.executionId, status })).resolves.toEqual(result)
    await expect(board.settleExecution({ taskId: task.id, executionId: run.executionId, status, error: { code: 'changed', message: 'Changed' } })).rejects.toMatchObject({ code: 'execution-state' })
    await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId })).rejects.toMatchObject({ code: 'execution-state' })
    await expect(board.attachExecution({ taskId: task.id, executionId: run.executionId, connection: dsh })).rejects.toMatchObject({ code: 'execution-state' })
  })

  it('compares request payloads before stale revisions and replays pruned history across restart', async () => {
    const first = await harness({ config: { executionHistoryLimit: 1, requestDeduplicationLimit: 3 } })
    let task = await first.board.create({ workspaceId: first.workspaceId, title: 'Task' })
    const input = request(task)
    const run = await first.board.beginExecution(input)
    await expect(first.board.beginExecution(input)).resolves.toMatchObject({ executionId: run.executionId, replayed: true })
    await expect(first.board.beginExecution({ ...input, executionSettings: { kind: 'copilot' } }))
      .resolves.toMatchObject({ executionId: run.executionId, replayed: true })
    await expect(first.board.beginExecution({ ...input, expectedRevision: run.task.revision }))
      .rejects.toMatchObject({ code: 'request-conflict' })
    task = await first.board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'failed' })
    const second = await first.board.beginExecution(request(task, 'second'))
    task = await first.board.settleExecution({ taskId: task.id, executionId: second.executionId, status: 'succeeded' })
    expect(task.executions.map(item => item.id)).toEqual([second.executionId])
    await first.ctx.fiber.dispose()
    const reopened = await harness({ pool: first.pool, config: { executionHistoryLimit: 1, requestDeduplicationLimit: 3 } })
    await expect(reopened.board.beginExecution(input)).resolves.toEqual({ task, executionId: run.executionId, replayed: true })
    await expect(reopened.board.beginExecution({ ...input, requestId: TaskRunRequestId('new') })).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
  })

  it('bounds the request index independently and protects the open receipt', async () => {
    const { board, workspaceId, facility } = await harness({ config: { executionHistoryLimit: 1, requestDeduplicationLimit: 1 } })
    let task = await board.create({ workspaceId, title: 'Task' })
    const first = request(task, 'first')
    const run1 = await board.beginExecution(first)
    task = await board.settleExecution({ taskId: task.id, executionId: run1.executionId, status: 'succeeded' })
    const second = request(task, 'second')
    const run2 = await board.beginExecution(second)
    const record = currentTaskRecord.parse(facility.get('taskboard')!.table('tasks').get(task.id))
    expect(record.requests.map(item => item.requestId)).toEqual(['second'])
    expect(record.executions).toHaveLength(2)
    task = await board.settleExecution({ taskId: task.id, executionId: run2.executionId, status: 'succeeded' })
    expect(currentTaskRecord.parse(facility.get('taskboard')!.table('tasks').get(task.id)).requests).toHaveLength(1)
    await expect(board.beginExecution(second)).resolves.toMatchObject({ executionId: run2.executionId, replayed: true })
    const run3 = await board.beginExecution({ ...first, expectedRevision: task.revision })
    expect(run3.replayed).toBe(false)
    expect(run3.executionId).not.toBe(run1.executionId)
  })

  it('does not reuse an expired request id still present in displayed history', async () => {
    const { board, workspaceId } = await harness({ config: { executionHistoryLimit: 3, requestDeduplicationLimit: 1 } })
    let task = await board.create({ workspaceId, title: 'Task' })
    const first = request(task, 'first')
    for (const id of ['first', 'second']) {
      const run = await board.beginExecution(request(task, id))
      task = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'cancelled' })
    }
    await expect(board.beginExecution({ ...first, expectedRevision: task.revision })).rejects.toMatchObject({ code: 'request-conflict' })
  })

  it.each(['pending', 'running'] as const)('rejects destructive and execution mutations while %s but permits manual planning edits', async (phase) => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Task' })
    const run = await board.beginExecution(request(task))
    task = run.task
    if (phase === 'running') {
      await board.attachExecution({
        taskId: task.id, executionId: run.executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 },
      })
      task = await board.advanceExecution({ taskId: task.id, executionId: run.executionId, receipt: { kind: 'dsh', afterSequence: 0 } })
    }
    const input = { taskId: task.id, expectedRevision: task.revision }
    for (const mutation of [
      () => board.archive(task.id, task.revision), () => board.delete(task.id, task.revision),
      () => board.disconnect(task.id, task.revision), () => board.connect({ ...input, connection: dsh }),
      () => board.confirmPermissions(task.id, task.revision),
      () => board.beginExecution(request(task, 'other')),
      ...([
        { prompt: 'Changed' }, { executionSettings: { kind: 'copilot' } }, { handover },
        { workspaceId: WorkspaceId('w2') }, { schedule },
      ] satisfies TaskboardUpdatePatch[]).map(patch => () => board.update({ ...input, patch })),
    ]) await expect(mutation()).rejects.toMatchObject({ code: 'busy' })
    task = await board.update({ ...input, patch: { title: 'New planning title', description: 'Details', labels: ['A'], priority: 'high' } })
    expect(task.executions[0]?.prompt).toBe('Task')
    expect(task.title).toBe('New planning title')
    task = await board.move({ taskId: task.id, expectedRevision: task.revision, status: 'done' })
    expect(task.status).toBe('done')
  })

  it('serializes competing admissions while a pending write is uncommitted', async () => {
    const { board, workspaceId, facility } = await harness()
    const task = await board.create({ workspaceId, title: 'Task' })
    const table = facility.get('taskboard')!.table('tasks')
    const put = table.put.bind(table)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    vi.spyOn(table, 'put').mockImplementationOnce(async (id, value) => {
      entered.resolve(undefined)
      await resume.promise
      return put(id, value)
    })
    const first = board.beginExecution(request(task))
    await entered.promise
    const replay = board.beginExecution(request(task))
    const competing = board.beginExecution(request(task, 'other'))
    const rejected = expect(competing).rejects.toBeInstanceOf(TaskboardRevisionConflictError)
    expect(board.get(task.id)?.executions).toEqual([])
    resume.resolve(undefined)
    const admitted = await first
    await expect(replay).resolves.toMatchObject({ executionId: admitted.executionId, replayed: true })
    await rejected
    expect(board.get(task.id)?.executions).toHaveLength(1)
  })

  it('rejects archived, stale, missing Workspace, unresolved and mismatched explicit choices', async () => {
    const { board, workspaceId, workspaces } = await harness()
    const task = await board.create({
      workspaceId, title: 'Task', executionSettings: { kind: 'dsh', presetId: 'basic', permission: 'workspace-write', model: { provider: 'deepseek', model: 'chat' } },
    })
    for (const settings of [
      { kind: 'copilot' },
      { kind: 'dsh', presetId: 'other', permission: 'workspace-write', model: { provider: 'deepseek', model: 'chat' } },
      { kind: 'dsh', presetId: 'basic', permission: 'danger-full-access', model: { provider: 'deepseek', model: 'chat' } },
      { kind: 'dsh', presetId: 'basic', permission: 'workspace-write', model: { provider: 'deepseek', model: 'other' } },
    ] satisfies TaskExecutionSettings[]) {
      await expect(board.beginExecution({ ...request(task), executionSettings: settings })).rejects.toMatchObject({ code: 'settings-conflict' })
    }
    workspaces.delete(workspaceId)
    await expect(board.beginExecution(request(task))).rejects.toBeInstanceOf(TaskboardWorkspaceNotFoundError)
    const archived = await board.archive(task.id, task.revision)
    await expect(board.beginExecution(request(archived))).rejects.toBeInstanceOf(TaskboardTaskArchivedError)
  })

  it('defaults Copilot to read-only and requires explicit confirmation for write permissions', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Copilot', executionSettings: { kind: 'copilot' } })
    expect(task.executionSettings).toEqual({ kind: 'copilot' })
    await expect(board.beginExecution({ ...request(task), executionSettings: { kind: 'copilot', permission: 'full-access' } })).rejects.toMatchObject({ code: 'settings-conflict' })
    let configured = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { executionSettings: { kind: 'copilot', permission: 'workspace-write' } } })
    await expect(board.beginExecution(request(configured))).rejects.toMatchObject({ code: 'permission-unconfirmed' })
    configured = await board.confirmPermissions(task.id, configured.revision)
    const run = await board.beginExecution(request(configured))
    expect(run.task.executions[0]?.executionSettings).toEqual(configured.executionSettings)
    const dshTask = await board.create({ workspaceId, title: 'DSH' })
    const elevated: TaskExecutionSettings = { kind: 'dsh', permission: 'danger-full-access' }
    const inherited = await board.beginExecution({ ...request(dshTask), executionSettings: elevated })
    expect(inherited.task.executionSettings).toEqual({ kind: 'dsh' })
    expect(inherited.task.executions[0]?.executionSettings).toEqual(elevated)
    let explicit = await board.create({ workspaceId, title: 'Explicit DSH', executionSettings: elevated })
    await expect(board.beginExecution(request(explicit))).rejects.toMatchObject({ code: 'permission-unconfirmed' })
    explicit = await board.confirmPermissions(explicit.id, explicit.revision)
    await expect(board.beginExecution(request(explicit))).resolves.toMatchObject({ replayed: false })
    expect(requiresPermissionConfirmation({ kind: 'dsh' })).toBe(false)
    expect(requiresPermissionConfirmation({ kind: 'dsh', permission: 'read-only' })).toBe(false)
    expect(requiresPermissionConfirmation({ kind: 'dsh', permission: 'workspace-write' })).toBe(false)
    expect(requiresPermissionConfirmation({ kind: 'dsh', permission: 'custom-admin' })).toBe(true)
  })

  it('requires connected dispatch and immutable recovery cursors while permitting message-id enrichment', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Copilot', executionSettings: { kind: 'copilot' } })
    const run = await board.beginExecution(request(task))
    await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId })).rejects.toMatchObject({ code: 'execution-state' })
    await expect(board.attachExecution({ taskId: task.id, executionId: TaskExecutionId('missing'), connection: copilot })).rejects.toMatchObject({ code: 'execution-not-found' })
    await expect(board.attachExecution({ taskId: task.id, executionId: run.executionId, connection: copilot, receipt: { kind: 'dsh', afterSequence: 0 } })).rejects.toMatchObject({ code: 'connection-conflict' })
    await board.attachExecution({ taskId: task.id, executionId: run.executionId, connection: copilot, receipt: { kind: 'copilot', afterCursor: null } })
    const running = await board.advanceExecution({ taskId: task.id, executionId: run.executionId, receipt: { kind: 'copilot', afterCursor: null, messageId: 'm1' } })
    await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId })).resolves.toEqual(running)
    await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId, receipt: { kind: 'copilot', afterCursor: null } })).resolves.toEqual(running)
    await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId, startedAt: '2000-01-01T00:00:00.000Z' })).rejects.toMatchObject({ code: 'execution-state' })
    for (const receipt of [
      { kind: 'copilot', afterCursor: 'changed' },
      { kind: 'copilot', afterCursor: null, messageId: 'different' },
    ] as const) {
      await expect(board.advanceExecution({ taskId: task.id, executionId: run.executionId, receipt })).rejects.toMatchObject({ code: 'execution-state' })
    }
    const ended = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    await expect(board.settleExecution({
      taskId: task.id, executionId: run.executionId, status: 'succeeded', endedAt: ended.executions[0]!.endedAt!,
    })).resolves.toEqual(ended)
    await expect(board.settleExecution({
      taskId: task.id, executionId: run.executionId, status: 'succeeded', endedAt: '2000-01-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'execution-state' })
  })

  it('rejects a different explicitly configured Copilot model and a different DSH reasoning choice', async () => {
    const { board, workspaceId } = await harness()
    const copilotTask = await board.create({ workspaceId, title: 'Copilot', executionSettings: { kind: 'copilot', model: 'selected' } })
    await expect(board.beginExecution({
      ...request(copilotTask), executionSettings: { kind: 'copilot', model: 'different' },
    })).rejects.toMatchObject({ code: 'settings-conflict' })
    const dshTask = await board.create({
      workspaceId, title: 'DSH',
      executionSettings: { kind: 'dsh', model: { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') } },
    })
    await expect(board.beginExecution({
      ...request(dshTask),
      executionSettings: { kind: 'dsh', model: { provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') } },
    })).rejects.toMatchObject({ code: 'settings-conflict' })
  })
})

describe('schedule admission', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })
  afterEach(() => { vi.useRealTimers() })
  const occurrence = {
    trigger: 'schedule' as const, scheduledAt: '2026-01-01T01:00:00.000Z',
    nextRunAt: '2026-01-01T02:00:00.000Z', now: '2026-01-01T01:00:00.000Z',
  }

  it('atomically advances the exact due occurrence with pending admission and replays it once', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Scheduled', description: 'Scheduled instructions', schedule })
    const input = { taskId: task.id, proposedConnection: dsh, requestId: TaskRunRequestId('schedule-1'), executionSettings: task.executionSettings, ...occurrence }
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    const run = await board.beginExecution(input)
    expect(writes).toHaveBeenCalledOnce()
    expect(run.task.schedule).toMatchObject({ lastTriggeredAt: occurrence.scheduledAt, nextRunAt: occurrence.nextRunAt })
    expect(run.task.executions[0]).toMatchObject({
      status: 'pending', trigger: 'schedule', scheduledAt: occurrence.scheduledAt, prompt: 'Scheduled\n\nScheduled instructions',
    })
    await expect(board.beginExecution(input)).resolves.toMatchObject({ replayed: true, executionId: run.executionId })
    await expect(board.beginExecution({ ...input, nextRunAt: '2026-01-01T03:00:00.000Z' }))
      .resolves.toMatchObject({ executionId: run.executionId, replayed: true })
    await expect(board.beginExecution({ ...input, scheduledAt: occurrence.nextRunAt }))
      .rejects.toMatchObject({ code: 'request-conflict' })
    await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    await expect(board.beginExecution({ ...input, requestId: TaskRunRequestId('different') })).rejects.toMatchObject({ code: 'schedule-stale' })
  })

  it('does not consume an occurrence on failed admission and rolls busy occurrences forward without overlap', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Scheduled', schedule })
    const input = { taskId: task.id, proposedConnection: dsh, requestId: TaskRunRequestId('scheduled'), executionSettings: task.executionSettings, ...occurrence }
    pool.failNextWrites = 1
    await expect(board.beginExecution(input)).rejects.toThrow('injected write failure')
    expect(board.get(task.id)).toEqual(task)
    const manual = await board.beginExecution(request(task))
    await expect(board.beginExecution(input)).rejects.toMatchObject({ code: 'busy' })
    const skipped = await board.rollForwardSchedule({ taskId: task.id, ...occurrence })
    expect(skipped.executions).toEqual(manual.task.executions)
    expect(skipped.schedule).toMatchObject({ lastTriggeredAt: occurrence.scheduledAt, nextRunAt: occurrence.nextRunAt })
    await expect(board.rollForwardSchedule({ taskId: task.id, ...occurrence })).rejects.toMatchObject({ code: 'schedule-stale' })
  })

  it('rejects future, stale, disabled and invalid successor occurrences', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Scheduled', schedule })
    await expect(board.rollForwardSchedule({ taskId: task.id, ...occurrence, now: '2025-12-31T23:59:59.000Z' })).rejects.toMatchObject({ code: 'schedule-not-due' })
    for (const patch of [{ nextRunAt: occurrence.scheduledAt }, { nextRunAt: 'invalid' }, { now: 'invalid' }]) {
      await expect(board.rollForwardSchedule({ taskId: task.id, ...occurrence, ...patch })).rejects.toBeInstanceOf(TaskboardInputError)
    }
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { schedule: { ...schedule, enabled: false } } })
    await expect(board.rollForwardSchedule({ taskId: task.id, ...occurrence })).rejects.toMatchObject({ code: 'schedule-stale' })
    task = await board.update({ taskId: task.id, expectedRevision: task.revision, patch: { schedule: null } })
    expect(task).not.toHaveProperty('schedule')
    await expect(board.rollForwardSchedule({ taskId: task.id, ...occurrence })).rejects.toMatchObject({ code: 'schedule-stale' })
  })

  it('uses the Host clock when a due occurrence has no explicit now', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Scheduled', schedule })
    vi.setSystemTime(new Date(occurrence.scheduledAt))
    await expect(board.rollForwardSchedule({
      taskId: task.id, scheduledAt: occurrence.scheduledAt, nextRunAt: occurrence.nextRunAt,
    })).resolves.toMatchObject({ schedule: { nextRunAt: occurrence.nextRunAt } })
  })
})

describe('durability and detached state', () => {
  it('rejects reads before the service has opened its authoritative table', () => {
    const ctx = new Context()
    roots.push(ctx)
    const board = new TaskboardService(ctx)
    expect(() => board.get(TaskId('uninitialized'))).toThrow('not initialized')
  })
  it.each(['create', 'edit', 'connect', 'delete', 'admit', 'attach', 'advance', 'settle', 'archive', 'restore', 'duplicate', 'confirm'] as const)(
    'does not publish failed %s writes', async (operation) => {
      const { board, workspaceId, pool, ctx } = await harness()
      let task = await board.create({ workspaceId, title: 'Original' })
      let executionId = TaskExecutionId('unused')
      if (['attach', 'advance', 'settle'].includes(operation)) {
        const run = await board.beginExecution(request(task))
        task = run.task
        executionId = run.executionId
        if (operation === 'advance') task = await board.attachExecution({
          taskId: task.id, executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 },
        })
      }
      if (operation === 'restore') task = await board.archive(task.id, task.revision)
      const changes = vi.fn()
      ctx.on('domain/changed', changes)
      pool.failNextWrites = 1
      const actions = {
        create: () => board.create({ workspaceId, title: 'New' }),
        edit: () => board.update({ taskId: task.id, expectedRevision: task.revision, patch: { title: 'Changed' } }),
        connect: () => board.connect({ taskId: task.id, expectedRevision: task.revision, connection: dsh }),
        delete: () => board.delete(task.id, task.revision),
        admit: () => board.beginExecution(request(task)),
        attach: () => board.attachExecution({ taskId: task.id, executionId, connection: dsh, receipt: { kind: 'dsh', afterSequence: 0 } }),
        advance: () => board.advanceExecution({ taskId: task.id, executionId, receipt: { kind: 'dsh', afterSequence: 0 } }),
        settle: () => board.settleExecution({ taskId: task.id, executionId, status: 'succeeded' }),
        archive: () => board.archive(task.id, task.revision),
        restore: () => board.restore(task.id, task.revision),
        duplicate: () => board.duplicate({ taskId: task.id, expectedRevision: task.revision }),
        confirm: () => board.confirmPermissions(task.id, task.revision),
      }
      await expect(actions[operation]()).rejects.toThrow('injected write failure')
      expect(board.list(undefined, true)).toEqual([task])
      expect(changes).not.toHaveBeenCalled()
    },
  )

  it('detaches queued input, all nested return values and reopened records', async () => {
    const first = await harness()
    const fields = {
      workspaceId: first.workspaceId, title: 'Task', labels: ['one'], handover: structuredClone(handover),
      executionSettings: { kind: 'dsh' as const, model: { provider: 'p', model: 'm' } }, schedule: { ...schedule },
    }
    const creating = first.board.create(fields)
    fields.labels.push('mutated')
    fields.executionSettings.model.model = 'mutated'
    const task = await creating
    expect(task.labels).toEqual(['one'])
    const run = await first.board.beginExecution(request(task))
    const returned = run.task
    const returnedExecution = returned.executions[0]
    const returnedModel = returned.executionSettings.model
    const executionModel = returnedExecution?.executionSettings.model
    if (returned.handover === undefined || returned.schedule === undefined || returnedExecution === undefined
      || returnedExecution.handover === undefined
      || typeof returnedModel !== 'object' || returnedModel === null
      || typeof executionModel !== 'object' || executionModel === null) {
      throw new Error('Taskboard detachment fixture did not retain its nested DSH values')
    }
    Array.prototype.push.call(returned.labels, 'outside')
    Array.prototype.push.call(returned.handover.references, 'returned')
    Reflect.set(returned.schedule, 'cron', 'outside')
    Array.prototype.push.call(returnedExecution.handover.references, 'returned')
    Reflect.set(executionModel, 'model', 'outside')
    Reflect.set(returnedModel, 'model', 'returned')
    const intact = first.board.get(task.id)!
    expect(intact.handover).toEqual(handover)
    expect(intact.executions[0]?.handover).toEqual(handover)
    expect(intact.executionSettings).toMatchObject({ model: { model: 'm' } })
    await first.ctx.fiber.dispose()
    const reopened = await harness({ pool: first.pool })
    expect(reopened.board.get(task.id)).toEqual(intact)
  })

  it.each(['create', 'update', 'delete', 'duplicate', 'connect', 'disconnect', 'begin'] as const)(
    'cancels queued %s before durability starts', async (operation) => {
      const { board, workspaceId, pool } = await harness()
      const task = await board.create({ workspaceId, title: 'Original' })
      const cancellation = new AbortController()
      const signal = cancellation.signal
      const writes = vi.spyOn(pool, 'consumeInjectedFailure')
      const operations = {
        create: () => board.create({ workspaceId, title: 'New' }, signal),
        update: () => board.update({ taskId: task.id, expectedRevision: 1, patch: { title: 'New' } }, signal),
        delete: () => board.delete(task.id, 1, signal),
        duplicate: () => board.duplicate({ taskId: task.id, expectedRevision: 1 }, signal),
        connect: () => board.connect({ taskId: task.id, expectedRevision: 1, connection: dsh }, signal),
        disconnect: () => board.disconnect(task.id, 1, signal),
        begin: () => board.beginExecution(request(task), signal),
      }
      const pending = operations[operation]()
      cancellation.abort(new Error('Cancelled in queue'))
      await expect(pending).rejects.toThrow('Cancelled in queue')
      expect(writes).not.toHaveBeenCalled()
      expect(board.get(task.id)).toEqual(task)
    },
  )

  it('finishes an admitted write before disposal and ignores cancellation after submission', async () => {
    const { board, workspaceId, facility, ctx } = await harness()
    const task = await board.create({ workspaceId, title: 'Original' })
    const table = facility.get('taskboard')!.table('tasks')
    const remove = table.delete.bind(table)
    const entered = Promise.withResolvers<undefined>()
    const resume = Promise.withResolvers<undefined>()
    vi.spyOn(table, 'delete').mockImplementationOnce(async (id) => {
      entered.resolve(undefined)
      await resume.promise
      return remove(id)
    })
    const cancellation = new AbortController()
    const deleting = board.delete(task.id, 1, cancellation.signal)
    await entered.promise
    cancellation.abort(new Error('After submission'))
    const disposal = ctx.fiber.dispose()
    resume.resolve(undefined)
    await expect(deleting).resolves.toEqual({ taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
    await disposal
    await expect(board.create({ workspaceId, title: 'After close' })).rejects.toThrow('closing')
  })

  it('validates retention configuration instead of accepting zero, negative or fractional limits', () => {
    expect(Config({})).toEqual({ executionHistoryLimit: 20, requestDeduplicationLimit: 256 })
    for (const value of [0, -1, 1.5]) {
      expect(() => Config({ executionHistoryLimit: value })).toThrow()
      expect(() => Config({ requestDeduplicationLimit: value })).toThrow()
    }
  })

  it('rejects malformed current records instead of decoding them as legacy data', async () => {
    const { board, workspaceId, facility } = await harness()
    const task = await board.create({ workspaceId, title: 'Task' })
    const record = facility.get('taskboard')!.table('tasks').get(task.id)
    expect(taskRecord.safeParse({ ...record as object, format: 3 }).success).toBe(false)
    expect(taskRecord.safeParse({ ...record as object, connection: copilot }).success).toBe(false)
    expect(taskRecord.safeParse({ ...record as object, unresolvedConnections: [dsh, dsh] }).success).toBe(false)
    expect(taskRecord.safeParse({ ...record as object, connection: dsh, unresolvedConnections: [dsh, copilot] }).success).toBe(false)
  })
})
