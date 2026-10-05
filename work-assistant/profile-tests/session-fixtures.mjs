import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { createUserMessage, joinAssistantStreamText, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const fixtureSessionId = SessionId('wa-profile-smoke-recent-activity')
const fixtureSessionsRoot = join(import.meta.dirname, 'fixtures', 'recent-activity', 'sessions')
const reactionFixtureId = SessionId('wa-profile-smoke-selective-reactions')
const reactionFixturesRoot = join(import.meta.dirname, 'fixtures', 'selective-reactions', 'sessions')
const workAssistantRoot = resolve(import.meta.dirname, '..')
const fixtureProvider = 'profile-smoke-fixture'
const fixtureModel = 'profile-smoke-fixture-model'
const calendarMemoryTools = ['calendar_list', 'memory_read', 'memory_list', 'memory_write']

export const RECENT_ACTIVITY_USER_TEXT = 'Review my focus block before the planning sync.'
export const RECENT_ACTIVITY_ASSISTANT_TEXT = 'Synthetic fixture: your planning sync focus block is ready to review.'
export const RECENT_ACTIVITY_TITLE = 'Review my focus block before'
export const CALENDAR_MEMORY_USER_TEXT = 'Show my design review day and memory note.'
export const CALENDAR_MEMORY_ASSISTANT_TEXT = 'Synthetic fixture: calendar and memory records are ready.'
export const CALENDAR_MEMORY_TITLE = 'Show my design review day'
export const CALENDAR_MEMORY_EVENT_TITLE = 'Nocturne design review'
export const CALENDAR_MEMORY_EVENT_LOCATION = 'Room 4'
export const CALENDAR_MEMORY_EVENT_LOCAL_START = '2026-03-10 10:00'
export const CALENDAR_MEMORY_NOTE = 'profile.md'
export const CALENDAR_MEMORY_NOTE_TEXT = 'Prefers concise planning notes.\nFocus reviews happen before lunch.\n'
export const CALENDAR_MEMORY_PROJECT_NOTE = 'projects/nocturne.md'
export const CALENDAR_MEMORY_PROJECT_NOTE_TEXT = 'Nocturne review notes stay synthetic.\n'
export const CALENDAR_MEMORY_RETAINED_PROJECT_NOTE = 'projects/zeta.md'
export const CALENDAR_MEMORY_RETAINED_PROJECT_NOTE_TEXT = 'Zeta planning memory remains visible when lists truncate.\n'
export const CALENDAR_MEMORY_ABSENT_NOTE = 'projects/missing.md'
export const MEMORY_FAILURE_USER_TEXT = 'Try to update my memory note with stale data.'
export const MEMORY_FAILURE_ASSISTANT_TEXT = 'Synthetic fixture: the memory update failed after the earlier read.'
export const MEMORY_FAILURE_TITLE = 'Try to update my memory'

/** Read current Session generations through the persistence owner's decoder. */
export async function readPersistedSessions(dshHome) {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions') })
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
  } finally {
    await ctx.fiber.dispose()
  }
}

export async function seedRecentActivitySession({ dshHome, workspace, id, createdAt = Date.now() - 60_000, agentOptions }) {
  return seedRecordedSession({
    dshHome, workspace, id, createdAt, agentOptions,
    sourceRoot: fixtureSessionsRoot, sourceId: fixtureSessionId, verify: assertFixtureConversation,
  })
}

/** Replay the recorded mixed text/reaction conversation without invoking a model. */
export async function seedSelectiveReactionSession({ dshHome, workspace, id }) {
  return seedRecordedSession({
    dshHome, workspace, id, createdAt: Date.now() - 90_000,
    sourceRoot: reactionFixturesRoot, sourceId: reactionFixtureId, verify: assertReactionFixture,
  })
}

/** Exercise legacy/non-Web replies using the same recorded assistant choices. */
export async function seedNonWebReactionSession({ dshHome, workspace, id }) {
  return seedRecordedSession({
    dshHome, workspace, id, createdAt: Date.now() - 100_000,
    sourceRoot: reactionFixturesRoot, sourceId: reactionFixtureId, verify: assertReactionFixture,
    mapEvents: events => events.map(event => {
      if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        return { ...event, data: { ...event.data, source: { kind: 'user' } } }
      }
      if (event.type === 'session/title') return { ...event, data: { ...event.data, title: 'Non-Web acknowledgement history' } }
      return event
    }),
  })
}

/** Record the synthetic installed-profile conversation through the persistence owner. */
export async function recordSelectiveReactionSession(dshHome, prompt) {
  const deadline = Date.now() + 30_000
  let source
  while (Date.now() < deadline) {
    const candidate = (await readPersistedSessions(dshHome)).find(({ events }) => events.some(event =>
      event.type === 'user/message' && event.data.source?.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === prompt)))
    if (candidate?.events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length >= 4) {
      source = candidate
      break
    }
    await delay(50)
  }
  if (source === undefined) throw new Error('selective reaction recording has no completed source conversation')
  assertReactionFixture(source.events)
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: reactionFixturesRoot, compression: 'none' })
    const { cwd: _cwd, ...header } = source.header
    const writer = await ctx.sessionPersistence.create({ ...header, id: reactionFixtureId })
    try {
      await writer.append(source.events)
    } finally {
      await writer.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

function assertReactionFixture(events) {
  const replies = events.filter(event => event.type === 'assistant/message' && !event.data.interrupted)
  const texts = replies.map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  if (texts.filter(text => text === '👍').length !== 2 || !texts.includes("You're welcome.") || !texts.includes('Hi! How can I help?')) {
    throw new Error('selective reaction fixture must include two emoji replies and two normal answers')
  }
  if (!events.some(event => event.type === 'system/message'
    && event.data.message.content.some(block => block.type === 'text' && block.text.includes('you may reply with just 👍')))) {
    throw new Error('selective reaction fixture is missing the optional-acknowledgement persona')
  }
}

async function seedRecordedSession({ dshHome, workspace, id, createdAt, agentOptions, sourceRoot, sourceId, verify, mapEvents = events => events }) {
  const source = new Context()
  const target = new Context()
  let reader
  let writer
  let failure
  try {
    await source.plugin(JsonlSessionPersistence, { root: sourceRoot, compression: 'none' })
    const fixture = (await source.sessionPersistence.list()).find(entry => entry.header.id === sourceId)
    if (fixture === undefined) throw new Error(`recorded fixture is missing: ${sourceId}`)
    reader = await source.sessionPersistence.open(sourceId, 'read')
    const { events } = await reader.read()
    verify(events)
    const rebasedEvents = retargetModelConfig(rebaseEventTimes(mapEvents(events), createdAt), agentOptions)

    await mountTargetProjectionServices(target, dshHome)
    await target.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions') })
    const header = {
      ...fixture.header,
      id: SessionId(id),
      createdAt,
      cwd: workspace,
      delegationDepth: 0,
      agentPreset: 'personal-assistant',
    }

    function retargetModelConfig(events, agentOptions) {
      if (agentOptions === undefined) return events
      return events.map(event => {
        switch (event.type) {
          case 'request/header':
            return {
              ...event,
              data: {
                ...event.data,
                header: {
                  ...event.data.header,
                  config: { ...event.data.header.config, provider: agentOptions.provider, model: agentOptions.model },
                },
              },
            }
          case 'request/context':
            return { ...event, data: { ...event.data, provider: agentOptions.provider, model: agentOptions.model } }
          case 'assistant/message':
            if (event.data.message?.source?.kind !== 'model') return event
            return {
              ...event,
              data: {
                ...event.data,
                message: {
                  ...event.data.message,
                  source: { ...event.data.message.source, provider: agentOptions.provider, model: agentOptions.model },
                },
              },
            }
          default:
            return event
        }
      })
    }

    writer = await target.sessionPersistence.create(header)
    await writer.append(rebasedEvents)
    await writer.close()
    writer = undefined
    const session = target.sessions.create(SessionId(id), {
      seed: rebasedEvents,
      meta: {
        createdAt,
        cwd: workspace,
        delegationDepth: 0,
        agentPreset: 'personal-assistant',
      },
    })
    await target.sessionProjectionCache.write(session)
    return {
      title: rebasedEvents.findLast(event => event.type === 'session/title')?.data.title,
      events: rebasedEvents,
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupFailure = await cleanupAll([
      () => closeHandle(writer),
      () => closeHandle(reader),
      () => target.fiber.dispose(),
      () => source.fiber.dispose(),
    ])
    if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure
  }
}

export async function seedCalendarMemorySession({ dshHome, workspace, id, createdAt = Date.now() - 30_000 }) {
  const ctx = new Context()
  const fixtureRoot = join(workspace, '.profile-smoke-fixtures', id)
  let handle
  let failure
  try {
    await mkdir(fixtureRoot, { recursive: true })
    const calendarPath = await writeCalendarFixture(fixtureRoot)
    const memoryRoot = await writeMemoryFixture(fixtureRoot)
    const adapter = new CalendarMemoryAdapter()
    await mountCalendarMemoryLoop(ctx, { dshHome, workspace, calendarPath, memoryRoot, adapter })
    handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { createdAt, cwd: workspace, delegationDepth: 0, agentPreset: 'personal-assistant' },
      agentOptions: { provider: fixtureProvider, model: fixtureModel },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'personal-assistant')
        agentCtx.tools.restrict({ allow: calendarMemoryTools })
      },
    })
    await ctx.agents.withInitiator(handle.agent, async () => {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: CALENDAR_MEMORY_USER_TEXT }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    })
    await ctx.sessionTitle.refresh(handle.agent.session)
    await ctx.sessions.flush(handle.agent.session)
    await ctx.sessionProjectionCache.write(handle.agent.session)
    assertCalendarMemoryFixture(handle.agent.session.snapshotEvents(), adapter)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupFailure = await cleanupAll([
      async () => {
        if (handle === undefined) return
        await handle.dispose()
        handle = undefined
      },
      () => ctx.fiber.dispose(),
    ])
    if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure
  }
}

export async function seedMemoryWriteFailureSession({ dshHome, workspace, id, createdAt = Date.now() - 20_000 }) {
  const ctx = new Context()
  const fixtureRoot = join(workspace, '.profile-smoke-fixtures', id)
  let handle
  let failure
  try {
    await mkdir(fixtureRoot, { recursive: true })
    const calendarPath = await writeCalendarFixture(fixtureRoot)
    const memoryRoot = await writeMemoryFixture(fixtureRoot)
    const adapter = new MemoryFailureAdapter()
    await mountCalendarMemoryLoop(ctx, { dshHome, workspace, calendarPath, memoryRoot, adapter })
    ctx.on('approval/request', () => Promise.resolve('allowed-once'))
    handle = await ctx.agents.create({
      sessionId: SessionId(id),
      meta: { createdAt, cwd: workspace, delegationDepth: 0, agentPreset: 'personal-assistant' },
      agentOptions: { provider: fixtureProvider, model: fixtureModel },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'personal-assistant')
        agentCtx.tools.restrict({ allow: calendarMemoryTools })
      },
    })
    await ctx.agents.withInitiator(handle.agent, async () => {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: MEMORY_FAILURE_USER_TEXT }],
        source: { kind: 'user' },
      }))
      await handle.agent.whenIdle()
    })
    await ctx.sessionTitle.refresh(handle.agent.session)
    await ctx.sessions.flush(handle.agent.session)
    await ctx.sessionProjectionCache.write(handle.agent.session)
    assertMemoryFailureFixture(handle.agent.session.snapshotEvents(), adapter)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupFailure = await cleanupAll([
      async () => {
        if (handle === undefined) return
        await handle.dispose()
        handle = undefined
      },
      () => ctx.fiber.dispose(),
    ])
    if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure
  }
}

export async function seedWorkspace({ dshHome, workspace }) {
  const ctx = new Context()
  let failure
  try {
    const [StorageJson, { default: WorkspaceRegistry }] = await Promise.all([
      importDshDependency('@deepseek-ai/dsh-storage-json'),
      importDshDependency('@deepseek-ai/dsh-workspace'),
    ])
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(dshHome, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions') })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.workspaceRegistry.create(workspace)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const cleanupFailure = await cleanupAll([() => ctx.fiber.dispose()])
    if (failure === undefined && cleanupFailure !== undefined) throw cleanupFailure
  }
}

async function mountTargetProjectionServices(ctx, dshHome) {
  const [StorageJson, { default: SessionProjectionCache }, { default: SessionTitle }] = await Promise.all([
    importDshDependency('@deepseek-ai/dsh-storage-json'),
    importDshDependency('@deepseek-ai/dsh-session-projection-cache'),
    importDshDependency('@deepseek-ai/dsh-session-title'),
  ])
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(dshHome, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
}

async function mountCalendarMemoryLoop(ctx, { dshHome, workspace, calendarPath, memoryRoot, adapter }) {
  const [
    StorageJson,
    { default: SessionProjectionCache },
    { default: SessionTitle },
    { default: Gateway },
    Calendar,
    Memory,
    { default: UserQuestions },
  ] = await Promise.all([
    importDshDependency('@deepseek-ai/dsh-storage-json'),
    importDshDependency('@deepseek-ai/dsh-session-projection-cache'),
    importDshDependency('@deepseek-ai/dsh-session-title'),
    importWorkAssistantPackage('wa-gateway'),
    importWorkAssistantPackage('wa-calendar'),
    importWorkAssistantPackage('wa-memory'),
    importDshDependency('@deepseek-ai/dsh-user-questions'),
  ])
  const presetRoot = resolve(workAssistantRoot, 'packages', 'wa-preset')
  const presetBaseUrl = `${pathToFileURL(presetRoot).href}/`
  ctx.baseUrl = presetBaseUrl
  await ctx.plugin(Loader, { baseUrl: presetBaseUrl })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([fixtureProvider], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(JsonlSessionPersistence, { root: join(dshHome, 'sessions') })
  await ctx.plugin(UserQuestions)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, {
    default: 'personal-assistant',
    roots: [{ path: resolve(workAssistantRoot, 'packages', 'wa-preset', 'presets'), trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(Credentials, { path: join(workspace, '.profile-smoke-fixtures', 'credentials.yaml'), watch: false })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(dshHome, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5_000 })
  await ctx.plugin(Gateway, { ownerId: 'smoke' })
  await ctx.plugin(Calendar, {
    source: { kind: 'file', path: calendarPath },
    maxEvents: 10,
    maxConflicts: 10,
  })
  await ctx.plugin(Memory, {
    root: memoryRoot,
    maxNoteBytes: 512,
    maxProjectNotes: 1,
  })
}

async function importDshDependency(specifier) {
  const require = createRequire(import.meta.url)
  const dshRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
  return import(pathToFileURL(dshRequire.resolve(specifier)).href)
}

async function importWorkAssistantPackage(name) {
  return import(pathToFileURL(join(workAssistantRoot, 'packages', name, 'lib', 'index.js')).href)
}

async function writeCalendarFixture(root) {
  const calendarPath = join(root, 'calendar-memory.ics')
  await writeFile(calendarPath, `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//DSH Work Assistant Profile Smoke//EN
BEGIN:VEVENT
UID:nocturne-design-review@example.test
SUMMARY:${CALENDAR_MEMORY_EVENT_TITLE}
LOCATION:${CALENDAR_MEMORY_EVENT_LOCATION}
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/Los_Angeles:20260310T100000
DTEND;TZID=America/Los_Angeles:20260310T110000
END:VEVENT
BEGIN:VEVENT
UID:focus-block@example.test
SUMMARY:Protected focus block
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/Los_Angeles:20260310T130000
DTEND;TZID=America/Los_Angeles:20260310T143000
END:VEVENT
END:VCALENDAR
`, 'utf8')
  return calendarPath
}

async function writeMemoryFixture(root) {
  const memoryRoot = join(root, 'memory')
  await mkdir(join(memoryRoot, 'projects'), { recursive: true })
  runGit(memoryRoot, ['init', '-b', 'main'])
  await writeFile(join(memoryRoot, CALENDAR_MEMORY_NOTE), CALENDAR_MEMORY_NOTE_TEXT, 'utf8')
  await writeFile(join(memoryRoot, 'projects', 'nocturne.md'), CALENDAR_MEMORY_PROJECT_NOTE_TEXT, 'utf8')
  await writeFile(join(memoryRoot, 'projects', 'zeta.md'), CALENDAR_MEMORY_RETAINED_PROJECT_NOTE_TEXT, 'utf8')
  runGit(memoryRoot, ['add', '.'])
  runGit(memoryRoot, [
    '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Work Assistant Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '-m', 'seed synthetic memory',
  ])
  return memoryRoot
}

function runGit(cwd, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
}

class CalendarMemoryAdapter extends LlmAdapter {
  requests = []

  providerInfo(provider) { return { id: provider, name: 'Profile smoke fixture provider' } }

  async listModels(provider) { return [{ provider, id: fixtureModel, name: 'Profile smoke fixture model' }] }

  async resolveModel(provider, model) { return { provider, id: model, name: model } }

  async *stream(options) {
    this.requests.push(options)
    if (!hasToolResult(options)) {
      assertPromptVisible(options)
      yield* calendarMemoryToolCalls()
      return
    }
    yield* textResponse(CALENDAR_MEMORY_ASSISTANT_TEXT)
  }
}

class MemoryFailureAdapter extends LlmAdapter {
  requests = []

  providerInfo(provider) { return { id: provider, name: 'Profile smoke fixture provider' } }

  async listModels(provider) { return [{ provider, id: fixtureModel, name: 'Profile smoke fixture model' }] }

  async resolveModel(provider, model) { return { provider, id: model, name: model } }

  async *stream(options) {
    this.requests.push(options)
    if (!hasToolResult(options)) {
      assertMemoryFailurePromptVisible(options)
      yield* memoryFailureToolCalls()
      return
    }
    yield* textResponse(MEMORY_FAILURE_ASSISTANT_TEXT)
  }
}

function hasToolResult(options) {
  return options.messages.some(message => message.content.some(block => block.type === 'tool-result'))
}

function assertPromptVisible(options) {
  const prompt = options.messages
    .flatMap(message => message.content)
    .find(block => block.type === 'text' && block.text.includes(CALENDAR_MEMORY_USER_TEXT))
  if (prompt === undefined) throw new Error('calendar/memory fixture prompt was not model-visible')
  const available = new Set(options.tools?.map(tool => tool.name) ?? [])
  for (const tool of calendarMemoryTools) {
    if (!available.has(tool)) throw new Error(`calendar/memory fixture missing tool ${tool}`)
  }
}

function assertMemoryFailurePromptVisible(options) {
  const prompt = options.messages
    .flatMap(message => message.content)
    .find(block => block.type === 'text' && block.text.includes(MEMORY_FAILURE_USER_TEXT))
  if (prompt === undefined) throw new Error('memory failure fixture prompt was not model-visible')
  const available = new Set(options.tools?.map(tool => tool.name) ?? [])
  for (const tool of ['memory_read', 'memory_write']) {
    if (!available.has(tool)) throw new Error(`memory failure fixture missing tool ${tool}`)
  }
}

function* calendarMemoryToolCalls() {
  const calls = [
    {
      id: 'calendar-memory-calendar',
      name: 'calendar_list',
      args: {
        start: '2026-03-10T07:00:00Z',
        end: '2026-03-11T07:00:00Z',
        timeZone: 'America/Los_Angeles',
        maxResults: 10,
      },
    },
    { id: 'calendar-memory-read', name: 'memory_read', args: { note: CALENDAR_MEMORY_NOTE } },
    { id: 'calendar-memory-retained-read', name: 'memory_read', args: { note: CALENDAR_MEMORY_RETAINED_PROJECT_NOTE } },
    { id: 'calendar-memory-absent', name: 'memory_read', args: { note: CALENDAR_MEMORY_ABSENT_NOTE } },
    { id: 'calendar-memory-list', name: 'memory_list', args: {} },
  ]
  yield* toolCalls(calls)
}

function* memoryFailureToolCalls() {
  yield* toolCalls([
    { id: 'memory-failure-read', name: 'memory_read', args: { note: CALENDAR_MEMORY_NOTE } },
    {
      id: 'memory-failure-write',
      name: 'memory_write',
      args: {
        note: CALENDAR_MEMORY_NOTE,
        expectedRevision: `sha256:${'0'.repeat(64)}`,
        content: 'This stale write must fail before replacing the fixture note.',
      },
    },
  ])
}

function* toolCalls(calls) {
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const argumentsJson = JSON.stringify(call.args)
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: ToolCallId(call.id), name: call.name, argumentsDelta: argumentsJson }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: argumentsJson } }
  }
  yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function assertFixtureConversation(events) {
  const user = events.find(event => event.type === 'user/message')
  const assistant = events.find(event => event.type === 'assistant/message')
  const turnEnd = events.find(event => event.type === 'turn/end')
  const title = events.find(event => event.type === 'session/title')
  const userText = JSON.stringify(user?.data ?? {})
  const assistantMessageText = messageText(assistant?.data?.message)
  const assistantStreamText = assistant === undefined ? '' : joinAssistantStreamText(assistant.data.stream)
  if (
    turnEnd?.data?.reason?.kind !== 'completed'
    || !userText.includes(RECENT_ACTIVITY_USER_TEXT)
    || assistantMessageText !== RECENT_ACTIVITY_ASSISTANT_TEXT
    || assistantStreamText !== RECENT_ACTIVITY_ASSISTANT_TEXT
    || title?.data?.title !== RECENT_ACTIVITY_TITLE
    || !Array.isArray(title?.data?.messageSeqs)
    || !title.data.messageSeqs.includes(user?.seq)
  ) {
    throw new Error('recent activity fixture text does not match the browser assertions')
  }
}

function assertCalendarMemoryFixture(events, adapter) {
  const user = events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes(CALENDAR_MEMORY_USER_TEXT))
  const assistant = events.findLast(event => event.type === 'assistant/message')
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  const title = events.findLast(event => event.type === 'session/title')
  const toolResults = events.filter(event => event.type === 'tool/result')
  const metadata = new Map(toolResults.map(event => [event.data.meta?.workAssistant?.kind, event.data]))
  const calendar = metadata.get('calendar-list')?.meta?.workAssistant?.value
  const memoryReads = toolResults
    .filter(event => event.data.meta?.workAssistant?.kind === 'memory-read')
    .map(event => event.data.meta.workAssistant.value)
  const memoryRead = memoryReads.find(value => value.note === CALENDAR_MEMORY_NOTE)
  const retainedRead = memoryReads.find(value => value.note === CALENDAR_MEMORY_RETAINED_PROJECT_NOTE)
  const memoryAbsent = memoryReads.find(value => value.note === CALENDAR_MEMORY_ABSENT_NOTE)
  const memoryList = metadata.get('memory-list')?.meta?.workAssistant?.value
  const assistantMessageText = messageText(assistant?.data?.message)
  const assistantStreamText = assistant === undefined ? '' : joinAssistantStreamText(assistant.data.stream)
  const failures = [
    adapter.requests.length === 2 ? undefined : `expected 2 model requests, got ${adapter.requests.length}`,
    user === undefined ? 'missing user message' : undefined,
    turnEnd?.data?.reason?.kind === 'completed' ? undefined : 'turn did not complete',
    assistantMessageText === CALENDAR_MEMORY_ASSISTANT_TEXT ? undefined : 'assistant message text mismatch',
    assistantStreamText === CALENDAR_MEMORY_ASSISTANT_TEXT ? undefined : 'assistant stream text mismatch',
    title?.data?.title === CALENDAR_MEMORY_TITLE ? undefined : `title mismatch: ${String(title?.data?.title)}`,
    toolResults.some(event => event.data.message.content[0]?.isError === true) ? 'a tool result recorded an error' : undefined,
    calendar?.events?.[0]?.title === CALENDAR_MEMORY_EVENT_TITLE ? undefined : 'calendar event title mismatch',
    calendar?.events?.[0]?.location === CALENDAR_MEMORY_EVENT_LOCATION ? undefined : 'calendar event location mismatch',
    calendar?.events?.[0]?.start?.local === CALENDAR_MEMORY_EVENT_LOCAL_START ? undefined : 'calendar event start mismatch',
    memoryRead?.note === CALENDAR_MEMORY_NOTE && memoryRead.exists === true && memoryRead.content === CALENDAR_MEMORY_NOTE_TEXT ? undefined : 'memory read mismatch',
    retainedRead?.note === CALENDAR_MEMORY_RETAINED_PROJECT_NOTE && retainedRead.exists === true && retainedRead.content === CALENDAR_MEMORY_RETAINED_PROJECT_NOTE_TEXT ? undefined : 'retained project memory read mismatch',
    memoryAbsent?.exists === false && memoryAbsent.revision === null && memoryAbsent.content === null ? undefined : 'memory absent read mismatch',
    Array.isArray(memoryList?.notes) ? undefined : 'memory list missing',
    memoryList?.truncated === true ? undefined : 'memory list should be truncated',
    memoryList?.notes?.some(note => note.note === CALENDAR_MEMORY_NOTE) ? undefined : 'memory list missing profile note',
    memoryList?.notes?.some(note => note.note === CALENDAR_MEMORY_PROJECT_NOTE) ? undefined : 'memory list missing project note',
    memoryList?.notes?.some(note => note.note === CALENDAR_MEMORY_RETAINED_PROJECT_NOTE) ? 'truncated memory list unexpectedly includes retained project note' : undefined,
  ].filter(failure => failure !== undefined)
  if (failures.length > 0) throw new Error(`calendar/memory fixture did not record the real tool data required by the browser assertions: ${failures.join('; ')}`)
}

function assertMemoryFailureFixture(events, adapter) {
  const user = events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes(MEMORY_FAILURE_USER_TEXT))
  const assistant = events.findLast(event => event.type === 'assistant/message')
  const turnEnd = events.findLast(event => event.type === 'turn/end')
  const title = events.findLast(event => event.type === 'session/title')
  const toolResults = events.filter(event => event.type === 'tool/result')
  const memoryRead = toolResults.find(event => event.data.meta?.workAssistant?.kind === 'memory-read')?.data.meta.workAssistant.value
  const failedWrite = toolResults.find(event => toolResultCallName(events, event) === 'memory_write')
  const assistantMessageText = messageText(assistant?.data?.message)
  const assistantStreamText = assistant === undefined ? '' : joinAssistantStreamText(assistant.data.stream)
  const failures = [
    adapter.requests.length === 2 ? undefined : `expected 2 model requests, got ${adapter.requests.length}`,
    user === undefined ? 'missing user message' : undefined,
    turnEnd?.data?.reason?.kind === 'completed' ? undefined : 'turn did not complete',
    assistantMessageText === MEMORY_FAILURE_ASSISTANT_TEXT ? undefined : 'assistant message text mismatch',
    assistantStreamText === MEMORY_FAILURE_ASSISTANT_TEXT ? undefined : 'assistant stream text mismatch',
    title?.data?.title === MEMORY_FAILURE_TITLE ? undefined : `title mismatch: ${String(title?.data?.title)}`,
    memoryRead?.note === CALENDAR_MEMORY_NOTE && memoryRead.exists === true && memoryRead.content === CALENDAR_MEMORY_NOTE_TEXT ? undefined : 'memory read mismatch',
    failedWrite?.data.message.content[0]?.isError === true ? undefined : 'memory_write did not record an error result',
    failedWrite?.data.meta?.workAssistant === undefined ? undefined : 'failed memory_write should not record presentation metadata',
  ].filter(failure => failure !== undefined)
  if (failures.length > 0) {
    const observed = toolResults.map(event => ({
      call: toolResultCallName(events, event),
      isError: event.data.message.content[0]?.isError,
      meta: event.data.meta?.workAssistant?.kind,
      text: messageText(event.data.message).slice(0, 120),
    }))
    throw new Error(`memory failure fixture did not record the real failed write required by the browser assertions: ${failures.join('; ')}; observed=${JSON.stringify(observed)}`)
  }
}

function toolResultCallName(events, result) {
  const callId = result.data.message.content[0]?.toolCallId
  return events.find(event => event.type === 'tool/call' && event.data.callId === callId)?.data.name
}

function messageText(message) {
  return (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function rebaseEventTimes(events, createdAt) {
  let next = createdAt
  return events.map(event => {
    const time = next++
    const rebased = { ...event, time }
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt') && Array.isArray(event.data?.stream)) {
      rebased.data = { ...event.data, stream: rebaseAssistantStream(event.data.stream, time - event.time) }
    }
    return rebased
  })
}

function rebaseAssistantStream(stream, delta) {
  return stream.map(record => {
    switch (record.type) {
      case 'chunk':
        return { ...record, time: record.time + delta }
      case 'text-chunks':
      case 'reasoning-chunks':
      case 'tool-call-chunks':
        return { ...record, time0: record.time0 + delta }
      default:
        throw new Error(`Unsupported assistant stream record in recent activity fixture: ${String(record.type)}`)
    }
  })
}

async function closeHandle(handle) {
  if (handle === undefined) return
  await handle.close()
}

async function cleanupAll(steps) {
  const failures = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 0) return undefined
  if (failures.length === 1) return failures[0]
  return new AggregateError(failures, 'recent activity fixture cleanup failed')
}
