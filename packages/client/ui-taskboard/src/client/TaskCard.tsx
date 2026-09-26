/** One draggable Taskboard card with live DSH execution decoration. */
import type { DragEvent, KeyboardEvent } from 'react'
import { IconLinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AgencyCopilotObservationStatus, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { agencyStatusLabel, priorityLabel, statusLabel, taskActivity, taskCode, taskTimeLabel } from './view.ts'
import css from './Taskboard.module.css'

/** Props of one Taskboard card. */
export interface TaskCardProps {
  readonly task: TaskboardTask
  readonly sessions: SessionListState
  readonly agencyStatus: AgencyCopilotObservationStatus | 'unavailable' | undefined
  readonly t: TaskboardSurfaceProps['t']
  readonly now: number
  readonly selected: boolean
  readonly draggable: boolean
  readonly dragging: boolean
  readonly moving: boolean
  readonly onOpen: () => void
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void
  readonly onDragEnd: () => void
  readonly onDropBefore: (event: DragEvent<HTMLElement>) => void
}

/**
 * Render one keyboard-openable, draggable task card.
 * @param props - Durable task, live activity, and card interactions.
 * @returns the task summary with its workflow status and execution activity.
 */
export function TaskCard(props: TaskCardProps) {
  const activity = taskActivity(props.task, props.sessions)
  const archived = props.task.archivedAt !== undefined
  const lastExecution = props.task.executions.at(-1)
  const openOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    props.onOpen()
  }
  return (
    <article
      className={css.card}
      aria-label={props.task.title}
      aria-busy={props.moving || undefined}
      title={props.draggable ? props.t('dragToMove') : undefined}
      data-selected={props.selected || undefined}
      data-dragging={props.dragging || undefined}
      data-archived={archived || undefined}
      data-running={!archived && (activity.running || props.agencyStatus === 'in_use') || undefined}
      data-blocked={!archived && activity.blocked || undefined}
      draggable={props.draggable}
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={openOnKey}
      onDragStart={props.draggable ? props.onDragStart : undefined}
      onDragEnd={props.draggable ? props.onDragEnd : undefined}
      onDrop={props.draggable ? props.onDropBefore : undefined}
    >
      {!archived && <div className={css.cardTop}>
        <span className={css.taskCode}>{taskCode(props.t, props.task)}</span>
        {props.task.priority !== undefined && (
          <span
            className={css.priority}
            data-priority={props.task.priority}
            title={priorityLabel(props.t, props.task.priority)}
          ><i /><i /><i /></span>
        )}
      </div>}
      <div className={css.cardTitle}>{props.task.title}</div>
      {props.task.description !== '' && <p className={css.cardDescription}>{props.task.description}</p>}
      {props.task.labels.length > 0 && <div className={css.labels}>
        {props.task.labels.slice(0, 4).map(label => <span key={label} className={css.label}>{label}</span>)}
      </div>}
      <div className={css.cardStatus}>
        <span className={css.statusBadge} data-status={props.task.status}>{statusLabel(props.t, props.task.status)}</span>
        {activity.blocked ? <span className={css.blocked}>{props.t('blocked')}</span>
          : activity.running && <span className={css.running}><span className={css.pulse} />{props.t('live')}</span>}
        {props.task.connection?.kind === 'copilot' && (
          <span className={!archived && props.agencyStatus === 'in_use' ? css.running : css.linked}>
            {archived ? props.t('copilotLinked') : agencyStatusLabel(props.agencyStatus, props.t)}
          </span>
        )}
        {lastExecution !== undefined && (
          <span>{props.t(`execution.${lastExecution.status}`)}</span>
        )}
      </div>
      <div className={css.cardFooter}>
        <time dateTime={props.task.updatedAt} title={props.task.updatedAt}>
          {props.t('updatedAt', { time: taskTimeLabel(props.t, props.task.updatedAt, props.now) })}
        </time>
        <span className={css.cardSpacer} />
        {props.task.connection === undefined ? <span>{props.t(props.task.unresolvedConnections === undefined ? 'noSession' : 'legacyChoice')}</span>
          : <span className={css.linked}><IconLinkOutline14 size={12} />{String(props.task.connection.sessionId).slice(0, 6)}</span>}
        {activity.jobs > 0 && <span>{props.t('jobs', { count: activity.jobs })}</span>}
      </div>
    </article>
  )
}
