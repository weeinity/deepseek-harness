/** Real Taskboard Controller/domain with a non-executing runtime and external terminal broker. */
import { EventEmitter } from 'node:events'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import TaskboardController from '../../../../../packages/api/taskboard-controller/lib/index.js'
import { taskRecord } from '../../../../../packages/workspace/taskboard/lib/index.js'
import { waitForGate } from './gates.mjs'

const DSH = 'taskboard-fixture-dsh'
const COPILOT = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491'
const SECOND_COPILOT = '2eb3dbf2-8b82-4863-b505-520708dcce80'

function record(value) {
  appendFileSync(join(process.env.DSH_TASKBOARD_FIXTURE_ROOT, 'external-calls.jsonl'), JSON.stringify(value) + '\n')
}

function runtime(ctx) {
  const listeners = new Set()
  const lifetime = new AbortController()
  const pending = new Set()
  const failures = []
  let settings = { enabled: true, announceToAgent: false, preventIdleSleep: false }
  const snapshot = () => ({
    settings, timeZone: 'UTC',
    power: {
      phase: settings.preventIdleSleep ? 'unsupported' : 'disabled', platform: 'fixture',
      runningSessions: 0, enabledSchedules: ctx.taskboard.list().filter(task => task.schedule?.enabled).length,
      sessionStateKnown: true,
    },
    scheduler: {},
  })
  async function complete(taskId, execution) {
    const attempt = { taskId, executionId: execution.id }
    const waiting = execution.prompt.startsWith('WAIT:')
    const failed = execution.prompt.startsWith('FAIL:')
    if (waiting) {
      await ctx.taskboard.advanceExecution({ ...attempt, waitingForInput: true }, lifetime.signal)
      record({ type: 'observation', executionId: execution.id, state: 'waiting' })
      await waitForGate(join(process.env.DSH_TASKBOARD_FIXTURE_ROOT, `resume-${execution.id}.release`), lifetime.signal)
      await ctx.taskboard.advanceExecution({ ...attempt, waitingForInput: false }, lifetime.signal)
      record({ type: 'observation', executionId: execution.id, state: 'running' })
      await waitForGate(join(process.env.DSH_TASKBOARD_FIXTURE_ROOT, `cancel-${execution.id}.release`), lifetime.signal)
    }
    const task = await ctx.taskboard.settleExecution({
      ...attempt, status: waiting ? 'cancelled' : failed ? 'failed' : 'succeeded',
      ...(failed ? { error: { code: 'fixture/provider-unavailable', message: 'Mock provider rejected the run' } } : {}),
    }, lifetime.signal)
    if (waiting) record({ type: 'observation', executionId: execution.id, state: 'cancelled' })
    return task
  }
  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async start() {
      const workspace = await ctx.workspaceRegistry.create(process.env.DSH_TASKBOARD_FIXTURE_WORKSPACE)
      await ctx.sessionController.create({ workspaceId: workspace.id, sessionId: DSH })
      const table = ctx.storageDomain.get('taskboard').table('tasks')
      for (const [index, copilot] of [COPILOT, SECOND_COPILOT].entries()) {
        const task = await ctx.taskboard.create({ workspaceId: workspace.id, title: `Legacy dual links ${index + 1}`, status: 'in_review' })
        const { revision, ordinal, workspaceId, title, description, status, rank, labels, createdAt, updatedAt } = task
        await table.put(task.id, taskRecord.parse({
          revision, ordinal, workspaceId, title, description, status, rank, labels, createdAt, updatedAt,
          sessionId: DSH, agencyCopilotSessionId: copilot,
        }))
      }
    },
    async run(request, signal) {
      const current = ctx.taskboard.get(request.taskId)
      if (current.connection?.kind !== 'copilot') throw new Error('UI fixture runs only explicitly connected mock Copilot sessions')
      const admitted = await ctx.taskboard.beginExecution({
        ...request, trigger: 'manual', executionSettings: current.executionSettings,
      }, signal)
      if (admitted.replayed) return { task: admitted.task, executionId: admitted.executionId }
      const execution = admitted.task.executions.find(item => item.id === admitted.executionId)
      await ctx.taskboard.attachExecution({
        taskId: current.id, executionId: admitted.executionId,
        connection: current.connection,
        receipt: { kind: 'copilot', afterCursor: `fixture-${admitted.executionId}` },
      })
      record({ type: 'dispatch', sessionId: current.connection.sessionId, execution })
      await ctx.taskboard.advanceExecution({ taskId: current.id, executionId: admitted.executionId })
      if (execution.prompt.startsWith('WAIT:')) {
        const completion = complete(current.id, execution).catch(error => {
          if (error === lifetime.signal.reason || (error?.code === 'ABORT_ERR' && error.cause === lifetime.signal.reason)) return
          failures.push(error)
        }).finally(() => pending.delete(completion))
        pending.add(completion)
        return { task: ctx.taskboard.get(current.id), executionId: admitted.executionId }
      }
      const task = await complete(current.id, execution)
      return { task, executionId: admitted.executionId }
    },
    async updateSettings(patch) {
      settings = { ...settings, ...patch }
      const state = snapshot()
      for (const listener of listeners) listener(state)
      return state
    },
    async dispose() {
      listeners.clear()
      lifetime.abort(new Error('Taskboard management fixture disposed'))
      await Promise.all(pending)
      if (failures.length > 0) throw new AggregateError(failures, 'Taskboard fixture observations failed')
    },
  }
}

/** Only runtime work and the native terminal broker are replaced; Remote commands stay inherited. */
export default class TaskboardFixtureController extends TaskboardController {
  static inject = [...TaskboardController.inject, 'storageDomain']

  constructor(ctx, config) {
    super(ctx, config, {
      runtime: runtime(ctx),
      agency: {
        platform: 'win32',
        spawnBroker(command, args) {
          record({ type: 'terminal', command, args })
          const child = new EventEmitter()
          child.unref = () => child
          queueMicrotask(() => child.emit('spawn'))
          return child
        },
      },
    })
  }
}
