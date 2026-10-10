/** Explicitly enabled Agency/SDK interoperability with isolated data and a loopback-only model fixture. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { realpathNormalize } from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { AgencyCopilotSessionId, TaskExecution, TaskExecutionId, TaskRunRequestId } from '@deepseek-ai/dsh-taskboard/types'
import { CopilotClient, RuntimeConnection, type SessionConfig, type SessionEvent } from '@github/copilot-sdk'
import { expect, it, vi } from 'vitest'
import { CopilotTaskExecutionAdapter } from '../src/runtime/copilot.ts'
import type { AgencyCopilotScan } from '../src/agency.ts'

vi.mock('../src/agency.ts', () => ({ AgencyCopilotHost: vi.fn() }))

const enabled = process.env.DSH_COPILOT_INTEROP === '1' && process.platform === 'win32'

it.skipIf(!enabled)('runs twice in one SDK conversation discoverable by Agency', { retry: 0 }, async () => {
  const directCli = process.env.DSH_COPILOT_INTEROP_CLI
  const root = await mkdtemp(join(process.cwd(), '.taskboard-copilot-interop-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  const copilotHome = join(home, '.copilot')
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMFILES']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'),
    COPILOT_HOME: copilotHome, TEMP: root, TMP: root,
    AGENCY_NO_UPDATE_CHECK: '1', AGENCY_NO_AUTO_UPDATE: '1', AGENCY_NO_PROTOCOL_HANDLER: '1',
  })
  const sessionId = randomUUID() as AgencyCopilotSessionId
  const workspaceId = 'copilot-fixture' as WorkspaceId
  const executable = process.env.DSH_COPILOT_INTEROP_AGENCY ?? 'agency.exe'
  let requests = 0
  let providerError = 'none'
  let sdkPhase = 'none'
  let sdkFailure = 'none'
  let userEventId: string | undefined
  let userMessageId: string | undefined
  let userTurnId: string | undefined
  let endedTurnId: string | undefined
  let acceptedMessageId: string | undefined
  let idleEvents = 0
  const diagnose = async <T>(phase: string, work: Promise<T>): Promise<T> => {
    sdkPhase = phase
    try { return await work }
    catch (error: unknown) {
      const message = error instanceof Error ? error.message : ''
      sdkFailure = [
        'unknown method', 'not found', 'not a function', 'invalid', 'unsupported', 'permission',
        'model', 'provider', 'schema', 'required', 'tool', 'installedPlugins', 'options', 'JSON',
      ].filter(word => message.toLowerCase().includes(word.toLowerCase())).join('+') || 'unclassified'
      throw error
    }
  }
  const model = createServer((request, response) => {
    requests += 1
    if (request.url?.endsWith('/chat/completions') !== true) {
      request.resume()
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 1024 * 1024) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof data !== 'object' || data === null || !('stream' in data) || data.stream !== true) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          id: 'fixture', object: 'chat.completion', created: 0, model: 'fixture',
          choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
      })}\n\n`)
      response.end(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`)
    })
  })
  const timeout = AbortSignal.timeout(90_000)
  let adapter: CopilotTaskExecutionAdapter | undefined
  let stage = 'startup'
  try {
    await Promise.all([mkdir(workspace), mkdir(copilotHome, { recursive: true })])
    const canonicalWorkspace = await realpathNormalize(workspace)
    await new Promise<void>((resolve, reject) => {
      model.once('error', reject)
      model.listen(0, '127.0.0.1', resolve)
    })
    const port = (model.address() as AddressInfo).port
    const provider = { type: 'openai' as const, baseUrl: `http://127.0.0.1:${port}`, wireApi: 'completions' as const }
    const modelOptions = <T extends SessionConfig>(config: T): T => ({
      ...config, model: 'fixture', provider,
      onEvent: (event: SessionEvent) => {
        config.onEvent?.(event)
        if (event.agentId === undefined) {
          if (event.type === 'user.message') {
            userEventId = event.id
            userMessageId = event.data.messageId
            userTurnId = event.data.turnId
          }
          if (event.type === 'assistant.turn_end') endedTurnId = event.data.turnId
          if (event.type === 'session.idle') idleEvents += 1
        }
        if (event.type === 'session.error' && /^[a-z_-]{1,64}$/i.test(event.data.errorType)) {
          providerError = event.data.errorType
        }
      },
    })
    const context = new Context()
    context.provide('workspaceRegistry', { get: () => ({ path: canonicalWorkspace }) } as never)
    adapter = new CopilotTaskExecutionAdapter(
      context,
      { operationTimeoutMs: 30_000, recoveryPageSize: 100, recoveryMaxPages: 10 },
      {
        agency: {
          inspect: (_ids, signal) => discover(executable, workspace, env, signal),
          copilotSdkEnvironment: () => env,
        },
        createClient: (options) => {
          // Empty mode prevents access to the real OS credential store in this private fixture.
          const client = new CopilotClient({
            ...options,
            ...(directCli === undefined ? {} : {
              connection: RuntimeConnection.forStdio({ path: directCli, args: ['--no-auto-login'] }),
            }),
            mode: 'empty', baseDirectory: copilotHome, useLoggedInUser: false,
          })
          const start = client.start.bind(client)
          const create = client.createSession.bind(client)
          const resume = client.resumeSession.bind(client)
          const inspectSession = (session: Awaited<ReturnType<typeof create>>) => {
            const rpc = session.rpc
            const snapshot = rpc.metadata.snapshot
            const activity = rpc.metadata.activity
            const update = rpc.options.update
            const mode = rpc.permissions.setMode
            const reset = rpc.permissions.resetSessionApprovals
            const configure = rpc.permissions.configure
            rpc.metadata.snapshot = () => diagnose('metadata.snapshot', snapshot())
            rpc.metadata.activity = () => diagnose('metadata.activity', activity())
            rpc.options.update = request => diagnose('options.update', update(request))
            rpc.permissions.setMode = request => diagnose('permissions.setMode', mode(request))
            rpc.permissions.resetSessionApprovals = request => diagnose('permissions.resetSessionApprovals', reset(request))
            rpc.permissions.configure = request => diagnose('permissions.configure', configure(request))
            return session
          }
          client.start = () => diagnose('start', start())
          client.createSession = async config => inspectSession(await diagnose('create', create(modelOptions(config))))
          client.resumeSession = async (id, config) => inspectSession(await diagnose('resume', resume(id, modelOptions(config ?? {}))))
          return client
        },
      },
    )
    let execution: TaskExecution = {
      id: randomUUID() as TaskExecutionId, requestId: randomUUID() as TaskRunRequestId,
      trigger: 'manual', requestedAt: '2026-09-09T00:00:00Z', status: 'pending', createsConnection: true,
      workspaceId, prompt: 'Reply with OK.', connection: { kind: 'copilot', sessionId },
      executionSettings: { kind: 'copilot', permission: 'read-only', model: 'fixture' },
    }
    stage = 'creation'
    await adapter.create(execution, timeout)
    for (const attempt of [1, 2]) {
      stage = `prepare-${attempt}`
      execution = { ...execution, receipt: await adapter.prepare(execution, timeout) }
      stage = `fixture-message-${attempt}`
      execution = { ...execution, receipt: await adapter.submit(execution, timeout) }
      acceptedMessageId = execution.receipt?.messageId
      const currentAdapter = adapter
      const observed = await vi.waitFor(async () => {
        const observed = await currentAdapter.observe(execution, timeout)
        expect(observed.state).toBe('settled')
        return observed
      }, { timeout: 15_000, interval: 50 })
      if (observed.state === 'settled' && observed.error !== undefined) providerError = observed.error.code
      expect(observed).toMatchObject({ outcome: 'succeeded' })
      stage = `repeat-observation-${attempt}`
      expect(await adapter.observe(execution, timeout)).toEqual(observed)
      expect(await adapter.observe(execution, timeout)).toEqual(observed)
      stage = `acknowledged-release-${attempt}`
      await adapter.release({ ...execution, status: 'succeeded' })
      if (attempt === 1) {
        const { receipt, ...previous } = execution
        expect(receipt?.kind).toBe('copilot')
        execution = {
          ...previous, id: randomUUID() as TaskExecutionId, requestId: randomUUID() as TaskRunRequestId,
          createsConnection: false,
        }
      }
    }
    stage = 'discovery'
    const discovery = await discover(executable, workspace, env, timeout)
    expect([...discovery.sessions.keys()]).toEqual([sessionId])
  } catch (error: unknown) {
    // SDK errors can embed vendor diagnostics or authentication links.
    const message = error instanceof Error ? error.message : ''
    const reason = /not found|does not exist|no session/i.test(message) ? 'session-missing'
      : /timeout|timed out/i.test(message) ? 'timeout'
        : /permission|auth|login/i.test(message) ? 'authorization'
          : /version|protocol/i.test(message) ? 'protocol'
            : /already|exist|duplicate/i.test(message) ? 'duplicate'
              : 'unclassified'
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
      && /^copilot\/[a-z-]+$/.test(error.code) ? error.code : 'none'
    const correlation = `message=${userMessageId !== undefined && userMessageId === acceptedMessageId},event=${userEventId !== undefined && userEventId === acceptedMessageId},turn=${userTurnId !== undefined && userTurnId === endedTurnId},idle=${idleEvents}`
    throw new Error(`Isolated Agency SDK interoperability failed during ${stage} (${reason}, ${code}, ${providerError}, ${sdkPhase}:${sdkFailure}, requests=${requests}, ${correlation}); vendor output suppressed`)
  } finally {
    try {
      await adapter?.dispose()
    } finally {
      model.closeAllConnections()
      await new Promise<void>((resolve) => { model.close(() => { resolve() }) })
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  }
})

async function discover(
  executable: string,
  cwd: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<AgencyCopilotScan> {
  const child = spawn(executable, ['hub', 'list-local-sessions', '--json', '--limit', '100'], {
    cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal,
  })
  const chunks: Buffer[] = []
  let bytes = 0
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 1024 * 1024) { overflow = true; child.kill() }
    else chunks.push(chunk)
  })
  child.stderr.resume()
  const code = await new Promise<number | null>((resolve, reject) => {
    let failed = false
    child.once('error', () => { failed = true })
    child.once('close', (code) => {
      if (failed) reject(new Error('Isolated Agency discovery process failed'))
      else resolve(code)
    })
  })
  if (code !== 0 || overflow) throw new Error('Isolated Agency discovery failed')
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof data !== 'object' || data === null || !('sessions' in data) || !Array.isArray(data.sessions)) {
    throw new Error('Isolated Agency discovery returned unsupported data')
  }
  const sessions: Map<AgencyCopilotSessionId, {
    sessionId: AgencyCopilotSessionId
    status: 'idle' | 'in_use'
    folder?: string
  }> = new Map()
  const rows: unknown[] = data.sessions
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('session_id' in row) || typeof row.session_id !== 'string'
      || !('status' in row) || (row.status !== 'idle' && row.status !== 'in_use')) {
      throw new Error('Isolated Agency discovery returned unsupported session metadata')
    }
    const sessionId = row.session_id as AgencyCopilotSessionId
    sessions.set(sessionId, {
      sessionId, status: row.status,
      ...('folder' in row && typeof row.folder === 'string' ? { folder: row.folder } : {}),
    })
  }
  return { sessions, complete: !('next_cursor' in data) || data.next_cursor == null }
}
