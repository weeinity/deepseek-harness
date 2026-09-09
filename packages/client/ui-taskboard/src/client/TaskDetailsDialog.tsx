/** Task details, linked sessions, and actions in a centered dialog. */
import { useEffect, useState } from 'react'
import {
  IconArchiveOutline20, IconBranchOutline16, IconCheckOutline14, IconCloseOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  AgencyCopilotObservationStatus, AgencyCopilotSessionId, TaskboardTask, TaskPriority, TaskStatus,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { CopilotSessionPicker } from './CopilotSessionPicker.tsx'
import {
  agencyStatusLabel, priorityLabel, statusLabel, taskActivity, taskCode, taskTimeLabel, TASK_PRIORITIES, TASK_STATUSES, workspaceTitle,
} from './view.ts'
import css from './Taskboard.module.css'

/** Data and operations for an active or read-only archived task. */
export interface TaskDetailsDialogProps {
  readonly task: TaskboardTask
  readonly sessions: SessionListState
  readonly workspaces: WorkspaceSnapshot
  readonly t: TaskboardSurfaceProps['t']
  readonly now: number
  readonly error: string | undefined
  readonly notice: string | undefined
  readonly onClose: () => void
  readonly onSave: (
    title: string,
    description: string,
    priority: TaskPriority | undefined,
    labels: readonly string[],
    agencyCopilotSessionId: AgencyCopilotSessionId | null | undefined,
  ) => Promise<void>
  readonly onMove: (status: TaskStatus) => Promise<void>
  readonly onArchive: () => Promise<void>
  readonly onDelete: () => Promise<void>
  readonly onStart: () => Promise<void>
  readonly onOpenSession: () => void
  readonly agencyStatus: AgencyCopilotObservationStatus | 'unavailable' | undefined
  readonly isLoopback: boolean
  readonly onStartAgencyCopilot: () => Promise<void>
  readonly onOpenAgencyCopilot: () => Promise<void>
  readonly onClearAgencyCopilot: () => Promise<void>
  readonly onRefreshAgencyCopilot: () => Promise<void>
  readonly listAgencyCopilotSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
}

function agencyStatusClass(
  status: AgencyCopilotObservationStatus | 'unavailable' | undefined,
  styles: Record<'running' | 'blocked' | 'linked', string>,
): string {
  if (status === 'in_use') return styles.running
  if (status === 'workspace_mismatch') return styles.blocked
  return styles.linked
}

/**
 * Render task details; archived tasks permit deletion and DSH navigation but not editing or launch.
 * @param props - Selected task, current session data, localized copy, and task operations.
 * @returns a centered task-details modal.
 */
export function TaskDetailsDialog(props: TaskDetailsDialogProps) {
  const [title, setTitle] = useState(props.task.title)
  const [description, setDescription] = useState(props.task.description)
  const [priority, setPriority] = useState<TaskPriority | ''>(props.task.priority ?? '')
  const [labels, setLabels] = useState(props.task.labels.join(', '))
  const [copilotSelection, setCopilotSelection] = useState<AgencyCopilotSessionId | null>()
  const selectedCopilot = copilotSelection === undefined ? props.task.agencyCopilotSessionId : copilotSelection ?? undefined
  const copilotChanged = selectedCopilot !== props.task.agencyCopilotSessionId
  useEffect(() => { setCopilotSelection(undefined) }, [props.task.agencyCopilotSessionId])
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const archived = props.task.archivedAt !== undefined
  const run = (operation: () => Promise<void>) => {
    setBusy(true)
    void operation().finally(() => { setBusy(false) })
  }
  const activity = taskActivity(props.task, props.sessions)
  if (confirmDelete) {
    return (
      <Modal
        open
        title={props.t('deleteTaskTitle')}
        closeLabel={props.t('close')}
        onClose={() => { if (!busy) setConfirmDelete(false) }}
        footer={<>
          <button
            type="button"
            className={css.secondaryButton}
            disabled={busy}
            autoFocus
            onClick={() => { setConfirmDelete(false) }}
          >{props.t('cancel')}</button>
          <button type="button" className={css.deleteButton} disabled={busy} onClick={() => { run(props.onDelete) }}>
            <IconTrashOutline16 />{props.t('deleteTask')}
          </button>
        </>}
      >
        <p className={css.deleteMessage}>{props.t('deleteTaskMessage', { title: props.task.title })}</p>
        {props.error !== undefined && <p role="alert" className={css.deleteError}>{props.error}</p>}
      </Modal>
    )
  }
  return (
    <Modal open headless title={props.t('taskDetails')} onClose={props.onClose} className={css.detailsDialog ?? ''}>
      <div className={css.detailsHeader}>
        <input
          className={css.titleInput}
          aria-label={props.t('taskTitle')}
          readOnly={archived}
          autoFocus={!archived}
          value={title}
          onChange={(event) => { setTitle(event.target.value) }}
        />
        <span className={css.statusBadge} data-status={props.task.status}>{statusLabel(props.t, props.task.status)}</span>
        <button type="button" className={css.iconButton} autoFocus={archived} aria-label={props.t('close')} onClick={props.onClose}>
          <IconCloseOutline16 />
        </button>
      </div>
      <div className={css.detailsBody}>
        <div className={css.detailsMeta}>
          <span className={css.taskCode}>{taskCode(props.t, props.task)}</span>
          <time dateTime={props.task.updatedAt} title={props.task.updatedAt}>
            {props.t('updatedAt', { time: taskTimeLabel(props.t, props.task.updatedAt, props.now) })}
          </time>
        </div>
        {props.error !== undefined && <div className={css.errorBanner} role="alert">{props.error}</div>}
        {props.notice !== undefined && <div className={css.noticeBanner} role="status">{props.notice}</div>}
        {archived && <p className={css.fieldHint}>{props.t('archivedReadOnly')}</p>}
        <label className={css.field}>{props.t('description')}
          <textarea
            className={css.descriptionInput}
            readOnly={archived}
            value={description}
            onChange={(event) => { setDescription(event.target.value) }}
          />
        </label>
        <label className={css.field}>{props.t('workspace')}
          <input readOnly value={workspaceTitle(props.task, props.workspaces)} />
        </label>
        <div className={css.propertyGrid}>
          <label className={css.field}>{props.t('priority')}
            <select value={priority} disabled={archived} onChange={(event) => { setPriority(event.target.value as TaskPriority | '') }}>
              <option value="">{props.t('priorityNone')}</option>
              {TASK_PRIORITIES.map(value => (
                <option key={value} value={value}>{priorityLabel(props.t, value)}</option>
              ))}
            </select>
          </label>
          <label className={css.field}>{props.t('labels')}
            <input readOnly={archived} value={labels} placeholder={props.t('labelsHint')} onChange={(event) => { setLabels(event.target.value) }} />
          </label>
        </div>
        <section className={css.detailsSection}>
          <h3 className={css.sectionLabel}>{props.t('linkedSession')}</h3>
          <div className={css.sessionBox}>
            {props.task.sessionId === undefined ? <span>{props.t('noSession')}</span> : (
              <>
                <IconBranchOutline16 />
                <span className={css.sessionTitle}>
                  {props.sessions.byId[props.task.sessionId]?.displayTitle ?? props.task.sessionId}
                </span>
                {activity.running && <span className={css.running}><span className={css.pulse} />{props.t('live')}</span>}
              </>
            )}
          </div>
          <div className={css.sessionActions}>
            {props.task.sessionId !== undefined ? (
              <button type="button" className={css.secondaryButton} onClick={props.onOpenSession}>{props.t('openSession')}</button>
            ) : !archived && (
              <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { run(props.onStart) }}>
                {props.t('startWork')}
              </button>
            )}
          </div>
        </section>
        <section className={css.detailsSection}>
          <h3 className={css.sectionLabel}>{props.t('agencyCopilot')}</h3>
          {!archived && <CopilotSessionPicker
            workspaceId={props.task.workspaceId}
            value={selectedCopilot}
            disabled={busy}
            t={props.t}
            listSessions={props.listAgencyCopilotSessions}
            onChange={(sessionId) => { setCopilotSelection(sessionId ?? null) }}
          />}
          {!archived && copilotChanged && <p className={css.fieldHint}>{props.t('copilotSessionSave')}</p>}
          <div className={css.sessionBox}>
            {props.task.agencyCopilotSessionId === undefined ? <span>{props.t('noAgencyCopilot')}</span> : (
              <>
                <IconBranchOutline16 />
                <span className={css.sessionTitle}>{props.task.agencyCopilotSessionId}</span>
                {!archived && <span className={agencyStatusClass(props.agencyStatus, css)}>
                  {agencyStatusLabel(props.agencyStatus, props.t)}
                </span>}
              </>
            )}
          </div>
          {!archived && <div className={css.sessionActions}>
            {props.task.agencyCopilotSessionId === undefined ? (
              <button
                type="button"
                className={css.primaryButton}
                disabled={busy || copilotChanged || !props.isLoopback}
                title={props.isLoopback ? undefined : props.t('copilotLocalOnly')}
                onClick={() => { run(props.onStartAgencyCopilot) }}
              >{props.t('startAgencyCopilot')}</button>
            ) : (
              <>
                <button
                  type="button"
                  className={css.primaryButton}
                  disabled={busy || copilotChanged || !props.isLoopback}
                  title={props.isLoopback ? undefined : props.t('copilotLocalOnly')}
                  onClick={() => { run(props.onOpenAgencyCopilot) }}
                >{props.t('openAgencyCopilot')}</button>
                <button type="button" className={css.secondaryButton} disabled={busy || copilotChanged} onClick={() => { run(props.onRefreshAgencyCopilot) }}>
                  {props.t('refreshCopilot')}
                </button>
                <button type="button" className={css.secondaryButton} disabled={busy || copilotChanged} onClick={() => { run(props.onClearAgencyCopilot) }}>
                  {props.t('unlinkCopilot')}
                </button>
              </>
            )}
          </div>}
          {!archived && !props.isLoopback && <div className={css.fieldHint}>{props.t('copilotLocalOnly')}</div>}
        </section>
        {!archived && <section className={css.detailsSection}>
          <h3 className={css.sectionLabel}>{props.t('status')}</h3>
          <div className={css.statusPicker}>
            {TASK_STATUSES.map(status => (
              <button
                key={status}
                type="button"
                data-active={props.task.status === status || undefined}
                aria-pressed={props.task.status === status}
                disabled={busy || props.task.status === status}
                onClick={() => { run(() => props.onMove(status)) }}
              >{statusLabel(props.t, status)}</button>
            ))}
          </div>
        </section>}
      </div>
      <div className={css.detailsFooter}>
        {!archived && <>
          <button type="button" className={css.primaryButton} disabled={busy} onClick={() => {
            run(() => props.onSave(
              title,
              description,
              priority === '' ? undefined : priority,
              labels.split(',').map(label => label.trim()).filter(Boolean),
              selectedCopilot === props.task.agencyCopilotSessionId ? undefined : selectedCopilot ?? null,
            ))
          }}><IconCheckOutline14 />{props.t('save')}</button>
          <button type="button" className={css.archiveButton} disabled={busy} onClick={() => { run(props.onArchive) }}>
            <IconArchiveOutline20 size={16} />{props.t('archive')}
          </button>
          {props.task.status === 'in_progress' && (
            <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { run(() => props.onMove('in_review')) }}>
              {props.t('submitReview')}
            </button>
          )}
        </>}
        <button type="button" className={css.deleteButton} disabled={busy} onClick={() => { setConfirmDelete(true) }}>
          <IconTrashOutline16 />{props.t('deleteTask')}
        </button>
        <time className={css.createdTime} dateTime={props.task.createdAt} title={props.task.createdAt}>
          {props.t('createdAt', { time: taskTimeLabel(props.t, props.task.createdAt, props.now) })}
        </time>
      </div>
    </Modal>
  )
}
