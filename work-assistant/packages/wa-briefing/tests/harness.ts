/** Scheduled briefings use the real agent loop, Session log, preset mount, and tool registry. */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { LlmAdapter, ToolCallId, type GenerateOptions, type LlmProviderInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Sqlite from '@deepseek-ai/dsh-storage-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as Calendar from '../../wa-calendar/src/index.ts'
import Gateway from '../../wa-gateway/src/index.ts'
import * as Memory from '../../wa-memory/src/index.ts'
import BriefingScheduler, { PERSONAL_ASSISTANT_PRESET_ID, type Config } from '../src/index.ts'
import { temporaryDirectory, trackedContext } from '../../../tests/support.ts'

const oneEvent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//DSH Work Assistant Briefing Tests//EN
BEGIN:VEVENT
UID:morning@example.test
SUMMARY:Morning planning
DTSTAMP:20260101T000000Z
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
END:VEVENT
END:VCALENDAR
`

interface GitResult { stdout: string; stderr: string }

function git(root: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolvePromise({ stdout: String(stdout), stderr: String(stderr) })
      else reject(new Error(String(stderr || error.message), { cause: error }))
    })
  })
}

async function makeMemoryRepo(): Promise<string> {
  const root = join(await temporaryDirectory(), 'memory')
  await mkdir(root, { recursive: true })
  await git(root, ['init', '-b', 'main'])
  await git(root, ['-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--no-verify', '-m', 'initial'])
  return root
}

export class ToolCallingAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Briefing test provider' } }
  override async listModels(provider: string) { return [{ provider, id: 'briefing-test-model', name: 'Briefing test model' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (!options.messages.some(message => message.role === 'user' && message.content.some(block => block.type === 'tool-result'))) {
      const prompt = options.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('Scheduled personal briefing request.'))
      if (prompt?.type !== 'text') throw new Error('Briefing prompt was not model-visible')
      const start = /^Window start: (.+)$/mu.exec(prompt.text)?.[1]
      const end = /^Window end: (.+)$/mu.exec(prompt.text)?.[1]
      const timeZone = /^Time zone: (.+)$/mu.exec(prompt.text)?.[1]
      const callId = ToolCallId('calendar-call-1')
      const args = JSON.stringify({ start, end, timeZone, maxResults: 20 })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'calendar_list', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'calendar_list', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Briefing complete: Morning planning.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Briefing complete: Morning planning.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class BlockingAdapter extends ToolCallingAdapter {
  readonly entered = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Blocking provider' } }
  override async listModels(provider: string) { return [{ provider, id: 'blocking-model', name: 'Blocking model' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
      yield* super.stream(options)
      return
    }
    this.calls.push(options)
    this.entered.resolve()
    await Promise.race([this.release.promise, aborted(options.signal)])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Released.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Released.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolvePromise => signal.addEventListener('abort', () => resolvePromise(), { once: true }))
}

export async function mountRealBriefing(adapter: LlmAdapter, options: { includeMemory?: boolean; directory?: string; config?: Partial<Config> } = {}) {
  const ctx = trackedContext()
  const directory = options.directory ?? await temporaryDirectory()
  const sessionsRoot = join(directory, 'sessions')
  const workspace = join(directory, 'workspace')
  await mkdir(workspace, { recursive: true })
  const calendarPath = join(directory, 'calendar.ics')
  await writeFile(calendarPath, oneEvent, 'utf8')

  const presetBaseUrl = `${pathToFileURL(resolve('packages', 'wa-preset')).href}/`
  ;(ctx as Context & { baseUrl: string }).baseUrl = presetBaseUrl
  await ctx.plugin(Loader, { baseUrl: presetBaseUrl })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['briefing-test'], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SessionPersistenceJsonl, { root: sessionsRoot, compression: 'none' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const presetRequire = createRequire(resolve('packages', 'wa-preset', 'package.json'))
  const questions = await import(pathToFileURL(presetRequire.resolve('@deepseek-ai/dsh-user-questions')).href) as { default: Plugin.Object<void> }
  await ctx.plugin(questions.default)
  await ctx.plugin(AgentPresets, {
    default: PERSONAL_ASSISTANT_PRESET_ID,
    roots: [{ path: resolve('packages', 'wa-preset', 'presets'), trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(Credentials, { path: join(directory, 'credentials.yaml'), watch: false })
  await ctx.plugin(Storage)
  await ctx.plugin(Sqlite, { path: join(directory, 'workassist.db'), journalMode: 'wal' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
  await ctx.plugin(Gateway, { ownerId: 'test-owner' })
  await ctx.plugin(Calendar, { source: { kind: 'file', path: calendarPath }, maxEvents: 20, maxConflicts: 20 })
  if (options.includeMemory === true) await ctx.plugin(Memory, { root: await makeMemoryRepo() })
  const briefingConfig = {
    enabled: true,
    cron: '0 9 * * *',
    timeZone: 'America/Los_Angeles',
    workspace,
    provider: 'briefing-test',
    model: 'briefing-test-model',
    lookAheadMinutes: 120,
    createTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
  }
  const config = { ...briefingConfig, ...(options.includeMemory === undefined ? {} : { includeMemory: options.includeMemory }), ...options.config }
  let briefingState: import('@deepseek-ai/dsh-storage-domain').KvTable<'current', import('../src/inbox.ts').BriefingState> | undefined
  const open = ctx.storageDomain.open.bind(ctx.storageDomain)
  const originalOpen = ctx.storageDomain.open
  ctx.storageDomain.open = (async spec => {
    const domain = await open(spec)
    if (spec.name === 'workassist_briefing') briefingState = domain.table('state') as typeof briefingState
    return domain
  }) as typeof ctx.storageDomain.open
  const schedulerFiber = ctx.plugin(BriefingScheduler, config)
  try { await schedulerFiber } finally { ctx.storageDomain.open = originalOpen }
  if (briefingState === undefined) throw new Error('Briefing domain was not opened')
  return { ctx, directory, sessionsRoot, workspace, calendarPath, config, schedulerFiber, briefingState }
}

export async function readPersistedSessionText(root: string): Promise<string> {
  const files = await readdir(root, { recursive: true })
  const jsonl = files.map(String).filter(file => file.endsWith('.jsonl'))
  const chunks = await Promise.all(jsonl.map(file => readFile(join(root, file), 'utf8')))
  return chunks.join('\n')
}

/** Read committed logs through the installed persistence decoder. */
export async function readPersistedSessions(ctx: Context) {
  const sessions = []
  for (const { header } of await ctx.sessionPersistence.list()) {
    const reader = await ctx.sessionPersistence.open(header.id, 'read')
    try {
      const { events } = await reader.read()
      sessions.push({ header, events })
    } finally {
      await reader.close()
    }
  }
  return sessions
}

/** Supply only model stream variability while retaining the real Agent and tool pipeline. */
export class ScriptedAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(private readonly respond: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Scripted briefing provider' } }
  override async listModels(provider: string) { return [{ provider, id: 'briefing-test-model', name: 'Scripted briefing model' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield* this.respond(options)
  }
}

/** Emit the same text-stream lifecycle as a real model adapter. */
export async function* textResponse(text: string, finish: 'stop' | 'max-tokens' = 'stop'): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: finish } }
}

/** Issue a configured-calendar read before supplying a synthetic final response. */
export async function* calendarResponse(options: GenerateOptions, text: string, finish: 'stop' | 'max-tokens' = 'stop'): AsyncIterable<StreamChunk> {
  if (options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
    yield* textResponse(text, finish)
    return
  }
  const prompt = options.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.includes('Scheduled personal briefing request.'))
  if (prompt?.type !== 'text') throw new Error('Scheduled briefing prompt is missing')
  const args = JSON.stringify({
    start: /^Window start: (.+)$/mu.exec(prompt.text)?.[1],
    end: /^Window end: (.+)$/mu.exec(prompt.text)?.[1],
    timeZone: /^Time zone: (.+)$/mu.exec(prompt.text)?.[1],
  })
  const id = ToolCallId('calendar-read')
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'calendar_list', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'calendar_list', arguments: args } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
