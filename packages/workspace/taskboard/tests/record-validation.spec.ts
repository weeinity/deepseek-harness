import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { TaskExecutionId, TaskRunRequestId } from '../src/index.ts'
import { currentTaskRecord, storedTaskId, taskExecution, taskRecord } from '../src/spec.ts'
import { copilot, dsh } from './harness.ts'

const at = '2026-01-01T00:00:00.000Z'
const later = '2026-01-01T01:00:00.000Z'
const before = '2025-12-31T23:59:59.000Z'
const attempt = {
  id: TaskExecutionId('attempt'), requestId: TaskRunRequestId('request'),
  trigger: 'manual' as const, requestedAt: at, status: 'pending' as const, createsConnection: false,
  workspaceId: WorkspaceId('w1'), prompt: 'Instructions', executionSettings: { kind: 'dsh' as const },
}
const record = {
  format: 2 as const, revision: 1, ordinal: 1, workspaceId: WorkspaceId('w1'),
  title: 'Task', description: '', status: 'todo' as const, rank: 0, labels: [],
  createdAt: at, updatedAt: at, prompt: '', executionSettings: { kind: 'dsh' as const },
  executions: [attempt], requests: [{ requestId: attempt.requestId, executionId: attempt.id, fingerprint: 'fingerprint' }],
}

describe('durable parser rejection', () => {
  it('validates stored task keys', () => {
    expect(storedTaskId('task')).toBe('task')
    expect(() => storedTaskId('')).toThrow()
  })

  it.each([
    { endedAt: later },
    { trigger: 'schedule' },
    { scheduledAt: at },
    { status: 'running' },
    { status: 'running', startedAt: at },
    { startedAt: at },
    { createsConnection: true },
    { connection: copilot },
    { receipt: { kind: 'dsh', afterSequence: 1 } },
    { connection: dsh, receipt: { kind: 'copilot', afterCursor: null } },
    { status: 'running', startedAt: before, connection: dsh },
    { status: 'succeeded' },
    { status: 'failed', endedAt: before },
    { status: 'cancelled', startedAt: later, endedAt: at },
  ])('rejects inconsistent persisted attempt fields: %j', (patch) => {
    expect(taskExecution.safeParse({ ...attempt, ...patch }).success).toBe(false)
  })

  it.each([
    { executions: [attempt, { ...attempt, id: TaskExecutionId('other'), requestId: TaskRunRequestId('other') }] },
    { archivedAt: later },
    { unresolvedConnections: [dsh, copilot] },
    { workspaceId: WorkspaceId('other') },
    { executionSettings: { kind: 'copilot' } },
    { connection: dsh },
    { requests: [] },
    { requests: [{ requestId: 'other', executionId: attempt.id, fingerprint: 'fingerprint' }] },
    { requests: [{ requestId: attempt.requestId, executionId: 'other', fingerprint: 'fingerprint' }] },
    { requests: [record.requests[0], record.requests[0]] },
    { requests: [record.requests[0], { ...record.requests[0], requestId: 'other' }] },
    { executions: [{ ...attempt, status: 'succeeded', endedAt: later }, { ...attempt, id: TaskExecutionId('other'), status: 'succeeded', endedAt: later }] },
    { executions: [{ ...attempt, status: 'succeeded', endedAt: later }, { ...attempt, requestId: TaskRunRequestId('other'), status: 'succeeded', endedAt: later }] },
    { executions: [], archivedAt: later, schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC', nextRunAt: later } },
    { schedule: { enabled: true, cron: '* * * * *', timeZone: 'UTC' } },
  ])('rejects inconsistent authoritative task records: %j', (patch) => {
    expect(currentTaskRecord.safeParse({ ...record, ...patch }).success).toBe(false)
  })

  it('retains settled historical connections independently of the current exclusive connection', () => {
    const settled = { ...attempt, connection: { kind: 'dsh' as const, sessionId: SessionId('former') }, status: 'succeeded', endedAt: later }
    const current = currentTaskRecord.parse({ ...record, connection: copilot, executionSettings: { kind: 'copilot' }, executions: [settled] })
    expect(current.connection).toEqual(copilot)
    expect(current.executions[0]?.connection?.sessionId).toBe('former')
  })

  it('rejects current fields without a format tag and unknown legacy fields', () => {
    const { format: _format, ...untagged } = record
    expect(taskRecord.safeParse(untagged).success).toBe(false)
    expect(taskRecord.safeParse({
      ...untagged, executions: undefined, requests: undefined, prompt: undefined, executionSettings: undefined,
    }).success).toBe(false)
  })
})
