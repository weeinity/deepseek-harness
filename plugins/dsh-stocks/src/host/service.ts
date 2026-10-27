/** Backend operations and one-shot in-app price alerts; no email delivery. */
import { randomUUID } from 'node:crypto'
import {
  requestSchemas,
  type StockEndpoint,
  type ApiReply,
  type StockSettings,
  type EndpointMap,
} from '../shared/api.ts'
import { Config, loadCredentials, type StocksConfig, type Credentials } from './config.ts'
import { StockProvider, defaultRuntime, type ProviderRuntime } from './provider.ts'
import { StockStorage } from './storage.ts'
import { StocksError, cancelled, reply, safeError } from './errors.ts'

export class StocksBackend {
  readonly storage: StockStorage
  readonly provider: StockProvider
  private lifetime = new AbortController()
  private requests = new Set<Promise<unknown>>()
  private checking: Promise<void> | undefined
  private settings: StockSettings
  constructor(
    readonly config: StocksConfig,
    credentials: Credentials,
    private runtime: ProviderRuntime = defaultRuntime,
  ) {
    this.storage = new StockStorage(config.statePath)
    this.provider = new StockProvider(config, credentials, runtime)
    this.settings = {
      hasFinnhub: credentials.finnhub.length > 0,
      hasSentiment: Boolean(credentials.sentiment),
      quoteRefreshSeconds: config.quoteRefreshSeconds,
      alertCheckSeconds: config.alertCheckSeconds,
      maxTabs: 12,
      maxWatchlist: 100,
    }
  }
  handle<K extends StockEndpoint>(
    endpoint: K,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<ApiReply<EndpointMap[K]>>
  handle(
    endpoint: StockEndpoint,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<ApiReply<EndpointMap[StockEndpoint]>> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    const work = reply(async (): Promise<EndpointMap[StockEndpoint]> => {
      cancelled(combined)
      switch (endpoint) {
        case 'settings':
          requestSchemas.settings.parse(payload)
          return { ...this.settings }
        case 'state':
          requestSchemas.state.parse(payload)
          return this.storage.read()
        case 'watchlist': {
          const request = requestSchemas.watchlist.parse(payload)
          return this.storage.mutate(
            request.revision,
            (state) => {
              const index = state.watchlist.findIndex((item) => item.symbol === request.symbol)
              if (request.add) {
                if (index >= 0) {
                  if (!request.name || state.watchlist[index]!.name === request.name) return false
                  state.watchlist[index]!.name = request.name
                } else {
                  if (state.watchlist.length >= 100)
                    throw new StocksError(
                      'stocks/limit',
                      'Watchlist is limited to 100 symbols. Remove one before adding another.',
                    )
                  state.watchlist.push({ symbol: request.symbol, name: request.name || request.symbol })
                }
              } else {
                if (index < 0) return false
                state.watchlist.splice(index, 1)
              }
              return true
            },
            combined,
          )
        }
        case 'alerts': {
          const request = requestSchemas.alerts.parse(payload)
          return this.storage.mutate(
            request.revision,
            (state) => {
              if (request.action === 'remove') {
                const index = state.alerts.findIndex((item) => item.id === request.id)
                if (index < 0) return false
                state.alerts.splice(index, 1)
              } else {
                if (state.alerts.length >= 100)
                  throw new StocksError(
                    'stocks/limit',
                    'Alerts are limited to 100. Remove one before adding another.',
                  )
                state.alerts.push({
                  id: randomUUID(),
                  symbol: request.symbol,
                  direction: request.direction,
                  price: request.price,
                  createdAt: new Date(this.runtime.now()).toISOString(),
                })
              }
              return true
            },
            combined,
          )
        }
        case 'quotes':
          return this.provider.quotes(requestSchemas.quotes.parse(payload).symbols, combined)
        case 'search':
          return this.provider.search(requestSchemas.search.parse(payload).query, combined)
        case 'news':
          return this.provider.news(requestSchemas.news.parse(payload).symbols, combined)
        case 'profile':
          return this.provider.profile(requestSchemas.profile.parse(payload).symbol, combined)
        case 'sentiment':
          return this.provider.sentiment(requestSchemas.sentiment.parse(payload).symbol, combined)
      }
    })
    this.requests.add(work)
    void work.then(
      () => this.requests.delete(work),
      () => this.requests.delete(work),
    )
    return work
  }
  /** Coalesce timer ticks; publish trigger state only after its atomic storage write. */
  checkAlerts(): Promise<void> {
    if (this.checking) return this.checking
    if (this.lifetime.signal.aborted) return Promise.resolve()
    const work = this.runAlertCheck()
      .catch((error) => {
        if (!this.lifetime.signal.aborted) this.settings.alertCheckError = safeError(error)
      })
      .finally(() => {
        this.checking = undefined
      })
    this.checking = work
    return work
  }
  private async runAlertCheck(): Promise<void> {
    const signal = this.lifetime.signal
    cancelled(signal)
    const state = await this.storage.read()
    const active = state.alerts.filter((alert) => !alert.triggeredAt)
    const quotes = await this.provider.quotes([...new Set(active.map((alert) => alert.symbol))], signal)
    cancelled(signal)
    const failure = Object.values(quotes.quotes).find((result) => !result.ok)
    if (failure && !failure.ok) this.settings.alertCheckError = failure.error
    else delete this.settings.alertCheckError
    const now = new Date(this.runtime.now()).toISOString()
    const checked = new Set(active.map((alert) => alert.id))
    await this.storage.mutate(
      undefined,
      (current) => {
        let changed = false
        for (const alert of current.alerts) {
          if (alert.triggeredAt || !checked.has(alert.id)) continue
          const quote = quotes.quotes[alert.symbol]
          if (!quote?.ok) continue
          const price = quote.value.price
          // A delayed cached trade may be displayed but must not trigger an alert.
          if (
            this.runtime.now() - quote.value.timestamp * 1000 > this.config.alertCheckSeconds * 1000 ||
            quote.value.timestamp * 1000 > this.runtime.now() + 60000
          ) {
            this.settings.alertCheckError = {
              code: 'stocks/stale-quote',
              message:
                'Some alert prices are stale or have invalid timestamps. Those alerts were not evaluated; wait for a fresh provider quote.',
            }
            continue
          }
          if (alert.lastPrice !== price) {
            alert.lastPrice = price
            changed = true
          }
          if (alert.direction === 'above' ? price >= alert.price : price <= alert.price) {
            alert.triggeredAt = now
            changed = true
          }
        }
        return changed
      },
      signal,
    )
    this.settings.lastAlertCheckAt = now
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await this.provider.dispose()
    await Promise.allSettled([...this.requests, ...(this.checking ? [this.checking] : [])])
    await this.storage.dispose()
  }
}

/** Resolve deployment input without making provider requests. */
export async function createBackend(
  input: unknown,
  runtime = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StocksBackend> {
  const config = Config.parse(input)
  return new StocksBackend(config, await loadCredentials(config, env), runtime)
}
