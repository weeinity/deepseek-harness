/** Framework hooks supply data and preferences; components never receive services. */
import { useEffect, useId, useRef, useState } from 'react'
import {
  IconDownloadOutlineRegular, IconInspectOutlineRegular, IconQuestionOutlineRegular, IconRefreshOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DashboardProps } from './contract.ts'
import { Ado, SourceForm } from './Ado.tsx'
import { Personal } from './Personal.tsx'
import { DashboardChat } from './DashboardChat.tsx'
import { ResourceStatus, sourceName } from './presentation.tsx'
import { date, referenceDate, refreshPolicy } from './format.ts'
import { selectedType, sourceKey, type View } from '../shared/selection.ts'
import { displayedContext, displayedReceipt } from './chat-selection.ts'
import { snapshotForExport } from './export-selection.ts'
import styles from './dsh-dashboard.module.css'

export function Dashboard(props: DashboardProps) {
  const { t, actions, select, refresh, exportSnapshot } = props
  const prefs = props.useStore(value => value)
  const state = props.useDashboard(value => value)
  const chat = props.useDashboardChat(value => value)
  const id = useId()
  const tabs = useRef<HTMLDivElement>(null)
  const [exportFailed, setExportFailed] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(false)
  useEffect(() => { select(prefs.tab, prefs.source) }, [select, prefs.tab, prefs.source])
  useEffect(() => {
    if (prefs.source === null && state.settings?.defaultAdoSource) actions.source(state.settings.defaultAdoSource)
  }, [actions, prefs.source, state.settings])
  const receipt = displayedReceipt(state, prefs)
  const context = displayedContext(state, prefs)
  useEffect(() => { props.selectChat(receipt) }, [props.selectChat, receipt])
  const resource = prefs.tab === 'personal' ? state.personal : state.ado
  const previous = prefs.tab === 'ado' && state.ado.data !== null
    && (prefs.source === null || state.ado.dataKey !== sourceKey(prefs.source))
  const chooseTab = (tab: View) => { setExportFailed(false); actions.tab(tab) }
  const zone = resource.data?.kind === 'personal' ? resource.data.timeZone : state.settings?.timeZone ?? 'UTC'
  const policy = state.settings ? refreshPolicy(state.settings, t) : null
  const adjustments = props.attentionActions ? { ...props.attentionActions, state: state.attention } : undefined
  return <div className={styles.dashboard} data-pane={prefs.mobilePane} data-qa-collapsed={railCollapsed}>
    <header className={styles.header}>
      <div className={styles.headerIdentity}>
        <h1>{t('view.label')}</h1><p>{resource.data?.kind === 'personal' && <>{resource.data.displayName} · </>}{t('header.subtitle')}</p>
      </div>
      <div className={styles.freshness}>
        <span className={styles.freshnessDot} data-state={resource.stale || previous || resource.error ? 'stale'
          : resource.status === 'pending' ? 'pending' : resource.data === null ? 'unavailable' : 'ready'} aria-hidden="true" />
        <span>{resource.data ? <><time dateTime={resource.data.generatedAt}>
          {t('updated', { time: date(resource.data.generatedAt, zone, t, 'time') })}</time>{policy && ' · '}</> : t('header.notFetched')}
          {policy && <span className={styles.refreshPolicy}>{policy}</span>}
        </span>
      </div>
      <div className={styles.headerActions}>
        <Tooltip label={t(resource.status === 'pending' ? 'refresh.loading' : 'refresh.now')} side="bottom">
          <button type="button" onClick={() => { void refresh() }} disabled={resource.status === 'pending'}
            className={styles.refresh} aria-label={t('refresh.now')} aria-busy={resource.status === 'pending'}>
            <span aria-hidden="true"><IconRefreshOutlineRegular size={18} /></span>
          </button>
        </Tooltip>
        <button type="button" className={styles.export} disabled={resource.data === null} onClick={() => {
          if (resource.data !== null) setExportFailed(!exportSnapshot(snapshotForExport(resource.data, prefs, t)))
        }}><span aria-hidden="true"><IconDownloadOutlineRegular size={14} /></span>{t('export')}</button>
      </div>
    </header>
    <div className={styles.tabRow}>
    <div ref={tabs} className={styles.tabs} role="tablist" aria-label={t('view.navigation')}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tab: View = event.key === 'Home' ? 'personal' : event.key === 'End' ? 'ado' : prefs.tab === 'personal' ? 'ado' : 'personal'
        chooseTab(tab)
        tabs.current?.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.focus()
      }}>
      {(['personal', 'ado'] as const).map(tab => <button key={tab} type="button" role="tab"
        id={`${id}-${tab}`} aria-controls={`${id}-panel-${tab}`} data-tab={tab}
        aria-selected={prefs.tab === tab} tabIndex={prefs.tab === tab ? 0 : -1}
        onClick={() => { chooseTab(tab) }}>{t(`view.${tab}`)}</button>)}
    </div>
      <div className={styles.mobilePanes} role="group" aria-label={t('chat.panes')}>
        <button type="button" aria-pressed={prefs.mobilePane === 'data'}
          onClick={() => { actions.mobilePane('data') }}>{t('chat.dataPane')}</button>
        <button type="button" aria-pressed={prefs.mobilePane === 'chat'}
          onClick={() => { actions.mobilePane('chat') }}>{t('chat.title')}</button>
      </div>
      <button type="button" className={styles.railToggle} aria-expanded={!railCollapsed}
        onClick={() => { setRailCollapsed(!railCollapsed) }}>
        <span aria-hidden="true"><IconQuestionOutlineRegular size={14} /></span>
        {t(railCollapsed ? 'chat.show' : 'chat.hide')}
      </button>
    </div>
    <div className={styles.caveats}>
      <span className={styles.readOnly}><span aria-hidden="true"><IconInspectOutlineRegular size={12} /></span>
        {t(resource.data?.kind === 'personal' && resource.data.attention ? 'adjustment.header' : 'header.readOnly')}</span>
      {resource.data?.kind === 'personal' && <>
        {resource.data.referenceAsOf && <span>{t('referenceAsOf', { date: referenceDate(resource.data.referenceAsOf, zone, t) })}</span>}
        <span className={styles.sourceFreshness}>{resource.data.sources.map(source => <span key={source.id}>
          {sourceName(source.id, t)} <strong data-source={source.state}>{t(`freshness.${source.state}`)}</strong>
        </span>)}</span>
      </>}
      {resource.data?.kind === 'ado' && !resource.data.complete && <span>{t('ado.partial')}</span>}
    </div>
    <div className={styles.workspace}>
    <div className={styles.dataPane}>
    <div id={`${id}-panel-${prefs.tab}`} role="tabpanel" aria-labelledby={`${id}-${prefs.tab}`} tabIndex={0}
      className={styles.panel} aria-busy={resource.status === 'pending'}>
      {prefs.tab === 'ado' && <details key={prefs.source ? sourceKey(prefs.source) : 'new'}
        className={styles.adoSourceDisclosure} open={prefs.source === null ? true : undefined}>
        <summary>{t('ado.sourceDisclosure')}</summary>
        <SourceForm source={prefs.source}
          onSubmit={source => { actions.source(source); select('ado', source); void refresh() }} t={t} />
      </details>}
      <ResourceStatus resource={resource} previousSource={previous} t={t} />
      {exportFailed && <p role="alert" className={styles.warning}>{t('export.error')}</p>}
      {prefs.tab === 'personal' && state.personal.data && <Personal snapshot={state.personal.data} t={t}
        attentionFilter={prefs.attentionFilter} onAttentionFilter={actions.attentionFilter} policy={policy ?? undefined}
        adjustments={adjustments} />}
      {prefs.tab === 'ado' && prefs.source === null && <p>{t('ado.noSource')}</p>}
      {prefs.tab === 'ado' && state.ado.data && <Ado snapshot={state.ado.data} prefs={prefs} actions={actions}
        zone={state.settings?.timeZone ?? 'UTC'} t={t} history={state.adoHistory}
        loadHistory={() => {
          const snapshot = state.ado.data
          if (!snapshot || previous || resource.status === 'pending') return
          const type = selectedType(snapshot, prefs.filters.type)
          void props.loadAdoHistory(type, state.adoHistory?.status === 'error'
            || (snapshot.analytics?.history?.type === type && snapshot.analytics.history.status !== 'complete'))
        }} />}
    </div>
    </div>
    <DashboardChat t={t} actions={actions} state={chat} context={context} receipt={receipt} prefs={prefs}
      fetchedAt={resource.data?.generatedAt} timeZone={zone}
      maxChars={state.settings?.maxChatQuestionChars ?? 0} sendQuestion={props.sendQuestion}
      retryQuestion={props.retryQuestion} retryHistory={props.retryHistory}
      stopQuestion={props.stopQuestion} loadHistory={props.loadHistory}
      adjustments={prefs.tab === 'personal' && state.personal.data?.attention ? adjustments : undefined} />
    </div>
  </div>
}
