import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Config, loadCredentials, parseCredentialsFile } from '../src/host/config.ts'
import { StocksBackend } from '../src/host/service.ts'
import { StockProvider, type ProviderRuntime } from '../src/host/provider.ts'
import { StockStorage } from '../src/host/storage.ts'
import { stocksFetch } from '../src/host/http.ts'
import { symbolSchema, stockStateSchema, type ApiReply } from '../src/shared/api.ts'

const signal = () => new AbortController().signal
const empty = () => ({ version: 1, revision: 0, watchlist: [], alerts: [] })
const epoch = Date.parse('2026-01-01T12:00:00Z')
const quote = (price = 120) => ({ c: price, d: 2, dp: 1.5, h: 125, l: 110, o: 115, pc: 118, t: epoch / 1000 })
function value<T>(result: ApiReply<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok) throw new Error('failed')
  return result.value
}
function errorCode(result: ApiReply<unknown>, code: string) {
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, code)
}
function fakeRuntime(fetcher: typeof fetch = async () => Response.json(quote())) {
  let now = epoch
  const timers = new Set<() => void>()
  const runtime: ProviderRuntime = {
    fetch: fetcher,
    now: () => now,
    timeout: (callback) => {
      timers.add(callback)
      return () => {
        timers.delete(callback)
      }
    },
  }
  return {
    runtime,
    timers,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stocks-host-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  await writeFile(path, JSON.stringify(empty()))
  return { directory, path, config: Config.parse({ statePath: path }) }
}

test('strict config and symbols reject unsafe inputs and normalize ASCII exchange symbols', () => {
  assert.equal(symbolSchema.parse(' nasdaq:aapl '), 'NASDAQ:AAPL')
  for (const invalid of ['https://host', 'A/B', 'A?x', 'ＡＡＰＬ', 'A:B:C', '<script>', 'A'.repeat(65)])
    assert.equal(symbolSchema.safeParse(invalid).success, false)
  assert.equal(Config.safeParse({ statePath: 'relative.json' }).success, false)
  assert.equal(Config.safeParse({ requestTimeoutMs: 0 }).success, false)
  assert.equal(Config.safeParse({ other: true }).success, false)
  assert.equal(stockStateSchema.safeParse({ ...empty(), version: 2 }).success, false)
})

test('credentials file parser allowlists literal keys and env keys override configured file', async (t) => {
  const { directory, config } = await fixture(t)
  const credentialsFile = join(directory, 'fixture.env')
  const text =
    'FINNHUB_API_KEYS="one,two" # comment\nOTHER_SECRET=never\nNEXT_PUBLIC_FINNHUB_API_KEY=legacy\nADANOS_API_KEY=sentiment\nFINNHUB_API_KEY=$(no-execution)'
  await writeFile(credentialsFile, text)
  assert.deepEqual(
    Object.keys(parseCredentialsFile(text)).sort(),
    ['ADANOS_API_KEY', 'FINNHUB_API_KEY', 'FINNHUB_API_KEYS', 'NEXT_PUBLIC_FINNHUB_API_KEY'].sort(),
  )
  assert.deepEqual(
    await loadCredentials({ ...config, credentialsFile }, { FINNHUB_API_KEY: 'environment' }),
    { finnhub: ['environment'], sentiment: 'sentiment' },
  )
  assert.deepEqual((await loadCredentials({ ...config, credentialsFile }, {})).finnhub, ['one', 'two'])
  assert.throws(() => parseCredentialsFile('FINNHUB_API_KEY="unterminated'), /malformed/)
  await assert.rejects(
    loadCredentials({ ...config, credentialsFile: join(directory, 'missing.env') }, {}),
    /Cannot read/,
  )
})

test('missing and corrupt storage stay visible and unchanged', async (t) => {
  const { path, config } = await fixture(t)
  const backend = new StocksBackend(config, { finnhub: [] }, fakeRuntime().runtime)
  t.after(() => backend.dispose())
  await writeFile(path, '{broken')
  errorCode(await backend.handle('state', {}, signal()), 'stocks/storage-corrupt')
  errorCode(
    await backend.handle('watchlist', { symbol: 'AAPL', add: true, revision: 0 }, signal()),
    'stocks/storage-corrupt',
  )
  assert.equal(await readFile(path, 'utf8'), '{broken')
  await rm(path)
  errorCode(await backend.handle('state', {}, signal()), 'stocks/storage-missing')
  errorCode(
    await backend.handle('watchlist', { symbol: 'AAPL', add: true, revision: 0 }, signal()),
    'stocks/storage-missing',
  )
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})

test('concurrent mutations serialize and reject stale revisions without lost state', async (t) => {
  const { path, config, directory } = await fixture(t)
  const backend = new StocksBackend(config, { finnhub: [] }, fakeRuntime().runtime)
  t.after(() => backend.dispose())
  const results = await Promise.all(
    ['AAPL', 'MSFT'].map((symbol) =>
      backend.handle('watchlist', { symbol, add: true, revision: 0 }, signal()),
    ),
  )
  assert.equal(results.filter((result) => result.ok).length, 1)
  errorCode(results.find((result) => !result.ok)!, 'stocks/conflict')
  const state = value(await backend.handle('state', {}, signal()))
  assert.equal(state.revision, 1)
  assert.equal(state.watchlist.length, 1)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), state)
  const newReader = new StockStorage(path)
  assert.deepEqual(await newReader.read(), state)
  assert.deepEqual(await readdir(directory), ['state.json'])
  errorCode(
    await backend.handle('watchlist', { symbol: 'AAPL', add: true, revision: 0 }, signal()),
    'stocks/conflict',
  )
})

test('foreign writer lock is retained and blocks changes', async (t) => {
  const { path } = await fixture(t)
  await writeFile(path + '.lock', 'another writer')
  const storage = new StockStorage(path)
  await assert.rejects(
    storage.mutate(
      0,
      (state) => {
        state.revision++
        return true
      },
      signal(),
    ),
    /locked/,
  )
  assert.equal(await readFile(path + '.lock', 'utf8'), 'another writer')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), empty())
})

test('watchlist limits, no-op edits, cancellation, and strict mutation fields', async (t) => {
  const { config, path } = await fixture(t)
  await writeFile(
    path,
    JSON.stringify({
      ...empty(),
      watchlist: Array.from({ length: 100 }, (_, i) => ({ symbol: 'S' + i, name: 'Stock' })),
    }),
  )
  const backend = new StocksBackend(config, { finnhub: [] }, fakeRuntime().runtime)
  t.after(() => backend.dispose())
  errorCode(
    await backend.handle('watchlist', { symbol: 'NEXT', add: true, revision: 0 }, signal()),
    'stocks/limit',
  )
  assert.equal(
    value(await backend.handle('watchlist', { symbol: 'S0', add: true, revision: 0 }, signal())).revision,
    0,
  )
  errorCode(
    await backend.handle(
      'watchlist',
      { symbol: 'S0', add: true, revision: 0, url: 'https://evil' },
      signal(),
    ),
    'stocks/invalid-input',
  )
  const abort = new AbortController()
  abort.abort()
  errorCode(
    await backend.handle('watchlist', { symbol: 'S0', add: false, revision: 0 }, abort.signal),
    'stocks/cancelled',
  )
  assert.equal(
    value(await backend.handle('watchlist', { symbol: 'S0', add: false, revision: 0 }, signal())).watchlist
      .length,
    99,
  )
})

test('settings expose capability booleans only and quotes preserve per-symbol failures', async (t) => {
  const { config } = await fixture(t)
  const backend = new StocksBackend(
    config,
    { finnhub: [], sentiment: 'private-secret' },
    fakeRuntime().runtime,
  )
  t.after(() => backend.dispose())
  const settings = value(await backend.handle('settings', {}, signal()))
  assert.equal(settings.hasFinnhub, false)
  assert.equal(settings.hasSentiment, true)
  assert.equal(JSON.stringify(settings).includes('private-secret'), false)
  const quotes = value(await backend.handle('quotes', { symbols: ['AAPL', 'MSFT'] }, signal()))
  errorCode(quotes.quotes.AAPL!, 'stocks/missing-key')
  errorCode(quotes.quotes.MSFT!, 'stocks/missing-key')
  assert.deepEqual(value(await backend.handle('search', { query: '' }, signal())), { results: [] })
})

test('quotes validate, normalize US prefixes, cache and coalesce duplicate requests', async (t) => {
  const { config } = await fixture(t)
  let calls = 0
  const clock = fakeRuntime(async (input, init) => {
    calls++
    assert.equal(new URL(String(input)).origin, 'https://finnhub.io')
    assert.equal(new URL(String(input)).searchParams.get('symbol'), 'AAPL')
    assert.equal(new Headers(init?.headers).get('X-Finnhub-Token'), 'secret')
    assert.equal(String(input).includes('secret'), false)
    assert.equal(init?.redirect, 'error')
    return Response.json(quote())
  })
  const provider = new StockProvider(config, { finnhub: ['secret'] }, clock.runtime)
  t.after(() => provider.dispose())
  const [a, b] = await Promise.all([
    provider.quote('NASDAQ:AAPL', signal()),
    provider.quote('AAPL', signal()),
  ])
  assert.equal(a.symbol, 'NASDAQ:AAPL')
  assert.equal(b.price, 120)
  assert.equal(calls, 1)
  await provider.quote('AAPL', signal())
  assert.equal(calls, 1)
  clock.advance(config.quoteRefreshSeconds * 1000 + 1)
  await provider.quote('AAPL', signal())
  assert.equal(calls, 2)
  assert.equal(clock.timers.size, 0)
})

test('provider total concurrency is at most two across keys with deterministic barriers', async (t) => {
  const { config } = await fixture(t)
  let active = 0,
    maximum = 0,
    started = 0
  const releases: (() => void)[] = []
  let firstTwo!: () => void
  const ready = new Promise<void>((resolve) => {
    firstTwo = resolve
  })
  const clock = fakeRuntime(async () => {
    active++
    started++
    maximum = Math.max(maximum, active)
    if (started === 2) firstTwo()
    await new Promise<void>((resolve) => releases.push(resolve))
    active--
    return Response.json(quote())
  })
  const provider = new StockProvider(config, { finnhub: ['one', 'two', 'three'] }, clock.runtime)
  t.after(() => provider.dispose())
  const requests = ['A', 'B', 'C', 'D'].map((symbol) => provider.quote(symbol, signal()))
  await ready
  assert.equal(started, 2)
  releases.splice(0).forEach((resolve) => resolve())
  await Promise.all(requests.slice(0, 2))
  assert.equal(started, 4)
  releases.splice(0).forEach((resolve) => resolve())
  await Promise.all(requests)
  assert.equal(maximum, 2)
  assert.equal(clock.timers.size, 0)
})

test('429 cooldown honors Retry-After across symbols without key rotation retries', async (t) => {
  const { config } = await fixture(t)
  let calls = 0
  const clock = fakeRuntime(async () => {
    calls++
    return calls === 1
      ? new Response('do not expose secret body', { status: 429, headers: { 'retry-after': '120' } })
      : Response.json(quote())
  })
  const provider = new StockProvider(config, { finnhub: ['secret', 'other'] }, clock.runtime)
  t.after(() => provider.dispose())
  await assert.rejects(provider.quote('A', signal()), /rate-limited/)
  await assert.rejects(provider.quote('B', signal()), /rate-limited/)
  assert.equal(calls, 1)
  clock.advance(120001)
  assert.equal((await provider.quote('B', signal())).price, 120)
  assert.equal(calls, 2)
})

test('invalid zero quotes and oversized provider data fail explicitly and cache failures', async (t) => {
  const { config } = await fixture(t)
  let calls = 0
  const clock = fakeRuntime(async () => {
    calls++
    return Response.json(quote(0))
  })
  const provider = new StockProvider(config, { finnhub: ['secret'] }, clock.runtime)
  t.after(() => provider.dispose())
  await assert.rejects(provider.quote('A', signal()), /invalid data/)
  await assert.rejects(provider.quote('A', signal()), /invalid data/)
  assert.equal(calls, 1)
  const oversized = new StockProvider(
    { ...config, maxResponseBytes: 1024 },
    { finnhub: ['secret'] },
    fakeRuntime(async () => new Response('x'.repeat(1025))).runtime,
  )
  t.after(() => oversized.dispose())
  await assert.rejects(oversized.quote('B', signal()), /size limit/)
})

test('injected deadlines abort fetch and disposal settles active and queued work', async (t) => {
  const { config } = await fixture(t)
  let began!: () => void
  const ready = new Promise<void>((resolve) => {
    began = resolve
  })
  const clock = fakeRuntime(async (_url, init) => {
    began()
    await new Promise((_, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('secret transport details')), {
        once: true,
      }),
    )
    throw new Error('unreachable')
  })
  const provider = new StockProvider(config, { finnhub: ['secret'] }, clock.runtime)
  const timed = assert.rejects(provider.quote('A', signal()), /timed out/)
  await ready
  for (const timer of [...clock.timers]) timer()
  await timed
  const pending = ['B', 'C', 'D'].map((symbol) =>
    assert.rejects(provider.quote(symbol, signal()), /unloaded|cancelled/),
  )
  await provider.dispose()
  await Promise.all(pending)
  assert.equal(clock.timers.size, 0)
  await assert.rejects(async () => provider.quote('E', signal()), /cancelled/)
})

test('one cancelled reader does not poison coalesced provider work', async (t) => {
  const { config } = await fixture(t)
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  const provider = new StockProvider(
    config,
    { finnhub: ['secret'] },
    fakeRuntime(async () => {
      await barrier
      return Response.json(quote())
    }).runtime,
  )
  t.after(() => provider.dispose())
  const abort = new AbortController()
  const cancelledRequest = assert.rejects(provider.quote('A', abort.signal), /cancelled/)
  const survivor = provider.quote('A', signal())
  abort.abort()
  await cancelledRequest
  release()
  assert.equal((await survivor).price, 120)
})

test('alerts persist only real fresh prices, trigger once, and surface background failures', async (t) => {
  const { config } = await fixture(t)
  let calls = 0
  const clock = fakeRuntime(async () => {
    calls++
    return Response.json(quote())
  })
  const backend = new StocksBackend(config, { finnhub: ['secret'] }, clock.runtime)
  t.after(() => backend.dispose())
  const added = value(
    await backend.handle(
      'alerts',
      { action: 'add', revision: 0, symbol: 'AAPL', direction: 'above', price: 119 },
      signal(),
    ),
  )
  assert.equal(added.alerts[0]!.createdAt, new Date(epoch).toISOString())
  const first = backend.checkAlerts()
  assert.equal(backend.checkAlerts(), first)
  await first
  const triggered = value(await backend.handle('state', {}, signal()))
  assert.equal(triggered.alerts[0]!.lastPrice, 120)
  assert.equal(triggered.alerts[0]!.triggeredAt, new Date(epoch).toISOString())
  assert.equal(triggered.revision, 2)
  await backend.checkAlerts()
  assert.equal(calls, 1)
  assert.equal(value(await backend.handle('state', {}, signal())).revision, 2)
  errorCode(
    await backend.handle('alerts', { action: 'remove', revision: 1, id: added.alerts[0]!.id }, signal()),
    'stocks/conflict',
  )
  assert.equal(
    value(
      await backend.handle('alerts', { action: 'remove', revision: 2, id: added.alerts[0]!.id }, signal()),
    ).alerts.length,
    0,
  )
  const missing = new StocksBackend(config, { finnhub: [] }, clock.runtime)
  t.after(() => missing.dispose())
  await missing.handle(
    'alerts',
    { action: 'add', revision: 3, symbol: 'AAPL', direction: 'below', price: 1 },
    signal(),
  )
  await missing.checkAlerts()
  assert.equal(
    value(await missing.handle('settings', {}, signal())).alertCheckError?.code,
    'stocks/missing-key',
  )
})

test('profiles expose metrics separately, search filters unsafe symbols, and news rejects unsafe URLs', async (t) => {
  const { config } = await fixture(t)
  const clock = fakeRuntime(async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/profile2'))
      return Response.json({ name: 'Apple', ticker: 'AAPL', currency: 'USD' })
    if (url.pathname.endsWith('/metric')) return new Response('private failure', { status: 403 })
    if (url.pathname.endsWith('/search'))
      return Response.json({
        result: [
          { symbol: 'AAPL', description: 'Apple', displaySymbol: 'AAPL', type: 'Common Stock' },
          { symbol: '<script>', description: 'bad', displaySymbol: 'bad', type: '' },
        ],
      })
    return Response.json([
      {
        id: 1,
        headline: 'News',
        summary: '',
        url: 'javascript:alert(1)',
        source: 'source',
        datetime: epoch / 1000,
      },
    ])
  })
  const backend = new StocksBackend(config, { finnhub: ['secret'] }, clock.runtime)
  t.after(() => backend.dispose())
  const profile = value(await backend.handle('profile', { symbol: 'AAPL' }, signal()))
  assert.equal(profile.profile.name, 'Apple')
  assert.equal(profile.metricsError?.code, 'stocks/provider')
  assert.equal(value(await backend.handle('search', { query: 'apple' }, signal())).results.length, 1)
  const news = value(await backend.handle('news', { symbols: [] }, signal()))
  assert.equal(news.articles.length, 0)
  assert.equal(news.errors.general?.code, 'stocks/provider-data')
})

test('stale quote never triggers an alert and exposes its degraded check status', async (t) => {
  const { config } = await fixture(t)
  const clock = fakeRuntime(async () => Response.json(quote()))
  clock.advance(301000)
  const backend = new StocksBackend(config, { finnhub: ['secret'] }, clock.runtime)
  t.after(() => backend.dispose())
  await backend.handle(
    'alerts',
    { action: 'add', revision: 0, symbol: 'AAPL', direction: 'above', price: 1 },
    signal(),
  )
  await backend.checkAlerts()
  const state = value(await backend.handle('state', {}, signal()))
  assert.equal(state.alerts[0]!.triggeredAt, undefined)
  assert.equal(state.revision, 1)
  assert.equal(
    value(await backend.handle('settings', {}, signal())).alertCheckError?.code,
    'stocks/stale-quote',
  )
})

test('news retains successful symbol results beside failures and sentiment labels its only source', async (t) => {
  const { config } = await fixture(t)
  const clock = fakeRuntime(async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.adanos.org')
      return Response.json({ stocks: [{ ticker: 'AAPL', mentions: 123, bullish_pct: 65 }] })
    if (url.searchParams.get('symbol') === 'FAIL')
      return new Response('hidden error details', { status: 500 })
    return Response.json([
      {
        id: 2,
        headline: 'Real fixture headline',
        summary: 'Fixture summary',
        url: 'https://example.com/article',
        source: 'Source',
        datetime: epoch / 1000,
      },
    ])
  })
  const backend = new StocksBackend(config, { finnhub: ['secret'], sentiment: 'secret' }, clock.runtime)
  t.after(() => backend.dispose())
  const news = value(await backend.handle('news', { symbols: ['AAPL', 'FAIL'] }, signal()))
  assert.equal(news.articles.length, 1)
  assert.equal(news.articles[0]!.symbol, 'AAPL')
  assert.equal(news.errors.FAIL?.code, 'stocks/provider')
  const sentiment = value(await backend.handle('sentiment', { symbol: 'AAPL' }, signal()))
  assert.deepEqual(sentiment, {
    symbol: 'AAPL',
    sources: [{ source: 'reddit', mentions: 123, sentimentScore: 65 }],
  })
})

test('HTTP enforces POST JSON byte limits and frames provider errors without details', async () => {
  let calls = 0
  const handle = stocksFetch('state', async () => {
    calls++
    return { ok: true, value: empty() }
  })
  const url = 'http://localhost/api/dsh-stocks/state'
  assert.equal((await handle(new Request(url))).status, 405)
  assert.equal((await handle(new Request(url, { method: 'POST', body: '{}' }))).status, 415)
  assert.equal(
    (
      await handle(
        new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }),
      )
    ).status,
    400,
  )
  assert.equal(
    (
      await handle(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify('界'.repeat(12000)),
        }),
      )
    ).status,
    413,
  )
  assert.equal(calls, 0)
  const response = await handle(
    new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    }),
  )
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
  assert.deepEqual(await response.json(), { ok: true, value: empty() })
})
