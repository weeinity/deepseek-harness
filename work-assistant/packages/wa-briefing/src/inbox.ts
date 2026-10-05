/** Durable briefing state; the Session remains the owner of complete assistant content. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const inboxItem = z.object({
  id: z.string().min(1).transform(SessionId),
  sessionId: z.string().min(1).transform(SessionId),
  messageId: z.string().min(1).transform(MessageId),
  createdAt: z.iso.datetime(),
  text: z.string().min(1),
  read: z.boolean(),
  dismissed: z.boolean(),
})

/** One generated message, not a delivery or action-completion receipt. */
export type BriefingItem = z.infer<typeof inboxItem>

const state = z.object({
  paused: z.boolean(),
  latestOccurrence: z.number().int().nonnegative().nullable(),
  pending: z.object({
    sessionId: z.string().min(1).transform(SessionId),
    triggeredAt: z.iso.datetime(),
  }).nullable(),
  items: z.array(inboxItem),
})

/** Single bounded state record, updated atomically by the storage-domain write chain. */
export type BriefingState = z.infer<typeof state>

/** Monotonic durable domain version, independent of the SQLite provider. */
export const SCHEMA_VERSION = 1

/** Separate namespace over the profile's existing storage backend. */
export const briefingDomain = defineDomain({
  name: 'workassist_briefing',
  version: SCHEMA_VERSION,
  tables: { state: domainTable<'current', BriefingState>(state) },
})

/** JSON response for the same-origin assistant Inbox. */
export interface BriefingSnapshot {
  version: 1
  enabled: boolean
  paused: boolean
  running: boolean
  items: BriefingItem[]
}
