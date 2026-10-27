/** Fixed authenticated dashboard endpoints; native Sessions own reply transport and history. */
import type { Request } from './owner.ts'
import { responseSchema } from './validation.ts'

const endpoints = {
  settings: '/api/dsh-dashboard/settings',
  snapshot: '/api/dsh-dashboard/snapshot',
  'ado-history': '/api/dsh-dashboard/ado-history',
  'attention-read': '/api/dsh-dashboard/attention-read',
  'attention-write': '/api/dsh-dashboard/attention-write',
  'chat-open': '/api/dsh-dashboard/chat-open',
  'chat-send': '/api/dsh-dashboard/chat-send',
} as const

/** The owner validates JSON; non-success HTTP may carry only a validated failure envelope. */
export function createDashboardRequest(fetcher: typeof fetch): Request {
  return async (endpoint, payload, signal) => {
    const response = await fetcher(endpoints[endpoint], {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const failure = responseSchema.safeParse(value)
      if (!failure.success || failure.data.ok) throw new Error('dashboard/http')
    }
    return value
  }
}
