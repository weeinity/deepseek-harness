/** OpenStock exchange mapping, AGPL-3.0; DSH port 2026-10-12. */
const FINNHUB_TO_TRADINGVIEW_EXCHANGE: Record<string, string> = {
  // Asia-Pacific
  '.TW': 'TWSE', // Taiwan Stock Exchange
  '.TWO': 'TPEX', // Taiwan OTC Exchange
  '.T': 'TSE', // Tokyo Stock Exchange
  '.HK': 'HKEX', // Hong Kong
  '.SS': 'SSE', // Shanghai
  '.SZ': 'SZSE', // Shenzhen
  '.KS': 'KRX', // Korea Exchange
  '.KQ': 'KRX', // KOSDAQ (Korea)
  '.SI': 'SGX', // Singapore
  '.AX': 'ASX', // Australian Securities Exchange
  '.NZ': 'NZX', // New Zealand
  '.BO': 'BSE', // Bombay Stock Exchange
  '.NS': 'BSE', // NSE listing: NSE is blocked in free TradingView embeds, the same ticker renders on BSE
  '.BK': 'SET', // Stock Exchange of Thailand
  '.JK': 'IDX', // Indonesia Stock Exchange
  '.KL': 'MYX', // Bursa Malaysia

  // Europe
  '.L': 'LSE', // London Stock Exchange
  '.IL': 'LSE', // London (IOB international)
  '.DE': 'XETR', // Deutsche Boerse (Xetra)
  '.F': 'FWB', // Frankfurt Stock Exchange
  '.PA': 'EURONEXT', // Euronext Paris
  '.AS': 'EURONEXT', // Euronext Amsterdam
  '.BR': 'EURONEXT', // Euronext Brussels
  '.LS': 'EURONEXT', // Euronext Lisbon
  '.MI': 'MIL', // Borsa Italiana (Milan)
  '.MC': 'BME', // Bolsa de Madrid
  '.ST': 'OMXSTO', // Stockholm (Nasdaq Nordic)
  '.HE': 'OMXHEX', // Helsinki (Nasdaq Nordic)
  '.CO': 'OMXCOP', // Copenhagen (Nasdaq Nordic)
  '.OL': 'OSL', // Oslo Stock Exchange
  '.SW': 'SIX', // SIX Swiss Exchange
  '.VI': 'VIE', // Vienna Stock Exchange
  '.WA': 'GPW', // Warsaw Stock Exchange
  '.PR': 'PSECZ', // Prague Stock Exchange (TradingView's PSE is the Philippines)
  '.AT': 'ATHEX', // Athens Stock Exchange
  '.IS': 'BIST', // Borsa Istanbul

  // Americas
  '.TO': 'TSX', // Toronto Stock Exchange
  '.V': 'TSXV', // TSX Venture Exchange
  '.SA': 'BMFBOVESPA', // B3 (Brazil)
  '.MX': 'BMV', // Bolsa Mexicana de Valores
  '.BA': 'BCBA', // Buenos Aires Stock Exchange

  // Middle East & Africa
  '.TA': 'TASE', // Tel Aviv Stock Exchange
  '.JO': 'JSE', // Johannesburg Stock Exchange
}

// Exchanges whose candle chart TradingView refuses in free embeds ("This symbol doesn't exist"), each confirmed
// with two tickers. Financials, technicals and profile still work for them.
// ponytail: static list, re-test with a real browser user agent if TradingView changes its licensing.
const CHART_BLOCKED_EXCHANGES = new Set([
  'TSE',
  'HKEX',
  'LSE',
  'KRX',
  'TWSE',
  'SGX',
  'NZX',
  'SET',
  'MYX',
  'BIST',
  'TSXV',
  'BMV',
  'JSE',
])

export const isChartEmbeddable = (tvSymbol: string) => !CHART_BLOCKED_EXCHANGES.has(tvSymbol.split(':')[0])

export const tradingViewSymbolUrl = (tvSymbol: string) =>
  `https://www.tradingview.com/symbols/${tvSymbol.replace(':', '-')}/`

// Listed outside the US (has a known exchange suffix like .L, .T, .NS). Class shares such as BRK.B are not.
export function isInternationalSymbol(symbol: string): boolean {
  const upper = symbol.toUpperCase()
  return Object.keys(FINNHUB_TO_TRADINGVIEW_EXCHANGE).some((suffix) => upper.endsWith(suffix.toUpperCase()))
}

export function formatSymbolForTradingView(symbol: string): string {
  if (!symbol) return ''
  const upperSymbol = symbol.toUpperCase()

  // Check for known exchange suffixes, trying longer suffixes first
  // to avoid ".TWO" matching ".TW" prematurely
  const suffixes = Object.keys(FINNHUB_TO_TRADINGVIEW_EXCHANGE).sort((a, b) => b.length - a.length)

  for (const suffix of suffixes) {
    if (upperSymbol.endsWith(suffix.toUpperCase())) {
      const exchange = FINNHUB_TO_TRADINGVIEW_EXCHANGE[suffix]
      // Finnhub pads Hong Kong codes (0700.HK); TradingView doesn't (HKEX:700)
      const ticker =
        exchange === 'HKEX'
          ? upperSymbol.slice(0, -suffix.length).replace(/^0+(?=\d)/, '')
          : upperSymbol.slice(0, -suffix.length)
      return `${exchange}:${ticker}`
    }
  }

  return upperSymbol
}
