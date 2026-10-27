/**
 * Authenticated Copilot model discovery; pi-ai owns OAuth and protocol streaming.
 */

import type { Api, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'

const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const MAX_CATALOG_MODELS = 1000
const ENDPOINTS = [
  ['anthropic-messages', '/v1/messages'],
  ['openai-responses', '/responses'],
  ['openai-completions', '/chat/completions'],
] as const
const THINKING_LEVELS: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function invalid(field: string): never {
  throw new Error(`dsh-llm-oauth: invalid Copilot models metadata (${field})`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) invalid(field)
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid(field)
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') invalid(field)
  return value
}

function thinkingMap(value: unknown): ThinkingLevelMap | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > THINKING_LEVELS.length) invalid('reasoning_effort')
  const result: ThinkingLevelMap = {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  }
  for (const effort of value) {
    const level = effort === 'none' ? 'off' : effort
    if (!THINKING_LEVELS.includes(level)) invalid('reasoning_effort')
    result[level as ModelThinkingLevel] = effort
  }
  return result
}

/**
 * Convert an account's picker-eligible chat metadata into pi-ai model descriptors.
 * @param raw - untrusted `/models` JSON envelope.
 * @param baseUrl - account endpoint derived by pi-ai authentication.
 * @param baseline - installed Copilot models supplying existing protocol compatibility.
 * @returns fresh descriptors, with no static-only models appended.
 */
export function parseCopilotModels(
  raw: unknown,
  baseUrl: string,
  baseline: readonly Model<Api>[],
): Model<Api>[] {
  const data = record(raw, 'response').data
  if (!Array.isArray(data) || data.length > MAX_CATALOG_MODELS) invalid('data')
  const seen = new Set<string>()
  const rows = data.flatMap((value) => {
    const row = record(value, 'model')
    const id = text(row.id, 'id')
    if (seen.has(id)) invalid('duplicate id')
    seen.add(id)
    const picker = optionalBoolean(row.model_picker_enabled, 'model_picker_enabled') === true
    const policy = row.policy === undefined ? undefined : record(row.policy, 'policy')
    const state = policy?.state === undefined ? undefined : text(policy.state, 'policy.state')
    const capabilities = record(row.capabilities, 'capabilities')
    if (text(capabilities.type, 'capabilities.type') !== 'chat') return []
    const supports = record(capabilities.supports, 'supports')
    const tools = optionalBoolean(supports.tool_calls, 'tool_calls')
    const streaming = optionalBoolean(supports.streaming, 'streaming')
    if (tools === false || streaming === false || state === 'disabled') return []
    return [{ row, id, picker, state, capabilities, supports }]
  })
  const hasPicker = rows.some(row => row.picker)
  const policyFallback = baseUrl === 'https://api.individual.githubcopilot.com' && !hasPicker
  const known = new Map(baseline.map(model => [model.id, model]))
  const headers = baseline.find(model => model.headers !== undefined)?.headers
  return rows.filter(row => row.picker || (policyFallback && row.state === 'enabled'))
    .map(({ row, id, capabilities, supports }) => {
      const endpoints = row.supported_endpoints
      if (!Array.isArray(endpoints) || !endpoints.every(endpoint => typeof endpoint === 'string')) {
        invalid('supported_endpoints')
      }
      const existing = known.get(id)
      const supported = ENDPOINTS.filter(([, endpoint]) => endpoints.includes(endpoint))
      const selected = supported.find(([api]) => api === existing?.api) ?? supported[0]
      if (selected === undefined) {
        throw new Error('dsh-llm-oauth: Copilot picker model has no supported HTTP streaming endpoint')
      }
      const [api] = selected
      const limits = record(capabilities.limits, 'limits')
      const contextWindow = positiveInteger(limits.max_context_window_tokens, 'max_context_window_tokens')
      const maxTokens = positiveInteger(limits.max_output_tokens, 'max_output_tokens')
      if (maxTokens > contextWindow) invalid('max_output_tokens exceeds context window')
      const vision = optionalBoolean(supports.vision, 'vision') === true
      const adaptive = optionalBoolean(supports.adaptive_thinking, 'adaptive_thinking')
      const budget = supports.max_thinking_budget === undefined
        ? undefined
        : positiveInteger(supports.max_thinking_budget, 'max_thinking_budget')
      const levels = thinkingMap(supports.reasoning_effort)
      const reasoning = levels === undefined
        ? adaptive === true || budget !== undefined
        : THINKING_LEVELS.some(level => level !== 'off' && typeof levels[level] === 'string')
      const compat = existing?.api === api ? existing.compat : undefined
      return {
        id,
        name: text(row.name, 'name', 512),
        provider: 'github-copilot',
        api,
        baseUrl,
        input: vision ? ['text', 'image'] : ['text'],
        contextWindow,
        maxTokens,
        reasoning,
        ...levels === undefined ? {} : { thinkingLevelMap: levels },
        cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...headers === undefined ? {} : { headers: { ...headers, ...existing?.headers } },
        compat: api === 'anthropic-messages'
          ? {
            supportsEagerToolInputStreaming: false,
            ...compat,
            ...adaptive === undefined ? {} : { forceAdaptiveThinking: adaptive },
          }
          : api === 'openai-completions'
            ? {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: levels !== undefined && reasoning,
              ...compat,
            }
            : { ...compat },
      }
    })
}

async function readCatalog(response: Response): Promise<unknown> {
  const size = response.headers.get('content-length')
  if (size !== null && Number(size) > MAX_CATALOG_BYTES) {
    await response.body?.cancel()
    throw new Error('dsh-llm-oauth: Copilot models response exceeds 2 MiB')
  }
  if (response.body === null) invalid('empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_CATALOG_BYTES) {
        await reader.cancel()
        throw new Error('dsh-llm-oauth: Copilot models response exceeds 2 MiB')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    const catalog: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return catalog
  } catch {
    // JSON parse errors may quote response content; expose only the failed field.
    invalid('JSON')
  }
}

/**
 * Extend the built-in Copilot provider with transactional live discovery.
 * @param provider - pi-ai's Copilot provider, including OAuth and all native stream APIs.
 * @returns provider whose synchronous catalog contains only the last successful live result.
 */
export function withCopilotDiscovery(provider: Provider): Provider {
  const baseline = provider.getModels()
  let current: readonly Model<Api>[] = []
  return {
    ...provider,
    getModels: () => current,
    // The live response is authoritative; credential.availableModelIds may predate it.
    filterModels: models => models,
    refreshModels: async ({ credential, allowNetwork, signal, publish }) => {
      if (!allowNetwork) return
      const auth = credential?.type === 'oauth'
        ? await provider.auth.oauth!.toAuth(credential)
        : { apiKey: credential?.key, baseUrl: provider.baseUrl }
      if (!auth.apiKey) throw new Error('dsh-llm-oauth: Copilot model discovery requires authentication')
      const baseUrl = auth.baseUrl ?? provider.baseUrl!
      const url = new URL(baseUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('dsh-llm-oauth: invalid Copilot API URL')
      }
      signal.throwIfAborted()
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: {
          ...baseline.find(model => model.headers !== undefined)?.headers,
          Accept: 'application/json',
          Authorization: `Bearer ${auth.apiKey}`,
          'X-GitHub-Api-Version': '2026-06-01',
        },
        signal,
        redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`dsh-llm-oauth: Copilot model discovery failed (HTTP ${response.status})`)
      }
      const models = parseCopilotModels(await readCatalog(response), baseUrl, baseline)
      signal.throwIfAborted()
      await publish({ update: () => { current = models } })
    },
  }
}
