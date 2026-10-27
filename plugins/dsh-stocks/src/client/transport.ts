/** Validate external JSON before admitting it to the UI. */
import { z } from 'zod'
import {
  stockStateSchema,
  symbolSchema,
  type EndpointMap,
  type EndpointRequest,
  type StockEndpoint,
} from '../shared/api.ts'
const error = z.object({ code: z.string(), message: z.string() })
const quote = z.object({
  symbol: symbolSchema,
  price: z.number().finite(),
  change: z.number().finite(),
  changePercent: z.number().finite(),
  high: z.number(),
  low: z.number(),
  open: z.number(),
  previousClose: z.number(),
  timestamp: z.number(),
})
const safeUrl = z
  .string()
  .url()
  .refine((s) => /^https?:/.test(s))
const schemas = {
  state: stockStateSchema,
  watchlist: stockStateSchema,
  alerts: stockStateSchema,
  settings: z.object({
    hasFinnhub: z.boolean(),
    hasSentiment: z.boolean(),
    quoteRefreshSeconds: z.number().positive(),
    alertCheckSeconds: z.number().positive(),
    maxTabs: z.literal(12),
    maxWatchlist: z.literal(100),
    alertCheckError: error.optional(),
    lastAlertCheckAt: z.string().optional(),
  }),
  quotes: z.object({
    quotes: z.record(
      z.string(),
      z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), value: quote }),
        z.object({ ok: z.literal(false), error }),
      ]),
    ),
  }),
  search: z.object({
    results: z.array(
      z.object({ symbol: symbolSchema, name: z.string(), displaySymbol: z.string(), type: z.string() }),
    ),
  }),
  news: z.object({
    articles: z.array(
      z.object({
        id: z.number(),
        headline: z.string(),
        summary: z.string(),
        url: safeUrl,
        image: z.string().optional(),
        source: z.string(),
        datetime: z.number(),
        symbol: z.string().optional(),
      }),
    ),
    errors: z.record(z.string(), error),
  }),
  profile: z.object({
    profile: z.object({
      name: z.string(),
      ticker: z.string(),
      currency: z.string().optional(),
      exchange: z.string().optional(),
      logo: z.string().optional(),
      weburl: z.string().optional(),
      marketCapitalization: z.number().optional(),
      finnhubIndustry: z.string().optional(),
      country: z.string().optional(),
      ipo: z.string().optional(),
    }),
    metrics: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
    metricsError: error.optional(),
  }),
  sentiment: z.object({
    symbol: symbolSchema,
    sources: z.array(
      z.object({ source: z.string(), mentions: z.number(), sentimentScore: z.number().nullable() }),
    ),
  }),
}
export class ApiFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export async function request<K extends StockEndpoint>(
  endpoint: K,
  input: EndpointRequest<K>,
  signal?: AbortSignal,
): Promise<EndpointMap[K]> {
  const response = await fetch('/api/dsh-stocks/' + endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const json: unknown = await response.json()
  const failure = z.object({ ok: z.literal(false), error }).safeParse(json)
  if (failure.success) throw new ApiFailure(failure.data.error.code)
  if (!response.ok) throw new ApiFailure('stocks/http')
  const envelope = z.object({ ok: z.literal(true), value: z.unknown() }).parse(json)
  return schemas[endpoint].parse(envelope.value) as EndpointMap[K]
}
