/** Authenticated source reads retain exact evidence for source-specific dashboard analysis. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { adoHistoryRequestSchema, adoSourceSchema, snapshotRequestSchema } from '../shared/requests.ts'
import { adoAnalyticsSettingsSchema } from '../shared/ado-analytics-schema.ts'
import type { DashboardSettings, DashboardSnapshot } from '../shared/types.ts'
import { DashboardMcp, safeError } from './mcp.ts'
import { loadAdo } from './ado.ts'
import { loadAdoHistory } from './ado-history.ts'
import { DashboardHistoryReads } from './history-context.ts'
import { loadPersonal } from './personal.ts'
import { SnapshotContexts } from './snapshot-context.ts'
import { chatOpenSchema, chatSendSchema, type SnapshotReceipt } from '../shared/chat.ts'
import { dashboardFetch, type DashboardEndpoint } from './http.ts'
import { DashboardChatError, DashboardChatSessions, registerDashboardChatPreset } from './chat/index.ts'
import { DashboardQuestions } from './questions.ts'
import { attentionReadSchema, attentionWriteSchema } from '../shared/attention.ts'
import { AttentionStore } from './attention-store.ts'
import { AttentionWriteRejection, DashboardAttentionViews } from './attention-views.ts'

export const name = 'dsh-dashboard'
export const inject = [
  'connection', 'loader', 'agents', 'agentDefaultModel', 'agentPresets',
  'sessions', 'sessionPersistence', 'storageDomain', 'systemPrompt', 'tools', 'llm', 'workspaceRegistry',
]

const connector = (server: 'ado' | 'workiq') => z.object({
  command: z.string().min(1).default('agency'),
  args: z.array(z.string()).default(['mcp', server]),
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
}).strict().default({ command: 'agency', args: ['mcp', server], timeoutMs: 60_000 })

const settingsSchema = z.object({
  timeZone: z.string().default('America/Los_Angeles').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
  }, 'Use a valid IANA time zone'),
  refreshMinutes: z.number().int().min(1).max(1440).default(60),
  refreshMinute: z.number().int().min(0).max(59).default(55),
  workdayStart: z.number().int().min(0).max(23).default(6),
  workdayEnd: z.number().int().min(1).max(24).default(18),
  referencePath: z.string().min(1).optional(),
  defaultAdoSource: adoSourceSchema.optional(),
  maxCalendarPages: z.number().int().min(1).max(10).default(5),
  maxPersonalItems: z.number().int().min(5).max(100).default(35),
  attention: z.object({
    lookbackDays: z.number().int().min(1).max(30).default(7),
    maxItems: z.number().int().min(1).max(10).default(5),
    maxMessages: z.number().int().min(5).max(100).default(50),
  }).strict().default(() => ({ lookbackDays: 7, maxItems: 5, maxMessages: 50 })),
  maxAdoItems: z.number().int().min(1).max(20_000).default(5000),
  adoPageSize: z.number().int().min(1).max(1000).default(1000),
  staleDays: z.number().int().min(1).max(365).default(7),
  blockedTags: z.array(z.string().min(1)).default(['blocked']),
  adoAnalytics: adoAnalyticsSettingsSchema.default(() => adoAnalyticsSettingsSchema.parse({})),
  cacheSeconds: z.number().int().min(0).max(3600).default(600),
  cacheEntries: z.number().int().min(1).max(32).default(8),
  chatSnapshotEntries: z.number().int().min(1).max(64).default(16),
  chatSnapshotRetentionMinutes: z.number().int().min(1).max(1440).default(240),
  maxChatContextBytes: z.number().int().min(4096).max(1_000_000).default(128_000),
  maxChatQuestionChars: z.number().int().min(1).max(16_000).default(4000),
  maxChatOutputTokens: z.number().int().min(128).max(128_000).default(8192),
  chatLockDirectory: z.string().refine(isAbsolute, 'Use an absolute dashboard lock directory')
    .default(() => dshHomePath('locks', 'dashboard')),
  chatWorkingDirectory: z.string().refine(isAbsolute, 'Use an absolute dashboard working directory')
    .default(() => dshHomePath('dashboards', 'workspace')),
  workiq: connector('workiq'),
  ado: connector('ado'),
}).strict().refine(value => value.workdayStart < value.workdayEnd, 'workdayStart must precede workdayEnd')

/** Register exact authenticated reads and dispose all connector work when unloaded. */
export async function apply(ctx: Context, input: unknown = {}): Promise<void> {
  const config = settingsSchema.parse(input)
  await registerDashboardChatPreset(ctx)
  const workiq = new DashboardMcp('workiq', config.workiq)
  const ado = new DashboardMcp('ado', config.ado)
  const lifetime = new AbortController()
  const requests = new Set<Promise<unknown>>()
  const contexts = new SnapshotContexts({
    maxEntries: config.chatSnapshotEntries,
    retentionMilliseconds: config.chatSnapshotRetentionMinutes * 60_000,
    maxContextBytes: config.maxChatContextBytes,
    now: () => Date.now(),
  })
  const histories = new DashboardHistoryReads(contexts,
    (snapshot, type, signal) => loadAdoHistory(ado, snapshot, type, signal), config.cacheEntries)
  let attentionToClose: AttentionStore | undefined
  const chats: DashboardChatSessions = new DashboardChatSessions(ctx, {
    lockDirectory: config.chatLockDirectory,
    workingDirectory: config.chatWorkingDirectory,
    maxQuestionBytes: config.maxChatQuestionChars * 4,
    maxContextBytes: config.maxChatContextBytes,
    maxOutputTokens: config.maxChatOutputTokens,
    proposeAttention: (request, signal) => attention.propose(request, signal),
    beforeReleaseOwnership: () => attentionToClose?.dispose(),
  })
  const attention: AttentionStore = new AttentionStore(ctx, { now: () => Date.now(), checkOwnership: () => chats.checkOwnership() })
  attentionToClose = attention
  const personalViews = new DashboardAttentionViews(attention, contexts)
  let personalReadGeneration = 0
  const cache = new Map<string, { time: number; value: DashboardSnapshot; receipt: SnapshotReceipt }>()
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Dashboard unloaded'))
    const results = await Promise.allSettled([workiq.dispose(), ado.dispose(), attention.dispose()])
    results.push(...await Promise.allSettled([chats.dispose()]))
    await Promise.allSettled([...requests])
    cache.clear()
    histories.clear()
    contexts.clear()
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Dashboard disposal failed.')
  }, 'dsh-dashboard: source and persistence ownership')
  await Promise.all([chats.ready, attention.ready])
  lifetime.signal.throwIfAborted()
  const questions = new DashboardQuestions(chats, contexts, config.maxChatQuestionChars,
    async sessionId => { await ctx.workspaceRegistry.archiveSession(sessionId) })
  const settings: DashboardSettings = {
    timeZone: config.timeZone,
    cacheSeconds: config.cacheSeconds,
    refreshMinutes: config.refreshMinutes,
    refreshMinute: config.refreshMinute,
    workdayStart: config.workdayStart,
    workdayEnd: config.workdayEnd,
    hasReference: Boolean(config.referencePath),
    maxChatQuestionChars: config.maxChatQuestionChars,
    ...(config.defaultAdoSource ? { defaultAdoSource: config.defaultAdoSource } : {}),
  }
  ctx.effect(() => {
    const handle = async (endpoint: DashboardEndpoint, payload: unknown, signal: AbortSignal) => {
      const run = async () => {
        const combined = AbortSignal.any([signal, lifetime.signal])
        combined.throwIfAborted()
        if (endpoint === 'settings') {
          z.object({}).strict().parse(payload)
          return { ok: true as const, value: settings }
        }
        if (endpoint === 'chat-open') {
          const request = chatOpenSchema.parse(payload)
          const scope = contexts.scope(request.snapshotId)
          const opened = await chats.open(scope)
          await ctx.workspaceRegistry.archiveSession(opened.sessionId)
          return { ok: true as const, value: { ...opened, scope } }
        }
        if (endpoint === 'chat-send') {
          const request = chatSendSchema.parse(payload)
          const value = await questions.submit(request, combined)
          return { ok: true as const, value }
        }
        if (endpoint === 'attention-read') {
          attentionReadSchema.parse(payload)
          await chats.checkOwnership()
          return { ok: true as const, ...personalViews.read() }
        }
        if (endpoint === 'attention-write') {
          const request = attentionWriteSchema.parse(payload)
          return { ok: true as const, ...await personalViews.write(request, combined) }
        }
        if (endpoint === 'ado-history') {
          const request = adoHistoryRequestSchema.parse(payload)
          const result = await histories.read(request, combined)
          for (const entry of cache.values()) {
            if (entry.receipt.id !== request.snapshotId) continue
            entry.value = result.value
            entry.receipt = result.receipt
          }
          return { ok: true as const, ...result }
        }
        if (endpoint !== 'snapshot') return { ok: false as const, error: { code: 'dashboard/not-found', message: 'Unknown dashboard operation', details: {} } }
        const request = snapshotRequestSchema.parse(payload)
        const key = JSON.stringify(request.view === 'personal' ? { view: 'personal' } : { view: 'ado', source: request.source })
        const previous = cache.get(key)
        if (!request.force && previous && Date.now() - previous.time < config.cacheSeconds * 1000) {
          if (previous.value.kind === 'personal') {
            return { ok: true as const, ...personalViews.read() }
          }
          if (!contexts.has(previous.receipt.id)) previous.receipt = contexts.retain(previous.value)
          return { ok: true as const, value: previous.value, receipt: previous.receipt }
        }
        const personalGeneration = request.view === 'personal' ? ++personalReadGeneration : 0
        let value: DashboardSnapshot = request.view === 'personal'
          ? await loadPersonal(workiq, {
            timeZone: config.timeZone,
            referencePath: config.referencePath,
            maxCalendarPages: config.maxCalendarPages,
            attention: config.attention,
            maxItems: config.maxPersonalItems,
            now: () => new Date(),
          }, combined)
          : await loadAdo(ado, request.source, {
            maxItems: config.maxAdoItems,
            pageSize: config.adoPageSize,
            staleDays: config.staleDays,
            blockedTags: config.blockedTags,
            now: () => new Date(),
          }, combined)
        if (value.kind === 'ado') {
          value = { ...value, analytics: { version: 1, timeZone: config.timeZone, settings: config.adoAnalytics } }
        }
        combined.throwIfAborted()
        if (cache.size >= config.cacheEntries) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        if (value.kind === 'personal') {
          const result = personalViews.publish(value, personalGeneration)
          cache.set(key, { time: Date.now(), value: personalViews.source(), receipt: result.receipt })
          return { ok: true as const, ...result }
        }
        const receipt = contexts.retain(value)
        cache.set(key, { time: Date.now(), value, receipt })
        return { ok: true as const, value, receipt }
      }
      const pending = run()
      requests.add(pending)
      try {
        return await pending
      } catch (error) {
        const message = safeError(error)
        if (!signal.aborted && !lifetime.signal.aborted) console.warn('[dsh-dashboard]', endpoint, message)
        return { ok: false as const, error: {
          code: signal.aborted || lifetime.signal.aborted ? 'dashboard/cancelled'
            : error instanceof z.ZodError ? 'dashboard/invalid-input'
              : error instanceof DashboardChatError || error instanceof AttentionWriteRejection ? error.code : 'dashboard/provider',
          message, details: {},
        } }
      } finally {
        requests.delete(pending)
      }
    }
    const endpoints: DashboardEndpoint[] = [
      'settings', 'snapshot', 'ado-history', 'chat-open', 'chat-send', 'attention-read', 'attention-write',
    ]
    const unregister = endpoints.map(endpoint => ctx.connection.fetch.register({
      path: `/api/dsh-dashboard/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: dashboardFetch(endpoint, handle),
    }))
    return async () => {
      lifetime.abort(new Error('Dashboard unloaded'))
      await Promise.all(unregister.map(remove => remove()))
    }
  }, 'dsh-dashboard: authenticated dashboard operations')
}
