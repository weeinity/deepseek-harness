/** Fixed provider endpoints, bounded responses, shared concurrency, and secret-free failures. */
import { z } from 'zod'
import {
  symbolSchema,
  type StockQuote,
  type QuoteResult,
  type SearchResult,
  type NewsResult,
  type ProfileResult,
  type SentimentResult,
} from '../shared/api.ts'
import type { Credentials, StocksConfig } from './config.ts'
import { StocksError, cancelled, reply } from './errors.ts'

export interface ProviderRuntime {
  fetch: typeof fetch
  now: () => number
  timeout: (callback: () => void, milliseconds: number) => () => void
}
export const defaultRuntime: ProviderRuntime = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  timeout: (callback, delay) => {
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  },
}
const number = z.number().finite()
const quoteSchema = z.object({
  c: number.positive(),
  d: number,
  dp: number,
  h: number.nonnegative(),
  l: number.nonnegative(),
  o: number.nonnegative(),
  pc: number.nonnegative(),
  t: number.int().positive(),
})
const httpUrl = z
  .string()
  .max(4096)
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
const profileSchema = z.object({
  name: z.string().min(1).max(300),
  ticker: symbolSchema,
  currency: z.string().max(32).optional(),
  exchange: z.string().max(200).optional(),
  logo: httpUrl.or(z.literal('')).optional(),
  weburl: httpUrl.or(z.literal('')).optional(),
  marketCapitalization: number.nonnegative().optional(),
  finnhubIndustry: z.string().max(200).optional(),
  country: z.string().max(100).optional(),
  ipo: z.string().max(32).optional(),
})
const searchSchema = z.object({
  result: z
    .array(
      z.object({
        symbol: z.string().max(128),
        description: z.string().max(500),
        displaySymbol: z.string().max(128),
        type: z.string().max(100),
      }),
    )
    .max(10000),
})
const articleSchema = z.object({
  id: number.int().nonnegative(),
  headline: z.string().min(1).max(1000),
  summary: z.string().max(30000),
  url: httpUrl,
  image: httpUrl.or(z.literal('')).optional(),
  source: z.string().max(300),
  datetime: number.int().positive(),
})
const newsSchema = z.array(articleSchema).max(10000)
const metricsSchema = z.object({
  metric: z.record(z.string(), z.union([number, z.string().max(1000), z.null()])),
})

/** Wait for shared work without letting a cancelled reader cancel another reader's request. */
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  cancelled(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(new StocksError('stocks/cancelled', 'The operation was cancelled.'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export class StockProvider {
  private lifetime = new AbortController()
  private active = 0
  private queue: { resume: () => void; reject: (error: Error) => void }[] = []
  private pending = new Map<string, Promise<unknown>>()
  private cache = new Map<string, { expires: number; value?: unknown; error?: StocksError }>()
  private cooldown = { finnhub: 0, sentiment: 0 }
  private keyIndex = 0
  constructor(
    private config: StocksConfig,
    private credentials: Credentials,
    private runtime: ProviderRuntime = defaultRuntime,
  ) {}
  private async acquire(signal: AbortSignal): Promise<() => void> {
    cancelled(signal)
    if (this.active < 2) this.active++
    else {
      if (this.queue.length >= 128)
        throw new StocksError('stocks/busy', 'Market data queue is full. Retry shortly.')
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          resume: () => {
            signal.removeEventListener('abort', abort)
            resolve()
          },
          reject,
        }
        const abort = () => {
          const index = this.queue.indexOf(waiter)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new StocksError('stocks/cancelled', 'The operation was cancelled.'))
        }
        signal.addEventListener('abort', abort, { once: true })
        this.queue.push(waiter)
      })
    }
    return () => {
      const next = this.queue.shift()
      if (next) next.resume()
      else this.active--
    }
  }
  private remember(key: string, entry: { expires: number; value?: unknown; error?: StocksError }): void {
    this.cache.delete(key)
    while (this.cache.size >= this.config.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, entry)
  }
  private request<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
    ttl: number,
    signal: AbortSignal,
    provider: 'finnhub' | 'sentiment' = 'finnhub',
  ): Promise<T> {
    cancelled(signal)
    cancelled(this.lifetime.signal)
    if (provider === 'finnhub' ? !this.credentials.finnhub.length : !this.credentials.sentiment)
      throw new StocksError(
        'stocks/missing-key',
        provider === 'finnhub'
          ? 'Finnhub is not configured. Add a server-side API key and reload the plugin.'
          : 'Sentiment is not configured. Add an Adanos API key and reload the plugin.',
      )
    const url = new URL(
      path,
      provider === 'finnhub' ? 'https://finnhub.io/api/v1/' : 'https://api.adanos.org/',
    )
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const key = url.toString()
    const hit = this.cache.get(key)
    if (hit && hit.expires > this.runtime.now()) {
      if (hit.error) throw hit.error
      return Promise.resolve(schema.parse(hit.value))
    }
    let work = this.pending.get(key)
    if (!work) {
      if (this.pending.size >= 130)
        throw new StocksError('stocks/busy', 'Too many pending market data requests. Retry shortly.')
      work = this.fetchData(url, provider)
        .then((value) => {
          const parsed = schema.safeParse(value)
          if (!parsed.success)
            throw new StocksError(
              'stocks/provider-data',
              'The provider returned unavailable or invalid data for this symbol.',
            )
          this.remember(key, { value: parsed.data, expires: this.runtime.now() + ttl * 1000 })
          return parsed.data
        })
        .catch((error) => {
          const failure =
            error instanceof StocksError
              ? error
              : new StocksError(
                  'stocks/provider',
                  'The market data request failed. Retry after checking the provider connection.',
                )
          if (!this.lifetime.signal.aborted)
            this.remember(key, {
              error: failure,
              expires: this.runtime.now() + this.config.failureCacheSeconds * 1000,
            })
          throw failure
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, work)
    }
    return waitFor(work, signal).then((value) => schema.parse(value))
  }
  private async fetchData(url: URL, provider: 'finnhub' | 'sentiment'): Promise<unknown> {
    const controller = new AbortController()
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal])
    const stopTimer = this.runtime.timeout(() => controller.abort(), this.config.requestTimeoutMs)
    let release: (() => void) | undefined
    try {
      release = await this.acquire(signal)
      cancelled(signal)
      if (this.cooldown[provider] > this.runtime.now())
        throw new StocksError(
          'stocks/rate-limited',
          'The provider is rate-limited. Wait before requesting new data.',
        )
      const headers: Record<string, string> =
        provider === 'finnhub'
          ? {
              'X-Finnhub-Token': this.credentials.finnhub[this.keyIndex++ % this.credentials.finnhub.length]!,
            }
          : { 'X-API-Key': this.credentials.sentiment! }
      const response = await this.runtime.fetch(url, {
        headers,
        signal,
        redirect: 'error',
        cache: 'no-store',
      })
      if (!response.ok) {
        if (response.status === 429) {
          const retry = response.headers.get('retry-after')
          const seconds =
            retry && /^\d+$/.test(retry)
              ? Number(retry)
              : retry
                ? Math.max(0, (Date.parse(retry) - this.runtime.now()) / 1000)
                : 0
          this.cooldown[provider] =
            this.runtime.now() +
            Math.max(
              this.config.failureCacheSeconds,
              Number.isFinite(seconds) ? Math.min(seconds, 86400) : 0,
            ) *
              1000
        }
        await response.body?.cancel()
        throw new StocksError(
          response.status === 429 ? 'stocks/rate-limited' : 'stocks/provider',
          response.status === 429
            ? 'The provider is rate-limited. Wait before requesting new data.'
            : 'The provider denied or failed this request. Verify the API key and plan coverage.',
        )
      }
      const reader = response.body?.getReader()
      if (!reader) throw new StocksError('stocks/provider-data', 'The provider returned an empty response.')
      let bytes = 0
      const chunks: Uint8Array[] = []
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > this.config.maxResponseBytes) {
            await reader.cancel()
            throw new StocksError(
              'stocks/provider-data',
              'The provider response exceeded the configured size limit.',
            )
          }
          chunks.push(value)
        }
      } finally {
        reader.releaseLock()
      }
      cancelled(signal)
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        throw new StocksError('stocks/provider-data', 'The provider returned invalid JSON.')
      }
    } catch (error) {
      if (this.lifetime.signal.aborted) throw new StocksError('stocks/cancelled', 'The plugin was unloaded.')
      if (controller.signal.aborted)
        throw new StocksError('stocks/timeout', 'Market data timed out. Retry shortly.')
      throw error
    } finally {
      stopTimer()
      release?.()
    }
  }
  async quote(symbol: string, signal: AbortSignal): Promise<StockQuote> {
    const normalized = symbolSchema.parse(symbol)
    // TradingView US exchange prefixes map to Finnhub tickers; other exchanges retain their explicit identity.
    const providerSymbol = normalized.replace(/^(NASDAQ|NYSE|AMEX|NYSEARCA):/, '')
    const value = await this.request(
      'quote',
      { symbol: providerSymbol },
      quoteSchema,
      this.config.quoteRefreshSeconds,
      signal,
    )
    return {
      symbol: normalized,
      price: value.c,
      change: value.d,
      changePercent: value.dp,
      high: value.h,
      low: value.l,
      open: value.o,
      previousClose: value.pc,
      timestamp: value.t,
    }
  }
  async quotes(symbols: string[], signal: AbortSignal): Promise<QuoteResult> {
    return {
      quotes: Object.fromEntries(
        await Promise.all(
          [...new Set(symbols)].map(async (symbol) => [
            symbol,
            await reply(() => this.quote(symbol, signal)),
          ]),
        ),
      ),
    }
  }
  async search(query: string, signal: AbortSignal): Promise<{ results: SearchResult[] }> {
    if (!query) return { results: [] }
    const value = await this.request(
      'search',
      { q: query },
      searchSchema,
      this.config.metadataCacheSeconds,
      signal,
    )
    const results: SearchResult[] = []
    for (const item of value.result) {
      const symbol = symbolSchema.safeParse(item.symbol)
      if (symbol.success && !results.some((other) => other.symbol === symbol.data))
        results.push({
          symbol: symbol.data,
          name: item.description,
          displaySymbol: item.displaySymbol,
          type: item.type,
        })
      if (results.length >= 30) break
    }
    return { results }
  }
  async news(symbols: string[], signal: AbortSignal): Promise<NewsResult> {
    const now = this.runtime.now()
    const to = new Date(now).toISOString().slice(0, 10)
    const from = new Date(now - 5 * 86400000).toISOString().slice(0, 10)
    const entries = await Promise.all(
      (symbols.length ? [...new Set(symbols)] : ['']).map(async (symbol) => ({
        symbol,
        result: await reply(() =>
          this.request(
            symbol ? 'company-news' : 'news',
            symbol
              ? { symbol: symbol.replace(/^(NASDAQ|NYSE|AMEX|NYSEARCA):/, ''), from, to }
              : { category: 'general' },
            newsSchema,
            this.config.newsCacheSeconds,
            signal,
          ),
        ),
      })),
    )
    const articles: NewsResult['articles'] = [],
      errors: NewsResult['errors'] = {}
    for (const { symbol, result } of entries) {
      if (!result.ok) {
        errors[symbol || 'general'] = result.error
        continue
      }
      for (const article of result.value)
        if (!articles.some((existing) => existing.url === article.url))
          articles.push({ ...article, ...(symbol ? { symbol } : {}) })
    }
    return { articles: articles.sort((a, b) => b.datetime - a.datetime).slice(0, 60), errors }
  }
  async profile(symbol: string, signal: AbortSignal): Promise<ProfileResult> {
    const ticker = symbol.replace(/^(NASDAQ|NYSE|AMEX|NYSEARCA):/, '')
    const [profile, metrics] = await Promise.all([
      this.request(
        'stock/profile2',
        { symbol: ticker },
        profileSchema,
        this.config.metadataCacheSeconds,
        signal,
      ),
      reply(() =>
        this.request(
          'stock/metric',
          { symbol: ticker, metric: 'all' },
          metricsSchema,
          this.config.metadataCacheSeconds,
          signal,
        ),
      ),
    ])
    return {
      profile,
      metrics: metrics.ok ? metrics.value.metric : {},
      ...(!metrics.ok ? { metricsError: metrics.error } : {}),
    }
  }
  async sentiment(symbol: string, signal: AbortSignal): Promise<SentimentResult> {
    const schema = z.object({
      stocks: z.array(
        z.object({
          ticker: symbolSchema,
          mentions: number.nonnegative(),
          bullish_pct: number.min(0).max(100).nullable().optional(),
        }),
      ),
    })
    const payload = await this.request(
      'reddit/stocks/v1/compare',
      { tickers: symbol.replace(/^(NASDAQ|NYSE|AMEX|NYSEARCA):/, ''), days: '7' },
      schema,
      this.config.newsCacheSeconds,
      signal,
      'sentiment',
    )
    const row = payload.stocks.find(
      (item) => item.ticker === symbol.replace(/^(NASDAQ|NYSE|AMEX|NYSEARCA):/, ''),
    )
    if (!row)
      throw new StocksError('stocks/provider-data', 'No Reddit sentiment is available for this symbol.')
    return {
      symbol,
      sources: [{ source: 'reddit', mentions: row.mentions, sentimentScore: row.bullish_pct ?? null }],
    }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.pending.values()])
    this.cache.clear()
  }
}
