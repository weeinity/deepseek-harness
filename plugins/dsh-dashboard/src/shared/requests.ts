/** Validate browser-controlled source selectors before starting provider work. */
import { z } from 'zod'
import { snapshotIdSchema } from './chat.ts'

const text = z.string().trim().min(1).max(512)
export const adoSourceSchema = z.object({
  input: text,
  orgName: z.string().trim().max(128),
  project: z.string().trim().max(256),
  team: z.string().trim().max(256).optional(),
  mode: z.enum(['iteration', 'area', 'query']),
  path: text.optional(),
  includeChildren: z.boolean().optional(),
}).strict()

export const snapshotRequestSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('personal'), force: z.boolean().optional() }).strict(),
  z.object({ view: z.literal('ado'), source: adoSourceSchema, force: z.boolean().optional() }).strict(),
])

/** History can enrich retained evidence, never a browser-supplied source or item list. */
export const adoHistoryRequestSchema = z.object({
  snapshotId: snapshotIdSchema,
  type: z.string().min(1).max(512),
  force: z.boolean().optional(),
}).strict()

export type AdoHistoryRequest = z.infer<typeof adoHistoryRequestSchema>
