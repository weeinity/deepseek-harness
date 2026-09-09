/** New durable Taskboard task dialog. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskboardCreateRequest, TaskStatus } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { NewTaskDraft, TaskboardSurfaceProps } from './contract.ts'
import { CopilotSessionPicker } from './CopilotSessionPicker.tsx'
import css from './Taskboard.module.css'

/** Props for the new-task modal. */
export interface NewTaskDialogProps {
  readonly workspaceId: WorkspaceId
  readonly workspaces: WorkspaceSnapshot
  readonly status: TaskStatus
  readonly t: TaskboardSurfaceProps['t']
  readonly error: string | undefined
  readonly listAgencyCopilotSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
  readonly onCancel: () => void
  readonly onCreate: (request: TaskboardCreateRequest) => Promise<void>
}

/** Render the new-task modal. */
export function NewTaskDialog(props: NewTaskDialogProps) {
  const [draft, setDraft] = useState<NewTaskDraft>({
    workspaceId: props.workspaceId,
    title: '',
    description: '',
  })
  const [busy, setBusy] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    void props.onCreate({ ...draft, status: props.status }).finally(() => { setBusy(false) })
  }
  return (
    <Modal open headless title={props.t('newTask')} onClose={props.onCancel} className={css.newTaskDialog ?? ''}>
      <form className={css.modal} onSubmit={submit}>
        <div className={css.modalHeader}>
          <h2>{props.t('newTask')}</h2>
        </div>
        {props.error !== undefined && <div className={css.errorBanner} role="alert">{props.error}</div>}
        <label className={css.field}>{props.t('taskTitle')}
          <input required autoFocus disabled={busy} placeholder={props.t('taskTitlePlaceholder')} value={draft.title} onChange={(event) => {
            setDraft(current => ({ ...current, title: event.target.value }))
          }} />
        </label>
        <label className={css.field}>{props.t('description')}
          <textarea disabled={busy} placeholder={props.t('taskDescriptionPlaceholder')} value={draft.description} onChange={(event) => {
            setDraft(current => ({ ...current, description: event.target.value }))
          }} />
        </label>
        <label className={css.field}>{props.t('workspace')}
          <select disabled={busy} value={draft.workspaceId} onChange={(event) => {
            setDraft(current => ({
              title: current.title, description: current.description, workspaceId: event.target.value as WorkspaceId,
            }))
          }}>
            {props.workspaces.items.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
        </label>
        <CopilotSessionPicker
          key={draft.workspaceId}
          workspaceId={draft.workspaceId}
          value={draft.agencyCopilotSessionId}
          disabled={busy}
          t={props.t}
          listSessions={props.listAgencyCopilotSessions}
          onChange={(sessionId) => {
            setDraft(current => ({
              title: current.title, description: current.description, workspaceId: current.workspaceId,
              ...(sessionId === undefined ? {} : { agencyCopilotSessionId: sessionId }),
            }))
          }}
        />
        <div className={css.modalActions}>
          <button type="button" className={css.secondaryButton} onClick={props.onCancel}>{props.t('cancel')}</button>
          <button className={css.primaryButton} type="submit" disabled={busy}>{props.t('createTask')}</button>
        </div>
      </form>
    </Modal>
  )
}
