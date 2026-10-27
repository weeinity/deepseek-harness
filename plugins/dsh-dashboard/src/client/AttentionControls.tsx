/** Local decisions and staged proposals are rendered only from Host-issued records. */
import { useId, useState } from 'react'
import type {
  AttentionActionId, AttentionIntent, AttentionItemState, AttentionProposal, AttentionProposalId, AttentionView,
} from '../shared/attention.ts'
import type { AttentionState } from './owner.ts'
import type { DashboardText } from './locale.ts'
import { attentionDeadline } from './attention-time.ts'
import { date, number } from './format.ts'
import { SourceLink } from './presentation.tsx'
import styles from './dsh-dashboard.module.css'

export interface AttentionActions {
  state?: AttentionState
  apply(item: AttentionItemState, intent: AttentionIntent): Promise<void>
  undo(actionId: AttentionActionId): Promise<void>
  decide(proposalId: AttentionProposalId, kind: 'confirm' | 'cancel'): Promise<void>
  retry(): Promise<void>
  read(): Promise<void>
}

function blocked(actions: AttentionActions): boolean {
  return actions.state?.status === 'writing' || actions.state?.pending != null
}

export function AttentionFeedback({ actions, t }: { actions: AttentionActions; t: DashboardText }) {
  const state = actions.state
  return <div className={styles.attentionFeedback} aria-live="polite">
    {state?.status === 'writing' && <p role="status">{t('adjustment.saving')}</p>}
    {state?.status === 'reading' && <p role="status">{t('adjustment.reading')}</p>}
    {state?.error && <p role="alert" className={styles.warning}>
      {t(`adjustment.error.${state.error}`)}
      {state.errorDetail && <span className={styles.errorDetail}>{state.errorDetail}</span>}
    </p>}
    {state?.pending && <button type="button" disabled={state.status === 'writing'} onClick={() => { void actions.retry() }}>
      {t('adjustment.retry')}
    </button>}
    {state?.error && <button type="button" disabled={state.status === 'reading'}
      onClick={() => { void actions.read() }}>{t('adjustment.reload')}</button>}
    {state?.mutation && <p role="status">{t('adjustment.saved')}
      {state.mutation.undoable && <button type="button" disabled={blocked(actions)}
        onClick={() => { void actions.undo(state.mutation!.id) }}>{t('adjustment.undo')}</button>}
    </p>}
  </div>
}

export function ItemAttentionControls({ item, actions, zone, t }: {
  item: AttentionItemState; actions: AttentionActions; zone: string; t: DashboardText
}) {
  const id = useId()
  const [snooze, setSnooze] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<'invalid' | 'gap' | 'ambiguous' | 'past' | null>(null)
  const disabled = blocked(actions) || item.ambiguous
  return <div className={styles.itemAttentionControls} role="group" aria-label={t('adjustment.controls', { title: item.title })}>
    {item.changed && <p className={styles.warning}>{t('adjustment.changed')}</p>}
    {item.ambiguous && <p className={styles.warning}>{t('adjustment.ambiguous')}</p>}
    {item.itemId !== null && <>
      <button type="button" disabled={disabled} onClick={() => { void actions.apply(item, { kind: 'hide' }) }}>{t('adjustment.hide')}</button>
      <button type="button" disabled={disabled} onClick={() => { void actions.apply(item, { kind: 'handle' }) }}>{t('adjustment.handle')}</button>
      <button type="button" disabled={disabled} aria-expanded={snooze} aria-controls={`${id}-snooze`}
        onClick={() => { setSnooze(!snooze); setError(null) }}>{t('adjustment.snooze')}</button>
    </>}
    {(item.disposition.mode !== 'visible' || item.itemId === null) && <button type="button" disabled={disabled}
      onClick={() => { void actions.apply(item, { kind: 'restore' }) }}>{t('adjustment.restore')}</button>}
    {item.itemId !== null && item.undoable && item.lastActionId && <button type="button" disabled={disabled}
      onClick={() => { void actions.undo(item.lastActionId!) }}>{t('adjustment.undo')}</button>}
    {snooze && item.itemId !== null && <form id={`${id}-snooze`} className={styles.attentionDeadline}
      onSubmit={event => {
        event.preventDefault()
        const deadline = attentionDeadline(input, zone, Date.now())
        if (!deadline.ok) { setError(deadline.error); return }
        setError(null)
        void actions.apply(item, { kind: 'snooze', until: deadline.until })
      }}>
      <label htmlFor={`${id}-until`}>{t('adjustment.deadline', { zone })}</label>
      <input id={`${id}-until`} type="datetime-local" step={60} required value={input} disabled={disabled}
        aria-invalid={error !== null} aria-describedby={error ? `${id}-error` : undefined}
        onChange={event => { setInput(event.currentTarget.value); setError(null) }} />
      {error && <p id={`${id}-error`} role="alert">{t(`adjustment.time.${error}`)}</p>}
      <button type="submit" disabled={disabled || !input}>{t('adjustment.snoozeApply')}</button>
      <button type="button" onClick={() => { setSnooze(false) }}>{t('adjustment.cancel')}</button>
    </form>}
  </div>
}

export function AttentionSummary({ view, t }: { view: AttentionView; t: DashboardText }) {
  return <div className={styles.attentionSummary}>
    <p>{t('adjustment.disclosure')}</p>
    <p>{t('adjustment.counts', {
      visible: number(view.visibleCount, t), hidden: number(view.hiddenCount, t),
      handled: number(view.handledCount, t), snoozed: number(view.snoozedCount, t),
    })}</p>
    <p>{t('adjustment.sourceCount', { count: number(view.sourceCount, t), loaded: number(view.loadedCount, t) })}
      {view.sourceCount === null && <> · {t('metric.unknown')}</>}</p>
  </div>
}

export function AttentionReview({ view, actions, zone, t }: {
  view: AttentionView; actions: AttentionActions; zone: string; t: DashboardText
}) {
  const saved = view.items.filter(item => item.revision > 0 || item.itemId === null)
  return <details className={styles.attentionReview}>
    <summary>{t('adjustment.review', { count: number(saved.length, t) })}</summary>
    <p>{t('adjustment.reviewHelp')}</p>
    {saved.length === 0 && <p>{t('adjustment.noSaved')}</p>}
    <ul className={styles.items}>{saved.map(item => <li key={`${item.key}:${item.itemId}`}>
      <SourceLink url={item.url} t={t}><strong>{item.title}</strong></SourceLink>
      <p>{t(`adjustment.mode.${item.disposition.mode}`)}
        {item.disposition.mode === 'snoozed' && <> · <time dateTime={item.disposition.until}>
          {date(item.disposition.until, zone, t)} · {zone}</time>
          <span className={styles.errorDetail}>{t('adjustment.exactDeadline', { value: item.disposition.until })}</span></>}
      </p>
      {item.effective.mode !== item.disposition.mode && <p>{t('adjustment.resurfaced')}</p>}
      {item.itemId === null && <p>{t('adjustment.absent')}</p>}
      <ItemAttentionControls item={item} actions={actions} zone={zone} t={t} />
    </li>)}</ul>
  </details>
}

export function AttentionProposals({ proposals, sessionId, actions, zone, t }: {
  proposals: readonly AttentionProposal[]; sessionId: string; actions: AttentionActions; zone: string; t: DashboardText
}) {
  const cards = proposals.filter(proposal => proposal.sessionId === sessionId)
  if (cards.length === 0) return null
  return <section className={styles.attentionProposals} aria-label={t('adjustment.proposals')}>
    <h3>{t('adjustment.proposals')}</h3>
    {cards.map(proposal => <article key={proposal.id} data-proposal={proposal.id}
      data-status={proposal.status} className={styles.attentionProposal}>
      <SourceLink url={proposal.target.url} t={t}><strong>{proposal.target.title}</strong></SourceLink>
      <p>{t(`adjustment.intent.${proposal.intent.kind}`)}</p>
      {proposal.intent.kind === 'snooze' && <p><time dateTime={proposal.intent.until}>
        {date(proposal.intent.until, zone, t)} · {zone}</time>
        <span className={styles.errorDetail}>{t('adjustment.exactDeadline', { value: proposal.intent.until })}</span></p>}
      <p>{t('adjustment.disclosure')}</p>
      <p role="status">{t(`adjustment.proposal.${proposal.status}`)}</p>
      {proposal.status === 'pending' && <div className={styles.itemAttentionControls}>
        <button type="button" disabled={blocked(actions)} onClick={() => { void actions.decide(proposal.id, 'confirm') }}>
          {t('adjustment.apply')}</button>
        <button type="button" disabled={blocked(actions)} onClick={() => { void actions.decide(proposal.id, 'cancel') }}>
          {t('adjustment.cancel')}</button>
      </div>}
    </article>)}
  </section>
}
