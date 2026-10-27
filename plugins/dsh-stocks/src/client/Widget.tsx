/** Cross-origin TradingView frames retain their own origin and cannot access DSH cookies or DOM. */
import { memo, useEffect, useRef, useState } from 'react'
import { Button, Tooltip, IconFullscreenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Text } from './locale.ts'
import { widgetUrl } from './widget-url.ts'
import css from './Stocks.module.css'
export type WidgetTheme = 'light' | 'dark'
export const Widget = memo(function Widget({
  script,
  config,
  title,
  height = 520,
  theme,
  t,
  expand = false,
}: {
  script: string
  config: Record<string, unknown>
  title: string
  height?: number
  theme: WidgetTheme
  t: Text
  expand?: boolean
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState('loading')
  const [full, setFull] = useState(false)
  const url = widgetUrl(
    script,
    {
      ...config,
      isTransparent: false,
      colorTheme: theme,
      theme,
      locale: t('widgetLocale'),
      backgroundColor: theme === 'dark' ? '#1e1e24' : '#ffffff',
    },
    location.origin,
  )
  useEffect(() => {
    setStatus('loading')
    const listener = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== 'https://www.tradingview-widget.com')
        return
      if (e.data?.name === 'tv-widget-no-data') setStatus('error')
      if (e.data?.name === 'tv-widget-ready' || e.data?.name === 'tv-widget-load') setStatus('ready')
    }
    window.addEventListener('message', listener)
    const timer = setTimeout(() => setStatus((s) => (s === 'loading' ? 'timeout' : s)), 20000)
    return () => {
      window.removeEventListener('message', listener)
      clearTimeout(timer)
    }
  }, [url, attempt])
  useEffect(() => {
    const listener = () => setFull(document.fullscreenElement === box.current)
    document.addEventListener('fullscreenchange', listener)
    return () => document.removeEventListener('fullscreenchange', listener)
  }, [])
  return (
    <div className={css.widget} style={{ height }} ref={box}>
      <iframe
        key={url + attempt}
        ref={frame}
        title={title}
        className={css.frame}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="origin"
        src={url}
        onLoad={() => setStatus('ready')}
        onError={() => setStatus('error')}
      />
      {expand && (
        <Tooltip label={t(full ? 'collapse' : 'expand')} portal>
          <button
            className={css.expand}
            aria-label={t(full ? 'collapse' : 'expand')}
            onClick={() => {
              const action = full ? document.exitFullscreen() : box.current?.requestFullscreen()
              void action?.catch(() => setStatus('error'))
            }}
          >
            <IconFullscreenOutlineRegular size={16} />
          </button>
        </Tooltip>
      )}
      {(status === 'error' || status === 'timeout') && (
        <div className={css.widgetError}>
          <span>{t(status === 'error' ? 'widgetError' : 'widgetWait')}</span>
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('retry')}
          </Button>
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
            {t('externalChart')}
          </a>
        </div>
      )}
    </div>
  )
})
