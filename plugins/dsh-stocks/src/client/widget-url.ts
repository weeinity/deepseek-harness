/** Fixed TradingView frame URLs, matching its public embed scripts without executing remote scripts in DSH. */
export const widgetKinds = [
  'single-quote',
  'symbol-info',
  'market-overview',
  'market-quotes',
  'stock-heatmap',
  'crypto-coins-heatmap',
  'timeline',
  'advanced-chart',
  'financials',
  'technical-analysis',
  'symbol-profile',
] as const
export function widgetUrl(script: string, config: Record<string, unknown>, origin: string) {
  if (!widgetKinds.some((kind) => kind === script)) throw new Error('Unsupported widget')
  const url = new URL('https://www.tradingview-widget.com/embed-widget/' + script + '/')
  url.searchParams.set('locale', String(config.locale ?? 'en'))
  // These widgets read routing fields from the query rather than the configuration hash.
  if (
    (script === 'symbol-info' || script === 'symbol-profile' || script === 'timeline') &&
    typeof config.symbol === 'string'
  ) {
    url.searchParams.set('symbol', config.symbol)
  }
  if (script === 'timeline' && typeof config.market === 'string') {
    url.searchParams.set('market', config.market)
  }
  const { locale, ...values } = config
  const settings = {
    ...values,
    width: '100%',
    height: '100%',
    autosize: true,
    utm_source: new URL(origin).hostname,
    utm_medium: 'widget',
    utm_campaign: script,
    'page-uri': origin.replace(/^https?:\/\//, ''),
  }
  url.hash = encodeURIComponent(JSON.stringify(settings))
  return url.toString()
}
