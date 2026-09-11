import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { TaskId, taskboardDomainSpec, taskRecord } from '../src/index.ts'
import type { TaskConnection } from '../src/index.ts'
import { cleanup, copilot, dsh, harness, request } from './harness.ts'

const directories: string[] = []
afterEach(async () => {
  await cleanup()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function legacy(ordinal: number, connections: readonly TaskConnection[]) {
  return {
    revision: 7, ordinal, workspaceId: 'w1', title: `Legacy ${ordinal}`, description: 'Preserve these instructions',
    status: 'in_review', rank: ordinal * 1024, priority: 'high', labels: ['Preserved'],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    ...Object.fromEntries(connections.map(connection => [
      connection.kind === 'dsh' ? 'sessionId' : 'agencyCopilotSessionId', connection.sessionId,
    ])),
  }
}

describe('released records', () => {
  it.each([
    { connections: [], expected: undefined },
    { connections: [dsh], expected: dsh },
    { connections: [copilot], expected: copilot },
    { connections: [dsh, copilot], expected: undefined },
  ])('decodes legacy connection choices without fabricating attempts: $connections', ({ connections, expected }) => {
    const input = legacy(1, connections)
    const result = taskRecord.parse(input)
    expect(result).toMatchObject({
      revision: 7, ordinal: 1, status: 'in_review', priority: 'high', labels: ['Preserved'],
      prompt: 'Legacy 1\n\nPreserve these instructions', executions: [], requests: [], format: 2,
    })
    expect(result.connection).toEqual(expected)
    expect(result.unresolvedConnections).toEqual(connections.length === 2 ? connections : undefined)
    expect(result).not.toHaveProperty('sessionId')
    expect(result).not.toHaveProperty('agencyCopilotSessionId')
    expect(input).not.toHaveProperty('executions')
    const blank = taskRecord.parse({ ...input, description: '' })
    expect(blank.prompt).toBe(input.title)
  })

  it('upgrades a real SQLite V1 unit, preserves every row, and persists exclusive legacy selections on edits', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'packages', 'workspace', 'taskboard', '.taskboard-migration-'))
    directories.push(directory)
    const path = join(directory, 'taskboard.sqlite')
    const seed = new SqliteStorageBackend({ path, journalMode: 'delete' })
    const unit = await seed.kv.open({ name: 'taskboard', version: 1, layout: 'per-record', tables: ['tasks'], hasGlobal: false })
    const inputs = [[], [dsh], [copilot], [dsh, copilot]]
    for (const [index, connections] of inputs.entries()) {
      await unit.putRecord('tasks', `legacy-${index}`, legacy(index + 1, connections))
    }
    await unit.close()
    await seed.close()
    const opened = await harness({ backend: new SqliteStorageBackend({ path, journalMode: 'delete' }) })
    expect(taskboardDomainSpec).toMatchObject({ version: 2, compatibleVersions: [1] })
    expect(opened.board.list()).toHaveLength(4)
    const unresolved = opened.board.get(TaskId('legacy-3'))!
    expect(unresolved.unresolvedConnections).toEqual([dsh, copilot])
    await expect(opened.board.beginExecution(request(unresolved))).rejects.toMatchObject({ code: 'unresolved-connections' })
    await expect(opened.board.connect({
      taskId: unresolved.id, expectedRevision: unresolved.revision,
      connection: { kind: 'dsh', sessionId: 's2' as typeof dsh.sessionId } as TaskConnection,
    })).rejects.toMatchObject({ code: 'connection-conflict' })
    const selected = await opened.board.connect({
      taskId: unresolved.id, expectedRevision: unresolved.revision, connection: copilot, executionSettings: { kind: 'copilot' },
    })
    expect(selected.connection).toEqual(copilot)
    expect(selected).not.toHaveProperty('unresolvedConnections')
    expect(selected.status).toBe('in_review')
    await opened.ctx.fiber.dispose()
    await cleanup()
    const db = new DatabaseSync(path)
    try {
      expect(db.prepare('SELECT version FROM units WHERE name = ?').get('taskboard')).toEqual({ version: 2 })
    } finally {
      db.close()
    }
    const reopened = await harness({ backend: new SqliteStorageBackend({ path, journalMode: 'delete' }) })
    expect(reopened.board.list()).toHaveLength(4)
    expect(reopened.board.get(selected.id)).toEqual(selected)
    expect(reopened.board.get(TaskId('legacy-1'))?.connection).toEqual(dsh)
    expect(reopened.board.get(TaskId('legacy-2'))?.connection).toEqual(copilot)
    expect(reopened.board.get(TaskId('legacy-0'))?.executions).toEqual([])
  })

  it('fails reopen for malformed authoritative records instead of deleting or silently skipping them', async () => {
    const fixture = await harness()
    const records = fixture.pool.media.get('taskboard')!.tables
    records.set('tasks', new Map([['invalid', { ...legacy(1, []), format: 2 }]]))
    await fixture.ctx.fiber.dispose()
    await expect(harness({ pool: fixture.pool })).rejects.toThrow()
    expect(records.get('tasks')?.has('invalid')).toBe(true)
  })
})
