/** Searchable MCP entries with stable row order and profile-owned enablement controls. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { LockSimpleIcon } from '@phosphor-icons/react/ssr'
import { Button, IconSearchOutlineRegular, IconLoadingOutlineRegular, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectorEntry, ConnectorSnapshot, ConnectorsSectionProps } from './contract.ts'
import { ConnectorMark } from './ConnectorMark.tsx'
import css from './ConnectorsSection.module.css'

type ReadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: ConnectorSnapshot }

/**
 * Render configured MCP servers without reading their private connection configuration.
 * @param props - Settings slot inputs, localized copy, and Host operations.
 * @returns Search, one ordered connector list, and query status.
 */
export function ConnectorsSection({ list, setEnabled, t }: ConnectorsSectionProps) {
  const headingId = useId()
  const pendingFocus = useRef<HTMLButtonElement | null>(null)
  const [state, setState] = useState<ReadState>({ status: 'loading' })
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState<ConnectorEntry['id'] | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setState({ status: 'loading' })
    setBusy(null)
    pendingFocus.current = null
    void Promise.resolve().then(list).then(
      (snapshot) => { if (current === generation.current) setState({ status: 'ready', snapshot }) },
      () => { if (current === generation.current) setState({ status: 'error' }) },
    )
    return () => { ++generation.current }
  }, [list, refresh])

  useLayoutEffect(() => {
    if (busy !== null || pendingFocus.current === null) return
    const element = pendingFocus.current
    pendingFocus.current = null
    if (document.activeElement !== element && document.activeElement !== document.body) return
    // Native disabling can blur the switch while its write is pending.
    element.focus({ preventScroll: true })
  }, [busy])

  const change = (entry: ConnectorEntry, enabled: boolean) => {
    const current = ++generation.current
    const element = document.activeElement
    pendingFocus.current = element instanceof HTMLButtonElement && element.matches('[role="switch"]')
      && element.closest('[data-connector-id]')?.getAttribute('data-connector-id') === entry.id
      ? element
      : null
    setBusy(entry.id)
    void Promise.resolve().then(() => setEnabled({ id: entry.id, enabled })).then(
      (receipt) => {
        if (current !== generation.current) return
        setState({ status: 'ready', snapshot: receipt.snapshot })
        setBusy(null)
      },
      () => {
        if (current !== generation.current) return
        setBusy(null)
      },
    )
  }

  const snapshot = state.status === 'ready' ? state.snapshot : undefined
  const normalized = query.trim().toLowerCase()
  const entries = snapshot?.entries.filter(entry =>
    [entry.serverName, entry.id, entry.transport ?? 'MCP'].some(value => value.toLowerCase().includes(normalized))) ?? []

  return (
    <section className={css.section} aria-labelledby={headingId}>
      <div className={css.header}>
        <h2 id={headingId} className={css.title}>{t('title')}</h2>
        <Button size="sm" variant="ghost" disabled={state.status === 'loading' || busy !== null}
          onClick={() => { setRefresh(value => value + 1) }}>{t('refresh')}</Button>
      </div>
      <p className={css.intro}>{t('intro')}</p>
      <Input className={clsx(css.search)} type="search" aria-label={t('search')}
        placeholder={t('search')} icon={<IconSearchOutlineRegular />} autoComplete="off"
        value={query} onChange={(event) => { setQuery(event.target.value) }} />
      {state.status === 'loading' && <div className={css.loading} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular className={css.spinner} /></div>}
      {state.status === 'error' && <div className={css.failure} role="alert">
        <p>{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => { setRefresh(value => value + 1) }}>{t('retry')}</Button>
      </div>}
      {snapshot !== undefined && <>
        {snapshot.capability === 'read-only' && <p className={css.status}>{t('blocked.unsupported-context')}</p>}
        {entries.length === 0
          ? <p className={css.status} role="status">{t(snapshot.entries.length === 0 ? 'empty' : 'noMatches')}</p>
          : <ul className={css.list}>
            {entries.map((entry) => {
              const blocked = entry.blockedReason === undefined ? undefined : t(`blocked.${entry.blockedReason}`)
              const readOnly = !entry.canToggle || snapshot.capability !== 'live'
              const status = t(!entry.enabled ? 'phase.disabled' : `phase.${entry.fiberPhase ?? 'unobserved'}`)
              return <li key={entry.id} className={css.row} data-connector-id={entry.id}
                aria-label={entry.serverName} aria-busy={busy === entry.id}>
                <ConnectorMark name={entry.serverName} />
                <div className={css.details}>
                  <strong className={css.name}>{entry.serverName}</strong>
                  <span className={css.metadata}>
                    {t(entry.transport === 'stdio' ? 'stdio' : entry.transport === 'streamable-http' ? 'http' : 'unknownTransport')}
                    {' '}<span aria-hidden="true">·</span>{' '}{status}
                  </span>
                  {blocked !== undefined && <span className={css.metadata}>{blocked}</span>}
                </div>
                <span className={css.controls}>
                  {readOnly && <LockSimpleIcon className={css.lock} size={12} aria-hidden="true" focusable="false" />}
                  <Switch checked={entry.enabled} label={t('toggle', { name: entry.serverName })}
                    disabled={busy !== null || readOnly}
                    title={blocked} onChange={(next) => { change(entry, next) }} />
                </span>
              </li>
            })}
          </ul>}
      </>}
      {busy !== null && <p className={css.status} role="status">{t('saving')}</p>}
    </section>
  )
}
