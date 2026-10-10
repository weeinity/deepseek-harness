import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgencyCopilotSessionId, TaskboardSessionInvalidError, TaskId, TaskRunRequestId } from '../src/index.ts'
import { cleanup, copilot, dsh, harness, request } from './harness.ts'

afterEach(cleanup)

describe('atomic conversation reservation', () => {
  it.each([dsh, copilot])('creates planning data and a validated existing $kind connection in one write', async (connection) => {
    const { board, workspaceId, pool } = await harness()
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    const task = await board.create({
      workspaceId, title: 'Linked at creation', status: 'in_review', priority: 'urgent', labels: ['Retain'],
      executionSettings: { kind: connection.kind }, connection,
    })
    expect(writes).toHaveBeenCalledOnce()
    expect(task).toMatchObject({ revision: 1, connection, status: 'in_review', priority: 'urgent', labels: ['Retain'] })
    const run = await board.beginExecution(request(task))
    expect(run.task.executions[0]).toMatchObject({ connection, createsConnection: false })
  })

  it('rejects invalid initial membership or mismatched executors without creating an orphan task', async () => {
    const { board, workspaceId, pool } = await harness()
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    await expect(board.create({
      workspaceId, title: 'Invalid', connection: { kind: 'dsh', sessionId: SessionId('s3') },
    })).rejects.toBeInstanceOf(TaskboardSessionInvalidError)
    await expect(board.create({ workspaceId, title: 'Mismatch', connection: copilot }))
      .rejects.toMatchObject({ code: 'settings-conflict' })
    expect(writes).not.toHaveBeenCalled()
    expect(board.list(undefined, true)).toEqual([])
  })

  it('does not publish a linked task when its atomic create fails', async () => {
    const { board, workspaceId, pool } = await harness()
    pool.failNextWrites = 1
    await expect(board.create({ workspaceId, title: 'Linked', connection: dsh })).rejects.toThrow('injected write failure')
    expect(board.list(undefined, true)).toEqual([])
  })

  it('reserves a first conversation and initiating connection in the same pending write', async () => {
    const { board, workspaceId, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'First', executionSettings: { kind: 'copilot' } })
    const writes = vi.spyOn(pool, 'consumeInjectedFailure')
    const input = { ...request(task), initiator: dsh }
    const run = await board.beginExecution(input)
    expect(writes).toHaveBeenCalledOnce()
    expect(run.task).toMatchObject({
      connection: copilot,
      executions: [{ connection: copilot, createsConnection: true, initiator: dsh, status: 'pending' }],
    })
    await expect(board.beginExecution({
      ...input, proposedConnection: { kind: 'copilot', sessionId: AgencyCopilotSessionId('2eb3dbf2-8b82-4863-b505-520708dcce80') },
    })).resolves.toEqual({ ...run, replayed: true })
    await expect(board.beginExecution({ ...input, initiator: copilot })).rejects.toMatchObject({ code: 'request-conflict' })
    expect(board.getRunRequest(input)).toEqual({ ...run, replayed: true })
    expect(() => board.getRunRequest({ ...input, initiator: copilot })).toThrow('different caller inputs')
    expect(() => board.getRunRequest({ ...input, expectedRevision: task.revision + 1 })).toThrow('different caller inputs')
    expect(board.getRunRequest({ ...input, requestId: TaskRunRequestId('absent') })).toBeUndefined()
    expect(board.getRunRequest({ ...input, taskId: TaskId('absent') })).toBeUndefined()
    expect(writes).toHaveBeenCalledOnce()
  })

  it('looks up pruned attempts without resolving changed task defaults or reallocating a conversation', async () => {
    const { board, workspaceId } = await harness({ config: { executionHistoryLimit: 1 } })
    let task = await board.create({ workspaceId, title: 'Task' })
    const firstInput = { ...request(task, 'first'), initiator: copilot }
    const first = await board.beginExecution(firstInput)
    task = await board.settleExecution({ taskId: task.id, executionId: first.executionId, status: 'failed' })
    const second = await board.beginExecution(request(task, 'second'))
    task = await board.settleExecution({ taskId: task.id, executionId: second.executionId, status: 'succeeded' })
    task = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { executionSettings: { kind: 'dsh', model: { provider: 'p', model: 'changed' } } },
    })
    expect(task.executions).toHaveLength(1)
    expect(board.getRunRequest(firstInput)).toEqual({ task, executionId: first.executionId, replayed: true })
    await expect(board.beginExecution({
      ...firstInput,
      executionSettings: { kind: 'dsh', permission: 'changed-host-default', model: { provider: 'other', model: 'new-default' } },
      proposedConnection: { kind: 'dsh', sessionId: SessionId('fresh-candidate') },
    })).resolves.toEqual({ task, executionId: first.executionId, replayed: true })
  })

  it('requires a matching reservation for an unconnected task', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'First' })
    const { proposedConnection: _proposal, ...withoutProposal } = request(task)
    await expect(board.beginExecution(withoutProposal)).rejects.toMatchObject({ code: 'connection-conflict' })
    await expect(board.beginExecution({ ...withoutProposal, proposedConnection: copilot }))
      .rejects.toMatchObject({ code: 'settings-conflict' })
    expect(board.get(task.id)).toEqual(task)
  })

  it('refuses to mark an unconnected persisted pending attempt running', async () => {
    const first = await harness()
    const task = await first.board.create({ workspaceId: first.workspaceId, title: 'Unconnected persisted attempt' })
    const run = await first.board.beginExecution(request(task))
    await first.ctx.fiber.dispose()
    const records = first.pool.media.get('taskboard')!.tables.get('tasks')!
    const stored = records.get(task.id) as { connection?: unknown; executions: { connection?: unknown; createsConnection: boolean }[] }
    delete stored.connection
    delete stored.executions[0]!.connection
    stored.executions[0]!.createsConnection = false
    const reopened = await harness({ pool: first.pool })
    await expect(reopened.board.advanceExecution({ taskId: task.id, executionId: run.executionId }))
      .rejects.toMatchObject({ code: 'execution-state' })
    expect(reopened.board.get(task.id)?.executions[0]?.status).toBe('pending')
  })

  it('retains a failed first allocation and requires explicit disconnect before allocating again', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'First' })
    const reserved = { kind: 'dsh' as const, sessionId: SessionId('not-materialized') }
    const run = await board.beginExecution({ ...request(task), proposedConnection: reserved })
    expect(run.task.connection).toEqual(reserved)
    await expect(board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: reserved, receipt: { kind: 'dsh', afterSequence: 0 },
    })).rejects.toBeInstanceOf(TaskboardSessionInvalidError)
    const failed = await board.settleExecution({
      taskId: task.id, executionId: run.executionId, status: 'failed',
      error: { code: 'creation-failed', message: 'Could not create the conversation' },
    })
    expect(failed).toMatchObject({
      connection: reserved,
      executions: [{ status: 'failed', createsConnection: true, connection: reserved }],
    })
    await expect(board.beginExecution(request(failed, 'retry-missing'))).rejects.toBeInstanceOf(TaskboardSessionInvalidError)
    await expect(board.beginExecution({ ...request(failed, 'replace'), proposedConnection: dsh }))
      .rejects.toMatchObject({ code: 'connection-conflict' })
    const disconnected = await board.disconnect(task.id, failed.revision)
    const replacement = await board.beginExecution(request(disconnected, 'explicit-replacement'))
    expect(replacement.task.connection).toEqual(dsh)
    expect(replacement.task.executions[1]).toMatchObject({ createsConnection: true, connection: dsh })
    expect(replacement.task.executions[0]).toEqual(failed.executions[0])
  })

  it('prepares only the reserved identity and never treats Run Again as another creation', async () => {
    const { board, workspaceId, workspace } = await harness()
    const task = await board.create({ workspaceId, title: 'First' })
    const reserved = { kind: 'dsh' as const, sessionId: SessionId('created-after-admission') }
    const run = await board.beginExecution({ ...request(task), proposedConnection: reserved })
    const sessionIds = workspace.sessionIds as SessionId[]
    sessionIds.push(reserved.sessionId)
    await expect(board.advanceExecution({
      taskId: task.id, executionId: run.executionId, receipt: { kind: 'dsh', afterSequence: 0 },
    })).rejects.toMatchObject({ code: 'execution-state' })
    const prepared = await board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: reserved, receipt: { kind: 'dsh', afterSequence: 0 },
    })
    expect(prepared.executions[0]).toMatchObject({ status: 'pending', receipt: { kind: 'dsh', afterSequence: 0 } })
    await board.advanceExecution({
      taskId: task.id, executionId: run.executionId, receipt: { kind: 'dsh', afterSequence: 0, messageId: 'sent' },
    })
    const settled = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    const { proposedConnection: _proposal, ...againInput } = request(settled, 'again')
    const again = await board.beginExecution(againInput)
    expect(again.task.executions[1]).toMatchObject({ connection: reserved, createsConnection: false })
    await expect(board.beginExecution({
      ...againInput, requestId: TaskRunRequestId('different'), proposedConnection: dsh,
      expectedRevision: again.task.revision,
    })).rejects.toMatchObject({ code: 'busy' })
  })

  it('persists uncertain-dispatch diagnostics without marking pending work running or terminal', async () => {
    const { board, workspaceId } = await harness()
    const task = await board.create({ workspaceId, title: 'Observed', status: 'in_review', connection: dsh })
    const run = await board.beginExecution(request(task))
    const uncertain = { code: 'dispatch-uncertain', message: 'Submission could not be confirmed; input was not resubmitted' }
    let observed = await board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: dsh,
      receipt: { kind: 'dsh', afterSequence: 0 }, error: uncertain,
    })
    expect(observed).toMatchObject({ status: 'in_progress', executions: [{ status: 'pending', error: uncertain }] })
    await expect(board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: dsh, error: uncertain,
    })).resolves.toEqual(observed)
    observed = await board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: dsh,
      receipt: { kind: 'dsh', afterSequence: 0, messageId: 'accepted' },
    })
    expect(observed.executions[0]).toMatchObject({ status: 'pending', error: uncertain })
    observed = await board.advanceExecution({ taskId: task.id, executionId: run.executionId, error: null })
    expect(observed.executions[0]?.status).toBe('running')
    expect(observed.executions[0]).not.toHaveProperty('error')
    observed = await board.advanceExecution({ taskId: task.id, executionId: run.executionId, error: uncertain })
    expect(observed.executions[0]).toMatchObject({ status: 'running', error: uncertain })
    observed = await board.attachExecution({ taskId: task.id, executionId: run.executionId, connection: dsh, error: null })
    expect(observed.executions[0]?.status).toBe('running')
    expect(observed.executions[0]).not.toHaveProperty('error')
    await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    await expect(board.attachExecution({
      taskId: task.id, executionId: run.executionId, connection: dsh, error: uncertain,
    })).rejects.toMatchObject({ code: 'execution-state' })
  })

  it('records and clears diagnostics by attempt identity when its Workspace is unavailable', async () => {
    const { board, workspaceId, workspaces, pool } = await harness()
    const task = await board.create({ workspaceId, title: 'Observed', status: 'in_review', connection: dsh })
    const run = await board.beginExecution(request(task))
    workspaces.delete(workspaceId)
    const input = {
      taskId: task.id, executionId: run.executionId,
      error: { code: 'observation-unavailable', message: 'Could not establish the outcome' },
    }
    const observed = await board.recordExecutionError(input)
    expect(observed).toMatchObject({
      status: 'in_progress', executions: [{ status: 'pending', prompt: 'Observed', connection: dsh, error: input.error }],
    })
    await expect(board.recordExecutionError(input)).resolves.toEqual(observed)
    pool.failNextWrites = 1
    await expect(board.recordExecutionError({ ...input, error: null })).rejects.toThrow('injected write failure')
    expect(board.get(task.id)).toEqual(observed)
    const cleared = await board.recordExecutionError({ ...input, error: null })
    expect(cleared.executions[0]?.status).toBe('pending')
    expect(cleared.executions[0]).not.toHaveProperty('error')
    await board.recordExecutionError(input)
    const settled = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    expect(settled.executions[0]).not.toHaveProperty('error')
    await expect(board.recordExecutionError(input)).rejects.toMatchObject({ code: 'execution-state' })
  })
})
