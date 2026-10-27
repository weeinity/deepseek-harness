/** Authoritative source identity and at-most-once question receipts; no evidence is duplicated here. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const scopeId = z.string().regex(/^(personal|ado:[a-f0-9]{64})$/)
const sessionId = z.string().regex(/^dashboard-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
const scopeRecord = z.object({
  scopeId,
  sessionId,
  state: z.enum(['reserved', 'ready']),
})
const requestRecord = z.object({
  scopeId,
  sessionId,
  requestId: z.uuid(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['claimed', 'queued']),
})

/** Domain schema version; incompatible records fail closed instead of being discarded. */
export const dashboardChatDomain = defineDomain({
  name: 'dashboard_chat',
  version: 1,
  layout: 'per-record',
  tables: {
    scopes: domainTable<string, z.infer<typeof scopeRecord>>(scopeRecord),
    requests: domainTable<string, z.infer<typeof requestRecord>>(requestRecord),
  },
})
