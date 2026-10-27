/** OpenStock-inspired main panel; provider failures never fabricate market values. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  Input,
  Modal,
  Pill,
  Tooltip,
  StateDot,
  IconPlusOutlineRegular,
  IconCloseOutlineRegular,
  IconSearchOutlineRegular,
  IconAlarmClockOutlineRegular,
  IconTrashOutlineRegular,
  IconPinOutlineRegular,
  IconPinFillRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  symbolSchema,
  type EndpointMap,
  type EndpointRequest,
  type StockEndpoint,
  type StockState,
  type StockSettings,
  type QuoteResult,
  type StockQuote,
  type PriceAlert,
  type SearchResult,
} from '../shared/api.ts'
import type { StocksProps } from './contract.ts'
import type { Text, TextKey } from './locale.ts'
import { MARKETS, getMarket, isMarketOpen, type Market } from './markets.ts'
import { formatSymbolForTradingView, isChartEmbeddable, tradingViewSymbolUrl } from './symbols.ts'
import * as widgets from './widgets.ts'
import { Widget, type WidgetTheme } from './Widget.tsx'
import { request, ApiFailure } from './transport.ts'
import css from './Stocks.module.css'

/** A mounted query owns its cancellation and discards superseded results. */
function useQuery<K extends StockEndpoint>(
  endpoint: K,
  input: EndpointRequest<K>,
  enabled = true,
  refresh = 0,
) {
  const [value, setValue] = useState<EndpointMap[K] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const serialized = JSON.stringify(input)
  const previousQuery = useRef('')
  useEffect(() => {
    if (!enabled) {
      setValue(null)
      setBusy(false)
      setError(null)
      return
    }
    const controller = new AbortController()
    const identity = endpoint + serialized
    if (previousQuery.current !== identity) {
      setValue(null)
      previousQuery.current = identity
    }
    setBusy(true)
    setError(null)
    void request(endpoint, JSON.parse(serialized), controller.signal)
      .then(
        (result) => {
          if (!controller.signal.aborted) setValue(result)
        },
        (failure) => {
          if (!controller.signal.aborted)
            setError(failure instanceof ApiFailure ? failure.code : 'stocks/network')
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [endpoint, serialized, enabled, refresh])
  return { value, error, busy }
}
function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className={css.panel}>
      <header className={css.panelHead}>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </header>
      <div className={css.panelBody}>{children}</div>
    </section>
  )
}
function ErrorNotice({ t, retry, code }: { t: Text; retry?: () => void; code?: string | null }) {
  return (
    <div className={css.notice} role="alert">
      <span>
        {t(
          code === 'stocks/missing-key'
            ? 'missingKey'
            : code === 'stocks/conflict'
              ? 'conflict'
              : code?.startsWith('stocks/storage-')
                ? 'stateRecovery'
                : 'readError',
        )}
      </span>
      {retry && (
        <Button size="sm" onClick={retry}>
          {t('retry')}
        </Button>
      )}
    </div>
  )
}
function Busy({ t }: { t: Text }) {
  return (
    <div className={css.busy} role="status" aria-label={t('loading')}>
      <StateDot state="ongoing" />
    </div>
  )
}
function price(value: number | undefined, currency = 'USD') {
  if (value === undefined) return '—'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: value < 1 ? 4 : 2,
    }).format(value)
  } catch (error) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
}
function change(value: number | undefined) {
  return value === undefined ? '—' : (value > 0 ? '+' : '') + value.toFixed(2) + '%'
}
function Quote({ quote, t }: { quote?: StockQuote; t: Text }) {
  return (
    <>
      <strong className={css.price}>{price(quote?.price)}</strong>
      <span className={quote && quote.changePercent >= 0 ? css.up : css.down}>
        {quote ? change(quote.changePercent) : t('unavailable')}
      </span>
      {quote && <small>{t('asOf', { time: new Date(quote.timestamp * 1000).toLocaleString() })}</small>}
    </>
  )
}
function quoteFor(result: QuoteResult | null, symbol: string) {
  const q = result?.quotes[symbol]
  return q?.ok ? q.value : undefined
}
function localResults(): SearchResult[] {
  const all = [
    ...widgets.POPULAR_STOCKS.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      displaySymbol: s.symbol,
      type: s.exchange,
    })),
    ...MARKETS.flatMap((m) =>
      m.groups.flatMap((g) =>
        g.symbols.map(([symbol, name]) => ({ symbol, name, displaySymbol: symbol, type: m.name })),
      ),
    ),
  ]
  return [...new Map(all.map((s) => [s.symbol, s])).values()]
}
function Search({
  t,
  open,
  close,
  onOpen,
  onTrack,
  watched,
  busy,
  hasFinnhub,
}: {
  t: Text
  open: boolean
  close: () => void
  onOpen: (symbol: string) => void
  onTrack: (symbol: string, name: string) => void
  watched: string[]
  busy: boolean
  hasFinnhub: boolean
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [invalid, setInvalid] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  const remote = useQuery('search', { query: debounced }, open && hasFinnhub && !!debounced)
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const local = localResults().filter(
      (s) => !q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
    )
    return [
      ...new Map([...local, ...(remote.value?.results ?? [])].map((s) => [s.symbol, s])).values(),
    ].slice(0, 30)
  }, [query, remote.value])
  const direct = () => {
    const s = symbolSchema.safeParse(query)
    if (!s.success) {
      setInvalid(true)
      return
    }
    onOpen(s.data)
    close()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      title={t('search')}
      closeLabel={t('close')}
      description={t('searchSub')}
      className={css.searchModal}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          direct()
        }}
        className={css.searchLine}
      >
        <Input
          data-modal-autofocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setInvalid(false)
          }}
          placeholder={t('searchHint')}
          aria-label={t('search')}
        />
        <Button type="submit" disabled={!query.trim()}>
          {t('more')}
        </Button>
      </form>
      {invalid && <p role="alert">{t('invalidSymbol')}</p>}
      {remote.error && <p className={css.muted}>{t('providerLimit')}</p>}
      <div className={css.results}>
        {results.map((s) => (
          <div className={css.result} key={s.symbol}>
            <button
              onClick={() => {
                onOpen(s.symbol)
                close()
              }}
            >
              <strong>{s.symbol}</strong>
              <span>{s.name}</span>
              <small>{s.type}</small>
            </button>
            <Tooltip label={t(watched.includes(s.symbol) ? 'untrack' : 'track')} portal>
              <button
                className={css.icon}
                disabled={busy}
                aria-label={t(watched.includes(s.symbol) ? 'untrack' : 'track') + ' ' + s.symbol}
                onClick={() => onTrack(s.symbol, s.name)}
              >
                {watched.includes(s.symbol) ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
              </button>
            </Tooltip>
          </div>
        ))}
        {!results.length && !remote.busy && <p className={css.empty}>{t('noResults')}</p>}
        {remote.busy && <Busy t={t} />}
      </div>
    </Modal>
  )
}
function localizedGroups(market: Market, t: Text) {
  return market.groups.map((group) => ({ ...group, title: t(('group_' + group.title) as TextKey) }))
}
function Overview({
  market,
  t,
  theme,
  settings,
  open,
  quotes,
}: {
  market: Market
  t: Text
  theme: WidgetTheme
  settings: StockSettings | null
  open: (symbol: string) => void
  quotes: QuoteResult | null
}) {
  const groups = localizedGroups(market, t)
  return (
    <>
      <Panel
        title={t('pulse')}
        sub={
          settings?.hasFinnhub ? t('nativeFeed', { seconds: settings.quoteRefreshSeconds }) : t('widgetFeed')
        }
      >
        <div className={css.pulse}>
          {market.pulse.map((p) => (
            <article key={p.symbol} className={css.pulseTile}>
              <button onClick={() => open(p.finnhub ?? p.symbol)} className={css.tileTitle}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M3 3v16a2 2 0 0 0 2 2h16" />
                  <path d="m7 15 4-4 3 3 5-6" />
                </svg>
                <span>{p.label}</span>
                <small>{p.finnhub ?? p.symbol}</small>
              </button>
              {p.finnhub && settings?.hasFinnhub ? (
                <div className={css.quote}>
                  <Quote quote={quoteFor(quotes, p.finnhub)} t={t} />
                </div>
              ) : (
                <Widget
                  title={p.label}
                  script="single-quote"
                  config={widgets.singleQuoteConfig(p.symbol)}
                  height={126}
                  theme={theme}
                  t={t}
                />
              )}
            </article>
          ))}
        </div>
      </Panel>
      <div className={css.overviewGrid}>
        <Panel title={t('leaders')} sub={t('leadersSub')}>
          <Widget
            script="market-overview"
            config={widgets.marketOverviewConfig(groups)}
            height={560}
            title={t('leaders')}
            theme={theme}
            t={t}
          />
          <div className={css.symbolChips}>
            {market.groups
              .flatMap((g) => g.symbols)
              .slice(0, 6)
              .map(([s]) => (
                <Pill key={s} onClick={() => open(s)}>
                  {s.split(':').at(-1)}
                </Pill>
              ))}
          </div>
        </Panel>
        <Panel
          title={market.heatmap ? t(market.heatmap === 'stocks' ? 'heatmap' : 'cryptoHeatmap') : t('quotes')}
          sub={market.heatmap ? t('heatmapSub') : t('widgetFeed')}
        >
          <Widget
            script={
              market.heatmap
                ? market.heatmap === 'stocks'
                  ? 'stock-heatmap'
                  : 'crypto-coins-heatmap'
                : 'market-quotes'
            }
            config={
              market.heatmap
                ? market.heatmap === 'stocks'
                  ? widgets.STOCK_HEATMAP_CONFIG
                  : widgets.CRYPTO_HEATMAP_CONFIG
                : widgets.marketQuotesConfig(groups)
            }
            title={t('quotes')}
            height={606}
            theme={theme}
            t={t}
            expand
          />
        </Panel>
      </div>
      <div className={css.newsGrid}>
        <Panel title={t('quotes')} sub={t('widgetFeed')}>
          <Widget
            script="market-quotes"
            config={widgets.marketQuotesConfig(groups)}
            title={t('quotes')}
            height={480}
            theme={theme}
            t={t}
          />
        </Panel>
        <Panel title={t('stories')} sub={t('storiesSub')}>
          <Widget
            script="timeline"
            config={widgets.timelineConfig(market.news)}
            title={t('stories')}
            height={480}
            theme={theme}
            t={t}
          />
        </Panel>
      </div>
    </>
  )
}
function AlertForm({
  symbol,
  t,
  close,
  save,
  busy,
}: {
  symbol: string
  t: Text
  close: () => void
  save: (direction: 'above' | 'below', value: number) => Promise<boolean>
  busy: boolean
}) {
  const [value, setValue] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [error, setError] = useState(false)
  return (
    <Modal
      open
      onClose={close}
      title={t('alert') + ' · ' + symbol}
      closeLabel={t('close')}
      description={t('alertHint')}
    >
      <form
        className={css.alertForm}
        onSubmit={(e) => {
          e.preventDefault()
          const n = Number(value)
          if (!Number.isFinite(n) || n <= 0) {
            setError(true)
            return
          }
          void save(direction, n).then((ok) => {
            if (ok) close()
          })
        }}
      >
        <div className={css.symbolChips}>
          {(['above', 'below'] as const).map((d) => (
            <Pill key={d} active={direction === d} onClick={() => setDirection(d)}>
              {t(d)}
            </Pill>
          ))}
        </div>
        <label>
          {t('threshold')}
          <Input
            data-modal-autofocus
            type="number"
            min="0.00000001"
            step="any"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{t('invalidPrice')}</p>}
        <Button type="submit" disabled={busy}>
          {t('create')}
        </Button>
      </form>
    </Modal>
  )
}
function News({
  symbols,
  t,
  settings,
  refresh,
  theme,
}: {
  symbols: string[]
  t: Text
  settings: StockSettings | null
  refresh: number
  theme: WidgetTheme
}) {
  const news = useQuery('news', { symbols: symbols.slice(0, 12) }, !!settings?.hasFinnhub, refresh)
  if (!settings?.hasFinnhub)
    return (
      <Widget
        script="timeline"
        title={t('news')}
        config={
          symbols.length === 1
            ? {
                ...widgets.timelineConfig('stock'),
                feedMode: 'symbol',
                symbol: formatSymbolForTradingView(symbols[0]),
              }
            : widgets.timelineConfig('stock')
        }
        height={460}
        theme={theme}
        t={t}
      />
    )
  return (
    <>
      {news.busy && <Busy t={t} />} {news.error && <ErrorNotice t={t} code={news.error} />}{' '}
      {!!news.value && Object.keys(news.value.errors).length > 0 && (
        <p className={css.notice}>{t('partialNews')}</p>
      )}{' '}
      {news.value?.articles.map((n) => (
        <a
          key={n.id + ':' + n.url}
          className={css.newsItem}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <small>
            {n.source} · {new Date(n.datetime * 1000).toLocaleString()}
          </small>
          <strong>{n.headline}</strong>
          <p>{n.summary}</p>
        </a>
      ))}
      {news.value && !news.value.articles.length && <p className={css.empty}>{t('noNews')}</p>}
    </>
  )
}
function Watchlist({
  state,
  settings,
  t,
  theme,
  quotes,
  busy,
  open,
  track,
  alert,
  removeAlert,
  search,
  refresh,
}: {
  state: StockState | null
  settings: StockSettings | null
  t: Text
  theme: WidgetTheme
  quotes: QuoteResult | null
  busy: boolean
  open: (s: string) => void
  track: (s: string, name: string) => void
  alert: (s: string) => void
  removeAlert: (id: string) => void
  search: () => void
  refresh: number
}) {
  const [sort, setSort] = useState<'symbol' | 'price' | 'change'>('symbol')
  const [ascending, setAscending] = useState(true)
  const rows = [...(state?.watchlist ?? [])].sort((a, b) => {
    const qa = quoteFor(quotes, a.symbol),
      qb = quoteFor(quotes, b.symbol)
    const cmp =
      sort === 'symbol'
        ? a.symbol.localeCompare(b.symbol)
        : sort === 'price'
          ? (qa?.price ?? -Infinity) - (qb?.price ?? -Infinity)
          : (qa?.changePercent ?? -Infinity) - (qb?.changePercent ?? -Infinity)
    return ascending ? cmp : -cmp
  })
  const sorting = (next: typeof sort) => {
    setAscending(sort === next ? !ascending : true)
    setSort(next)
  }
  return (
    <div className={css.detailGrid}>
      <div className={css.stack}>
        <Panel title={t('symbols')} sub={t('symbolsSub')}>
          {!rows.length ? (
            <div className={css.empty}>
              <IconPinOutlineRegular size={28} />
              <h3>{t('empty')}</h3>
              <p>{t('emptySub')}</p>
              <Button onClick={search}>{t('add')}</Button>
              <div className={css.symbolChips}>
                {['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN'].map((s) => (
                  <Pill key={s} onClick={() => open(s)}>
                    {s}
                  </Pill>
                ))}
              </div>
            </div>
          ) : (
            <div className={css.tableScroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    {(['symbol', 'price', 'change'] as const).map((k) => (
                      <th key={k} aria-sort={sort === k ? (ascending ? 'ascending' : 'descending') : 'none'}>
                        <button onClick={() => sorting(k)}>
                          {t(k === 'symbol' ? 'company' : k === 'change' ? 'today' : 'price')}{' '}
                          {sort === k ? (ascending ? '↑' : '↓') : ''}
                        </button>
                      </th>
                    ))}
                    <th>{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const q = quoteFor(quotes, row.symbol)
                    return (
                      <tr key={row.symbol}>
                        <td>
                          <button className={css.company} onClick={() => open(row.symbol)}>
                            <span className={css.logo}>{row.symbol[0]}</span>
                            <span>
                              <strong>{row.name}</strong>
                              <small>{row.symbol}</small>
                            </span>
                          </button>
                        </td>
                        <td>{price(q?.price)}</td>
                        <td className={q && q.changePercent >= 0 ? css.up : css.down}>
                          {change(q?.changePercent)}
                        </td>
                        <td>
                          <div className={css.rowActions}>
                            <Tooltip label={t('alert')} portal>
                              <button
                                disabled={busy || !settings?.hasFinnhub}
                                className={css.icon}
                                aria-label={t('alert') + ' ' + row.symbol}
                                onClick={() => alert(row.symbol)}
                              >
                                <IconAlarmClockOutlineRegular />
                              </button>
                            </Tooltip>
                            <Tooltip label={t('untrack')} portal>
                              <button
                                disabled={busy}
                                className={css.icon}
                                aria-label={t('untrack') + ' ' + row.symbol}
                                onClick={() => track(row.symbol, row.name)}
                              >
                                <IconTrashOutlineRegular />
                              </button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!settings?.hasFinnhub && rows.length > 0 && (
            <Widget
              script="market-quotes"
              config={widgets.marketQuotesConfig([
                {
                  title: t('watchlist'),
                  symbols: rows.map((s) => [formatSymbolForTradingView(s.symbol), s.name]),
                },
              ])}
              title={t('watchlist')}
              height={Math.min(600, 100 + rows.length * 65)}
              theme={theme}
              t={t}
            />
          )}
        </Panel>
        <Panel title={t('news')} sub={t('newsSub')}>
          <News
            symbols={rows.map((s) => s.symbol)}
            t={t}
            settings={settings}
            refresh={refresh}
            theme={theme}
          />
        </Panel>
      </div>
      <Panel title={t('alerts')} sub={t('alertsSub')}>
        <p className={css.notice}>{t('alertHint')}</p>
        {!settings?.hasFinnhub && <p className={css.notice}>{t('missingKey')}</p>}
        {settings?.alertCheckError && (
          <p className={css.notice} role="alert">
            {t('alertCheckError')}
          </p>
        )}
        {!state?.alerts.length && <p className={css.empty}>{t('noAlerts')}</p>}
        {state?.alerts.map((a) => (
          <div key={a.id} className={css.alertRow}>
            <button onClick={() => open(a.symbol)}>
              <strong>{a.symbol}</strong>
              <span>
                {t(a.direction)} {price(a.price)}
              </span>
              <small>
                {t(a.triggeredAt ? 'triggered' : 'active')}
                {a.triggeredAt ? ' · ' + new Date(a.triggeredAt).toLocaleString() : ''}
              </small>
            </button>
            <Tooltip label={t('remove')} portal>
              <button
                className={css.icon}
                disabled={busy}
                aria-label={t('remove') + ' ' + a.symbol}
                onClick={() => removeAlert(a.id)}
              >
                <IconTrashOutlineRegular />
              </button>
            </Tooltip>
          </div>
        ))}
      </Panel>
    </div>
  )
}
function Details({
  symbol,
  t,
  theme,
  settings,
  refresh,
  quotes,
  watched,
  track,
  busy,
  alert,
}: {
  symbol: string
  t: Text
  theme: WidgetTheme
  settings: StockSettings | null
  refresh: number
  quotes: QuoteResult | null
  watched: boolean
  track: (s: string, name: string) => void
  busy: boolean
  alert: () => void
}) {
  const profile = useQuery('profile', { symbol }, !!settings?.hasFinnhub, refresh)
  const sentiment = useQuery('sentiment', { symbol }, !!settings?.hasSentiment, refresh)
  const tv = formatSymbolForTradingView(symbol)
  const name = profile.value?.profile.name ?? localResults().find((s) => s.symbol === symbol)?.name ?? symbol
  const q = quoteFor(quotes, symbol)
  return (
    <>
      <header className={css.stockHead}>
        <div>
          <h1>{symbol}</h1>
          <p>{name}</p>
        </div>
        <div className={css.headActions}>
          <Button disabled={busy} onClick={() => track(symbol, name)}>
            {watched ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
            {t(watched ? 'untrack' : 'track')}
          </Button>
          <Button variant="outline" disabled={!settings?.hasFinnhub || busy} onClick={alert}>
            {t('alert')}
          </Button>
        </div>
      </header>
      {settings?.hasFinnhub ? (
        <div className={css.stockQuote}>
          <Quote quote={q} t={t} />
          {q && (
            <div className={css.stats}>
              <span>
                {t('high')} {price(q.high)}
              </span>
              <span>
                {t('low')} {price(q.low)}
              </span>
              <span>
                {t('previousClose')} {price(q.previousClose)}
              </span>
            </div>
          )}
        </div>
      ) : (
        <Widget
          script="symbol-info"
          config={widgets.symbolInfoConfig(tv)}
          title={symbol}
          height={180}
          theme={theme}
          t={t}
        />
      )}
      <div className={css.detailGrid}>
        <div className={css.stack}>
          <Panel title={t('chart')} sub={t('chartSub')}>
            {isChartEmbeddable(tv) ? (
              <Widget
                script="advanced-chart"
                config={widgets.CANDLE_CHART_WIDGET_CONFIG(tv)}
                title={t('chart') + ' ' + symbol}
                height={560}
                theme={theme}
                t={t}
                expand
              />
            ) : (
              <div className={css.empty}>
                <p>{t('chartBlocked')}</p>
                <a href={tradingViewSymbolUrl(tv)} target="_blank" rel="noopener noreferrer">
                  {t('externalChart')}
                </a>
              </div>
            )}
          </Panel>
          <Panel title={t('financials')} sub={t('financialsSub')}>
            <Widget
              script="financials"
              config={widgets.COMPANY_FINANCIALS_WIDGET_CONFIG(tv)}
              title={t('financials') + ' ' + symbol}
              height={500}
              theme={theme}
              t={t}
            />
          </Panel>
          <Panel title={t('news')} sub={t('newsSub')}>
            <News symbols={[symbol]} settings={settings} refresh={refresh} t={t} theme={theme} />
          </Panel>
        </div>
        <div className={css.stack}>
          <Panel title={t('technicals')} sub={t('technicalsSub')}>
            <Widget
              script="technical-analysis"
              config={widgets.TECHNICAL_ANALYSIS_WIDGET_CONFIG(tv)}
              title={t('technicals') + ' ' + symbol}
              height={410}
              theme={theme}
              t={t}
            />
          </Panel>
          <Panel title={t('profile')} sub={t('profileSub')}>
            <Widget
              script="symbol-profile"
              config={widgets.COMPANY_PROFILE_WIDGET_CONFIG(tv)}
              title={t('profile') + ' ' + symbol}
              height={420}
              theme={theme}
              t={t}
            />
            {profile.value?.profile.marketCapitalization !== undefined && (
              <p className={css.notice}>
                {t('marketCap')}:{' '}
                {new Intl.NumberFormat(undefined, { notation: 'compact' }).format(
                  profile.value.profile.marketCapitalization * 1000000,
                )}
              </p>
            )}
          </Panel>
          <Panel title={t('sentiment')} sub={t('sentimentSub')}>
            {!settings?.hasSentiment ? (
              <p className={css.notice}>{t('missingSentiment')}</p>
            ) : sentiment.busy ? (
              <Busy t={t} />
            ) : sentiment.error ? (
              <ErrorNotice t={t} code={sentiment.error} />
            ) : (
              sentiment.value?.sources.map((s) => (
                <p className={css.notice} key={s.source}>
                  {s.source} · {s.mentions} {t('mentions')} · {t('sentimentScore')}:{' '}
                  {s.sentimentScore === null ? '—' : s.sentimentScore + '%'}
                </p>
              ))
            )}
          </Panel>
        </div>
      </div>
    </>
  )
}

export function Stocks(props: StocksProps) {
  const { t, actions, persist } = props
  const preferences = props.useStore((s) => s)
  const theme = props.usePalette((s) => s)
  const [search, setSearch] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<StockState | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mutationPending = useRef(false)
  const [alert, setAlert] = useState<string | null>(null)
  const [about, setAbout] = useState(false)
  const [sourceError, setSourceError] = useState(false)
  const lifetime = useRef<AbortController | null>(null)
  const settings = useQuery('settings', {}, true, refresh)
  const market = getMarket('us')
  const stock = !['overview', 'watchlist'].includes(preferences.active) ? preferences.active : null
  const refreshAll = () => setRefresh((n) => n + 1)
  useEffect(() => {
    const c = new AbortController()
    lifetime.current = c
    return () => {
      c.abort()
      lifetime.current = null
    }
  }, [])
  useEffect(() => {
    const c = new AbortController()
    setStateError(null)
    void request('state', {}, c.signal).then(
      (value) => {
        if (!c.signal.aborted)
          setState((current) => (!current || value.revision >= current.revision ? value : current))
      },
      (error) => {
        if (!c.signal.aborted) setStateError(error instanceof ApiFailure ? error.code : 'stocks/network')
      },
    )
    return () => c.abort()
  }, [refresh])
  useEffect(() => {
    const { version, tabs, active, market } = preferences
    if (!persist({ version, tabs: [...tabs], active, market })) actions.storageFailed()
  }, [preferences.tabs, preferences.active, preferences.market, persist, actions])
  useEffect(() => {
    if (!settings.value) return
    let pending = false
    const timer = setInterval(
      () => {
        if (document.hidden || pending) return
        pending = true
        setRefresh((n) => n + 1)
        pending = false
      },
      Math.max(15, settings.value.quoteRefreshSeconds) * 1000,
    )
    return () => clearInterval(timer)
  }, [settings.value?.quoteRefreshSeconds])
  const symbolList = stock
    ? [stock]
    : preferences.active === 'watchlist'
      ? (state?.watchlist.map((s) => s.symbol) ?? [])
      : market.pulse.flatMap((p) => (p.finnhub ? [p.finnhub] : []))
  const quotes = useQuery(
    'quotes',
    { symbols: symbolList },
    !!settings.value?.hasFinnhub && symbolList.length > 0,
    refresh,
  )
  const watched = state?.watchlist.map((s) => s.symbol) ?? []
  const mutate = async <K extends 'watchlist' | 'alerts'>(
    endpoint: K,
    payload: EndpointRequest<K>,
    removed = false,
  ) => {
    if (mutationPending.current) return false
    mutationPending.current = true
    setBusy(true)
    const signal = lifetime.current?.signal
    try {
      const value = await request(endpoint, payload, signal)
      if (!signal?.aborted) {
        setState((current) => (!current || value.revision >= current.revision ? value : current))
        actions.notify(removed ? 'removed' : 'saved', true)
      }
      return true
    } catch (error) {
      if (!signal?.aborted)
        actions.notify(
          error instanceof ApiFailure && error.code === 'stocks/conflict' ? 'conflict' : 'mutationError',
          false,
        )
      return false
    } finally {
      mutationPending.current = false
      if (!signal?.aborted) setBusy(false)
    }
  }
  const track = (symbol: string, name: string) => {
    if (!state) return
    const add = !watched.includes(symbol)
    void mutate('watchlist', { symbol, name, add, revision: state.revision }, !add)
  }
  const open = (symbol: string) => actions.open(symbol)
  const tabs = ['overview', 'watchlist', ...preferences.tabs]
  return (
    <div className={css.root} data-stocks-theme={theme}>
      <div className={css.tabbar}>
        <div
          className={css.tabs}
          role="tablist"
          aria-label={t('label')}
          onKeyDown={(e) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
            const target = e.target as HTMLElement
            if (target.getAttribute('role') !== 'tab') return
            e.preventDefault()
            const i = tabs.indexOf(preferences.active)
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? tabs.length - 1
                  : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            actions.select(tabs[next])
            const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')
            buttons[next]?.focus()
          }}
        >
          {tabs.map((tab) => (
            <div className={css.tab} data-active={preferences.active === tab} key={tab}>
              <button
                role="tab"
                aria-selected={preferences.active === tab}
                aria-controls="stocks-page"
                tabIndex={preferences.active === tab ? 0 : -1}
                onClick={() => actions.select(tab)}
              >
                {tab === 'overview' ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  >
                    <rect x="3" y="3" width="7" height="9" rx="1" />
                    <rect x="14" y="3" width="7" height="5" rx="1" />
                    <rect x="14" y="12" width="7" height="9" rx="1" />
                    <rect x="3" y="16" width="7" height="5" rx="1" />
                  </svg>
                ) : tab === 'watchlist' ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  >
                    <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.5L12 17.3l-5.9 3.2 1.3-6.5L2.5 9.4l6.6-.8Z" />
                  </svg>
                ) : null}
                {tab === 'overview' || tab === 'watchlist' ? t(tab) : tab}
              </button>
              {!['overview', 'watchlist'].includes(tab) && (
                <Tooltip label={t('closeTab', { symbol: tab })} portal>
                  <button
                    className={css.closeTab}
                    aria-label={t('closeTab', { symbol: tab })}
                    onClick={() => actions.close(tab)}
                  >
                    <IconCloseOutlineRegular size={12} />
                  </button>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
        <Tooltip label={t('openStock')} portal>
          <button className={css.icon} aria-label={t('openStock')} onClick={() => setSearch(true)}>
            <IconPlusOutlineRegular size={20} />
          </button>
        </Tooltip>
        <div className={css.tabTools}>
          <Tooltip label={t('refresh')} portal>
            <button className={css.icon} aria-label={t('refresh')} onClick={refreshAll}>
              <IconRefreshOutlineRegular />
            </button>
          </Tooltip>
        </div>
      </div>
      <main className={css.content} id="stocks-page" role="tabpanel">
        {preferences.storageError && <p className={css.notice}>{t('storageError')}</p>}
        {settings.error && <ErrorNotice t={t} code={settings.error} retry={refreshAll} />}
        {stateError && <ErrorNotice t={t} code={stateError} retry={refreshAll} />}
        {preferences.active === 'overview' && (
          <>
            <header className={css.pageHead}>
              <div className={css.marketHeading}>
                <h1>{t('markets')}</h1>
                <p>
                  {t('market_us')} · {t(isMarketOpen(market) ? 'open' : 'closed')} · {t('liveData')}
                </p>
              </div>
              <Button variant="outline" onClick={() => setSearch(true)}>
                <IconSearchOutlineRegular />
                {t('search')}
              </Button>
            </header>
            <Overview
              market={market}
              t={t}
              theme={theme}
              settings={settings.value}
              open={open}
              quotes={quotes.value}
            />
          </>
        )}
        {preferences.active === 'watchlist' && (
          <>
            <header className={css.pageHead}>
              <div>
                <h1>{t('watchlist')}</h1>
                <p>
                  {t(watched.length === 1 ? 'savedSymbol' : 'savedSymbols', { count: watched.length })} ·{' '}
                  {settings.value?.hasFinnhub
                    ? t('nativeFeed', { seconds: settings.value.quoteRefreshSeconds })
                    : t('widgetFeed')}
                </p>
              </div>
              <Button onClick={() => setSearch(true)}>
                <IconPlusOutlineRegular />
                {t('add')}
              </Button>
            </header>
            {!state && !stateError ? (
              <Busy t={t} />
            ) : (
              <Watchlist
                state={state}
                settings={settings.value}
                t={t}
                theme={theme}
                quotes={quotes.value}
                busy={busy || !state}
                open={open}
                track={track}
                alert={setAlert}
                removeAlert={(id) => {
                  if (state) void mutate('alerts', { action: 'remove', id, revision: state.revision }, true)
                }}
                search={() => setSearch(true)}
                refresh={refresh}
              />
            )}
          </>
        )}
        {stock && (
          <Details
            key={stock}
            symbol={stock}
            t={t}
            theme={theme}
            settings={settings.value}
            refresh={refresh}
            quotes={quotes.value}
            watched={watched.includes(stock)}
            track={track}
            busy={busy || !state}
            alert={() => setAlert(stock)}
          />
        )}
        <footer className={css.footer}>
          <span>{t('legal')}</span>
          <button onClick={() => setAbout(true)}>{t('about')}</button>
        </footer>
      </main>
      <Search
        key={search ? 'open' : 'closed'}
        t={t}
        open={search}
        close={() => setSearch(false)}
        onOpen={open}
        onTrack={track}
        watched={watched}
        busy={busy || !state}
        hasFinnhub={settings.value?.hasFinnhub ?? false}
      />
      {alert && (
        <AlertForm
          symbol={alert}
          t={t}
          close={() => setAlert(null)}
          busy={busy || !state}
          save={(direction, price) =>
            state
              ? mutate('alerts', { action: 'add', symbol: alert, direction, price, revision: state.revision })
              : Promise.resolve(false)
          }
        />
      )}
      <Modal open={about} onClose={() => setAbout(false)} title={t('about')} closeLabel={t('close')}>
        <p>{t('legal')}</p>
        <p>
          <a href="https://github.com/Open-Dev-Society/OpenStock" target="_blank" rel="noopener noreferrer">
            OpenStock
          </a>{' '}
          ·{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">
            AGPL-3.0
          </a>
        </p>
        <p>{t('hours')}</p>
        {settings.value && !settings.value.hasFinnhub && <p>{t('missingKey')}</p>}
        <Button
          onClick={() => {
            setSourceError(false)
            void fetch('/api/dsh-stocks/source', { method: 'POST', credentials: 'same-origin' })
              .then(async (response) => {
                if (!response.ok) throw new Error('download')
                const blob = await response.blob()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'dsh-stocks-source.json'
                a.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
              })
              .catch(() => setSourceError(true))
          }}
        >
          {t('source')}
        </Button>
        {sourceError && <p role="alert">{t('sourceError')}</p>}
      </Modal>
    </div>
  )
}
