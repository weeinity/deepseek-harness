/** Task details with exclusive connection, saved execution inputs, and durable history. */
import { useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { IconArchiveOutline20, IconCheckOutline14, IconCloseOutline16, IconTrashOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgencyCopilotObservationStatus, TaskboardTask, TaskboardUpdatePatch, TaskConnection,
  TaskExecutionId, TaskExecutionSettings, TaskPriority, TaskRunRequestId, TaskStatus,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ExecutionDraft, TaskboardSurfaceProps } from './contract.ts'
import { ConnectionPicker } from './ConnectionPicker.tsx'
import { ExecutionFields } from './ExecutionFields.tsx'
import {
  agencyStatusLabel, priorityLabel, statusLabel, taskboardErrorText, taskCode, taskTimeLabel, TASK_PRIORITIES, TASK_STATUSES,
} from './view.ts'
import css from './Taskboard.module.css'

type PlanningPatch = Required<Pick<TaskboardUpdatePatch, 'title' | 'description' | 'priority' | 'labels'>>
type DraftPatch = PlanningPatch
  & Required<Pick<TaskboardUpdatePatch, 'workspaceId' | 'prompt' | 'executionSettings'>>
  & Pick<TaskboardUpdatePatch, 'schedule' | 'handover'>

/** Data and operations for active or archived task details. */
export interface TaskDetailsDialogProps {
  readonly task: TaskboardTask
  readonly sessions: SessionListState
  readonly workspaces: WorkspaceSnapshot
  readonly t: TaskboardSurfaceProps['t']
  readonly now: number
  readonly error: string | undefined
  readonly notice: string | undefined
  readonly options: Awaited<ReturnType<TaskboardSurfaceProps['executionOptions']>> | undefined
  readonly onClose: () => void
  /** The draft's original revision prevents incoming rows from authorizing stale edits. */
  readonly onSave: (patch: TaskboardUpdatePatch, expectedRevision: number) => Promise<void>
  readonly onMove: (status: TaskStatus) => Promise<void>
  readonly onArchive: () => Promise<void>
  readonly onDelete: () => Promise<void>
  readonly onRestore: () => Promise<void>
  /** Complete edited fields seed the copy; omitted schedule retains the saved schedule. */
  readonly onDuplicate: (patch: DraftPatch) => void
  readonly onStart: (requestId: TaskRunRequestId) => Promise<void>
  readonly onConnect: (connection: TaskConnection, settings?: TaskExecutionSettings) => Promise<void>
  readonly onDisconnect: () => Promise<void>
  readonly onConfirmPermissions: () => Promise<void>
  readonly onOpenSession: TaskboardSurfaceProps['openSession']
  readonly agencyStatus: AgencyCopilotObservationStatus | 'unavailable' | undefined
  readonly isLoopback: boolean
  readonly onOpenAgencyCopilot: (executionId?: TaskExecutionId) => Promise<void>
  readonly onRefreshAgencyCopilot: () => Promise<void>
  readonly listAgencyCopilotSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
}

interface Draft extends ExecutionDraft {
  readonly title: string
  readonly description: string
  readonly workspaceId: WorkspaceId
  readonly priority: TaskPriority | undefined
  readonly labels: string
}

/**
 * Render saved-input editing and explicit Run, Connect, Open, and Disconnect actions.
 * Pending commands prevent dismissal; status changes require saved inputs.
 * @param props - Authoritative task and framework-derived Session/Workspace data.
 * @returns the task dialog with Host-authorized status controls and execution history.
 */
export function TaskDetailsDialog(props: TaskDetailsDialogProps) {
  const { task, t } = props
  const saved: Draft = {
    title: task.title, description: task.description, workspaceId: task.workspaceId, priority: task.priority,
    labels: task.labels.join(', '), prompt: task.prompt, executionSettings: task.executionSettings,
    schedule: task.schedule, handover: task.handover,
  }
  const [edited, setEdited] = useState<{ readonly revision: number; readonly draft: Draft }>()
  const draft = edited?.draft ?? saved
  const editDraft = (value: Draft) => {
    setEdited(current => JSON.stringify(value) === JSON.stringify(saved)
      ? undefined
      : { revision: current?.revision ?? task.revision, draft: value })
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const executionDirty = draft.workspaceId !== saved.workspaceId || draft.prompt !== saved.prompt
    || JSON.stringify(draft.executionSettings) !== JSON.stringify(saved.executionSettings)
    || JSON.stringify(draft.handover) !== JSON.stringify(saved.handover)
    || draft.schedule?.enabled !== saved.schedule?.enabled || draft.schedule?.cron !== saved.schedule?.cron
    || draft.schedule?.timeZone !== saved.schedule?.timeZone
  const [selection, setSelection] = useState<TaskConnection>()
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [permissionReviewedRevision, setPermissionReviewedRevision] = useState<number>()
  const permissionReviewed = permissionReviewedRevision === task.revision
  const retry = useRef<{ revision: number; requestId: TaskRunRequestId }>()
  const archived = task.archivedAt !== undefined
  const openAttempt = task.executions.some(item => item.status === 'pending' || item.status === 'running')
  const reservedConnection = task.executions.some(item => item.status === 'pending' && item.createsConnection)
  const pinned = task.connection !== undefined || task.unresolvedConnections !== undefined
  const planningLocked = busy || archived
  const locked = planningLocked || openAttempt
  const connection = task.connection
  const missingSession = !reservedConnection && connection?.kind === 'dsh' && props.sessions.phase === 'ready'
    && props.sessions.byId[connection.sessionId] === undefined
  const error = localError ?? props.error
  const close = () => { if (!busy) props.onClose() }
  const run = (operation: () => Promise<void>) => {
    setBusy(true)
    setLocalError(undefined)
    void operation().catch((reason: unknown) => {
      setLocalError(t('error', { message: taskboardErrorText(reason) }))
    }).finally(() => { setBusy(false) })
  }
  const planningPatch = (): PlanningPatch => ({
    title: draft.title, description: draft.description, priority: draft.priority ?? null,
    labels: draft.labels.split(',').map(label => label.trim()).filter(Boolean),
  })
  const patch = (): DraftPatch => ({
    ...planningPatch(), workspaceId: draft.workspaceId, prompt: draft.prompt,
    executionSettings: draft.executionSettings, handover: draft.handover ?? null,
    ...(JSON.stringify(draft.schedule) === JSON.stringify(saved.schedule) ? {} : {
      schedule: draft.schedule === undefined ? null : {
        enabled: draft.schedule.enabled, cron: draft.schedule.cron, timeZone: draft.schedule.timeZone,
      },
    }),
  })
  const save = (closeAfterSave: boolean) => {
    run(async () => {
      await props.onSave(openAttempt ? planningPatch() : patch(), edited?.revision ?? task.revision)
      setEdited(undefined)
      if (closeAfterSave) props.onClose()
    })
  }
  const saveDisabled = planningLocked || (openAttempt && executionDirty) || draft.title.trim() === ''
  const sources: TaskConnection[] = [...new Map([
    ...(props.workspaces.items.find(item => item.workspaceId === draft.workspaceId)?.sessionIds ?? [])
      .map(sessionId => ({ kind: 'dsh' as const, sessionId })),
    ...(connection?.kind === 'copilot' ? [connection] : []),
    ...task.executions.flatMap(item => item.connection === undefined ? [] : [item.connection]),
  ].map(source => [JSON.stringify(source), source])).values()]
  if (confirmDelete) return <Modal open title={t('deleteTaskTitle')} closeLabel={t('close')}
    onClose={() => { if (!busy) setConfirmDelete(false) }}
    footer={<>
      <button type="button" className={css.secondaryButton} disabled={busy} autoFocus onClick={() =>{  setConfirmDelete(false) }}>{t('cancel')}</button>
      <button type="button" className={css.deleteButton} disabled={busy} onClick={() =>{  run(props.onDelete) }}>{t('deleteTask')}</button>
    </>}>
    <p className={css.deleteMessage}>{t('deleteTaskMessage', { title: task.title })}</p>
    {error !== undefined && <p role="alert" className={css.deleteError}>{error}</p>}
  </Modal>
  return <Modal open headless title={t('taskDetails')} onClose={close} className={css.detailsDialog ?? ''}>
    <div className={css.detailsHeader}>
      <input className={css.titleInput} aria-label={t('taskTitle')} disabled={planningLocked} autoFocus={!archived}
        value={draft.title} onChange={(event) => { editDraft({ ...draft, title: event.target.value }) }} />
      <span className={css.statusBadge} data-status={task.status}>{statusLabel(t, task.status)}</span>
      <button type="button" className={css.iconButton} autoFocus={archived} aria-label={t('close')} disabled={busy} onClick={close}><IconCloseOutline16 /></button>
    </div>
    <div className={css.detailsBody}>
      <div className={css.detailsMeta}>
        <span className={css.taskCode}>{taskCode(t, task)}</span>
        <time dateTime={task.updatedAt}>{t('updatedAt', { time: taskTimeLabel(t, task.updatedAt, props.now) })}</time>
      </div>
      {error !== undefined && <div className={css.errorBanner} role="alert">{error}</div>}
      {props.notice !== undefined && <div className={css.noticeBanner} role="status">{props.notice}</div>}
      {archived && <p className={css.fieldHint}>{t('archivedReadOnly')} {t('restoreHint')}</p>}
      <label className={css.field}>{t('description')}
        <textarea className={css.descriptionInput} disabled={planningLocked} value={draft.description}
          onChange={(event) => { editDraft({ ...draft, description: event.target.value }) }} />
      </label>
      <label className={css.field}>{t('workspace')}
        <select value={draft.workspaceId} disabled={locked || pinned} onChange={(event) => {
          editDraft({ ...draft, workspaceId: event.target.value as WorkspaceId })
          setSelection(undefined)
        }}>
          {props.workspaces.items.map(workspace =>
            <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}
        </select>
      </label>
      <div className={css.propertyGrid}>
        <label className={css.field}>{t('priority')}
          <select value={draft.priority ?? ''} disabled={planningLocked} onChange={(event) => {
            editDraft({ ...draft, priority: event.target.value === '' ? undefined : event.target.value as TaskPriority })
          }}>
            <option value="">{t('priorityNone')}</option>
            {TASK_PRIORITIES.map(value => <option key={value} value={value}>{priorityLabel(t, value)}</option>)}
          </select>
        </label>
        <label className={css.field}>{t('labels')}
          <input disabled={planningLocked} value={draft.labels} placeholder={t('labelsHint')}
            onChange={(event) => { editDraft({ ...draft, labels: event.target.value }) }} />
        </label>
      </div>
      <section className={css.detailsSection}>
        <h3 className={css.sectionLabel}>{t('connection')}</h3>
        {task.unresolvedConnections !== undefined ? <>
          <p role="alert" className={css.fieldHint}>{t('legacyHint')}</p>
          <div className={css.sessionActions}>{task.unresolvedConnections.map(choice =>
            <button key={choice.kind} type="button" className={css.secondaryButton} disabled={locked || dirty}
              onClick={() =>{  run(() => props.onConnect(choice, choice.kind === task.executionSettings.kind ? task.executionSettings
                : choice.kind === 'copilot' ? { kind: 'copilot', permission: 'read-only' } : { kind: 'dsh' })) }}>
              {t(choice.kind)}: {choice.sessionId}
            </button>)}</div>
        </> : connection !== undefined ? <>
          <div className={css.sessionBox}><span>{t(connection.kind)}</span><span className={css.sessionTitle}>{connection.sessionId}</span>
            {connection.kind === 'copilot' && <span>
              {reservedConnection ? t('execution.pending') : agencyStatusLabel(props.agencyStatus, t)}
            </span>}
          </div>
          {missingSession && <p role="alert" className={css.fieldHint}>{t('sessionMissing')}</p>}
          <div className={css.sessionActions}>
            {connection.kind === 'dsh'
              ? <button type="button" className={css.secondaryButton} disabled={busy || missingSession || reservedConnection}
                onClick={() =>{  props.onOpenSession(connection.sessionId) }}>{t('openSession')}</button>
              : <>
                <button type="button" className={css.secondaryButton} disabled={busy || !props.isLoopback || reservedConnection}
                  onClick={() =>{  run(() => props.onOpenAgencyCopilot()) }}>{t('openAgencyCopilot')}</button>
                <button type="button" className={css.secondaryButton} disabled={busy} onClick={() =>{  run(props.onRefreshAgencyCopilot) }}>{t('refreshCopilot')}</button>
              </>}
            {!archived && <button type="button" className={css.secondaryButton} disabled={locked || dirty}
              onClick={() =>{  run(props.onDisconnect) }}>{t('disconnect')}</button>}
          </div>
        </> : <>
          <label className={css.field}>{t('connectionKind')}
            <select disabled={locked} value={draft.executionSettings.kind} onChange={(event) => {
              editDraft({
                ...draft, executionSettings: event.target.value === 'copilot' ? { kind: 'copilot', permission: 'read-only' } : { kind: 'dsh' },
              })
              setSelection(undefined)
            }}>
              <option value="dsh">{t('dsh')}</option><option value="copilot">{t('copilot')}</option>
            </select>
          </label>
          {!archived && <ConnectionPicker kind={draft.executionSettings.kind} value={selection} workspaceId={draft.workspaceId}
            sessions={props.sessions} workspaces={props.workspaces} disabled={locked} t={t}
            listSessions={props.listAgencyCopilotSessions} onChange={setSelection} />}
          {!archived && <button type="button" className={css.secondaryButton} disabled={locked || dirty || selection === undefined}
            onClick={() => {
              /* v8 ignore next -- Connect is disabled without a selected conversation. */
              if (selection !== undefined) run(() => props.onConnect(selection))
            }}>{t('connect')}</button>}
        </>}
        {!archived && <div className={css.sessionActions}>
          <button type="button" className={css.primaryButton}
            disabled={locked || dirty || task.unresolvedConnections !== undefined || props.options === undefined
              || (connection === undefined && selection !== undefined)
              || (task.executionSettings.kind === 'copilot' && !props.options.copilotAvailable)}
            onClick={() =>{  run(async () => {
              if (retry.current?.revision !== task.revision) {
                retry.current = { revision: task.revision, requestId: randomUUID() as TaskRunRequestId }
              }
              await props.onStart(retry.current.requestId)
              retry.current = undefined
            }) }}>{t(task.executions.length === 0 ? 'startWork' : 'runAgain')}</button>
        </div>}
        <p className={css.fieldHint}>{t(dirty ? 'startWorkSave' : 'startWorkHint')}</p>
        {task.executionSettings.kind === 'copilot' && props.options?.copilotAvailable === false
          && <p className={css.fieldHint}>{t('copilotExecutionUnavailable')}</p>}
        {connection === undefined && selection !== undefined && <p className={css.fieldHint}>{t('connectSelection')}</p>}
      </section>
      <ExecutionFields value={draft} options={props.options} disabled={locked} compositionLocked={pinned}
        sourceConnections={sources} t={t} onChange={(value) => {
          editDraft({ ...draft, ...value })
          setPermissionReviewedRevision(undefined)
        }} />
      {!archived && <section className={css.detailsSection}>
        <h3 className={css.sectionLabel}>{t('confirmPermissions')}</h3>
        <p className={css.fieldHint}>{t('confirmPermissionHint')}</p>
        {task.permissionConfirmedAt !== undefined && <p>{t('permissionsConfirmed', { time: task.permissionConfirmedAt })}</p>}
        <label className={css.checkbox}><input type="checkbox" checked={permissionReviewed} disabled={locked || dirty}
          onChange={(event) =>{  setPermissionReviewedRevision(event.target.checked ? task.revision : undefined) }} />{t('confirmPermissionCheck')}</label>
        <button type="button" className={css.secondaryButton} disabled={locked || dirty || !permissionReviewed}
          onClick={() =>{  run(props.onConfirmPermissions) }}>{t('confirmPermissions')}</button>
      </section>}
      <section className={css.detailsSection}>
        <h3 className={css.sectionLabel}>{t('history')}</h3>
        {task.executions.length === 0 && <p className={css.fieldHint}>{t('noHistory')}</p>}
        <ol className={css.history}>{[...task.executions].reverse().map(execution => <li key={execution.id} className={css.historyItem}>
          <strong>{t(`execution.${execution.status}`)}</strong>
          <span>{t(execution.trigger === 'manual' ? 'manualRun' : 'scheduledRun')}</span>
          <time dateTime={execution.requestedAt}>{t('requestedAt', { time: execution.requestedAt })}</time>
          {execution.startedAt !== undefined && <time dateTime={execution.startedAt}>{t('startedAt', { time: execution.startedAt })}</time>}
          {execution.endedAt !== undefined && <time dateTime={execution.endedAt}>{t('endedAt', { time: execution.endedAt })}</time>}
          {execution.connection !== undefined && <button type="button" className={css.secondaryButton}
            disabled={busy || (execution.status === 'pending' && execution.createsConnection)
              || (execution.connection.kind === 'copilot' && !props.isLoopback)}
            onClick={() => {
              if (execution.connection?.kind === 'dsh') props.onOpenSession(execution.connection.sessionId)
              else run(() => props.onOpenAgencyCopilot(execution.id))
            }}>{t(execution.connection.kind)}: {execution.connection.sessionId}</button>}
          {execution.error !== undefined && <p role="alert">
            {t('executionError', { code: execution.error.code, message: execution.error.message })}
          </p>}
          <details><summary>{t('savedInput')}</summary><pre>{execution.prompt}</pre>
            <dl>
              <div><dt>{t('connectionKind')}</dt><dd>{t(execution.executionSettings.kind)}</dd></div>
              <div><dt>{t('permission')}</dt><dd>{execution.executionSettings.permission ?? t('defaultOption')}</dd></div>
              {execution.executionSettings.kind === 'dsh' && execution.executionSettings.presetId !== undefined
                && <div><dt>{t('preset')}</dt><dd>{execution.executionSettings.presetId}</dd></div>}
              {execution.executionSettings.model !== undefined && <div><dt>{t('model')}</dt><dd>
                {typeof execution.executionSettings.model === 'string' ? execution.executionSettings.model
                  : `${execution.executionSettings.model.provider}: ${execution.executionSettings.model.model}`}
              </dd></div>}
            </dl>
            {execution.handover !== undefined && <>
              <dl>{(['goal', 'progress', 'next'] as const).map(field =>
                <div key={field}><dt>{t(field)}</dt><dd>{execution.handover?.[field]}</dd></div>)}</dl>
              <p>{t('references')}</p><pre>{execution.handover.references.join('\n')}</pre>
              {execution.handover.source !== undefined && <p>{t('source')}: {t(execution.handover.source.kind)}: {execution.handover.source.sessionId}</p>}
              <time dateTime={execution.handover.frozenAt}>{t('frozenAt', { time: execution.handover.frozenAt })}</time>
            </>}
          </details>
        </li>)}</ol>
      </section>
      {!archived && <section className={css.detailsSection}>
        <h3 className={css.sectionLabel}>{t('status')}</h3>
        <div className={css.statusPicker}>{TASK_STATUSES.map(status => <button key={status} type="button"
          data-active={task.status === status || undefined} aria-pressed={task.status === status}
          disabled={busy || dirty || !task.allowedManualStatuses.includes(status)}
          onClick={() =>{  run(() => props.onMove(status)) }}>{statusLabel(t, status)}</button>)}</div>
      </section>}
    </div>
    <div className={css.detailsFooter}>
      {!archived && <>
        <button type="button" className={css.primaryButton}
          disabled={saveDisabled} onClick={() => { save(true) }}><IconCheckOutline14 />{t('saveAndClose')}</button>
        <button type="button" className={css.primaryButton}
          disabled={saveDisabled} onClick={() => { save(false) }}><IconCheckOutline14 />{t('save')}</button>
        <button type="button" className={css.archiveButton} disabled={busy || openAttempt} onClick={() =>{  run(props.onArchive) }}><IconArchiveOutline20 size={16} />{t('archive')}</button>
        {task.status === 'in_progress' && <button type="button" className={css.secondaryButton}
          disabled={busy || dirty || !task.allowedManualStatuses.includes('in_review')}
          onClick={() =>{  run(() => props.onMove('in_review')) }}>{t('submitReview')}</button>}
      </>}
      {archived && <button type="button" className={css.primaryButton} disabled={busy} onClick={() =>{  run(props.onRestore) }}>{t('restore')}</button>}
      <button type="button" className={css.secondaryButton} disabled={busy} onClick={() =>{  props.onDuplicate(patch()) }}>{t(dirty ? 'editAsCopy' : 'duplicate')}</button>
      <button type="button" className={css.deleteButton} disabled={busy || openAttempt} onClick={() =>{  setConfirmDelete(true) }}><IconTrashOutline16 />{t('deleteTask')}</button>
      <time className={css.createdTime} dateTime={task.createdAt}>{t('createdAt', { time: taskTimeLabel(t, task.createdAt, props.now) })}</time>
    </div>
  </Modal>
}
