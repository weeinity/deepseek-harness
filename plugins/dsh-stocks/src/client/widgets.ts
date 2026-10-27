/** OpenStock widget definitions, AGPL-3.0; DSH port 2026-10-12. */
type SymbolGroup = { title: string; symbols: [symbol: string, name: string][] }

export const marketOverviewConfig = (groups: SymbolGroup[]) => ({
  colorTheme: 'dark',
  dateRange: '12M',
  locale: 'en',
  largeChartUrl: '',
  isTransparent: true,
  showFloatingTooltip: true,
  plotLineColorGrowing: '#47d9bb', // brand teal (oklch 0.80 0.13 176)
  plotLineColorFalling: '#47d9bb',
  gridLineColor: 'rgba(240, 243, 250, 0)',
  scaleFontColor: '#adaba3', // --muted
  belowLineFillColorGrowing: 'rgba(71, 217, 187, 0.12)',
  belowLineFillColorFalling: 'rgba(71, 217, 187, 0.12)',
  belowLineFillColorGrowingBottom: 'rgba(71, 217, 187, 0)',
  belowLineFillColorFallingBottom: 'rgba(71, 217, 187, 0)',
  symbolActiveColor: 'rgba(71, 217, 187, 0.08)',
  tabs: groups.map(({ title, symbols }) => ({ title, symbols: symbols.map(([s, d]) => ({ s, d })) })),
  support_host: 'https://www.tradingview.com',
  showSymbolLogo: true,
  showChart: true,
})

export const marketQuotesConfig = (groups: SymbolGroup[]) => ({
  locale: 'en',
  showSymbolLogo: true,
  colorTheme: 'dark',
  isTransparent: true,
  symbolsGroups: groups.map(({ title, symbols }) => ({
    name: title,
    symbols: symbols.map(([name, displayName]) => ({ name, displayName })),
  })),
})

export const STOCK_HEATMAP_CONFIG = {
  dataSource: 'SPX500',
  blockSize: 'market_cap_basic',
  blockColor: 'change',
  grouping: 'sector',
  isTransparent: true,
  locale: 'en',
  symbolUrl: '',
  colorTheme: 'dark',
  exchanges: [],
  hasTopBar: false,
  isDataSetEnabled: false,
  isZoomEnabled: true,
  hasSymbolTooltip: true,
  isMonoSize: false,
}

export const CRYPTO_HEATMAP_CONFIG = {
  dataSource: 'Crypto',
  blockSize: 'market_cap_calc',
  blockColor: 'change',
  locale: 'en',
  symbolUrl: '',
  colorTheme: 'dark',
  hasTopBar: false,
  isDataSetEnabled: false,
  isZoomEnabled: true,
  hasSymbolTooltip: true,
  isMonoSize: false,
  isTransparent: true,
}

export const timelineConfig = (market: 'stock' | 'crypto' | 'forex') => ({
  displayMode: 'regular',
  feedMode: 'market',
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
  market,
})

export const symbolInfoConfig = (symbol: string) => ({
  symbol,
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
  width: '100%',
})

export const singleQuoteConfig = (symbol: string) => ({
  symbol,
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
})

export const CANDLE_CHART_WIDGET_CONFIG = (symbol: string) => ({
  allow_symbol_change: false,
  calendar: false,
  details: true,
  hide_side_toolbar: true,
  hide_top_toolbar: false,
  hide_legend: false,
  hide_volume: false,
  hotlist: false,
  interval: 'D',
  locale: 'en',
  save_image: false,
  style: 1,
  symbol: symbol.toUpperCase(),
  theme: 'dark',
  timezone: 'exchange',
  backgroundColor: '#1f1e1a', // --card
  gridColor: 'rgba(255, 255, 255, 0.04)',
  watchlist: [],
  withdateranges: false,
  compareSymbols: [],
  studies: [],
  width: '100%',
  height: 600,
})

export const TECHNICAL_ANALYSIS_WIDGET_CONFIG = (symbol: string) => ({
  symbol: symbol.toUpperCase(),
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
  width: '100%',
  height: 400,
  interval: '1h',
  largeChartUrl: '',
})

// embed-widget-company-profile.js was retired by TradingView (403); symbol-profile.js takes the same config
export const COMPANY_PROFILE_WIDGET_CONFIG = (symbol: string) => ({
  symbol: symbol.toUpperCase(),
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
  width: '100%',
  height: 440,
})

export const COMPANY_FINANCIALS_WIDGET_CONFIG = (symbol: string) => ({
  symbol: symbol.toUpperCase(),
  colorTheme: 'dark',
  isTransparent: true,
  locale: 'en',
  width: '100%',
  height: 464,
  displayMode: 'regular',
  largeChartUrl: '',
})

// Default list in the search palette (static on purpose, see searchStocks)
export const POPULAR_STOCKS = [
  { symbol: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ' },
  { symbol: 'MSFT', name: 'Microsoft Corp', exchange: 'NASDAQ' },
  { symbol: 'NVDA', name: 'NVIDIA Corp', exchange: 'NASDAQ' },
  { symbol: 'GOOGL', name: 'Alphabet Inc', exchange: 'NASDAQ' },
  { symbol: 'AMZN', name: 'Amazon.com Inc', exchange: 'NASDAQ' },
  { symbol: 'META', name: 'Meta Platforms Inc', exchange: 'NASDAQ' },
  { symbol: 'TSLA', name: 'Tesla Inc', exchange: 'NASDAQ' },
  { symbol: 'NFLX', name: 'Netflix Inc', exchange: 'NASDAQ' },
  { symbol: 'AMD', name: 'Advanced Micro Devices Inc', exchange: 'NASDAQ' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co', exchange: 'NYSE' },
]
