import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Commands from '@deepseek-ai/dsh-commands'
import DynamicCordisRunnerService from '@deepseek-ai/dsh-cordis-host-runner'
import { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import TaskboardService, { TaskRunRequestId } from '@deepseek-ai/dsh-taskboard'
import type { TaskExecution, TaskExecutionReceipt } from '@deepseek-ai/dsh-taskboard/types'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TaskboardController from '../src/index.ts'
import { createDshExecutionAdapter } from '../src/runtime/dsh.ts'
import type { TaskExecutionAdapter } from '../src/runtime/adapter.ts'
import { MemorySettings } from './memory-settings.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface TurnEndReasonMap {
    'taskboard-fixture': { kind: 'taskboard-fixture' }
  }
}

type Script = (options: GenerateOptions) => Promise<StreamChunk[]>

class ScriptedModel extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  scripts: Script[] = []

  override listModels(): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([
      'host-default', 'task-model', 'human-next-model', 'pinned-model', 'human-model',
    ].map(id => ({ provider: 'script', id, name: id })))
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const script = this.scripts.shift()
    if (script === undefined) throw new Error('No scripted model response')
    yield* await script(options)
  }
}

class SessionReadFixture extends SessionQuery {
  override searchSessions(): never { throw new Error('This fixture does not expose indexed search') }
  override searchEvents(): never { throw new Error('This fixture does not expose indexed search') }
}

function answer(text = 'finished'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function human(text = 'human work'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function deferred() {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  return { promise, resolve: () => { resolve(undefined) } }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

/** Real Session/Agent/Controller and storage; unused network and shell executors refuse work. */
async function harness(root?: string) {
  const directory = root ?? await mkdtemp(join(process.cwd(), '.taskboard-dsh-test-'))
  if (root === undefined) cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccess)
  await ctx.plugin(AgentDefaultModel, { provider: 'script', model: 'host-default' })
  await ctx.plugin(SessionPersistenceJsonl, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(SessionReadFixture)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(directory, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(AttachmentLocal, { dshHome: directory })
  await ctx.plugin(Commands)
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  await ctx.plugin(FileUploads)
  ctx.provide('shell', {
    sandboxMode: 'read-only' as const,
    resolve() { throw new Error('This fixture exposes no shell tool') },
    run() { throw new Error('This fixture exposes no shell tool') },
    start() { throw new Error('This fixture exposes no shell tool') },
  })
  ctx.provide('fs', {} as never)
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(PermissionPresets, {
    defaultPreset: 'read-only',
    presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'session-choice': { sandbox: 'workspace-write', approval: 'ask' },
    },
  })
  await ctx.plugin(AgentPresets, { default: 'fixture' })
  await ctx.agentPresets.register({ id: 'fixture', plugins: [] })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionController, {})
  const model = new ScriptedModel()
  ctx.llm.registerAdapter(['script'], model)
  const workspace = await ctx.workspaceRegistry.create(directory)
  const adapter = createDshExecutionAdapter(ctx)
  cleanups.push(() => adapter.dispose())
  const signal = new AbortController().signal
  const execution: TaskExecution = {
    id: randomUUID() as TaskExecution['id'],
    requestId: randomUUID() as TaskExecution['requestId'],
    trigger: 'manual', requestedAt: '2026-09-09T00:00:00.000Z', status: 'pending',
    createsConnection: true,
    connection: { kind: 'dsh', sessionId: SessionId(`taskboard-${randomUUID()}`) },
    workspaceId: workspace.id, prompt: 'Complete this task',
    executionSettings: {
      kind: 'dsh', presetId: 'fixture', permission: 'read-only',
      model: { provider: 'script', model: 'task-model' },
    },
  }
  return { ctx, model, workspace, adapter, execution, signal, directory }
}

describe('Loader Taskboard execution', () => {
  it('runs with a pinned model and preset through the scoped controller', async () => {
    const test = await harness()
    const { ctx, directory, model, workspace } = test
    await ctx.plugin(MemorySettings)
    await ctx.plugin(TaskboardService)
    // Loader entries enforce the controller's inject list; root-Context adapter tests do not.
    ctx.loader.builtins.include = { default: Include }
    ctx.loader.builtins['taskboard-controller'] = { default: TaskboardController }
    await writeFile(join(directory, 'cordis.yml'), [
      '- name: cordis:taskboard-controller',
      '  config:',
      '    timeZone: UTC',
      '    pollIntervalMs: 1',
      `    lockPath: ${JSON.stringify(join(directory, 'taskboard-owner'))}`,
      '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: 'cordis.yml' } })
    await ctx.loader.await()
    const task = await ctx.taskboard.create({
      workspaceId: workspace.id,
      title: 'Synthetic Taskboard run',
      prompt: 'Reply with finished. Do not use tools.',
      executionSettings: test.execution.executionSettings,
    })
    const requestId = TaskRunRequestId(randomUUID())
    const settled = Promise.withResolvers<TaskExecution>()
    const unwatch = ctx.on('domain/changed', () => {
      const execution = ctx.taskboard.get(task.id)?.executions.find(value => value.requestId === requestId)
      if (execution?.status === 'succeeded' || execution?.status === 'failed' || execution?.status === 'cancelled') {
        settled.resolve(execution)
      }
    })
    try {
      model.scripts.push(async () => answer())
      const result = await ctx.taskboardController.run({
        taskId: task.id, expectedRevision: task.revision, requestId,
      }, test.signal)
      const execution = await settled.promise
      expect(execution).toMatchObject({ id: result.executionId, status: 'succeeded' })
      expect(model.calls).toHaveLength(1)
      expect(model.calls[0]).toMatchObject({ provider: 'script', model: 'task-model' })
      const agent = agentFor(test, execution)
      expect(ctx.agentPresets.presetForSession(agent.session)).toBe('fixture')
      expect(ownInsertions(agent.session.snapshotEvents(), execution)).toHaveLength(1)
    } finally {
      unwatch()
    }
  })
})

async function prepared(test: Awaited<ReturnType<typeof harness>>): Promise<TaskExecution> {
  await test.adapter.create(test.execution, test.signal)
  return { ...test.execution, receipt: await test.adapter.prepare(test.execution, test.signal) }
}

function agentFor(test: Awaited<ReturnType<typeof harness>>, execution = test.execution) {
  if (execution.connection?.kind !== 'dsh') throw new Error('Expected DSH connection')
  const agent = test.ctx.agents.get(execution.connection.sessionId)
  if (agent === undefined) throw new Error('Expected live test Agent')
  return agent
}

function ownInsertions(events: readonly SessionEvent[], execution: TaskExecution): UserMessage[] {
  return events.flatMap(event => event.type === 'agent/inbox/spliced'
    ? event.data.inserted.filter(message => message.source.kind === 'user'
      && 'rpcId' in message.source && message.source.rpcId === `taskboard:${execution.id}`)
    : [])
}

async function dispatch(test: Awaited<ReturnType<typeof harness>>, execution: TaskExecution) {
  const receipt = await test.adapter.submit(execution, test.signal)
  await agentFor(test, execution).whenIdle()
  return { ...execution, receipt }
}

async function runningExecution(test: Awaited<ReturnType<typeof harness>>) {
  const preparedExecution = await prepared(test)
  const working = deferred()
  const finished = deferred()
  cleanups.push(async () => { finished.resolve() })
  test.model.scripts.push(async () => {
    working.resolve()
    await finished.promise
    return answer()
  })
  const receipt = await test.adapter.submit(preparedExecution, test.signal)
  await working.promise
  return { execution: { ...preparedExecution, receipt }, agent: agentFor(test), finish: finished.resolve }
}

async function dynamicApproval(
  test: Awaited<ReturnType<typeof harness>>, agent = agentFor(test),
) {
  if (test.ctx.get('dynamicCordisRunner') === undefined) await test.ctx.plugin(DynamicCordisRunnerService)
  const runner = test.ctx.dynamicCordisRunner
  const definition = runner.define({
    sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'check' },
    name: 'Fixture approval', purpose: 'Verify a pending Client activation', code: { client: 'return () => {}' },
  })
  const started = await runner.run(agent, definition.pluginId, definition.packageId, 'run')
  if (!started.ok) throw new Error(started.message)
  const requestId = runner.inventory().find(row => row.pluginId === definition.pluginId)?.latestRun?.approvalRequestId
  if (requestId === undefined) throw new Error('Expected a pending dynamic activation request')
  return { runner, ...definition, pluginRunId: started.pluginRunId, requestId }
}

async function coldExecution(
  test: Awaited<ReturnType<typeof harness>>,
  stage: 'empty' | 'queued' | 'claimed' | 'interrupted' | 'empty-completed',
) {
  if (test.execution.connection?.kind !== 'dsh') throw new Error('Expected DSH connection')
  const id = test.execution.connection.sessionId
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false,
    cwd: test.directory, agentPreset: 'fixture',
  })
  const input = createUserMessage({
    content: [{ type: 'text', text: test.execution.prompt }],
    source: { kind: 'user', rpcId: `taskboard:${test.execution.id}` as never },
  })
  if (stage !== 'empty') session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] })
  if (stage !== 'empty' && stage !== 'queued') {
    session.append('turn/start', { turn: 1 })
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
  }
  if (stage === 'interrupted' || stage === 'empty-completed') {
    session.append('turn/end', { turn: 1, reason: { kind: stage === 'interrupted' ? 'interrupted' : 'completed' } })
  }
  const handle = await test.ctx.sessionPersistence.create(session.header)
  try {
    await handle.append(session.snapshotEvents())
    await handle.flush()
  } finally {
    await handle.close()
  }
  await test.workspace.attachSession(id)
  const execution: TaskExecution = {
    ...test.execution, createsConnection: false,
    receipt: { kind: 'dsh', afterSequence: -1, ...(stage === 'empty' ? {} : { messageId: input.id }) },
  }
  return { execution, session, input }
}

describe('DSH Taskboard execution', () => {
  it.each(['approved', 'denied'] as const)(
    'defers exact success until an owned dynamic approval is %s without claiming its continuation',
    async (decision) => {
      const test = await harness()
      const { execution, agent, finish } = await runningExecution(test)
      const approval = await dynamicApproval(test)
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
      finish()
      await agent.whenIdle()
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting', receipt: execution.receipt })
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('temporary history failure'))
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting', receipt: execution.receipt })
      expect(flush).not.toHaveBeenCalled()
      flush.mockRestore()
      test.model.scripts.push(async () => { throw new LlmError('later steering failed', 'LATER_FAILURE') })
      if (decision === 'approved') {
        const half = await approval.runner.runHostHalf(
          agent, approval.pluginId, approval.packageId, 'run', approval.requestId, false,
        )
        expect(half.ok).toBe(true)
        const current = approval.runner.inventory().find(row => row.pluginId === approval.pluginId)!.latestRun!
        expect(current.approvalRequestId).toBe(approval.requestId)
        expect(current.requiresApproval).toBe(true)
        expect(current.status).toBe('client-pending')
        await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded', receipt: execution.receipt })
        await approval.runner.resolveRequestRun(approval.requestId, { ok: true, pluginRunId: approval.pluginRunId })
      } else {
        await approval.runner.resolveRequestRun(approval.requestId, { ok: false, reason: 'rejected' })
      }
      await agent.whenIdle()
      const terminal = await test.adapter.observe(execution, test.signal)
      expect(terminal).toMatchObject({ outcome: 'succeeded', receipt: execution.receipt })
      await expect(test.adapter.observe(execution, test.signal)).resolves.toEqual(terminal)
      expect(agent.session.snapshotEvents().some(event =>
        event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
      await test.adapter.release!(execution)
    },
  )

  it('retains validated success across a transient approval-registry failure and settlement release', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const approval = await dynamicApproval(test)
    finish()
    await agent.whenIdle()
    const inventory = vi.spyOn(approval.runner, 'inventory').mockImplementationOnce(() => { throw new Error('registry read unavailable') })
    await expect(test.adapter.observe(execution, test.signal)).rejects.toThrow('registry read unavailable')
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('log read unavailable'))
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await approval.runner.stop(agent, approval.pluginId)
    const terminal = await test.adapter.observe(execution, test.signal)
    expect(terminal).toMatchObject({ outcome: 'succeeded' })
    expect(flush).not.toHaveBeenCalled()
    inventory.mockImplementationOnce(() => { throw new Error('registry unavailable after publication') })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toEqual(terminal)
    await test.adapter.release!(execution)
    inventory.mockRestore()
    await expect(test.adapter.observe(execution, test.signal)).rejects.toThrow('log read unavailable')
  })

  it('waits for every owned dynamic approval before publishing success', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const first = await dynamicApproval(test)
    const second = await dynamicApproval(test)
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await first.runner.stop(agent, first.pluginId)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await second.runner.stop(agent, second.pluginId)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  it('does not report automatic Client activation as a human wait', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const approval = await dynamicApproval(test)
    await approval.runner.runHostHalf(agent, approval.pluginId, approval.packageId, 'run', approval.requestId, false)
    await approval.runner.resolveRequestRun(approval.requestId, { ok: true, pluginRunId: approval.pluginRunId })
    const automatic = await approval.runner.run(agent, approval.pluginId, approval.packageId, 'run')
    expect(automatic).toMatchObject({ ok: true, status: 'starting' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    test.model.scripts.push(async () => answer('steering'))
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    await approval.runner.stop(agent, approval.pluginId)
  })

  it('does not reuse registry-local identities after the issuing provider is replaced', async () => {
    const test = await harness()
    const owner = test.ctx.plugin(DynamicCordisRunnerService)
    await owner
    const { execution, agent, finish } = await runningExecution(test)
    const original = await dynamicApproval(test)
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await owner.dispose()
    const replacement = await dynamicApproval(test)
    expect(replacement.requestId).toBe(original.requestId)
    expect(replacement.pluginRunId).toBe(original.pluginRunId)
    expect(replacement.pluginId).toBe(original.pluginId)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(replacement.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    await replacement.runner.stop(agent, replacement.pluginId)
  })

  it('ignores a dynamic request issued through an already retired Agent', async () => {
    const test = await harness()
    const created = vi.spyOn(test.ctx.agents, 'create')
    const { execution, agent, finish } = await runningExecution(test)
    finish()
    await agent.whenIdle()
    const result = created.mock.results[0]
    if (result?.type !== 'return') throw new Error('Expected the test Agent handle')
    await (await result.value).dispose()
    const approval = await dynamicApproval(test, agent)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(approval.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    await approval.runner.stop(agent, approval.pluginId)
  })

  it.each(['cancelled', 'disposed'] as const)('does not capture a dynamic request whose owner was synchronously %s', async (action) => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    await test.ctx.plugin(DynamicCordisRunnerService)
    const runner = test.ctx.dynamicCordisRunner
    const stopped: Promise<unknown>[] = []
    test.ctx.on('cordis/request-run', (request) => {
      stopped.push(action === 'disposed' ? test.adapter.dispose() : runner.stop(agent, request.pluginId))
    }, { prepend: true })
    const definition = runner.define({
      sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'check' }, name: 'Immediate decision',
      purpose: 'Request lifetime regression', code: { client: 'return () => {}' },
    })
    await runner.run(agent, definition.pluginId, definition.packageId, 'run')
    await Promise.all(stopped)
    if (action === 'cancelled') {
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    } else {
      expect(runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
      await runner.stop(agent, definition.pluginId)
    }
    finish()
    await agent.whenIdle()
  })

  it('publishes one preserved result to concurrent terminal observers', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => answer())
    const done = await dispatch(test, execution)
    const results = await Promise.all([test.adapter.observe(done, test.signal), test.adapter.observe(done, test.signal)])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ outcome: 'succeeded' })
  })

  it('does not hold success for a dynamic approval issued outside its execution turn', async () => {
    const test = await harness()
    await test.adapter.create(test.execution, test.signal)
    const approval = await dynamicApproval(test)
    const receipt = await test.adapter.prepare(test.execution, test.signal)
    test.model.scripts.push(async () => answer())
    const execution = await dispatch(test, { ...test.execution, receipt })
    expect(approval.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    await approval.runner.stop(agentFor(test), approval.pluginId)
  })

  it('ignores another active Session dynamic approval and keeps its registered request intact', async () => {
    const test = await harness()
    const first = await runningExecution(test)
    const other: TaskExecution = {
      ...test.execution, id: randomUUID() as TaskExecution['id'],
      connection: { kind: 'dsh', sessionId: SessionId(randomUUID()) },
    }
    const second = await runningExecution({ ...test, execution: other })
    const approval = await dynamicApproval(test, second.agent)
    await expect(test.adapter.observe(first.execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    first.finish()
    await first.agent.whenIdle()
    await expect(test.adapter.observe(first.execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(approval.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    second.finish()
    await second.agent.whenIdle()
    await expect(test.adapter.observe(second.execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await approval.runner.stop(second.agent, approval.pluginId)
  })

  it('does not transfer an earlier-turn dynamic approval to a later attempt in the same Session', async () => {
    const test = await harness()
    const first = await runningExecution(test)
    const approval = await dynamicApproval(test)
    first.finish()
    await first.agent.whenIdle()
    await expect(test.adapter.observe(first.execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    const next = { ...test.execution, id: randomUUID() as TaskExecution['id'], createsConnection: false }
    const receipt = await test.adapter.prepare(next, test.signal)
    test.model.scripts.push(async () => answer('next turn'))
    const done = await dispatch(test, { ...next, receipt })
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    await expect(test.adapter.observe(first.execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await approval.runner.stop(first.agent, approval.pluginId)
  })

  it('retains live approval attribution when the completed Session becomes cold', async () => {
    const test = await harness()
    const created = vi.spyOn(test.ctx.agents, 'create')
    const { execution, agent, finish } = await runningExecution(test)
    const approval = await dynamicApproval(test)
    finish()
    await agent.whenIdle()
    const result = created.mock.results[0]
    if (result?.type !== 'return') throw new Error('Expected an owned test Agent handle')
    await (await result.value).dispose()
    expect(test.ctx.agents.get(agent.id)).toBeUndefined()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting', receipt: execution.receipt })
    await approval.runner.resolveRequestRun(approval.requestId, { ok: false, reason: 'rejected' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(test.ctx.agents.list()).toHaveLength(0)
    expect(test.model.calls).toHaveLength(1)
  })

  it.each(['error', 'cancelled'] as const)('does not defer exact %s for an outstanding dynamic approval', async (outcome) => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    const working = deferred()
    const finished = deferred()
    cleanups.push(async () => { finished.resolve() })
    test.model.scripts.push(async () => {
      working.resolve()
      await finished.promise
      throw new LlmError('original turn failed', 'ORIGINAL_FAILURE')
    })
    const receipt = await test.adapter.submit(execution, test.signal)
    await working.promise
    const approval = await dynamicApproval(test)
    if (outcome === 'cancelled') agent.cancel({ kind: 'user' })
    finished.resolve()
    await agent.whenIdle()
    await expect(test.adapter.observe({ ...execution, receipt }, test.signal)).resolves.toMatchObject({
      state: 'settled', outcome: outcome === 'cancelled' ? 'cancelled' : 'failed',
    })
    expect(approval.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    await approval.runner.stop(agent, approval.pluginId)
  })

  it('disposes deferred-success observation without resolving the registered approval or cancelling its Agent', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const approval = await dynamicApproval(test)
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await test.adapter.dispose()
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    expect(approval.runner.inventory()[0]?.latestRun?.status).toBe('awaiting-approval')
    await expect(test.adapter.observe(execution, test.signal)).rejects.toThrow('disposed')
    await approval.runner.stop(agent, approval.pluginId)
  })

  it.each(['question', 'plan-review', 'approval'] as const)(
    'observes a pending %s in the exact execution turn and resumes after its answer',
    async (kind) => {
      const test = await harness()
      const execution = await prepared(test)
      const agent = agentFor(test)
      const requested = deferred()
      const answered = deferred()
      const working = deferred()
      const finished = deferred()
      cleanups.push(async () => { answered.resolve(); finished.resolve() })
      test.ctx.on('user-questions/request', async () => {
        requested.resolve()
        await answered.promise
        return { answers: [{ id: 'confirm', selected: ['Yes'] }] }
      })
      test.ctx.on('approval/request', async () => {
        requested.resolve()
        await answered.promise
        return 'allowed-once'
      })
      agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
        if (kind === 'approval') {
          await test.ctx.approval.request({ agent, toolName: 'fixture', signal })
        } else {
          await test.ctx.userQuestions.ask({
            agent, signal, questions: [{
              id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }],
              ...(kind === 'plan-review' ? { detail: '# Plan', intent: { kind: 'plan-review', approve: 'Yes' } as const } : {}),
            }],
          })
        }
        return next()
      })
      test.model.scripts.push(async () => {
        working.resolve()
        await finished.promise
        return answer()
      })
      const receipt = await test.adapter.submit(execution, test.signal)
      const accepted = { ...execution, receipt }
      await requested.promise
      await expect(test.adapter.observe(accepted, test.signal)).resolves.toMatchObject({ state: 'waiting', receipt })
      expect(test.model.calls).toHaveLength(0)
      expect(agent.status).toBe('running')
      answered.resolve()
      await working.promise
      await expect(test.adapter.observe(accepted, test.signal)).resolves.toMatchObject({ state: 'running', receipt })
      finished.resolve()
      await agent.whenIdle()
      await expect(test.adapter.observe(accepted, test.signal)).resolves.toMatchObject({
        state: 'settled', outcome: 'succeeded', receipt,
      })
    },
  )

  it.each(['question', 'plan-review', 'approval'] as const)(
    'follows a manual linked-chat %s without attributing it to an execution',
    async (kind) => {
      const test = await harness()
      await prepared(test)
      const agent = agentFor(test)
      const requested = deferred()
      const answered = deferred()
      const working = deferred()
      const finished = deferred()
      cleanups.push(async () => { answered.resolve(); finished.resolve() })
      test.ctx.on('user-questions/request', async () => {
        requested.resolve()
        await answered.promise
        return { answers: [{ id: 'confirm', selected: ['Yes'] }] }
      })
      test.ctx.on('approval/request', async () => {
        requested.resolve()
        await answered.promise
        return 'allowed-once'
      })
      const stopQuestion = agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
        if (kind === 'approval') {
          await test.ctx.approval.request({ agent, toolName: 'fixture', signal })
        } else {
          await test.ctx.userQuestions.ask({
            agent, signal, questions: [{
              id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }],
              ...(kind === 'plan-review' ? { detail: '# Plan', intent: { kind: 'plan-review', approve: 'Yes' } as const } : {}),
            }],
          })
        }
        return next()
      })
      test.model.scripts.push(async () => {
        working.resolve()
        await finished.promise
        return answer()
      })
      expect(test.adapter.attention!(test.execution.connection!, test.workspace.id)).toBeUndefined()
      agent.followup(human('Continue this chat manually'))
      await requested.promise
      const monitor = test.adapter.attention!(test.execution.connection!, test.workspace.id)
      expect(monitor).toBeDefined()
      await expect(monitor!.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
      answered.resolve()
      await working.promise
      expect(test.adapter.attention!(test.execution.connection!, test.workspace.id)).toBeUndefined()
      await expect(monitor!.observe(test.signal)).resolves.toEqual({ state: 'running' })
      finished.resolve()
      await agent.whenIdle()
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('durability unavailable'))
      await expect(monitor!.observe(test.signal)).rejects.toThrow('durability unavailable')
      flush.mockRestore()
      await expect(monitor!.observe(test.signal)).resolves.toEqual({ state: 'settled', outcome: 'succeeded' })
      stopQuestion()
      test.model.scripts.push(async () => { throw new Error('later unrelated turn failed') })
      agent.followup(human('A later turn'))
      await agent.whenIdle()
      await expect(monitor!.observe(test.signal)).resolves.toEqual({ state: 'settled', outcome: 'succeeded' })
      expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')
        .map(event => event.data.source).filter(source => source.kind === 'user')).toEqual([{ kind: 'user' }, { kind: 'user' }])
    },
  )

  it('disposes a linked-chat monitor without answering its question or cancelling its borrowed Agent', async () => {
    const test = await harness()
    const { agent, finish } = await runningExecution(test)
    const requested = deferred()
    const answered = deferred()
    cleanups.push(async () => { answered.resolve(); finish() })
    test.ctx.on('user-questions/request', async () => {
      requested.resolve()
      await answered.promise
      return { answers: [] }
    })
    const asking = test.ctx.userQuestions.ask({ agent, questions: [{ id: 'wait', question: 'Continue?' }] })
    await requested.promise
    const monitor = test.adapter.attention!(test.execution.connection!, test.workspace.id)!
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
    await test.adapter.dispose()
    expect(agent.status).toBe('running')
    await expect(monitor.observe(test.signal)).rejects.toThrow('disposed')
    answered.resolve()
    await asking
    finish()
    await agent.whenIdle()
  })

  it('requires a live DSH connection and leaves unavailable Sessions cold', async () => {
    const test = await harness()
    expect(test.adapter.attention!(test.execution.connection!, test.workspace.id)).toBeUndefined()
    expect(test.ctx.agents.get(test.execution.connection!.sessionId as SessionId)).toBeUndefined()
    expect(() => test.adapter.attention!({
      kind: 'copilot', sessionId: randomUUID() as Extract<TaskExecution['connection'], { kind: 'copilot' }>['sessionId'],
    }, test.workspace.id)).toThrow('Expected a DSH Session connection')
  })

  it.each(['failed', 'cancelled'] as const)('observes an exact %s linked-chat turn without borrowing a later outcome', async (outcome) => {
    const test = await harness()
    await prepared(test)
    const agent = agentFor(test)
    const working = deferred()
    const finished = deferred()
    const requested = deferred()
    const answered = deferred()
    cleanups.push(async () => { answered.resolve(); finished.resolve() })
    test.model.scripts.push(async () => {
      working.resolve()
      await finished.promise
      throw new LlmError('manual turn failed', 'MANUAL_FAILURE')
    })
    agent.followup(human())
    await working.promise
    test.ctx.on('user-questions/request', async () => {
      requested.resolve()
      await answered.promise
      return { answers: [] }
    })
    const asking = test.ctx.userQuestions.ask({ agent, questions: [{ id: 'manual', question: 'Continue?' }] })
    await requested.promise
    const monitor = test.adapter.attention!(test.execution.connection!, test.workspace.id)!
    answered.resolve()
    await asking
    if (outcome === 'cancelled') agent.cancel({ kind: 'user' })
    finished.resolve()
    await agent.whenIdle()
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'settled', outcome })
  })

  it('keeps linked-chat dynamic approvals visible after their exact turn succeeds', async () => {
    const test = await harness()
    const { agent, finish } = await runningExecution(test)
    const approval = await dynamicApproval(test)
    const monitor = test.adapter.attention!(test.execution.connection!, test.workspace.id)!
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
    finish()
    await agent.whenIdle()
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
    expect(test.adapter.attention!(test.execution.connection!, test.workspace.id)).toBeDefined()
    await approval.runner.resolveRequestRun(approval.requestId, { ok: false, reason: 'rejected' })
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'settled', outcome: 'succeeded' })
  })

  it('keeps waiting until every overlapping question and approval has resolved', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const questioned = deferred()
    const approved = deferred()
    const question = deferred()
    const approval = deferred()
    cleanups.push(async () => { question.resolve(); approval.resolve() })
    test.ctx.on('user-questions/request', async () => {
      questioned.resolve()
      await question.promise
      return { answers: [] }
    })
    test.ctx.on('approval/request', async () => {
      approved.resolve()
      await approval.promise
      return 'allowed-once'
    })
    const asking = test.ctx.userQuestions.ask({ agent, questions: [{ id: 'question', question: 'Continue?' }] })
    const deciding = test.ctx.approval.request({ agent, toolName: 'fixture' })
    await Promise.all([questioned.promise, approved.promise])
    const monitor = test.adapter.attention!(test.execution.connection!, test.workspace.id)!
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    question.resolve()
    await asking
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'waiting' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    approval.resolve()
    await deciding
    await expect(monitor.observe(test.signal)).resolves.toEqual({ state: 'running' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    finish()
    await agent.whenIdle()
  })

  it('ignores unscoped questions and idle Sessions while another execution is active', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const otherId = SessionId(randomUUID())
    await test.ctx.sessionController.create({ sessionId: otherId, workspaceId: test.workspace.id })
    const other = test.ctx.agents.get(otherId)!
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.ctx.on('user-questions/request', async () => {
      await release.promise
      return { answers: [] }
    })
    const requests = [
      test.ctx.userQuestions.ask({ questions: [{ id: 'unscoped', question: 'Continue?' }] }),
      test.ctx.userQuestions.ask({ agent: other, questions: [{ id: 'idle', question: 'Continue?' }] }),
    ]
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    release.resolve()
    await Promise.all(requests)
    finish()
    await agent.whenIdle()
    await test.ctx.userQuestions.ask({ agent, questions: [{ id: 'ended', question: 'Continue?' }] })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  it('does not transfer another active Agent question to this execution', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const otherId = SessionId(randomUUID())
    await test.ctx.sessionController.create({ sessionId: otherId, workspaceId: test.workspace.id })
    const other = test.ctx.agents.get(otherId)!
    const requested = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.ctx.on('user-questions/request', async () => {
      requested.resolve()
      await release.promise
      return { answers: [] }
    })
    other.ctx.on('agent/pre-step', async ({ signal }, next) => {
      await test.ctx.userQuestions.ask({ agent: other, signal, questions: [{ id: 'other', question: 'Continue?' }] })
      return next()
    })
    test.model.scripts.push(async () => answer('other finished'))
    other.followup(human())
    await requested.promise
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    release.resolve()
    await other.whenIdle()
  })

  it('preserves terminal completion and excludes an earlier-turn question from Run Again', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.ctx.on('user-questions/request', async () => {
      await release.promise
      return { answers: [] }
    })
    const asking = test.ctx.userQuestions.ask({ agent, questions: [{ id: 'old-turn', question: 'Continue?' }] })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    finish()
    await agent.whenIdle()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    await test.adapter.release!(execution)
    const next = { ...test.execution, id: randomUUID() as TaskExecution['id'], createsConnection: false }
    const receipt = await test.adapter.prepare(next, test.signal)
    const working = deferred()
    const finished = deferred()
    cleanups.push(async () => { finished.resolve() })
    test.model.scripts.push(async () => {
      working.resolve()
      await finished.promise
      return answer('continued')
    })
    const accepted = await test.adapter.submit({ ...next, receipt }, test.signal)
    await working.promise
    await expect(test.adapter.observe({ ...next, receipt: accepted }, test.signal)).resolves.toMatchObject({ state: 'running' })
    release.resolve()
    await asking
    finished.resolve()
    await agent.whenIdle()
  })

  it.each(['question', 'approval'] as const)('clears cancelled %s waiting without cancelling its borrowed Agent', async (kind) => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.ctx.on('user-questions/request', async () => {
      entered.resolve()
      await release.promise
      return { answers: [] }
    })
    test.ctx.on('approval/request', async () => {
      entered.resolve()
      await release.promise
      return 'allowed-once'
    })
    const controller = new AbortController()
    const request = kind === 'question'
      ? test.ctx.userQuestions.ask({ agent, signal: controller.signal, questions: [{ id: 'cancel', question: 'Continue?' }] })
      : test.ctx.approval.request({ agent, signal: controller.signal, toolName: 'fixture' })
    await entered.promise
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    controller.abort(new Error('user request withdrawn'))
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    expect(agent.status).toBe('running')
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    release.resolve()
    await request
    finish()
    await agent.whenIdle()
  })

  it('clears rejected question waiting and retains the answerer rejection', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const failure = new Error('answerer disconnected')
    test.ctx.on('user-questions/request', async () => {
      await release.promise
      throw failure
    })
    const asking = test.ctx.userQuestions.ask({ agent, questions: [{ id: 'failed', question: 'Continue?' }] })
    const rejected = expect(asking).rejects.toBe(failure)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    release.resolve()
    await rejected
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    finish()
    await agent.whenIdle()
  })

  it('disposes pending-input observers without waiting for or withdrawing the borrowed question', async () => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.ctx.on('user-questions/request', async () => {
      await release.promise
      return { answers: [] }
    })
    const controller = new AbortController()
    let answered = false
    const asking = test.ctx.userQuestions.ask({
      agent, signal: controller.signal, questions: [{ id: 'owned-by-agent', question: 'Continue?' }],
    }).then((value) => {
      answered = true
      return value
    })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'waiting' })
    await test.adapter.dispose()
    expect(answered).toBe(false)
    expect(controller.signal.aborted).toBe(false)
    expect(agent.status).toBe('running')
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    release.resolve()
    await asking
    await expect(test.ctx.userQuestions.ask({ agent, questions: [{ id: 'after-dispose', question: 'Continue?' }] }))
      .resolves.toEqual({ answers: [] })
    finish()
    await agent.whenIdle()
  })

  it.each(['cancelled', 'disposed'] as const)('delegates a waterfall captured before its observation is %s', async (mode) => {
    const test = await harness()
    const { execution, agent, finish } = await runningExecution(test)
    const entered = deferred()
    const release = deferred()
    const answered = deferred()
    cleanups.push(async () => { release.resolve(); answered.resolve() })
    test.ctx.on('user-questions/request', async (_request, next) => {
      entered.resolve()
      await release.promise
      return next()
    }, { prepend: true })
    test.ctx.on('user-questions/request', async () => {
      await answered.promise
      return { answers: [] }
    })
    const controller = new AbortController()
    const asking = test.ctx.userQuestions.ask({ agent, signal: controller.signal, questions: [{ id: 'delayed', question: 'Continue?' }] })
    await entered.promise
    if (mode === 'cancelled') controller.abort(new Error('request withdrawn'))
    else await test.adapter.dispose()
    release.resolve()
    if (mode === 'cancelled') {
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'running' })
    }
    answered.resolve()
    await asking
    finish()
    await agent.whenIdle()
  })

  it('inherits normal Session initialization when a new connection has no pins', async () => {
    const test = await harness()
    const execution: TaskExecution = { ...test.execution, executionSettings: { kind: 'dsh' } }
    await test.adapter.create(execution, test.signal)
    const agent = agentFor(test)
    expect(agent.session.header.agentPreset).toBe('fixture')
    expect(test.ctx.permissionPresets.current(agent.session)).toBe('read-only')
    expect(test.model.calls).toHaveLength(0)
    const select = vi.spyOn(test.ctx.sessionController, 'selectModel')
    const permission = vi.spyOn(test.ctx.permissionPresets, 'set')
    const sequence = agent.session.seq
    const receipt = await test.adapter.prepare(execution, test.signal)
    expect(receipt).toEqual({ kind: 'dsh', afterSequence: sequence - 1 })
    expect(agent.session.seq).toBe(sequence)
    expect(select).not.toHaveBeenCalled()
    expect(permission).not.toHaveBeenCalled()
    test.model.scripts.push(async () => answer())
    const done = await dispatch(test, { ...execution, receipt })
    expect(test.model.calls[0]?.model).toBe('host-default')
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  it.each(['none', 'model', 'permission', 'preset'] as const)(
    'preserves connected Session choices except the explicit %s pin',
    async (pin) => {
      const test = await harness()
      await test.ctx.agentPresets.register({ id: 'other', plugins: [] })
      const settings = test.execution.executionSettings
      if (settings.kind !== 'dsh') throw new Error('Expected DSH settings')
      const initial = { ...test.execution, executionSettings: { ...settings, presetId: 'other' } }
      await test.adapter.create(initial, test.signal)
      const first = { ...initial, receipt: await test.adapter.prepare(initial, test.signal) }
      test.model.scripts.push(async () => answer(), async () => answer('continued'))
      await dispatch(test, first)
      const agent = agentFor(test)
      await test.ctx.sessionController.selectModel({
        sessionId: agent.id, provider: 'script', model: 'human-next-model', saveDefault: false,
      })
      test.ctx.permissionPresets.set(agent.session, 'session-choice')
      expect(test.model.calls.map(call => call.model)).toEqual(['task-model'])
      const select = vi.spyOn(test.ctx.sessionController, 'selectModel')
      const permission = vi.spyOn(test.ctx.permissionPresets, 'set')
      const next: TaskExecution = {
        ...test.execution, id: randomUUID() as TaskExecution['id'], createsConnection: false,
        executionSettings: {
          kind: 'dsh',
          ...(pin === 'model' ? { model: { provider: 'script', model: 'pinned-model' } } : {}),
          ...(pin === 'permission' ? { permission: 'read-only' } : {}),
          ...(pin === 'preset' ? { presetId: 'other' } : {}),
        },
      }
      const receipt = await test.adapter.prepare(next, test.signal)
      expect(select).toHaveBeenCalledTimes(pin === 'model' ? 1 : 0)
      expect(permission).toHaveBeenCalledTimes(pin === 'permission' ? 1 : 0)
      expect(test.ctx.permissionPresets.current(agent.session))
        .toBe(pin === 'permission' ? 'read-only' : 'session-choice')
      expect(test.ctx.agentPresets.presetForSession(agent.session)).toBe('other')
      const done = await dispatch(test, { ...next, receipt })
      expect(test.model.calls[1]?.model).toBe(pin === 'model' ? 'pinned-model' : 'human-next-model')
      expect(agentFor(test)).toBe(agent)
      expect(test.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'script', model: 'host-default' })
      await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    },
  )

  it.each([
    { kind: 'dsh' as const, permission: 'unconfigured' },
    { kind: 'dsh' as const, model: { provider: 'unconfigured', model: 'missing' } },
  ])('rejects invalid explicit pins before creating a Session: %j', async (executionSettings) => {
    const test = await harness()
    await expect(test.adapter.create({ ...test.execution, executionSettings }, test.signal)).rejects.toThrow()
    expect(test.ctx.agents.list()).toHaveLength(0)
  })

  it('creates without prompting, applies local settings, and continues the exact connected Session', async () => {
    const test = await harness()
    const savedDefault = vi.spyOn(test.ctx.agentDefaultModel, 'saveSelection')
    const first = await prepared(test)
    expect(test.model.calls).toHaveLength(0)
    const originalAgent = agentFor(test)
    await test.adapter.validateConnection(first.connection!, first.workspaceId, test.signal)
    expect(test.workspace.sessionIds).toContain(originalAgent.id)
    expect(test.ctx.permissionPresets.current(originalAgent.session)).toBe('read-only')
    test.model.scripts.push(async () => answer(), async () => answer('continued'))
    const done = await dispatch(test, first)
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({
      state: 'settled', outcome: 'succeeded', receipt: done.receipt,
    })
    expect(done.receipt.messageId).toBeTypeOf('string')
    const next: TaskExecution = {
      ...test.execution,
      id: randomUUID() as TaskExecution['id'], requestId: randomUUID() as TaskExecution['requestId'],
      createsConnection: false, prompt: 'Continue the same task',
    }
    const nextPrepared = { ...next, receipt: await test.adapter.prepare(next, test.signal) }
    const continued = await dispatch(test, nextPrepared)
    await expect(test.adapter.observe(continued, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(agentFor(test)).toBe(originalAgent)
    expect(savedDefault).not.toHaveBeenCalled()
    expect(test.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'script', model: 'host-default' })
    expect(test.model.calls.map(call => call.model)).toEqual(['task-model', 'task-model'])
    expect(test.model.calls[1]?.messages.flatMap(message => message.content))
      .toContainEqual({ type: 'text', text: test.execution.prompt })
    await expect(test.adapter.create(next, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-create-forbidden' })
  })

  it('does not mistake a claimed but rejected input for model-admitted work', async () => {
    const test = await harness()
    const execution = await prepared(test)
    agentFor(test).ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
    const done = await dispatch(test, execution)
    expect(test.model.calls).toHaveLength(0)
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({
      state: 'settled', outcome: 'failed', error: { code: 'taskboard/dsh-blocked' },
    })
    const receipt = await test.adapter.submit(execution, test.signal)
    expect(receipt).toEqual(done.receipt)
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), execution)).toHaveLength(1)
  })

  it('rejects a completed turn whose pre-step removed its claimed input', async () => {
    const test = await harness()
    const execution = await prepared(test)
    agentFor(test).ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
    const done = await dispatch(test, execution)
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-not-admitted' },
    })
    expect(test.model.calls).toHaveLength(0)
  })

  it('reports model output limits independently of human planning status', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => [
      ...answer().slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const done = await dispatch(test, execution)
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-max-tokens' },
    })
    expect(execution.status).toBe('pending')
  })

  it('reports explicit user cancellation before model admission without claiming success', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    agentFor(test).ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve()
      await release.promise
      return next()
    })
    const receipt = await test.adapter.submit(execution, test.signal)
    await entered.promise
    agentFor(test).cancel({ kind: 'user' })
    release.resolve()
    await agentFor(test).whenIdle()
    await expect(test.adapter.observe({ ...execution, receipt }, test.signal))
      .resolves.toMatchObject({ state: 'settled', outcome: 'cancelled' })
    expect(test.model.calls).toHaveLength(0)
  })

  it('preserves its failed turn when a later human turn succeeds', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(
      async () => { throw new LlmError('execution failed', 'TASK_FAILURE') },
      async () => answer('human succeeded'),
    )
    const done = await dispatch(test, execution)
    agentFor(test).followup(human())
    await agentFor(test).whenIdle()
    const result = await test.adapter.observe(done, test.signal)
    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'TASK_FAILURE' } })
    expect(result.state === 'settled' && result.error?.message).toContain('execution failed')
  })

  it.each(['error', 'not-admitted'] as const)('retains its first %s when external work reuses the same input identity', async (failure) => {
    const test = await harness()
    const execution = await prepared(test)
    const stop = failure === 'not-admitted'
      ? agentFor(test).ctx.on('agent/pre-step', async () => ({ kind: 'enter', messages: [] }))
      : undefined
    if (failure === 'error') {
      test.model.scripts.push(async () => { throw new LlmError('first turn failed', 'FIRST_FAILURE') })
    }
    test.model.scripts.push(async () => answer('later reuse'))
    const done = await dispatch(test, execution)
    stop?.()
    const input = ownInsertions(agentFor(test).session.snapshotEvents(), execution)[0]
    if (input === undefined) throw new Error('Expected accepted input')
    agentFor(test).followup(input)
    await agentFor(test).whenIdle()
    expect(test.model.calls).toHaveLength(failure === 'error' ? 2 : 1)
    expect(agentFor(test).session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason)
      .toEqual({ kind: 'completed' })
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: failure === 'error' ? 'FIRST_FAILURE' : 'taskboard/dsh-not-admitted' },
    })
  })

  it('observes running admission and the exact owning turn without waiting for unrelated queued work', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const firstEntered = deferred()
    const firstRelease = deferred()
    const humanEntered = deferred()
    const humanRelease = deferred()
    cleanups.push(async () => { firstRelease.resolve(); humanRelease.resolve() })
    test.model.scripts.push(async () => {
      firstEntered.resolve()
      await firstRelease.promise
      return answer()
    }, async () => {
      humanEntered.resolve()
      await humanRelease.promise
      return answer()
    })
    const receipt = await test.adapter.submit(execution, test.signal)
    await firstEntered.promise
    const accepted = { ...execution, receipt }
    await expect(test.adapter.observe(accepted, test.signal)).resolves.toMatchObject({ state: 'running' })
    agentFor(test).followup(human())
    firstRelease.resolve()
    await humanEntered.promise
    await expect(test.adapter.observe(accepted, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(agentFor(test).status).toBe('running')
    humanRelease.resolve()
    await agentFor(test).whenIdle()
  })

  it('rejects existing busy and parked input without steering or cancelling it', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    const input = human()
    agent.inject(input)
    await expect(test.adapter.submit(execution, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-busy' })
    expect(agent.inbox.nextStep.map(message => message.id)).toEqual([input.id])
    expect(ownInsertions(agent.session.snapshotEvents(), execution)).toHaveLength(0)
  })

  it('rejects the prompt-admission race while preserving and running the competing human message', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const admit = test.ctx.attachments.admitPromptContent.bind(test.ctx.attachments)
    vi.spyOn(test.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async (content) => {
      entered.resolve()
      await release.promise
      return admit(content)
    })
    test.model.scripts.push(async () => answer('human only'))
    const pending = test.adapter.submit(execution, test.signal)
    const outcome = pending.then(value => value, (error: unknown) => error)
    await Promise.race([entered.promise, pending])
    const input = human()
    agentFor(test).followup(input)
    expect(test.model.calls).toHaveLength(0)
    release.resolve()
    expect(await outcome).toMatchObject({ code: 'taskboard/dsh-busy' })
    await agentFor(test).whenIdle()
    expect(test.model.calls).toHaveLength(1)
    const users = agentFor(test).session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
    expect(users).toEqual([input])
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-input-removed' },
    })
  })

  it('retains uncertain durable acceptance and never resubmits after a flush failure', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => answer())
    const stopFailure = test.ctx.on('session/flush', (session) => {
      if (ownInsertions(session.snapshotEvents(), execution).length > 0) throw new Error('disk unavailable')
    })
    await expect(test.adapter.submit(execution, test.signal)).rejects.toMatchObject({
      code: 'taskboard/dsh-acceptance-unknown',
    })
    stopFailure()
    await agentFor(test).whenIdle()
    const receipt = await test.adapter.submit(execution, test.signal)
    await expect(test.adapter.observe({ ...execution, receipt }, test.signal))
      .resolves.toMatchObject({ outcome: 'succeeded' })
    expect(test.model.calls).toHaveLength(1)
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), execution)).toHaveLength(1)
  })

  it('rejects absent persistence participation before input admission', async () => {
    const test = await harness()
    await test.adapter.create(test.execution, test.signal)
    vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValue(false)
    await expect(test.adapter.prepare(test.execution, test.signal)).rejects.toMatchObject({
      code: 'taskboard/dsh-persistence-required',
    })
    expect(test.model.calls).toHaveLength(0)
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), test.execution)).toHaveLength(0)
  })

  it('reads completed cold history without activation and resumes that identity for the next attempt', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => answer())
    const done = await dispatch(test, execution)
    await test.adapter.observe(done, test.signal)
    await test.adapter.dispose()
    await test.ctx.fiber.dispose()
    const restarted = await harness(test.directory)
    const read = vi.spyOn(restarted.ctx.sessionPersistence, 'open')
    await expect(restarted.adapter.observe(done, restarted.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(read).toHaveBeenCalledWith(execution.connection?.sessionId, 'read', expect.any(Object))
    expect(restarted.ctx.agents.list()).toHaveLength(0)
    await expect(restarted.adapter.validateConnection(done.connection!, done.workspaceId, restarted.signal))
      .resolves.toBeUndefined()
    await expect(restarted.adapter.submit(done, restarted.signal)).resolves.toEqual(done.receipt)
    expect(restarted.model.calls).toHaveLength(0)
    const next: TaskExecution = {
      ...execution, id: randomUUID() as TaskExecution['id'],
      requestId: randomUUID() as TaskExecution['requestId'], createsConnection: false,
    }
    const nextReceipt = await restarted.adapter.prepare(next, restarted.signal)
    restarted.model.scripts.push(async () => answer())
    const nextAccepted = await dispatch(restarted, { ...next, receipt: nextReceipt })
    await expect(restarted.adapter.observe(nextAccepted, restarted.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    expect(restarted.model.calls).toHaveLength(1)
  })

  it.each(['empty', 'queued', 'claimed', 'interrupted', 'empty-completed'] as const)(
    'observes cold %s evidence without activation or queue mutation',
    async (stage) => {
      const test = await harness()
      const { execution, session } = await coldExecution(test, stage)
      const open = vi.spyOn(test.ctx.sessionPersistence, 'open')
      await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
        state: 'settled', outcome: 'failed',
        error: { code: stage === 'empty-completed' ? 'taskboard/dsh-not-admitted' : 'taskboard/dsh-interrupted' },
      })
      expect(open.mock.calls.every(call => call[1] === 'read')).toBe(true)
      expect(test.ctx.agents.list()).toHaveLength(0)
      const handle = await test.ctx.sessionPersistence.open(session.id, 'read')
      try {
        expect((await handle.read()).events).toEqual(session.snapshotEvents())
      } finally {
        await handle.close()
      }
      const validation = test.adapter.validateConnection(execution.connection!, execution.workspaceId, test.signal)
      if (stage === 'queued' || stage === 'claimed') {
        await expect(validation).rejects.toMatchObject({ code: 'taskboard/dsh-busy' })
      } else {
        await expect(validation).resolves.toBeUndefined()
      }
      expect(test.model.calls).toHaveLength(0)
    },
  )

  it('does not interpret a plugin-defined turn ending as success', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    const input = createUserMessage({
      content: [{ type: 'text', text: execution.prompt }],
      source: { kind: 'user', rpcId: `taskboard:${execution.id}` as never },
    })
    agent.send(input, 'next-turn', false)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'taskboard-fixture' } })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-unknown-ending' },
    })
  })

  it('rejects retry after adapter restart when the prepared cursor contains no acceptance', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const observer = createDshExecutionAdapter(test.ctx)
    cleanups.push(() => observer.dispose())
    await expect(observer.submit(execution, test.signal)).rejects.toMatchObject({
      code: 'taskboard/dsh-acceptance-unknown',
    })
    await expect(observer.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-interrupted' },
    })
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), execution)).toHaveLength(0)
  })

  it('requires DSH identities, matching provider settings, and a persisted preparation receipt', async () => {
    const test = await harness()
    const foreign = { kind: 'copilot' as const, sessionId: 'foreign' as never }
    expect(() => test.adapter.create({ ...test.execution, connection: foreign }, test.signal))
      .toThrow('reserved DSH Session')
    await expect(test.adapter.validateConnection(foreign, test.workspace.id, test.signal))
      .rejects.toMatchObject({ code: 'taskboard/dsh-connection-required' })
    await expect(test.adapter.create({
      ...test.execution, executionSettings: { kind: 'copilot' },
    }, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-settings-required' })
    await expect(test.adapter.submit(test.execution, test.signal))
      .rejects.toMatchObject({ code: 'taskboard/dsh-receipt-required' })
    expect(test.ctx.agents.list()).toHaveLength(0)
  })

  it.each(['before-submit', 'during-admission'] as const)(
    'refuses changed Session model settings %s without overwriting the human choice',
    async (when) => {
      const test = await harness()
      const execution = await prepared(test)
      const entered = deferred()
      const release = deferred()
      cleanups.push(async () => { release.resolve() })
      const select = () => test.ctx.sessionController.selectModel({
        sessionId: agentFor(test).id, provider: 'script', model: 'human-model', saveDefault: false,
      })
      if (when === 'before-submit') await select()
      else {
        const admit = test.ctx.attachments.admitPromptContent.bind(test.ctx.attachments)
        vi.spyOn(test.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async (content) => {
          entered.resolve()
          await release.promise
          return admit(content)
        })
      }
      const pending = test.adapter.submit(execution, test.signal)
      const outcome = pending.then(value => value, (error: unknown) => error)
      if (when === 'during-admission') {
        await Promise.race([entered.promise, pending])
        await select()
      }
      release.resolve()
      expect(await outcome).toMatchObject({ code: 'taskboard/dsh-settings-changed' })
      expect(test.model.calls).toHaveLength(0)
      expect(agentFor(test).model.current()?.model)
        .toBe('human-model')
    },
  )

  it('rejects conflicting message receipts and truncated history rather than matching prompt text', async () => {
    const test = await harness()
    const execution = await prepared(test)
    await expect(test.adapter.observe({
      ...execution, receipt: { kind: 'dsh', afterSequence: agentFor(test).session.seq + 1 },
    }, test.signal)).resolves.toMatchObject({ error: { code: 'taskboard/dsh-history-truncated' } })
    await test.adapter.release!(execution)
    await expect(test.adapter.observe({
      ...execution, receipt: { kind: 'dsh', afterSequence: -1, messageId: 'absent' },
    }, test.signal)).resolves.toMatchObject({ error: { code: 'taskboard/dsh-receipt-mismatch' } })
    await test.adapter.release!(execution)
    for (const text of [execution.prompt, 'same identity, different content']) {
      agentFor(test).send(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: `taskboard:${execution.id}` as never },
      }), 'next-turn', false)
    }
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-ambiguous-receipt' },
    })
    expect(agentFor(test).inbox.nextTurn).toHaveLength(2)
  })

  it('reports pending only while this adapter owns an in-flight submission', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const admit = test.ctx.attachments.admitPromptContent.bind(test.ctx.attachments)
    vi.spyOn(test.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async (content) => {
      entered.resolve()
      await release.promise
      return admit(content)
    })
    test.model.scripts.push(async () => answer())
    const pending = test.adapter.submit(execution, test.signal)
    await Promise.race([entered.promise, pending])
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({ state: 'pending' })
    release.resolve()
    const receipt = await pending
    await agentFor(test).whenIdle()
    await expect(test.adapter.observe({ ...execution, receipt }, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
  })

  it('uses durable insertion order when an inbox observer synchronously queues human work', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    const input = human()
    let queued = false
    test.ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
      if (subject !== agent || queued) return
      if (message.source.kind === 'user'
        && 'rpcId' in message.source && message.source.rpcId === `taskboard:${execution.id}`) {
        queued = true
        agent.followup(input)
      }
    })
    test.model.scripts.push(async () => answer(), async () => answer('human'))
    const done = await dispatch(test, execution)
    await expect(test.adapter.observe(done, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
    const users = agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data.id] : [])
    expect(users).toEqual([done.receipt.messageId, input.id])
  })

  it('withdraws only its newly inserted input when disposal interrupts admission', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const admit = test.ctx.attachments.admitPromptContent.bind(test.ctx.attachments)
    vi.spyOn(test.ctx.attachments, 'admitPromptContent').mockImplementationOnce(async (content) => {
      entered.resolve()
      await release.promise
      return admit(content)
    })
    const pending = test.adapter.submit(execution, test.signal)
    const outcome = pending.then(value => value, (error: unknown) => error)
    await Promise.race([entered.promise, pending])
    const disposed = test.adapter.dispose()
    release.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    await disposed
    const agent = agentFor(test)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(test.model.calls).toHaveLength(0)
    expect(ownInsertions(agent.session.snapshotEvents(), execution)).toHaveLength(1)
  })

  it.each([new Error('storage offline'), 'storage offline'])('rejects transient history failures without caching an outcome: %s', async (error) => {
    const test = await harness()
    const { execution } = await coldExecution(test, 'queued')
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockRejectedValueOnce(error)
    await expect(test.adapter.observe(execution, test.signal)).rejects.toBe(error)
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-interrupted' },
    })
  })

  it('settles definite durable corruption without attempting to repair history', async () => {
    const test = await harness()
    const { execution } = await coldExecution(test, 'queued')
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockRejectedValueOnce(
      new SessionPersistenceCorruptionError('invalid durable event', {}),
    )
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-history-unavailable', message: 'invalid durable event' },
    })
    expect(test.ctx.agents.list()).toHaveLength(0)
  })

  it.each([
    ['prepare', 'model'], ['prepare', 'permission'], ['submit', 'model'], ['submit', 'permission'],
  ] as const)('preserves human %s-flush %s changes without admitting Taskboard work', async (phase, choice) => {
    const test = await harness()
    await test.adapter.create(test.execution, test.signal)
    const execution = phase === 'submit'
      ? { ...test.execution, receipt: await test.adapter.prepare(test.execution, test.signal) }
      : test.execution
    const agent = agentFor(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve()
      await release.promise
      return flush(session)
    })
    const pending = test.adapter[phase](execution, test.signal)
    const outcome = pending.then(value => value, (error: unknown) => error)
    await Promise.race([entered.promise, pending])
    if (choice === 'model') {
      await test.ctx.sessionController.selectModel({
        sessionId: agent.id, provider: 'script', model: 'human-model', saveDefault: false,
      })
    } else {
      test.ctx.permissionPresets.set(agent.session, 'session-choice')
    }
    release.resolve()
    expect(await outcome).toMatchObject({ code: 'taskboard/dsh-settings-changed' })
    expect(test.model.calls).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(ownInsertions(agent.session.snapshotEvents(), execution)).toHaveLength(phase === 'submit' ? 1 : 0)
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    if (choice === 'model') {
      expect(agent.model.current()?.model).toBe('human-model')
    } else {
      expect(test.ctx.permissionPresets.current(agent.session)).toBe('session-choice')
    }
  })

  it.each([new Error('dispatch cancelled'), 'dispatch cancelled'])(
    'withdraws only the unrun Taskboard input when cancellation arrives during its acceptance flush: %s',
    async (reason) => {
      const test = await harness()
      const execution = await prepared(test)
      const agent = agentFor(test)
      const entered = deferred()
      const release = deferred()
      cleanups.push(async () => { release.resolve() })
      const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
      vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
        entered.resolve()
        await release.promise
        return flush(session)
      })
      const controller = new AbortController()
      const pending = test.adapter.submit(execution, controller.signal)
      const rejected = expect(pending).rejects.toThrow('dispatch cancelled')
      await Promise.race([entered.promise, pending])
      const input = human()
      test.model.scripts.push(async () => answer('human only'))
      agent.followup(input)
      controller.abort(reason)
      release.resolve()
      await rejected
      await agent.whenIdle()
      expect(test.model.calls).toHaveLength(1)
      const admitted = agent.session.snapshotEvents().flatMap(event =>
        event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data.id] : [])
      expect(admitted).toEqual([input.id])
      expect(test.ctx.agents.get(agent.id)).toBe(agent)
    },
  )

  it('retains a flushed exact result until settlement release, including after a transient flush failure', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => answer())
    const done = await dispatch(test, execution)
    const flush = vi.spyOn(test.ctx.sessions, 'flush')
    const unavailable = new Error('flush unavailable')
    flush.mockRejectedValueOnce(unavailable)
    await expect(test.adapter.observe(done, test.signal)).rejects.toBe(unavailable)
    const terminal = await test.adapter.observe(done, test.signal)
    expect(terminal).toMatchObject({ outcome: 'succeeded', receipt: done.receipt })
    flush.mockRejectedValueOnce(unavailable)
    await expect(Promise.all([
      test.adapter.observe(done, test.signal), test.adapter.observe(done, test.signal),
    ])).resolves.toEqual([terminal, terminal])
    await test.adapter.release!(done)
    await test.adapter.release!(done)
    await expect(test.adapter.observe(done, test.signal)).rejects.toBe(unavailable)
    await expect(test.adapter.observe(done, test.signal)).resolves.toEqual(terminal)
    expect(test.model.calls).toHaveLength(1)
  })

  it('releases only matching preparations without disposing the borrowed Agent', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    await test.adapter.release!({
      ...execution, connection: { kind: 'dsh', sessionId: SessionId('different') },
    })
    test.model.scripts.push(async () => answer())
    const done = await dispatch(test, execution)
    const terminal = await test.adapter.observe(done, test.signal)
    await test.adapter.release!({ ...done, connection: { kind: 'dsh', sessionId: SessionId('different') } })
    await expect(test.adapter.observe({
      ...done, connection: { kind: 'dsh', sessionId: SessionId('different') },
    }, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-receipt-mismatch' })
    await expect(test.adapter.observe(done, test.signal)).resolves.toEqual(terminal)
    await test.adapter.release!(done)
    const next = { ...execution, id: randomUUID() as TaskExecution['id'], createsConnection: false }
    const receipt = await test.adapter.prepare(next, test.signal)
    await test.adapter.release!(next)
    await test.adapter.release!(next)
    await expect(test.adapter.submit({ ...next, receipt }, test.signal)).rejects.toMatchObject({
      code: 'taskboard/dsh-acceptance-unknown',
    })
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.status).toBe('idle')
  })

  it.each(['succeeded', 'failed'] as const)('drains an in-flight %s observation without restoring evidence after release', async (outcome) => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => {
      if (outcome === 'failed') throw new LlmError('failed turn', 'FAILED_TURN')
      return answer()
    })
    const done = await dispatch(test, execution)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flushing = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve()
      await release.promise
      return flush(session)
    })
    const observing = test.adapter.observe(done, test.signal)
    await Promise.race([entered.promise, observing])
    const releasing = test.adapter.release!(done)
    release.resolve()
    await expect(observing).resolves.toMatchObject({ outcome })
    await releasing
    flushing.mockRejectedValueOnce(new Error('read after release'))
    await expect(test.adapter.observe(done, test.signal)).rejects.toThrow('read after release')
    expect(test.ctx.agents.get(agentFor(test).id)).toBe(agentFor(test))
  })

  it.each(['read', 'close'] as const)('rejects a transient cold handle %s failure and closes the read handle', async (operation) => {
    const test = await harness()
    const { execution } = await coldExecution(test, 'queued')
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const unavailable = new Error(`transient ${operation} failure`)
    const closed = vi.fn()
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementationOnce(async (id, mode, options) => {
      const handle = await open(id, mode, options)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close()
        closed()
        if (operation === 'close') throw unavailable
      })
      if (operation === 'read') vi.spyOn(handle, 'read').mockRejectedValueOnce(unavailable)
      return handle
    })
    await expect(test.adapter.observe(execution, test.signal)).rejects.toBe(unavailable)
    expect(closed).toHaveBeenCalledOnce()
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-interrupted' },
    })
    expect(test.ctx.agents.list()).toHaveLength(0)
  })

  it('serializes duplicate submissions to one durable insertion', async () => {
    const test = await harness()
    const execution = await prepared(test)
    test.model.scripts.push(async () => answer())
    const [left, right] = await Promise.all([
      test.adapter.submit(execution, test.signal), test.adapter.submit(execution, test.signal),
    ])
    expect(left).toEqual(right)
    await agentFor(test).whenIdle()
    expect(test.model.calls).toHaveLength(1)
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), execution)).toHaveLength(1)
  })

  it('fails closed when another idle maintenance operation reserves the Agent', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    const maintenance = agentFor(test).runMaintenance(async () => { await release.promise })
    await expect(test.adapter.submit(execution, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-busy' })
    release.resolve()
    await maintenance
    expect(ownInsertions(agentFor(test).session.snapshotEvents(), execution)).toHaveLength(0)
  })

  it('refuses to transfer a prepared admission to a replacement Agent lifecycle', async () => {
    const test = await harness()
    const created = vi.spyOn(test.ctx.agents, 'create')
    const execution = await prepared(test)
    const original = agentFor(test)
    const result = created.mock.results[0]
    if (result?.type !== 'return') throw new Error('Expected the shared Session Controller to create an Agent')
    const handle = await result.value
    await handle.dispose()
    const replacement = await test.ctx.sessionController.resolveAgent(original.id)
    if ('error' in replacement) throw replacement.error
    expect(replacement.agent).not.toBe(original)
    await expect(test.adapter.submit(execution, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-busy' })
    expect(ownInsertions(replacement.agent.session.snapshotEvents(), execution)).toHaveLength(0)
    expect(test.model.calls).toHaveLength(0)
  })

  it('does not infer Taskboard acceptance from unrelated currently running human work', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.model.scripts.push(async () => {
      entered.resolve()
      await release.promise
      return answer()
    })
    agentFor(test).followup(human())
    await entered.promise
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-interrupted' },
    })
    await expect(test.adapter.submit(execution, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-busy' })
    release.resolve()
    await agentFor(test).whenIdle()
  })

  it('never recreates missing connected history', async () => {
    const test = await harness()
    const execution: TaskExecution = {
      ...test.execution, createsConnection: false, receipt: { kind: 'dsh', afterSequence: -1 },
    }
    await expect(test.adapter.prepare(execution, test.signal)).rejects.toMatchObject({ code: 'session/not-found' })
    await expect(test.adapter.observe(execution, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-history-unavailable' },
    })
    expect(test.ctx.agents.list()).toHaveLength(0)
    expect(await test.ctx.sessionPersistence.list()).toHaveLength(0)
  })

  it('preserves pending restart input without waking, removing, or reinserting it', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const agent = agentFor(test)
    const input = createUserMessage({
      content: [{ type: 'text', text: execution.prompt }],
      source: { kind: 'user', rpcId: `taskboard:${execution.id}` as never },
    })
    agent.send(input, 'next-turn', false)
    await test.ctx.sessions.flush(agent.session)
    const before = agent.session.snapshotEvents()
    const receipt: TaskExecutionReceipt = { ...execution.receipt as Extract<TaskExecutionReceipt, { kind: 'dsh' }>, messageId: input.id }
    const observer = createDshExecutionAdapter(test.ctx)
    cleanups.push(() => observer.dispose())
    await expect(observer.observe({ ...execution, receipt }, test.signal)).resolves.toMatchObject({
      outcome: 'failed', error: { code: 'taskboard/dsh-interrupted' },
    })
    expect(agent.session.snapshotEvents()).toEqual(before)
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([input.id])
    expect(test.model.calls).toHaveLength(0)
  })

  it('rejects wrong Workspace, changed preset, and unresolved permissions before submission', async () => {
    const test = await harness()
    const execution = await prepared(test)
    await expect(test.adapter.validateConnection(
      execution.connection!, 'missing' as TaskExecution['workspaceId'], test.signal,
    )).rejects.toMatchObject({ code: 'taskboard/dsh-workspace-mismatch' })
    const settings = execution.executionSettings
    if (settings.kind !== 'dsh') throw new Error('Expected DSH settings')
    await expect(test.adapter.prepare({
      ...execution, executionSettings: { ...settings, presetId: 'other' },
    }, test.signal)).rejects.toMatchObject({ code: 'taskboard/dsh-preset-mismatch' })
    await expect(test.adapter.prepare({
      ...execution, executionSettings: { ...settings, permission: 'unconfigured' },
    }, test.signal)).rejects.toThrow()
    expect(test.model.calls).toHaveLength(0)
  })

  it('validates the currently selected preset rather than only the creation header', async () => {
    const test = await harness()
    await test.adapter.create(test.execution, test.signal)
    await test.ctx.agentPresets.register({ id: 'other', plugins: [] })
    await test.ctx.agentPresets.select(agentFor(test), 'other')
    expect(agentFor(test).session.header.agentPreset).toBe('fixture')
    await expect(test.adapter.prepare(test.execution, test.signal))
      .rejects.toMatchObject({ code: 'taskboard/dsh-preset-mismatch' })
  })

  it('disposes only adapter observation while admitted human-shared work completes', async () => {
    const test = await harness()
    const execution = await prepared(test)
    const entered = deferred()
    const release = deferred()
    cleanups.push(async () => { release.resolve() })
    test.model.scripts.push(async () => {
      entered.resolve()
      await release.promise
      return answer()
    })
    const receipt = await test.adapter.submit(execution, test.signal)
    await entered.promise
    const agent = agentFor(test)
    await test.adapter.dispose()
    expect(test.ctx.agents.get(agent.id)).toBe(agent)
    expect(agent.status).toBe('running')
    await expect(test.adapter.observe({ ...execution, receipt }, test.signal)).rejects.toThrow('disposed')
    release.resolve()
    await agent.whenIdle()
    const observer: TaskExecutionAdapter = createDshExecutionAdapter(test.ctx)
    cleanups.push(() => observer.dispose())
    await expect(observer.observe({ ...execution, receipt }, test.signal)).resolves.toMatchObject({ outcome: 'succeeded' })
  })
})
