/** Source-local Q&A preserves native history, captured retries, and draft revisions. */
import { useEffect, useId, useRef } from 'react'
import {
  Button, IconClockOutlineRegular, IconDatabaseOutlineRegular, IconEllipsisOutlineRegular, IconPlusOutlineRegular,
  IconQuestionOutlineRegular, IconSendOutlineRegular, IconStopFillRegular, IconThinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DashboardProps } from './contract.ts'
import type { ChatState } from './chat-owner.ts'
import type { ChatContext } from './chat-selection.ts'
import type { SnapshotReceipt } from '../shared/chat.ts'
import type { Preferences } from './stores.ts'
import { AnswerCopy, FinalAnswer, QuestionSuggestions } from './chat-presentation.tsx'
import { date } from './format.ts'
import styles from './dsh-dashboard.module.css'
import { AttentionFeedback, AttentionProposals, type AttentionActions } from './AttentionControls.tsx'

type ChatProps = Pick<DashboardProps,
  't' | 'actions' | 'sendQuestion' | 'retryQuestion' | 'retryHistory' | 'stopQuestion' | 'loadHistory'>
  & {
    state: ChatState; context: ChatContext | null; receipt: SnapshotReceipt | null; prefs: Preferences; maxChars: number
    fetchedAt?: string; timeZone?: string
    adjustments?: AttentionActions
  }

export function DashboardChat(props: ChatProps) {
  const { t, state, context, receipt, prefs, actions, maxChars } = props
  const id = useId()
  const scroll = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const follow = useRef(true)
  const scopeId = receipt?.scope.id
  const active = scopeId !== undefined && state.scope?.id === scopeId
  const draft = scopeId === undefined ? { text: '', revision: 0 } : prefs.drafts[scopeId] ?? { text: '', revision: 0 }
  const messages = active ? state.messages : []
  const running = active && state.running
  const pending = active && state.pendingQuestion !== null
  const uncertain = active && state.retryQuestion !== null
  const ready = active && state.status === 'ready'
  const personalAdjustments = receipt?.scope.id === 'personal' ? props.adjustments : undefined
  const questions = receipt?.scope.id === 'personal'
    ? [t('chat.suggest.attention'), t('chat.suggest.prep'), t('chat.suggest.replies')]
    : [t('chat.suggest.risks'), t('chat.suggest.progress'), t('chat.suggest.owners')]
  const selection = context?.selection
  const criteria = selection?.view === 'ado' ? [
    ...(['person', 'state', 'tag', 'text'] as const).map(key => ({
      key, label: t(`filter.${key}`), value: selection.filters[key],
    })),
    { key: 'metric', label: t('filter.activeMetric'), value: selection.filters.metric ? t(`ado.${selection.filters.metric}`) : '' },
    { key: 'risk', label: t('filter.activeRisk'), value: selection.filters.risk ? t(`risk.${selection.filters.risk}`) : '' },
  ].filter(criterion => criterion.value !== '') : []
  useEffect(() => { follow.current = true }, [scopeId])
  useEffect(() => {
    if (follow.current && scroll.current !== null) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [messages])
  const submit = () => {
    if (!ready || context === null || pending || running || uncertain
      || !draft.text.trim() || draft.text.length > maxChars) return
    const capturedScope = context.receipt.scope.id
    const revision = draft.revision
    void props.sendQuestion(context, draft.text, revision).then(accepted => {
      if (accepted) actions.accepted(capturedScope, revision)
    })
  }
  return <aside className={styles.chat} aria-labelledby={`${id}-title`}>
    <header className={styles.chatHeader}>
      <h2 id={`${id}-title`}><span aria-hidden="true"><IconQuestionOutlineRegular size={13} /></span>{t('chat.title')}</h2>
      <button type="button" className={styles.iconButton} aria-label={t('chat.newQuestion')} title={t('chat.newQuestion')}
        disabled={scopeId === undefined} onClick={() => { composer.current?.focus() }}>
        <span aria-hidden="true"><IconPlusOutlineRegular size={14} /></span>
      </button>
      <span className={styles.toolbarSpacer} />
      <button type="button" className={styles.iconButton} aria-label={t('chat.older')} title={t('chat.older')}
        disabled={!active || !state.hasMore || state.loadingOlder} onClick={() => {
          if (scopeId) { follow.current = false; void props.loadHistory(scopeId) }
        }}><span aria-hidden="true"><IconClockOutlineRegular size={15} /></span></button>
      <details className={styles.chatMenu}>
        <summary aria-label={t('chat.about')} title={t('chat.about')}><span aria-hidden="true"><IconEllipsisOutlineRegular size={15} /></span></summary>
        <div><strong>{t(personalAdjustments ? 'adjustment.chatTitle' : 'chat.dashboardOnly')}</strong><p>{t('chat.historyScope')}</p><p>{t('chat.modelReadOnly')}</p></div>
      </details>
    </header>
    <div className={styles.chatMessages} ref={scroll} onScroll={() => {
      const element = scroll.current
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
    }}>
    <div className={styles.chatContext} id={`${id}-context`}>
      <div className={styles.contextChip}><span aria-hidden="true"><IconDatabaseOutlineRegular size={12} /></span>
        <span>{receipt?.scope.id === 'personal' ? t('view.personal') : receipt?.scope.title ?? t('chat.noSource')}</span>
      </div>
      <strong className={styles.contextLabel}>{t('chat.context')}</strong>
      {props.fetchedAt && <p className={styles.muted}>{t('chat.currentSnapshot', {
        time: date(props.fetchedAt, props.timeZone ?? 'UTC', t),
      })}</p>}
      {context === null ? <p>{t('chat.contextUnavailable')}</p>
        : context.selection.view === 'personal' ? <>
          <p>{t('chat.personalContext')}</p>
          <span className={styles.badge}>{t(`attention.selected.${context.selection.attentionFilter ?? 'all'}`)}</span>
        </>
          : <>
            <p>{t('chat.adoContext', { type: context.selection.filters.type, page: context.selection.page + 1 })}</p>
            <p>{t('chat.orderContext', {
              column: t(context.selection.sort === 'title' ? 'table.titleColumn' : `table.${context.selection.sort}`),
              direction: t(context.selection.direction === 'asc' ? 'chat.ascending' : 'chat.descending'),
              size: context.selection.pageSize,
            })}</p>
            {criteria.map(({ key, label, value }) => <span key={key} className={styles.badge}>
              {t('export.criterion', { label, value })}
            </span>)}
            {context.selection.selectedItem !== null && <p>{t('detail.title', { id: context.selection.selectedItem })}</p>}
          </>}
      {context?.selection.stale && <p className={styles.warning}>{t('chat.staleContext')}</p>}
    </div>
      {active && state.hasMore && <Button variant="ghost" disabled={state.loadingOlder}
        onClick={() => { if (scopeId) { follow.current = false; void props.loadHistory(scopeId) } }}>
        {state.loadingOlder ? t('loading') : t('chat.older')}
      </Button>}
      {(!active || state.status === 'opening') && receipt !== null && <p role="status">{t('chat.opening')}</p>}
      {receipt === null && <p className={styles.muted}>{t('chat.noSource')}</p>}
      {ready && messages.length === 0 && !running && <p className={styles.chatEmpty}>{t(personalAdjustments ? 'adjustment.chatEmpty' : 'chat.empty')}</p>}
      <div role="log" aria-label={t('chat.history')} aria-live="polite" aria-relevant="additions text">
        {messages.map(message => <article key={`${scopeId}:${message.id}`} className={styles.chatMessage}
          data-role={message.role} aria-label={t(message.role === 'user' ? 'chat.you' : 'chat.assistant')}>
          <strong className={styles.chatRole}>{t(message.role === 'user' ? 'chat.you' : 'chat.assistant')}</strong>
          {message.role === 'assistant' && !message.streaming
            ? <FinalAnswer text={message.text} /> : <p className={styles.messageText}>{message.text}</p>}
          {message.interrupted && <p className={styles.muted}>{t('chat.stopped')}</p>}
          {message.role === 'assistant' && !message.streaming && <AnswerCopy text={message.text} t={t} />}
        </article>)}
      </div>
      {active && state.sessionId && personalAdjustments && <>
        <AttentionProposals proposals={personalAdjustments.state?.proposals ?? []} sessionId={state.sessionId}
          actions={personalAdjustments} zone={props.timeZone ?? 'UTC'} t={t} />
        <AttentionFeedback actions={personalAdjustments} t={t} />
      </>}
      {running && <p role="status" className={styles.muted}>{t('chat.responding')}</p>}
      {active && state.nativeError !== null && <p role="alert" className={styles.warning}>
        {t('chat.modelError')}<span className={styles.errorDetail}>{state.nativeError}</span>
      </p>}
      {active && state.error !== null && <p role="alert" className={styles.warning}>
        {t(`chat.error.${state.error}`)}
        {state.errorDetail !== null && <span className={styles.errorDetail}>{state.errorDetail}</span>}
      </p>}
      {active && state.status === 'error' && <Button variant="outline" onClick={() => { void props.retryHistory() }}>
        {t('chat.retryHistory')}
      </Button>}
    </div>
    <form className={styles.chatComposer} onSubmit={event => { event.preventDefault(); submit() }}>
      {pending && <p role="status">{t('chat.sending')}<span className={styles.pendingQuestion}>{state.pendingQuestion}</span></p>}
      {uncertain && <div className={styles.warning}>
        <p>{t('chat.retryCapture')}</p><p className={styles.pendingQuestion}>{state.retryQuestion}</p>
        <Button variant="outline" disabled={!ready || context === null || pending} onClick={() => {
          if (scopeId === undefined || state.retryRevision === null) return
          const revision = state.retryRevision
          void props.retryQuestion(scopeId).then(accepted => { if (accepted) actions.accepted(scopeId, revision) })
        }}>{t('chat.retryQuestion')}</Button>
      </div>}
      <QuestionSuggestions questions={questions} enabled={scopeId !== undefined} maxChars={maxChars} t={t} fill={text => {
        if (scopeId) { actions.question(scopeId, text); composer.current?.focus() }
      }} />
      <div className={styles.composerGroup}>
      <label className={styles.srOnly} htmlFor={`${id}-question`}>{t('chat.question')}</label>
      <textarea ref={composer} id={`${id}-question`} rows={3} value={draft.text}
        disabled={scopeId === undefined} maxLength={maxChars} aria-describedby={`${id}-context ${id}-limit ${id}-disclosure`}
        placeholder={t('chat.placeholder')}
        onChange={event => { if (scopeId) actions.question(scopeId, event.currentTarget.value) }} />
      <div className={styles.chatActions}>
        <span className={styles.modelLabel} title={t('chat.modelReadOnly')}>
          <span aria-hidden="true"><IconThinkOutlineRegular size={13} /></span>{t('chat.model')}</span>
        <span id={`${id}-limit`} className={styles.muted}>{t('chat.limit', { count: draft.text.length, max: maxChars })}</span>
        {running && <button type="button" className={styles.stopButton} onClick={() => { if (scopeId) void props.stopQuestion(scopeId) }}>
          <span aria-hidden="true"><IconStopFillRegular size={12} /></span>{t('chat.stop')}</button>}
        <button type="submit" className={styles.sendButton} aria-label={t('chat.send')} title={t('chat.send')}
          disabled={!ready || context === null || pending || running || uncertain || !draft.text.trim() || draft.text.length > maxChars}>
          <span aria-hidden="true"><IconSendOutlineRegular size={14} /></span></button>
      </div>
      </div>
      <p id={`${id}-disclosure`} className={styles.disclosure}>{t(personalAdjustments ? 'adjustment.chatDisclosure' : 'chat.disclosure')}</p>
    </form>
  </aside>
}
