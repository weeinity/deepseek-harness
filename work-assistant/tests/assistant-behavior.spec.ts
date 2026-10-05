/** Focused assistant behavior composition tests over real DSH services. */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets, { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtime, trackedContext } from './support.ts'
import { CLIENT_CONFIG_KEY, Config } from '../packages/wa-ui/src/config.ts'

afterEach(() => vi.unstubAllGlobals())

const questionArgs = {
  questions: [{
    id: 'date',
    question: 'Which date should I use?',
    options: [{ label: 'Use today' }, { label: 'Cancel' }],
  }],
}

async function waPresetDependency<T>(specifier: string): Promise<T> {
  const presetRequire = createRequire(resolve('packages', 'wa-preset', 'package.json'))
  return import(pathToFileURL(presetRequire.resolve(specifier)).href) as Promise<T>
}

async function waUiDependency<T>(specifier: string): Promise<T> {
  const waUiRequire = createRequire(resolve('packages', 'wa-ui', 'package.json'))
  return import(pathToFileURL(waUiRequire.resolve(specifier)).href) as Promise<T>
}

async function userQuestionsPlugin(): Promise<Plugin.Object<void>> {
  const module = await waPresetDependency<{ default: Plugin.Object<void> }>('@deepseek-ai/dsh-user-questions')
  return module.default
}

interface SlotCoreFace {
  register(options: object, component: unknown): () => void
}

interface WaUiClientModule {
  apply(ctx: Context): void
  inject: string[]
}

async function waUiClientSource(): Promise<WaUiClientModule> {
  return import(pathToFileURL(resolve('packages', 'wa-ui', 'src', 'client', 'index.ts')).href) as Promise<WaUiClientModule>
}

function makeAgent(): Agent & { session: Session } {
  const session = Session.create(SessionId(randomUUID()))
  return { id: session.id, session } as unknown as Agent & { session: Session }
}

function runFor(ctx: Context, agent: Agent, name: string, args: unknown = {}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    name,
    arguments: args,
    callId: ToolCallId(randomUUID()),
    agent,
    signal: new AbortController().signal,
  })
}

function writeAction(body = vi.fn(async () => 'saved')) {
  return {
    body,
    tool: defineTool({
      name: 'memory_write',
      description: 'Test memory write',
      parameters: {
        note: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: body,
    }),
  }
}

async function personalAssistantHarness() {
  const h = await runtime()
  const presetRoot = resolve('packages', 'wa-preset')
  const presetBaseUrl = `${pathToFileURL(presetRoot).href}/`
  h.ctx.baseUrl = presetBaseUrl
  await h.ctx.plugin(Loader, { baseUrl: presetBaseUrl })
  await h.ctx.plugin(SessionProjection)
  h.ctx.sessionProjections.register(agentPresetProjectionDefinition)
  await h.ctx.plugin(AgentRegistry)
  await h.ctx.plugin(await userQuestionsPlugin())
  await h.ctx.plugin(AgentPresets, {
    default: 'personal-assistant',
    roots: [{ path: resolve('packages', 'wa-preset', 'presets'), trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  const scope = createScope(h.ctx, h.agent)
  ;(h.agent as Agent & { ctx: Context }).ctx = scope.ctx
  h.ctx.effect(() => () => scope.dispose(), 'test.personal-assistant.scope')
  h.ctx.agents.register(h.agent)
  await h.ctx.agentPresets.mount(scope.ctx, 'personal-assistant')
  return { ...h, scope }
}

describe('personal-assistant behavior composition', () => {
  it('composes optional acknowledgement guidance, ask policy, and native-only tool visibility', async () => {
    const h = await personalAssistantHarness()

    const scope = scopeOf(h.scope.ctx)
    if (scope === undefined) throw new Error('personal-assistant test scope was not tagged')
    const prompt = renderPrompt(await h.ctx.systemPrompt.assemble({ scope }))
    expect(prompt).toContain('you may reply with just 👍 instead of a text message')
    expect(prompt).toContain('Use this sparingly and only when it fits the conversation')
    expect(prompt).toContain('it does not approve, promise, or report completed work')
    expect(prompt).not.toContain('The interface may show a receipt')
    expect(prompt).toContain('use ask_user_question with concise options')
    expect(prompt).toContain('This profile has no calendar write, invitation send, reminder creation')
    expect(prompt).toContain('A memory_write approval applies only to that one write')
    expect(prompt).toContain('Free text, empty selections, cancellation, denial, timeout, provider absence, or tool failure is not approval')

    const globalTools = h.ctx.tools.schemas().map(tool => tool.name)
    const scopedTools = h.ctx.tools.schemas(h.agent)
    const scopedNames = scopedTools.map(tool => tool.name)
    expect(globalTools).not.toContain('ask_user_question')
    expect(scopedNames).toContain('ask_user_question')
    expect(scopedNames).not.toContain('run_code')
    expect(scopedNames).not.toContain('bash')

    const ask = scopedTools.find(tool => tool.name === 'ask_user_question') as {
      parameters: { properties: { questions: { items: { properties: Record<string, unknown> } } } }
    } | undefined
    expect(ask).toBeDefined()
    const question = ask!.parameters.properties.questions.items.properties
    expect(question).toHaveProperty('id')
    expect(question).toHaveProperty('question')
    expect(question).toHaveProperty('options')
    expect(question).toHaveProperty('multi_select')
    expect(question).not.toHaveProperty('detail')
  })

  it('admits only the exact scoped ask_user_question definition and grants no write approval', async () => {
    const h = await personalAssistantHarness()
    h.ctx.on('user-questions/request', async request => ({
      answers: [{ id: request.questions[0]!.id, selected: ['Use today'] }],
    }))

    await expect(h.run('ask_user_question', questionArgs)).resolves.toMatchObject({
      isError: false,
      value: { answers: [{ id: 'date', selected: ['Use today'] }] },
    })
    expect(h.ctx.workAssistGateway.records()).toEqual([])

    const child = makeAgent()
    const childScope = createScope(h.ctx, child, { parent: h.agent })
    ;(child as Agent & { ctx: Context }).ctx = childScope.ctx
    h.ctx.effect(() => () => childScope.dispose(), 'test.shadow-child.scope')
    h.ctx.agents.register(child)
    const shadowBody = vi.fn(async (): Promise<Record<string, never>> => ({}))
    await childScope.ctx.plugin(Object.assign((ctx: Context) => {
      ctx.tools.register(defineTool({
        name: 'ask_user_question',
        description: 'Same name, different definition',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false }, render: () => [{ type: 'text', text: '{}' }] },
        execute: shadowBody,
      }))
    }, { inject: ['tools'] }))

    await expect(runFor(h.ctx, child, 'ask_user_question')).resolves.toMatchObject({ isError: true })
    expect(shadowBody).not.toHaveBeenCalled()

    const { tool, body } = writeAction()
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })
    const denied = await h.run(tool.name, { note: 'profile.md', content: 'save this' })
    expect(denied.isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()).toEqual([expect.objectContaining({
      tool: 'memory_write',
      decision: 'deny',
      status: 'denied',
    })])
  })

  it('fails closed for the unsupported PTC transport in the native profile harness', async () => {
    const h = await personalAssistantHarness()

    const result = await h.run('run_code', { language: 'typescript', code: 'return await tools.memory_write({})' })

    expect(result.isError).toBe(true)
    expect(h.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch')).toEqual([])
    expect(h.ctx.workAssistGateway.records()).toEqual([])
  })

  it('rejects the receipt contribution when shared Chat has not declared its badge slot', async () => {
    const { SlotCore } = await waUiDependency<{ SlotCore: new () => SlotCoreFace }>('@deepseek-ai/dsh-client-ui-slots')
    const { apply, inject } = await waUiClientSource()
    const ctx = trackedContext()
    const core = new SlotCore()
    const declared = new Set(['root'])
    const injectCalls: string[] = []
    const slots = {
      register(options: { name: string; children?: Record<string, unknown> }, component: unknown): () => void {
        const dispose = core.register(options, component)
        for (const key of Object.keys(options.children ?? {})) declared.add(key)
        return dispose
      },
      inject(name: string, install: () => () => void): () => void {
        injectCalls.push(name)
        if (!declared.has(name)) throw new Error(`test harness would silently wait on undeclared slot "${name}"`)
        return install()
      },
    }
    slots.register({
      name: 'root',
      children: {
        rightbar: { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'conversation.session.header.corner': { kind: 'single', scope: 'session' },
        'conversation.chat.node': { kind: 'chain', scope: 'session' },
      },
    }, () => null)
    ctx.provide('slots', slots as never)
    ctx.provide('locale', { register: () => () => {} } as never)
    ctx.provide('layout', {
      openRightbar: () => {},
      closeRightbar: () => {},
      selectPanel: () => {},
      toggleSidebar: () => {},
    } as never)
    ctx.provide('theme', { overrideTokens: () => () => {} } as never)
    ctx.provide('connection', { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } } as never)
    ctx.provide('uiWorkspace', { openSession: () => {} } as never)
    ctx.provide('chatReactions', { register: () => () => {} } as never)

    let thrown: unknown
    vi.stubGlobal(CLIENT_CONFIG_KEY, Config({ receipt: { presetIds: ['personal-assistant'], style: 'thumbs-up' } }))
    try {
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('slot "conversation.chat.user-badges" is not declared')
    expect(injectCalls).toContain('conversation.chat.node')
    expect(injectCalls).not.toContain('conversation.chat.user-badges')
  })
})
