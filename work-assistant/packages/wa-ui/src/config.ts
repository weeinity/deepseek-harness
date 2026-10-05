/** Public display configuration shared by the Host and browser halves. */
import z from '@deepseek-ai/schemastery'
import { resolveReceiptPolicy, type ReceiptPolicy } from './receipt-policy.ts'

/** Sections in the personal-assistant rail. */
export const ASSISTANT_TABS = ['timeline', 'queue', 'day', 'memory', 'inbox'] as const
/** Selected assistant section. */
export type AssistantTab = typeof ASSISTANT_TABS[number]
/** The Host's public, page-local configuration value. */
export const CLIENT_CONFIG_KEY = '__DSH_WA_UI_CONFIG__'

/** Personal-assistant UI configuration accepted from cordis.yml. */
export interface Config {
  /** Maximum nonblank conversations in the activity list. */
  maxActivities?: number
  /** Interval for reading persisted Inbox state; it never schedules model work. */
  inboxRefreshIntervalMs?: number
  /** Deadline for one Inbox HTTP request, including its response body. */
  inboxRequestTimeoutMs?: number
  /** Rail tab selected on first load. */
  defaultTab?: AssistantTab
  /** Optional acknowledgement-reply presentation; absent preserves ordinary replies. */
  receipt?: ReceiptPolicy | null
}

/** Validated Host configuration; browser boot carries only resolved public fields. */
export const Config: z<Config> = z.object({
  maxActivities: z.natural().min(1).max(20).default(6),
  inboxRefreshIntervalMs: z.natural().min(1000).max(300000).default(15000),
  inboxRequestTimeoutMs: z.natural().min(100).max(120000).default(10000),
  defaultTab: z.union(ASSISTANT_TABS.map(tab => z.const(tab))).default('timeline') as z<AssistantTab>,
  receipt: z.union([
    z.const(null),
    z.object({
      presetIds: z.array(z.string()).min(1).required(),
      style: z.union([z.const('thumbs-up'), z.const('neutral'), z.const('off')]).required() as z<ReceiptPolicy['style']>,
    }),
  ]).default(null) as z<ReceiptPolicy | null>,
})

/**
 * Validate and snapshot only the fields allowed in the browser.
 * @param value - Host configuration or the public browser boot value.
 * @returns Explicit display defaults and a detached receipt policy.
 */
export function resolveClientConfig(value: unknown): Required<Config> {
  const config = z.resolve(value, Config, {})[0] as Required<Config>
  return {
    maxActivities: config.maxActivities,
    inboxRefreshIntervalMs: config.inboxRefreshIntervalMs,
    inboxRequestTimeoutMs: config.inboxRequestTimeoutMs,
    defaultTab: config.defaultTab,
    receipt: config.receipt == null ? null : resolveReceiptPolicy(config.receipt),
  }
}
