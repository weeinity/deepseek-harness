/** Scheduled briefings use the real agent loop, Session log, preset mount, and tool registry. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Context } from '@deepseek-ai/cordis'
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
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Calendar from '../../wa-calendar/src/index.ts'
import Gateway from '../../wa-gateway/src/index.ts'
import * as Memory from '../../wa-memory/src/index.ts'
import BriefingScheduler, { PERSONAL_ASSISTANT_PRESET_ID } from '../src/index.ts'
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

const consoleWarnings: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  consoleWarnings.length = 0
})

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

class ToolCallingAdapter extends LlmAdapter {
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

class BlockingAdapter extends LlmAdapter {
  readonly entered = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  readonly calls: GenerateOptions[] = []

  override providerInfo(provider: string): LlmProviderInfo { return { id: provider, name: 'Blocking provider' } }
  override async listModels(provider: string) { return [{ provider, id: 'blocking-model', name: 'Blocking model' }] }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return { provider, id: model, name: model } }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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

async function mountRealBriefing(adapter: LlmAdapter, options: { includeMemory?: boolean } = {}) {
  const ctx = trackedContext()
  const directory = await temporaryDirectory()
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
  await ctx.plugin(BriefingScheduler, options.includeMemory === undefined ? briefingConfig : { ...briefingConfig, includeMemory: options.includeMemory })
  return { ctx, directory, sessionsRoot, workspace }
}

async function readPersistedSessionText(root: string): Promise<string> {
  const files = await readdir(root, { recursive: true })
  const jsonl = files.map(String).filter(file => file.endsWith('.jsonl'))
  const chunks = await Promise.all(jsonl.map(file => readFile(join(root, file), 'utf8')))
  return chunks.join('\n')
}

describe('wa-briefing', () => {
  it('is disabled by default and validates enabled schedules before startup', async () => {
    await expect(new BriefingScheduler(new Context(), {}).trigger()).resolves.toEqual({ status: 'skipped', reason: 'disabled' })
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * * *', timeZone: 'UTC', workspace: process.cwd(), provider: 'p', model: 'm' })).toThrow('five-field')
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * *', timeZone: 'Mars/Base', workspace: process.cwd(), provider: 'p', model: 'm' })).toThrow('IANA')
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * *', timeZone: 'UTC', workspace: 'relative', provider: 'p', model: 'm' })).toThrow('absolute')
  })

  it('runs a real Agent with the personal preset, read-only tools, calendar data, and persisted Session evidence', async () => {
    const adapter = new ToolCallingAdapter()
    const h = await mountRealBriefing(adapter, { includeMemory: true })

    const result = await h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))

    expect(result).toMatchObject({ status: 'completed', window: { start: '2026-03-01T08:00:00.000Z', end: '2026-03-01T10:00:00.000Z', timeZone: 'America/Los_Angeles' } })
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[0]?.tools?.map(tool => tool.name).sort()).toEqual(['calendar_find_conflicts', 'calendar_list', 'memory_list', 'memory_read'])
    expect(adapter.calls[0]?.tools?.some(tool => tool.name === 'memory_write')).toBe(false)
    const firstMessages = JSON.stringify(adapter.calls[0]?.messages)
    expect(firstMessages).toContain('You are a personal assistant for one user')
    expect(firstMessages).not.toContain('coding agent')
    const scheduledPrompt = adapter.calls[0]?.messages
      .flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('Scheduled personal briefing request.'))
    expect(scheduledPrompt).toMatchSnapshot('scheduled personal briefing')
    const persisted = await readPersistedSessionText(h.sessionsRoot)
    expect(persisted).toContain('Scheduled personal briefing request.')
    expect(persisted).toContain('Window start: 2026-03-01T08:00:00.000Z')
    expect(persisted).toContain('Morning planning')
    expect(persisted).toContain('Briefing complete: Morning planning.')
  })

  it('skips overlapping runs without queueing a backlog', async () => {
    const adapter = new BlockingAdapter()
    const h = await mountRealBriefing(adapter)
    const first = h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))
    await adapter.entered.promise

    await expect(h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:01:00Z'))).resolves.toEqual({ status: 'skipped', reason: 'overlap' })

    adapter.release.resolve()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(adapter.calls).toHaveLength(1)
  })

  it('cancels and joins owned work during scheduler disposal', async () => {
    const adapter = new BlockingAdapter()
    const h = await mountRealBriefing(adapter)
    const warn = vi.spyOn(console, 'warn').mockImplementation(message => { consoleWarnings.push(String(message)) })
    const run = h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))
    await adapter.entered.promise
    const agents = h.ctx.agents

    await h.ctx.fiber.dispose()
    adapter.release.resolve()

    await expect(run).rejects.toThrow('unloading')
    expect(warn).toHaveBeenCalled()
    expect(agents.list()).toHaveLength(0)
  })
})
