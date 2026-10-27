import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultPreferences, restorePreferences, openTab, closeTab } from '../src/client/state.ts'
import { MARKETS, isMarketOpen } from '../src/client/markets.ts'
import { formatSymbolForTradingView, isChartEmbeddable } from '../src/client/symbols.ts'
import { en, zh } from '../src/client/locale.ts'
import { widgetUrl } from '../src/client/widget-url.ts'
test('widget URLs pin external origin and encode hostile configuration as data', () => {
  const u = new URL(
    widgetUrl('single-quote', { symbol: '</script><script>alert(1)</script>' }, 'http://127.0.0.1:3080'),
  )
  assert.equal(u.origin, 'https://www.tradingview-widget.com')
  assert.equal(JSON.parse(decodeURIComponent(u.hash.slice(1))).symbol, '</script><script>alert(1)</script>')
  assert.throws(() => widgetUrl('../anything', {}, 'http://localhost'))
})
test('summary profile and symbol news route the selected symbol through query parameters', () => {
  for (const kind of ['symbol-info', 'symbol-profile', 'timeline']) {
    for (const symbol of ['MRNA', 'NASDAQ:MSFT', 'TSX:SHOP']) {
      const url = new URL(widgetUrl(kind, { symbol, market: 'stock' }, 'http://localhost'))
      assert.equal(url.searchParams.get('symbol'), symbol)
      assert.equal(JSON.parse(decodeURIComponent(url.hash.slice(1))).symbol, symbol)
      if (kind === 'timeline') assert.equal(url.searchParams.get('market'), 'stock')
    }
  }
  const chart = new URL(widgetUrl('advanced-chart', { symbol: 'MRNA' }, 'http://localhost'))
  assert.equal(JSON.parse(decodeURIComponent(chart.hash.slice(1))).symbol, 'MRNA')
})
test('pinned tabs survive the ten-stock cap and closing active chooses neighbour', () => {
  const p = defaultPreferences()
  for (let i = 0; i < 15; i++) openTab(p, 'S' + i)
  assert.equal(p.tabs.length, 10)
  assert.equal(p.active, 'S14')
  closeTab(p, 'S14')
  assert.equal(p.active, 'S13')
  p.tabs = ['AAPL']
  p.active = 'AAPL'
  closeTab(p, 'AAPL')
  assert.equal(p.active, 'overview')
})
test('restore validates storage and deduplicates while rejecting invalid symbols', () => {
  assert.deepEqual(restorePreferences(null), defaultPreferences())
  assert.throws(() => restorePreferences('{bad'))
  assert.throws(() => restorePreferences(JSON.stringify({ ...defaultPreferences(), tabs: ['<script>'] })))
  const p = restorePreferences(
    JSON.stringify({ ...defaultPreferences(), tabs: ['AAPL', 'AAPL'], active: 'gone' }),
  )
  assert.deepEqual(p.tabs, ['AAPL'])
  assert.equal(p.active, 'overview')
})
test('all seven markets supply widgets and time-zone trading sessions', () => {
  assert.equal(MARKETS.length, 7)
  for (const m of MARKETS) {
    assert.equal(m.pulse.length, 4)
    assert.ok(m.groups.length > 0)
  }
  assert.equal(isMarketOpen(MARKETS[0], new Date('2026-10-12T14:00:00Z')), true)
  assert.equal(isMarketOpen(MARKETS[0], new Date('2026-10-11T14:00:00Z')), false)
  assert.equal(isMarketOpen(MARKETS[5], new Date('2026-10-11T14:00:00Z')), true)
})
test('OpenStock exchange mapping and blocked chart coverage remain intact', () => {
  assert.equal(formatSymbolForTradingView('0700.HK'), 'HKEX:700')
  assert.equal(formatSymbolForTradingView('SHOP.TO'), 'TSX:SHOP')
  assert.equal(formatSymbolForTradingView('BRK.B'), 'BRK.B')
  assert.equal(isChartEmbeddable('HKEX:700'), false)
  assert.equal(isChartEmbeddable('NASDAQ:AAPL'), true)
})
test('US Biotech leaders include all requested stocks and ETFs exactly once', () => {
  const group = MARKETS[0].groups.find((group) => group.title === 'Biotech')
  assert.ok(group)
  const symbols = group.symbols.map(([symbol]) => symbol)
  assert.deepEqual(symbols, [
    'NASDAQ:AMGN',
    'NASDAQ:VRTX',
    'NASDAQ:MRNA',
    'NASDAQ:REGN',
    'NASDAQ:ALNY',
    'NASDAQ:INSM',
    'NASDAQ:TWST',
    'NASDAQ:CRSP',
    'NASDAQ:PCVX',
    'NASDAQ:BNTX',
    'NASDAQ:ABSI',
    'NASDAQ:RXRX',
    'NASDAQ:SDGR',
    'NASDAQ:IBB',
    'AMEX:XBI',
  ])
  assert.equal(new Set(symbols).size, 15)
  assert.equal(en.group_Biotech, 'Biotech')
})
test('both dictionaries own the same complete keys and placeholders', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(en) as (keyof typeof en)[])
    assert.deepEqual(en[key].match(/{[^}]+}/g), zh[key].match(/{[^}]+}/g), key)
})
