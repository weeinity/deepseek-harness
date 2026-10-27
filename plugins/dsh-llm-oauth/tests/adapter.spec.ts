import assert from 'node:assert/strict'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OAuthPiAiAdapter } from '../src/adapter.ts'
import { catalog, chatModel, credentialStore, enterpriseUrl, responseStream } from './copilot-fixtures.ts'

vi.mock('@deepseek-ai/dsh-llm', () => ({
  LlmAdapter: class {},
  LlmError: class extends Error {
    constructor(message: string, readonly code: string) { super(message) }
  },
  ReasoningEffortId: (id: string) => id,
  ToolCallId: (id: string) => id,
  attributionHeaders: () => ({ 'x-test-attribution': 'oauth' }),
  contentHasImage: (content: { type: string }[]) => content.some(block => block.type === 'image'),
}))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function adapter(store?: InMemoryCredentialStore) {
  return new OAuthPiAiAdapter({ authPath: 'unused-test-auth.json', store: store ?? await credentialStore(), catalog: ['github-copilot', 'openai-codex'] })
}

function request(model = 'gpt-6-astra') {
  return {
    provider: 'github-copilot',
    model,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
  }
}

async function collect(source: AsyncIterable<unknown>) {
  const chunks = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

describe('live Copilot adapter', () => {
  it('lists and resolves new models with live limits, modalities, and efforts', async () => {
    const llm = await adapter()
    const fetch = vi.fn(async () => Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    expect(await llm.listModels('github-copilot')).toEqual([{
      provider: 'github-copilot', id: 'gpt-6-astra', name: 'GPT-6 Astra', inputModalities: ['text', 'image'],
    }])
    const resolved = await llm.resolveModel('github-copilot', 'gpt-6-astra')
    expect(resolved.context).toEqual({ contextWindow: 1_000_000 })
    expect(resolved.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves every picker entry from one successful live listing', async () => {
    const llm = await adapter()
    const rows = Array.from({ length: 23 }, (_, index) => chatModel(`live-model-${index}`))
    const fetch = vi.fn(async () => Response.json(catalog(...rows)))
    vi.stubGlobal('fetch', fetch)
    const listed = await llm.listModels('github-copilot')
    const resolved = await Promise.all(listed.map(model => llm.resolveModel('github-copilot', model.id)))
    expect(resolved.map(model => model.id)).toEqual(rows.map(model => model.id))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves on first lookup without a prior list and rejects unknown or withdrawn models', async () => {
    const llm = await adapter()
    const row = chatModel()
    row.policy.state = 'disabled'
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(Response.json(catalog(row)))
      .mockResolvedValueOnce(Response.json(catalog(row)))
    vi.stubGlobal('fetch', fetch)
    expect((await llm.resolveModel('github-copilot', 'gpt-6-astra')).id).toBe('gpt-6-astra')
    expect(await llm.listModels('github-copilot')).toEqual([])
    await expect(llm.resolveModel('github-copilot', 'gpt-6-astra')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    await expect(collect(llm.stream(request()))).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps completed picker metadata available while another listing refreshes', async () => {
    const llm = await adapter()
    const rows = Array.from({ length: 23 }, (_, index) => chatModel(`live-model-${index}`))
    let release!: (response: Response) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(catalog(...rows)))
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        release = resolve
        entered()
      }))
    vi.stubGlobal('fetch', fetch)
    const listed = await llm.listModels('github-copilot')
    const refreshing = llm.listModels('github-copilot')
    await started
    try {
      const resolved = await Promise.all(listed.map(model => llm.resolveModel('github-copilot', model.id)))
      expect(resolved.map(model => model.id)).toEqual(rows.map(model => model.id))
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      release(Response.json(catalog(...rows)))
      await refreshing
    }
  })

  it('streams a new model on first use through pi-ai Responses with auth and attribution', async () => {
    const llm = await adapter()
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('/models')
      ? Response.json(catalog())
      : responseStream())
    vi.stubGlobal('fetch', fetch)
    const chunks = await collect(llm.stream({ ...request(), reasoningEffort: ReasoningEffortId('max') }))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'OK' })
    expect(chunks).toContainEqual({ type: 'finish', reason: { kind: 'stop' } })
    const [url, init] = fetch.mock.calls.at(-1)!
    assert(init)
    expect(String(url)).toBe(`${enterpriseUrl}/responses`)
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-6-astra', reasoning: { effort: 'max' } })
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe('Bearer fake;proxy-ep=proxy.enterprise.githubcopilot.com;')
    expect(headers.get('x-test-attribution')).toBe('oauth')
  })

  it('rejects unadvertised reasoning before inference', async () => {
    const llm = await adapter()
    const fetch = vi.fn(async () => Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    await expect(collect(llm.stream({ ...request(), reasoningEffort: ReasoningEffortId('minimal') }))).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends an explicitly selected off effort when live Responses metadata advertises none', async () => {
    const llm = await adapter()
    const row = chatModel('gpt-5.4')
    row.capabilities.supports.reasoning_effort = ['none', 'low', 'medium', 'high', 'xhigh']
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => String(url).endsWith('/models')
      ? Response.json(catalog(row))
      : responseStream())
    vi.stubGlobal('fetch', fetch)
    await collect(llm.stream({ ...request(row.id), reasoningEffort: ReasoningEffortId('off') }))
    const [, init] = fetch.mock.calls.at(-1)!
    assert(init)
    expect(JSON.parse(init.body as string).reasoning).toEqual({ effort: 'none' })
  })

  it('requires auth for every live access and never falls back to the static catalog', async () => {
    const llm = await adapter(new InMemoryCredentialStore())
    vi.stubEnv('COPILOT_GITHUB_TOKEN', '')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    try {
      await expect(llm.listModels('github-copilot')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      await expect(llm.resolveModel('github-copilot', 'gpt-5-mini')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      await expect(collect(llm.stream(request()))).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('surfaces a failed refresh after success and retries at the next lookup', async () => {
    const llm = await adapter()
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(Response.json({ data: 'invalid' }))
      .mockResolvedValueOnce(Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    await llm.listModels('github-copilot')
    await expect(llm.listModels('github-copilot')).rejects.toThrow('network unavailable')
    await expect(llm.resolveModel('github-copilot', 'gpt-6-astra')).rejects.toThrow(/metadata/)
    expect((await llm.resolveModel('github-copilot', 'gpt-6-astra')).id).toBe('gpt-6-astra')
  })

  it('serializes overlapping discovery and keeps an in-flight model descriptor unchanged', async () => {
    const llm = await adapter()
    const first = chatModel()
    const second = chatModel()
    second.name = 'Updated name'
    let count = 0
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/models')) return Response.json(catalog(++count === 1 ? first : second))
      entered()
      await waiting
      return responseStream()
    })
    vi.stubGlobal('fetch', fetch)
    const dispatch = vi.spyOn(llm.modelsApi(), 'streamSimple')
    const streaming = collect(llm.stream(request()))
    let captured: (typeof dispatch.mock.calls)[number][0] | undefined
    try {
      await started
      captured = dispatch.mock.calls[0]![0]
      await llm.listModels('github-copilot')
      const resolved = await llm.resolveModel('github-copilot', first.id)
      expect(resolved.name).toBe('Updated name')
      expect(captured.name).toBe('GPT-6 Astra')
    } finally {
      release()
      await streaming
    }
    assert(captured)
    expect(captured.name).toBe('GPT-6 Astra')
  })

  it('does not supersede concurrent list and resolve calls', async () => {
    const llm = await adapter()
    const fetch = vi.fn(async () => Response.json(catalog()))
    vi.stubGlobal('fetch', fetch)
    const [listed, resolved] = await Promise.all([
      llm.listModels('github-copilot'),
      llm.resolveModel('github-copilot', 'gpt-6-astra'),
    ])
    expect(listed[0]!.id).toBe(resolved.id)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('propagates cancellation to discovery and permits the next request', async () => {
    const llm = await adapter()
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      entered()
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const pending = llm.resolveModel('github-copilot', 'gpt-6-astra', controller.signal)
    const rejected = expect(pending).rejects.toThrow('user cancelled')
    await started
    controller.abort(new Error('user cancelled'))
    await rejected
    fetch.mockImplementation(async () => Response.json(catalog()))
    expect((await llm.listModels('github-copilot'))[0]!.id).toBe('gpt-6-astra')
  })

  it('bounds discovery to 20 seconds including queued waits', async () => {
    const llm = await adapter()
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      entered()
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })))
    const pending = llm.listModels('github-copilot')
    const rejected = expect(pending).rejects.toThrow('deadline reached')
    await started
    controller.abort(new Error('deadline reached'))
    await rejected
    expect(timeout).toHaveBeenCalledWith(20_000)
  })

  it('cancels a queued lookup without cancelling the active discovery or fetching for it', async () => {
    const llm = await adapter()
    let release!: (response: Response) => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetch = vi.fn(() => new Promise<Response>(resolve => {
      release = resolve
      entered()
    }))
    vi.stubGlobal('fetch', fetch)
    const active = llm.listModels('github-copilot')
    await started
    const controller = new AbortController()
    const queued = llm.resolveModel('github-copilot', 'gpt-6-astra', controller.signal)
    const rejected = expect(queued).rejects.toThrow('cancel queued')
    controller.abort(new Error('cancel queued'))
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    release(Response.json(catalog()))
    expect((await active)[0]!.id).toBe('gpt-6-astra')
    fetch.mockImplementation(async () => Response.json(catalog()))
    expect((await llm.listModels('github-copilot'))[0]!.id).toBe('gpt-6-astra')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves other providers on pi-ai static lookup and stream dispatch', async () => {
    const store = await credentialStore()
    await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'fake', refresh: 'fake', expires: Date.now() + 3_600_000 }))
    const llm = await adapter(store)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const list = await llm.listModels('openai-codex')
    expect(list.length).toBeGreaterThan(0)
    expect((await llm.resolveModel('openai-codex', list[0]!.id)).id).toBe(list[0]!.id)
    const sentinel = new Error('native dispatch reached')
    const dispatch = vi.spyOn(llm.modelsApi(), 'streamSimple').mockImplementation(() => { throw sentinel })
    await expect(collect(llm.stream({ ...request(list[0]!.id), provider: 'openai-codex' }))).rejects.toBe(sentinel)
    expect(dispatch.mock.calls[0]![0].provider).toBe('openai-codex')
    expect(fetch).not.toHaveBeenCalled()
    await expect(llm.resolveModel('unknown', 'any')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })
})
