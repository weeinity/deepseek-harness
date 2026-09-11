/** Editable task creation and copy flow with separately awaited source archival. */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TaskboardCreateRequest, TaskboardTask, TaskConnection, TaskPriority, TaskStatus } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ExecutionDraft, TaskboardSurfaceProps } from './contract.ts'
import { ConnectionPicker } from './ConnectionPicker.tsx'
import { ExecutionFields } from './ExecutionFields.tsx'
import { priorityLabel, TASK_PRIORITIES } from './view.ts'
import css from './Taskboard.module.css'

/** Inputs for a new task or an editable copy without provider linkage. */
export interface NewTaskDialogProps {
  readonly workspaceId: WorkspaceId
  readonly workspaces: WorkspaceSnapshot
  readonly sessions: SessionListState
  readonly status: TaskStatus
  readonly initial?: TaskboardCreateRequest
  readonly sourceTask?: TaskboardTask
  readonly options: Awaited<ReturnType<TaskboardSurfaceProps['executionOptions']>> | undefined
  readonly t: TaskboardSurfaceProps['t']
  readonly listAgencyCopilotSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
  readonly onCancel: () => void
  readonly onCreate: (request: TaskboardCreateRequest) => Promise<TaskboardTask>
  /** Receive the saved task and whether to close instead of opening its details. */
  readonly onCreated: (task: TaskboardTask, closeAfterSave: boolean) => void
  readonly onArchiveOriginal: (task: TaskboardTask) => Promise<void>
}

/**
 * Create from an editable draft; a failed source archive never repeats creation.
 * Pending commands prevent dismissal and retain failure feedback.
 * @param props - Initial inputs, authoritative options, and mutation callbacks.
 * @returns a new-task or editable-copy modal.
 */
export function NewTaskDialog(props: NewTaskDialogProps) {
  const { t } = props
  const [workspaceId, setWorkspaceId] = useState(props.initial?.workspaceId ?? props.workspaceId)
  const [title, setTitle] = useState(props.initial?.title ?? '')
  const [description, setDescription] = useState(props.initial?.description ?? '')
  const [priority, setPriority] = useState<TaskPriority | undefined>(props.initial?.priority)
  const [labels, setLabels] = useState(props.initial?.labels?.join(', ') ?? '')
  const [connection, setConnection] = useState<TaskConnection>()
  const [execution, setExecution] = useState<ExecutionDraft>({
    prompt: props.initial?.prompt ?? '', executionSettings: props.initial?.executionSettings ?? { kind: 'dsh' },
    schedule: props.initial?.schedule, handover: props.initial?.handover,
  })
  const [archiveOriginal, setArchiveOriginal] = useState(false)
  const [created, setCreated] = useState<{ task: TaskboardTask; closeAfterSave: boolean }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const complete = async (copy: TaskboardTask, closeAfterSave: boolean) => {
    if (archiveOriginal && props.sourceTask !== undefined) {
      try { await props.onArchiveOriginal(props.sourceTask) }
      catch (reason: unknown) {
        setError(t('archiveOriginalFailed', { message: reason instanceof Error ? reason.message : String(reason) }))
        return
      }
    }
    props.onCreated(copy, closeAfterSave)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const closeAfterSave = event.nativeEvent instanceof SubmitEvent
      && event.nativeEvent.submitter?.getAttribute('value') === 'close'
    setBusy(true)
    setError(undefined)
    void (async () => {
      if (created !== undefined) return complete(created.task, created.closeAfterSave)
      const copy = await props.onCreate({
        workspaceId, title, description, status: props.status, prompt: execution.prompt,
        executionSettings: execution.executionSettings, labels: labels.split(',').map(label => label.trim()).filter(Boolean),
        ...(priority === undefined ? {} : { priority }),
        ...(connection === undefined ? {} : { connection }),
        ...(execution.schedule === undefined ? {} : { schedule: {
          enabled: execution.schedule.enabled, cron: execution.schedule.cron, timeZone: execution.schedule.timeZone,
        } }),
        ...(execution.handover === undefined ? {} : { handover: execution.handover }),
      })
      setCreated({ task: copy, closeAfterSave })
      await complete(copy, closeAfterSave)
    })().catch((reason: unknown) => {
      setError(t('error', { message: reason instanceof Error ? reason.message : String(reason) }))
    }).finally(() => { setBusy(false) })
  }
  const disabled = busy || created !== undefined
  return <Modal open headless title={t(props.sourceTask === undefined ? 'newTask' : 'duplicate')}
    onClose={() => { if (!busy) props.onCancel() }} className={css.newTaskDialog ?? ''}>
    <form className={css.modal} onSubmit={submit}>
      <div className={css.modalHeader}><h2>{t(props.sourceTask === undefined ? 'newTask' : 'duplicate')}</h2></div>
      {error !== undefined && <div className={css.errorBanner} role="alert">{error}</div>}
      {created !== undefined && <p role="status">{t('copyCreated')}</p>}
      <label className={css.field}>{t('taskTitle')}
        <input required autoFocus disabled={disabled} placeholder={t('taskTitlePlaceholder')} value={title} onChange={(event) =>{  setTitle(event.target.value) }} />
      </label>
      <label className={css.field}>{t('description')}
        <textarea disabled={disabled} placeholder={t('taskDescriptionPlaceholder')} value={description}
          onChange={(event) => { setDescription(event.target.value) }} />
      </label>
      <label className={css.field}>{t('workspace')}
        <select disabled={disabled} value={workspaceId} onChange={(event) => {
          setWorkspaceId(event.target.value as WorkspaceId)
          setConnection(undefined)
        }}>
          {props.workspaces.items.map(workspace =>
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
        </select>
      </label>
      <div className={css.propertyGrid}>
        <label className={css.field}>{t('priority')}
          <select value={priority ?? ''} disabled={disabled} onChange={(event) =>{  setPriority(event.target.value === '' ? undefined : event.target.value as TaskPriority) }}>
            <option value="">{t('priorityNone')}</option>
            {TASK_PRIORITIES.map(value => <option key={value} value={value}>{priorityLabel(t, value)}</option>)}
          </select>
        </label>
        <label className={css.field}>{t('labels')}
          <input disabled={disabled} value={labels} placeholder={t('labelsHint')} onChange={(event) =>{  setLabels(event.target.value) }} />
        </label>
      </div>
      <label className={css.field}>{t('connectionKind')}
        <select disabled={disabled} value={execution.executionSettings.kind} onChange={(event) => {
          setExecution({ ...execution, executionSettings: event.target.value === 'copilot' ? { kind: 'copilot', permission: 'read-only' } : { kind: 'dsh' } })
          setConnection(undefined)
        }}>
          <option value="dsh">{t('dsh')}</option><option value="copilot">{t('copilot')}</option>
        </select>
      </label>
      <ConnectionPicker key={`${workspaceId}:${execution.executionSettings.kind}`} kind={execution.executionSettings.kind}
        value={connection} workspaceId={workspaceId} workspaces={props.workspaces} sessions={props.sessions}
        disabled={disabled} t={t} listSessions={props.listAgencyCopilotSessions} onChange={setConnection} />
      <ExecutionFields value={execution} options={props.options} disabled={disabled} compositionLocked={false} t={t}
        sourceConnections={[
          ...(props.workspaces.items.find(item => item.workspaceId === workspaceId)?.sessionIds ?? [])
            .map(sessionId => ({ kind: 'dsh' as const, sessionId })),
          ...(connection?.kind === 'copilot' ? [connection] : []),
        ]} onChange={setExecution} />
      {props.sourceTask !== undefined && props.sourceTask.archivedAt === undefined && <label className={css.checkbox}>
        <input type="checkbox" disabled={disabled} checked={archiveOriginal} onChange={(event) =>{  setArchiveOriginal(event.target.checked) }} />{t('archiveOriginal')}
      </label>}
      <div className={css.modalActions}>
        <button type="button" className={css.secondaryButton} disabled={busy}
          onClick={() => {
            if (created === undefined) props.onCancel()
            else props.onCreated(created.task, true)
          }}>{t(created === undefined ? 'cancel' : 'finishCopy')}</button>
        {created === undefined && <button className={css.primaryButton} type="submit" value="close"
          disabled={busy || props.options === undefined}>{t('saveAndClose')}</button>}
        <button className={css.primaryButton} type="submit" disabled={busy || props.options === undefined}>
          {t(created === undefined ? 'save' : 'retryArchive')}
        </button>
      </div>
    </form>
  </Modal>
}
