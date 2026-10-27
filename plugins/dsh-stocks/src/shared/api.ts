/** JSON-only stock API. All routes are authenticated same-origin POST requests. */
import { z } from 'zod'

export const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/)
  .transform((value) => value.toUpperCase())
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1)
export const watchlistEntrySchema = z
  .object({ symbol: symbolSchema, name: z.string().trim().min(1).max(160) })
  .strict()
export const priceAlertSchema = z
  .object({
    id: z.string().uuid(),
    symbol: symbolSchema,
    direction: z.enum(['above', 'below']),
    price: z.number().finite().positive(),
    createdAt: z.string().datetime(),
    triggeredAt: z.string().datetime().optional(),
    lastPrice: z.number().finite().positive().optional(),
  })
  .strict()
export const stockStateSchema = z
  .object({
    version: z.literal(1),
    revision: revisionSchema,
    watchlist: z.array(watchlistEntrySchema).max(100),
    alerts: z.array(priceAlertSchema).max(100),
  })
  .strict()
  .refine(
    (state) => new Set(state.watchlist.map((item) => item.symbol)).size === state.watchlist.length,
    'Duplicate watchlist symbol',
  )
  .refine(
    (state) => new Set(state.alerts.map((item) => item.id)).size === state.alerts.length,
    'Duplicate alert id',
  )
export const requestSchemas = {
  settings: z.object({}).strict(),
  state: z.object({}).strict(),
  watchlist: z
    .object({
      symbol: symbolSchema,
      name: z.string().trim().min(1).max(160).optional(),
      add: z.boolean(),
      revision: revisionSchema,
    })
    .strict(),
  quotes: z.object({ symbols: z.array(symbolSchema).max(100) }).strict(),
  search: z.object({ query: z.string().trim().max(100) }).strict(),
  news: z.object({ symbols: z.array(symbolSchema).max(12) }).strict(),
  profile: z.object({ symbol: symbolSchema }).strict(),
  alerts: z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('add'),
        revision: revisionSchema,
        symbol: symbolSchema,
        direction: z.enum(['above', 'below']),
        price: z.number().finite().positive(),
      })
      .strict(),
    z.object({ action: z.literal('remove'), revision: revisionSchema, id: z.string().uuid() }).strict(),
  ]),
  sentiment: z.object({ symbol: symbolSchema }).strict(),
}
export type StockState = z.infer<typeof stockStateSchema>
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>
export type PriceAlert = z.infer<typeof priceAlertSchema>
export interface ApiError {
  code: string
  message: string
}
export type ApiReply<T> = { ok: true; value: T } | { ok: false; error: ApiError }
export interface StockSettings {
  hasFinnhub: boolean
  hasSentiment: boolean
  quoteRefreshSeconds: number
  alertCheckSeconds: number
  maxTabs: 12
  maxWatchlist: 100
  /** Persistent background degradation, cleared only after a successful check. */
  alertCheckError?: ApiError
  lastAlertCheckAt?: string
}
export interface StockQuote {
  symbol: string
  price: number
  change: number
  changePercent: number
  high: number
  low: number
  open: number
  previousClose: number
  timestamp: number
}
export interface QuoteResult {
  quotes: Record<string, ApiReply<StockQuote>>
}
export interface SearchResult {
  symbol: string
  name: string
  displaySymbol: string
  type: string
}
export interface NewsArticle {
  id: number
  headline: string
  summary: string
  url: string
  image?: string
  source: string
  datetime: number
  symbol?: string
}
export interface NewsResult {
  articles: NewsArticle[]
  errors: Record<string, ApiError>
}
export interface CompanyProfile {
  name: string
  ticker: string
  currency?: string
  exchange?: string
  logo?: string
  weburl?: string
  marketCapitalization?: number
  finnhubIndustry?: string
  country?: string
  ipo?: string
}
export interface ProfileResult {
  profile: CompanyProfile
  metrics: Record<string, number | string | null>
  metricsError?: ApiError
}
export interface SentimentResult {
  symbol: string
  sources: { source: string; mentions: number; sentimentScore: number | null }[]
}
export interface EndpointMap {
  settings: StockSettings
  state: StockState
  watchlist: StockState
  quotes: QuoteResult
  search: { results: SearchResult[] }
  news: NewsResult
  profile: ProfileResult
  alerts: StockState
  sentiment: SentimentResult
}
export type StockEndpoint = keyof EndpointMap
export type EndpointRequest<K extends StockEndpoint> = z.infer<(typeof requestSchemas)[K]>
