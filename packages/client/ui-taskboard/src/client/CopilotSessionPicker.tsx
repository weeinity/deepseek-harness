/** Workspace-scoped selection of an existing Copilot CLI session. */
import { useEffect, useState } from 'react'
import type {
  AgencyCopilotSessionId, TaskboardListAgencyCopilotSessionsValue,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { agencyStatusLabel } from './view.ts'
import css from './Taskboard.module.css'

interface CopilotSessionPickerProps {
  readonly workspaceId: WorkspaceId
  readonly value: AgencyCopilotSessionId | undefined
  readonly disabled: boolean
  readonly t: TaskboardSurfaceProps['t']
  readonly listSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
  readonly onChange: (sessionId: AgencyCopilotSessionId | undefined) => void
}

type Discovery =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: TaskboardListAgencyCopilotSessionsValue }
  | { readonly state: 'error'; readonly message: string }

/**
 * Select an existing session without launching or resuming it.
 * @param props - Workspace, selected identity, discovery callback, and localized copy.
 * @returns the session selector with explicit discovery progress and retry.
 */
export function CopilotSessionPicker(props: CopilotSessionPickerProps) {
  const [discovery, setDiscovery] = useState<Discovery>({ state: 'loading' })
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setDiscovery({ state: 'loading' })
    props.listSessions(props.workspaceId).then(
      (value) => { if (active) setDiscovery({ state: 'ready', value }) },
      (reason: unknown) => {
        if (active) setDiscovery({ state: 'error', message: reason instanceof Error ? reason.message : String(reason) })
      },
    )
    return () => { active = false }
  }, [props.listSessions, props.workspaceId, refresh])
  const sessions = discovery.state === 'ready' ? discovery.value.sessions : []
  return (
    <div className={css.sessionPicker}>
      <label className={css.field}>{props.t('copilotSession')}
        <select
          value={props.value ?? ''}
          disabled={props.disabled}
          onChange={(event) => {
            const value = event.target.value
            if (value === '') props.onChange(undefined)
            else if (value === props.value) props.onChange(props.value)
            else {
              const selected = sessions.find(session => session.sessionId === value)
              if (selected === undefined) throw new Error('Copilot session selection is not in the displayed options')
              props.onChange(selected.sessionId)
            }
          }}
        >
          <option value="">{props.t('copilotSessionNone')}</option>
          {props.value !== undefined && !sessions.some(session => session.sessionId === props.value) && (
            <option value={props.value}>{props.t('copilotSessionSelected', { id: props.value })}</option>
          )}
          {sessions.map(session => (
            <option key={session.sessionId} value={session.sessionId}>
              {props.t('copilotSessionOption', {
                session: session.summary === undefined || session.summary === '' ? session.sessionId
                  : props.t('copilotSessionSummary', { summary: session.summary, id: session.sessionId.slice(0, 8) }),
                status: agencyStatusLabel(session.status, props.t),
              })}
            </option>
          ))}
        </select>
      </label>
      <div className={css.sessionPickerFeedback}>
        {discovery.state === 'loading' && <span role="status">{props.t('copilotSessionsLoading')}</span>}
        {discovery.state === 'error' && <span role="alert">{props.t('copilotSessionsError', { message: discovery.message })}</span>}
        {discovery.state === 'ready' && discovery.value.sessions.length === 0 && (
          <span role="status">{props.t('copilotSessionsEmpty')}</span>
        )}
        {discovery.state === 'ready' && discovery.value.truncated && <span role="status">{props.t('copilotSessionsTruncated')}</span>}
        <button
          type="button"
          className={css.secondaryButton}
          disabled={props.disabled || discovery.state === 'loading'}
          onClick={() => { setRefresh(current => current + 1) }}
        >{props.t('copilotSessionsRefresh')}</button>
      </div>
      <p className={css.fieldHint}>{props.t('copilotSessionHint')}</p>
    </div>
  )
}
