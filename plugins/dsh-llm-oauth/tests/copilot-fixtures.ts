import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { OAuthCredential } from '@earendil-works/pi-ai'

export const enterpriseUrl = 'https://api.enterprise.githubcopilot.com'

export function chatModel(id = 'gpt-6-astra', endpoints = ['/responses', 'ws:/responses']) {
  return {
    id,
    name: id === 'gpt-6-astra' ? 'GPT-6 Astra' : id,
    model_picker_enabled: true,
    policy: { state: 'enabled' },
    capabilities: {
      type: 'chat',
      limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 128_000 },
      supports: {
        tool_calls: true,
        streaming: true,
        vision: true,
        reasoning_effort: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    },
    supported_endpoints: endpoints,
  }
}

export function catalog(...rows: unknown[]) {
  return { data: rows.length === 0 ? [chatModel()] : rows }
}

export async function credentialStore(overrides: Partial<OAuthCredential> = {}) {
  const store = new InMemoryCredentialStore()
  await store.modify('github-copilot', async () => ({
    type: 'oauth',
    access: 'fake;proxy-ep=proxy.enterprise.githubcopilot.com;',
    refresh: 'fake-refresh',
    expires: Date.now() + 3_600_000,
    availableModelIds: ['stale-static-id'],
    ...overrides,
  }))
  return store
}

export function responseStream() {
  const item = { id: 'msg_test', type: 'message', role: 'assistant', content: [] }
  const events = [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OK' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { ...item, content: [{ type: 'output_text', text: 'OK', annotations: [] }] },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_test',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    },
  ]
  return sse(events)
}

export function sse<T extends { type?: string }>(events: T[]) {
  return new Response(events.map(event => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
