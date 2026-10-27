import assert from 'node:assert/strict'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCopilotModels, withCopilotDiscovery } from '../src/copilot.ts'
import { catalog, chatModel, credentialStore, enterpriseUrl, responseStream, sse } from './copilot-fixtures.ts'

const baseline = githubCopilotProvider().getModels()

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Copilot metadata', () => {
  it('discovers new Responses-only models without extending the static catalog', () => {
    expect(baseline.some(model => model.id === 'gpt-6-astra')).toBe(false)
    const [model] = parseCopilotModels(catalog(), enterpriseUrl, baseline)
    expect(model).toMatchObject({
      id: 'gpt-6-astra',
      name: 'GPT-6 Astra',
      api: 'openai-responses',
      baseUrl: enterpriseUrl,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    expect(getSupportedThinkingLevels(model!)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(model!.headers).toEqual(baseline[0]!.headers)
  })

  it('routes by endpoints, preferring the installed native API where still supported', () => {
    const messages = chatModel('opaque-messages', ['/chat/completions', '/v1/messages'])
    Object.assign(messages.capabilities.supports, { adaptive_thinking: true })
    const result = parseCopilotModels(catalog(
      chatModel('gpt-5-mini', ['/chat/completions', '/responses']),
      chatModel('opaque-chat', ['/chat/completions']),
      messages,
      chatModel('gpt-5.3-codex', ['/chat/completions']),
    ), enterpriseUrl, baseline)
    expect(result.map(model => model.api)).toEqual([
      'openai-responses', 'openai-completions', 'anthropic-messages', 'openai-completions',
    ])
    expect(result[0]!.compat).toEqual(baseline.find(model => model.id === 'gpt-5-mini')!.compat)
    expect(result[2]!.compat).toMatchObject({ forceAdaptiveThinking: true })
    expect(result[3]!.compat).not.toHaveProperty('supportsOpenAIGrammarTools')
  })

  it('retains installed model-specific compatibility, without inferring it from a new model name', () => {
    const known = baseline.find(model => model.api === 'openai-completions'
      && model.compat && 'supportsReasoningEffort' in model.compat && model.compat.supportsReasoningEffort === false)!
    const [existing, fresh] = parseCopilotModels(catalog(
      chatModel(known.id, ['/chat/completions']),
      chatModel('gemini-3.8-flash', ['/chat/completions']),
    ), enterpriseUrl, baseline)
    expect(existing!.compat).toMatchObject(known.compat!)
    expect(fresh!.compat).toMatchObject({ supportsReasoningEffort: true })
  })

  it('filters denied, non-picker, embedding, non-tool, and non-streaming rows', () => {
    const denied = chatModel('denied'); denied.policy.state = 'disabled'
    const internal = chatModel('internal'); internal.model_picker_enabled = false
    const embedding = chatModel('embedding'); embedding.capabilities.type = 'embeddings'
    const noTools = chatModel('no-tools'); noTools.capabilities.supports.tool_calls = false
    const noStream = chatModel('no-stream'); noStream.capabilities.supports.streaming = false
    const unconfigured = chatModel('unconfigured'); unconfigured.policy.state = 'unconfigured'
    const result = parseCopilotModels(catalog(chatModel(), denied, internal, embedding, noTools, noStream, unconfigured), enterpriseUrl, baseline)
    expect(result.map(model => model.id)).toEqual(['gpt-6-astra', 'unconfigured'])
  })

  it('uses enabled-policy fallback only for individual accounts with no eligible picker rows', () => {
    const hidden = chatModel('hidden'); hidden.model_picker_enabled = false
    const unconfigured = chatModel('unconfigured'); unconfigured.model_picker_enabled = false; unconfigured.policy.state = 'unconfigured'
    const raw = catalog(hidden, unconfigured)
    expect(parseCopilotModels(raw, enterpriseUrl, baseline)).toEqual([])
    expect(parseCopilotModels(raw, 'https://api.individual.githubcopilot.com', baseline).map(model => model.id)).toEqual(['hidden'])
    expect(parseCopilotModels(catalog(hidden, chatModel()), 'https://api.individual.githubcopilot.com', baseline).map(model => model.id)).toEqual(['gpt-6-astra'])
  })

  it('maps none to off and does not advertise unspecified effort levels', () => {
    const row = chatModel()
    row.capabilities.supports.reasoning_effort = ['none', 'low', 'high']
    row.capabilities.supports.vision = false
    const [model] = parseCopilotModels(catalog(row), enterpriseUrl, baseline)
    expect(getSupportedThinkingLevels(model!)).toEqual(['off', 'low', 'high'])
    expect(model!.thinkingLevelMap!.off).toBe('none')
    expect(model!.input).toEqual(['text'])
  })

  it('supports token-budget reasoning and text-only models without an effort vocabulary', () => {
    const row = chatModel('opaque-budget', ['/v1/messages'])
    const { reasoning_effort: _efforts, vision: _vision, ...supports } = row.capabilities.supports
    const [model] = parseCopilotModels(catalog({
      ...row, capabilities: { ...row.capabilities, supports: { ...supports, max_thinking_budget: 32000 } },
    }), enterpriseUrl, baseline)
    expect(model!.reasoning).toBe(true)
    expect(model!.input).toEqual(['text'])
    expect(model!.thinkingLevelMap).toBeUndefined()
    const [plain] = parseCopilotModels(catalog({
      ...row, capabilities: { ...row.capabilities, supports },
    }), enterpriseUrl, baseline)
    expect(plain!.reasoning).toBe(false)
  })

  it.each([
    ['envelope', []],
    ['data', { data: {} }],
    ['row', { data: [null] }],
    ['id', catalog({ ...chatModel(), id: '' })],
    ['name', catalog({ ...chatModel(), name: 123 })],
    ['duplicate', catalog(chatModel(), chatModel())],
    ['picker', catalog({ ...chatModel(), model_picker_enabled: 'true' })],
    ['policy', catalog({ ...chatModel(), policy: [] })],
    ['capabilities', catalog({ ...chatModel(), capabilities: null })],
    ['endpoint', catalog({ ...chatModel(), supported_endpoints: ['/responses', 3] })],
    ['unsupported protocol', catalog(chatModel('ws-only', ['ws:/responses']))],
    ['limits', catalog({ ...chatModel(), capabilities: { ...chatModel().capabilities, limits: { max_context_window_tokens: 0, max_output_tokens: 1 } } })],
    ['output limit', catalog({ ...chatModel(), capabilities: { ...chatModel().capabilities, limits: { max_context_window_tokens: 10, max_output_tokens: 11 } } })],
    ['tool flag', catalog({ ...chatModel(), capabilities: { ...chatModel().capabilities, supports: { tool_calls: 'false' } } })],
    ['unknown effort', catalog({ ...chatModel(), capabilities: { ...chatModel().capabilities, supports: { reasoning_effort: ['turbo'] } } })],
    ['oversized list', { data: Array.from({ length: 1001 }, (_, index) => chatModel(`m${index}`)) }],
  ])('rejects malformed %s', (_name, raw) => {
    expect(() => parseCopilotModels(raw, enterpriseUrl, baseline)).toThrow(/Copilot/)
  })
})

async function setup(overrides = {}) {
  const store = await credentialStore(overrides)
  const models = createModels({ credentials: store })
  const original = githubCopilotProvider()
  const provider = withCopilotDiscovery(original)
  models.setProvider(provider)
  return { store, models, provider, original }
}

describe('Copilot provider refresh', () => {
  it('uses pi-ai authentication and live availability instead of stale credential ids', async () => {
    const { models, original, provider } = await setup()
    const fetch = vi.fn().mockResolvedValue(Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    expect(models.getModels('github-copilot')).toEqual([])
    expect((await models.refresh()).errors.size).toBe(0)
    expect((await models.getAvailable('github-copilot')).map(model => model.id)).toEqual(['gpt-6-astra'])
    expect(provider.auth).toBe(original.auth)
    expect(provider.streamSimple).toBe(original.streamSimple)
    const [url, request] = fetch.mock.calls[0]!
    expect(url).toBe(`${enterpriseUrl}/models`)
    expect(request).toMatchObject({
      redirect: 'error',
      headers: {
        Authorization: 'Bearer fake;proxy-ep=proxy.enterprise.githubcopilot.com;',
        'X-GitHub-Api-Version': '2026-06-01',
        'Editor-Version': baseline[0]!.headers!['Editor-Version'],
      },
    })
  })

  it('refreshes expired OAuth using pi-ai under the credential store lock', async () => {
    const { models, store } = await setup({ expires: 0 })
    const modify = vi.spyOn(store, 'modify')
    const fetch = vi.fn(async (url: string) => url.endsWith('/token')
      ? Response.json({ token: 'rotated;proxy-ep=proxy.enterprise.githubcopilot.com;', expires_at: Math.floor(Date.now() / 1000) + 3600 })
      : Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    expect((await models.refresh()).errors.size).toBe(0)
    expect(modify).toHaveBeenCalledTimes(1)
    const credential = await store.read('github-copilot')
    expect(credential?.type === 'oauth' && credential.access).toContain('rotated;')
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1)
    expect(models.getModel('github-copilot', 'gpt-6-astra')).toBeDefined()
  })

  it.each([401, 403, 429, 500])('reports HTTP %s and retries on the next refresh without fallback', async (status) => {
    const { models } = await setup()
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(new Response('private response detail', { status }))
      .mockResolvedValueOnce(Response.json(catalog(chatModel('new-model'))))
    vi.stubGlobal('fetch', fetch)
    await models.refresh()
    const old = models.getModel('github-copilot', 'gpt-6-astra')
    const failed = await models.refresh()
    expect(failed.errors.get('github-copilot')?.message).toBe(`dsh-llm-oauth: Copilot model discovery failed (HTTP ${status})`)
    expect(models.getModels('github-copilot')).toEqual([old])
    expect((await models.refresh()).errors.size).toBe(0)
    expect(models.getModel('github-copilot', 'gpt-6-astra')).toBeUndefined()
    expect(old!.id).toBe('gpt-6-astra')
    expect(models.getModels('github-copilot').map(model => model.id)).toEqual(['new-model'])
  })

  it('does not rotate credentials or publish a catalog when OAuth refresh fails', async () => {
    const { models, store } = await setup({ expires: 0 })
    const before = await store.read('github-copilot')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    expect((await models.refresh()).errors.size).toBe(1)
    expect(await store.read('github-copilot')).toEqual(before)
    expect(models.getModels('github-copilot')).toEqual([])
  })

  it.each([
    ['JSON', () => new Response('{private')],
    ['metadata', () => Response.json({ data: 'wrong' })],
    ['declared size', () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } })],
    ['streamed size', () => new Response(' '.repeat(2 * 1024 * 1024 + 1))],
  ])('rejects invalid %s without publishing', async (_name, response) => {
    const { models } = await setup()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
    expect((await models.refresh()).errors.get('github-copilot')?.message).toMatch(/invalid Copilot|exceeds 2 MiB/)
    expect(models.getModels('github-copilot')).toEqual([])
  })

  it('honors cancellation without publishing a partial result', async () => {
    const { models } = await setup()
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      controller.abort(new Error('cancel discovery'))
      init.signal.throwIfAborted()
      return Response.json(catalog())
    }))
    expect((await models.refresh({ signal: controller.signal })).aborted).toBe(true)
    expect(models.getModels('github-copilot')).toEqual([])
  })
})

describe('Copilot native streaming', () => {
  it.each([
    ['responses', '/responses', () => responseStream()],
    ['messages', '/v1/messages', () => sse([
      { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'opaque', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ])],
    ['completions', '/chat/completions', () => new Response(
      `data: ${JSON.stringify({ id: 'chat_test', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'chat_test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )],
  ])('uses the built-in %s implementation with derived account authentication', async (_name, endpoint, streamResponse) => {
    const { models } = await setup()
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('/models')
      ? Response.json(catalog(chatModel('opaque', [endpoint])))
      : streamResponse())
    vi.stubGlobal('fetch', fetch)
    await models.refresh()
    const model = models.getModel('github-copilot', 'opaque')!
    const result = await models.completeSimple(model, { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }, { maxRetries: 0, reasoning: 'low' })
    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'OK' })]))
    const call = fetch.mock.calls.at(-1)!
    expect(String(call[0])).toBe(`${enterpriseUrl}${endpoint}`)
    const init = call[1]
    assert(init)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fake;proxy-ep=proxy.enterprise.githubcopilot.com;')
    expect(new Headers(init.headers).get('x-initiator')).toBe('user')
    expect(JSON.parse(init.body as string).model).toBe('opaque')
  })
})
