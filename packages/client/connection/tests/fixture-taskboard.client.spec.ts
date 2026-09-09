import { describe, expect, it } from 'vitest'
import { createFixtureFaces } from '../src/client/fixture.ts'

const workspaceId = 'fx-ws-fixture'
const copilot = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491'
const replacement = '2eb3dbf2-8b82-4863-b505-520708dcce80'
const foreign = 'e1239201-0601-4ec4-b33f-e88aeccf8d4c'

describe('Taskboard fixture session association', () => {
  it('lists only the selected Workspace sessions with summaries and current ownership', async () => {
    const { rpc } = createFixtureFaces()
    await expect(rpc.call('/api', 'taskboard/listAgencyCopilotSessions', { args: { request: { workspaceId } } }))
      .resolves.toEqual({ ok: true, value: {
        sessions: [
          { sessionId: copilot, summary: 'Existing Copilot investigation', status: 'idle' },
          { sessionId: replacement, summary: 'Active Copilot review', status: 'in_use' },
        ], truncated: false,
      } })
    await expect(rpc.call('/api', 'taskboard/listAgencyCopilotSessions', { args: { request: { workspaceId: 'missing' } } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'taskboard/workspace-not-found' } })
  })

  describe('Taskboard fixture deletion', () => {
    it.each([false, true])('removes the task and publishes a tombstone without changing sessions, archived: %s', async (archived) => {
      const { rpc } = createFixtureFaces()
      const call = (endpoint: string, request: object = {}) => rpc.call('/api', endpoint, { args: { request } })
      await call('taskboard/update', { taskId: 'fx-task-2', expectedRevision: 1, patch: { agencyCopilotSessionId: copilot } })
      if (archived) await call('taskboard/archive', { taskId: 'fx-task-2', expectedRevision: 2 })
      const sessions = await call('session/list')
      const copilotSessions = await call('taskboard/listAgencyCopilotSessions', { workspaceId })
      const cancellation = new AbortController()
      const stream = rpc.open?.('/api', 'taskboard/follow', { args: { request: {} } }, cancellation.signal)
      if (stream === undefined) throw new Error('Taskboard fixture must expose its follow stream')
      const iterator = stream[Symbol.asyncIterator]()
      try {
        expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'baseline' } })
        const expectedRevision = archived ? 3 : 2
        const removal = iterator.next()
        await expect(call('taskboard/delete', { taskId: 'fx-task-2', expectedRevision }))
          .resolves.toEqual({ ok: true, value: { taskId: 'fx-task-2', revision: Number.MAX_SAFE_INTEGER } })
        await expect(removal).resolves.toEqual({
          done: false, value: { type: 'remove', taskId: 'fx-task-2', revision: Number.MAX_SAFE_INTEGER },
        })
        const listed = await call('taskboard/list')
        expect(listed).toHaveProperty('value.tasks.length', 4)
        expect(listed).toMatchObject({ value: { tasks: [
          { id: 'fx-task-1' }, { id: 'fx-task-3' }, { id: 'fx-task-4' }, { id: 'fx-task-5' },
        ] } })
        expect(await call('session/list')).toEqual(sessions)
        expect(await call('taskboard/listAgencyCopilotSessions', { workspaceId })).toEqual(copilotSessions)
        await expect(call('taskboard/delete', { taskId: 'fx-task-2', expectedRevision }))
          .resolves.toMatchObject({ ok: false, error: { code: 'taskboard/task-not-found' } })
      } finally {
        cancellation.abort()
        await iterator.return?.()
      }
    })

    it('rejects stale deletion without changing membership or preventing an explicit retry', async () => {
      const { rpc } = createFixtureFaces()
      const before = await rpc.call('/api', 'taskboard/list', { args: { request: {} } })
      await expect(rpc.call('/api', 'taskboard/delete', { args: { request: { taskId: 'fx-task-2', expectedRevision: 0 } } }))
        .resolves.toMatchObject({ ok: false, error: { code: 'taskboard/revision-conflict' } })
      expect(await rpc.call('/api', 'taskboard/list', { args: { request: {} } })).toEqual(before)
      await expect(rpc.call('/api', 'taskboard/delete', { args: { request: { taskId: 'fx-task-2', expectedRevision: 1 } } }))
        .resolves.toEqual({ ok: true, value: { taskId: 'fx-task-2', revision: Number.MAX_SAFE_INTEGER } })
    })
  })

  it('creates, replaces, and clears an existing Copilot link independently of the DSH session', async () => {
    const { rpc } = createFixtureFaces()
    await expect(rpc.call('/api', 'taskboard/create', { args: { request: {
      workspaceId, title: 'Continue work', agencyCopilotSessionId: copilot,
    } } })).resolves.toMatchObject({ ok: true, value: { task: {
      id: 'fx-task-6', revision: 1, status: 'backlog', agencyCopilotSessionId: copilot,
    } } })
    await expect(rpc.call('/api', 'taskboard/update', { args: { request: {
      taskId: 'fx-task-2', expectedRevision: 1, patch: { agencyCopilotSessionId: replacement },
    } } })).resolves.toMatchObject({ ok: true, value: { task: {
      id: 'fx-task-2', revision: 2, status: 'in_progress', sessionId: 'fx-alpha', agencyCopilotSessionId: replacement,
    } } })
    const cleared = await rpc.call('/api', 'taskboard/update', { args: { request: {
      taskId: 'fx-task-2', expectedRevision: 2, patch: { agencyCopilotSessionId: null },
    } } })
    expect(cleared).toMatchObject({ ok: true, value: { task: { revision: 3, sessionId: 'fx-alpha' } } })
    expect(cleared).not.toHaveProperty('value.task.agencyCopilotSessionId')
  })

  it('rejects cross-Workspace association without committing task content', async () => {
    const { rpc } = createFixtureFaces()
    await expect(rpc.call('/api', 'taskboard/create', { args: { request: {
      workspaceId, title: 'Rejected creation', agencyCopilotSessionId: foreign,
    } } })).resolves.toMatchObject({ ok: false, error: { code: 'taskboard/bad-request' } })
    await expect(rpc.call('/api', 'taskboard/update', { args: { request: {
      taskId: 'fx-task-2', expectedRevision: 1, patch: { title: 'Rejected edit', agencyCopilotSessionId: foreign },
    } } })).resolves.toMatchObject({ ok: false, error: { code: 'taskboard/bad-request' } })
    const listed = await rpc.call('/api', 'taskboard/list', { args: { request: {} } })
    expect(listed).toHaveProperty('value.tasks.length', 5)
    expect(listed).toHaveProperty('value.tasks.1.title', 'Build native board surface')
    expect(listed).toHaveProperty('value.tasks.1.revision', 1)
  })
})
