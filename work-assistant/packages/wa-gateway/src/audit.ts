/** Versioned action decisions; tool payloads remain in DSH's Session log. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

/** Identity minted by the gateway for one invocation, never supplied by the model. */
export type ActionId = Branded<'workassist.action'>
/** Single-user deployment identity; not a multi-user authentication mechanism. */
export type OwnerId = Branded<'workassist.owner'>

const auditRecord = z.object({
  id: z.string().uuid().transform(brandString<ActionId>),
  ownerId: z.string().min(1).transform(brandString<OwnerId>),
  sessionId: z.string().min(1).transform(brandString<SessionId>),
  callId: z.string().min(1).transform(brandString<ToolCallId>),
  tool: z.string().min(1),
  connector: z.string().min(1),
  method: z.string().min(1),
  kind: z.enum(['read', 'write']),
  argsSha256: z.string().length(64),
  tainted: z.boolean(),
  decision: z.enum(['allow', 'ask', 'deny']),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'denied', 'interrupted']),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

/** Durable metadata; secrets, argument bodies, and provider responses are excluded. */
export type AuditRecord = z.infer<typeof auditRecord>

/** Monotonic application-domain version, independent of the SQLite backend schema. */
export const SCHEMA_VERSION = 1

/** Authoritative records reject incompatible versions or malformed stored data. */
export const auditDomain = defineDomain({
  name: 'workassist',
  version: SCHEMA_VERSION,
  tables: { audit: domainTable<ActionId, AuditRecord>(auditRecord) },
})
