/** Native five-column Taskboard surface. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { IconPlusOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TaskboardTask, TaskId, TaskStatus,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { NewTaskDialog } from './NewTaskDialog.tsx'
import { TaskCard } from './TaskCard.tsx'
import { TaskDetailsDialog } from './TaskDetailsDialog.tsx'
import { statusLabel, taskActivity, TASK_STATUSES } from './view.ts'
import css from './Taskboard.module.css'

const TASK_DRAG_MIME = 'application/x-dsh-taskboard-task'

/** Render the native root-scoped Taskboard surface. */
export function Taskboard(props: TaskboardSurfaceProps) {
  const taskboard = props.useTaskboard(snapshot => snapshot)
  const sessions = props.useSessions(snapshot => snapshot)
  const workspaces = props.useWorkspaces(snapshot => snapshot)
  const currentSession = sessions.current
  const currentWorkspace = currentSession === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(currentSession))?.workspaceId
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceId | 'all'>(currentWorkspace ?? 'all')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<TaskId>()
  const [draggedId, setDraggedId] = useState<TaskId>()
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [hostCopilotLaunch, setHostCopilotLaunch] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const matchingTasks = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return taskboard.tasks.filter(task => (workspaceFilter === 'all' || task.workspaceId === workspaceFilter)
      && (query === '' || [task.title, task.description, task.labels.join(' ')]
        .join(' ').toLocaleLowerCase().includes(query)))
  }, [search, taskboard.tasks, workspaceFilter])
  const tasks = matchingTasks.filter(task => (task.archivedAt !== undefined) === showArchived)
  const archiveCount = matchingTasks.filter(task => task.archivedAt !== undefined).length
  const now = Date.now()
  const selected = taskboard.tasks.find(task => task.id === selectedId)
  const runningDsh = new Set(tasks.flatMap(task =>
    task.sessionId !== undefined && taskActivity(task, sessions).running ? [task.sessionId] : [],
  ))
  const runningCopilot = new Set(tasks.flatMap(task =>
    task.agencyCopilotSessionId !== undefined && taskboard.agencyByTask[task.id]?.status === 'in_use'
      ? [task.agencyCopilotSessionId]
      : [],
  ))
  const running = runningDsh.size + runningCopilot.size
  const dragEnabled = !showArchived && workspaceFilter !== 'all' && search.trim() === ''
  const sourceError = taskboard.state === 'error'
    ? taskboard.error
    : workspaces.state === 'error' ? workspaces.error : null
  const creationWorkspace = workspaceFilter === 'all'
    ? currentWorkspace ?? workspaces.items[0]?.workspaceId
    : workspaceFilter
  const agencyTasks = taskboard.tasks.filter(task => task.archivedAt === undefined && task.agencyCopilotSessionId !== undefined)
  const agencyTaskKey = agencyTasks.map(task => `${task.id}:${task.agencyCopilotSessionId}`).join('|')

  useEffect(() => {
    if (selectedId !== undefined && selected === undefined) setSelectedId(undefined)
  }, [selected, selectedId])
  useEffect(() => { rootRef.current?.focus() }, [])
  useEffect(() => {
    let active = true
    props.agencyCopilotCapability().then(
      (available) => { if (active) setHostCopilotLaunch(available) },
      () => { if (active) setHostCopilotLaunch(false) },
    )
    return () => { active = false }
  }, [props.agencyCopilotCapability])
  useEffect(() => {
    if (workspaces.phase !== 'ready' || workspaceFilter === 'all') return
    if (!workspaces.items.some(workspace => workspace.workspaceId === workspaceFilter)) setWorkspaceFilter('all')
  }, [workspaceFilter, workspaces])

  const attempt = async (operation: () => Promise<void>) => {
    setError(undefined)
    setNotice(undefined)
    try {
      await operation()
    } catch (reason) {
      setError(props.t('error', { message: reason instanceof Error ? reason.message : String(reason) }))
    }
  }
  useEffect(() => {
    if (agencyTasks.length === 0) return
    let active = true
    props.refreshAgencyCopilot(agencyTasks).catch((reason: unknown) => {
      if (active) setError(props.t('error', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
    return () => { active = false }
    // The stable identity key deliberately controls refresh; task content/reorder changes do not rerun Agency.
  }, [agencyTaskKey])

  const drop = (status: TaskStatus, event: DragEvent<HTMLElement>, beforeTaskId?: TaskId) => {
    const payload = event.dataTransfer.getData(TASK_DRAG_MIME)
    const task = payload !== '' && payload === draggedId
      ? taskboard.tasks.find(candidate => candidate.id === payload && candidate.archivedAt === undefined)
      : undefined
    setDraggedId(undefined)
    if (!dragEnabled || task === undefined || (task.status === status && task.id === beforeTaskId)) return
    const anchor = beforeTaskId === undefined ? undefined : taskboard.tasks.find(candidate => candidate.id === beforeTaskId)
    if (anchor !== undefined && anchor.workspaceId !== task.workspaceId) return
    void attempt(() => props.moveTask(task, status, beforeTaskId))
  }
  const dragStart = (task: TaskboardTask, event: DragEvent<HTMLElement>) => {
    setDraggedId(task.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(TASK_DRAG_MIME, task.id)
  }
  const renderCard = (task: TaskboardTask) => (
    <TaskCard
      key={task.id}
      task={task}
      sessions={sessions}
      agencyStatus={taskboard.agencyState === 'error' ? 'unavailable' : taskboard.agencyByTask[task.id]?.status}
      t={props.t}
      now={now}
      selected={selectedId === task.id}
      draggable={dragEnabled}
      onOpen={() => {
        setError(undefined)
        setNotice(undefined)
        setSelectedId(task.id)
      }}
      onDragStart={(event) => { dragStart(task, event) }}
      onDragEnd={() => { setDraggedId(undefined) }}
      onDropBefore={(event) => {
        event.preventDefault()
        event.stopPropagation()
        drop(task.status, event, task.id)
      }}
    />
  )

  return (
    <div ref={rootRef} className={css.root} tabIndex={-1}>
      <header className={css.header}>
        <div>
          <div className={css.headingRow}><h1>{props.t('title')}</h1><span className={css.liveBadge}>{props.t('badge')}</span></div>
          <p>{showArchived
            ? props.t('archiveSubtitle', { count: tasks.length })
            : props.t('subtitle', { count: tasks.length, running })}</p>
        </div>
        <div className={css.headerActions}>
          <label className={css.search}>
            <IconSearchOutline16 />
            <input value={search} placeholder={props.t('search')} onChange={(event) => { setSearch(event.target.value) }} />
          </label>
          <select
            className={css.workspaceSelect}
            value={workspaceFilter}
            aria-label={props.t('workspace')}
            onChange={(event) => { setWorkspaceFilter(event.target.value as WorkspaceId | 'all') }}
          >
            <option value="all">{props.t('allWorkspaces')}</option>
            {workspaces.items.map(workspace => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>
            ))}
          </select>
          <button type="button" className={css.secondaryButton} onClick={props.closeSurface}>{props.t('close')}</button>
          <button type="button" className={showArchived ? css.primaryButton : css.secondaryButton} onClick={() => {
            setShowArchived(!showArchived)
            setSelectedId(undefined)
            setDraggedId(undefined)
          }}>{showArchived ? props.t('backToBoard') : props.t('archivedCount', { count: archiveCount })}</button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={creationWorkspace === undefined}
            onClick={() => {
              setError(undefined)
              setNotice(undefined)
              setNewTaskStatus('backlog')
            }}
          ><IconPlusOutline16 />{props.t('newTask')}</button>
        </div>
      </header>
      {error !== undefined && <div className={css.errorBanner}>{error}</div>}
      {notice !== undefined && <div className={css.noticeBanner}>{notice}</div>}
      {sourceError !== null ? <div className={css.errorBanner} role="alert">{sourceError.message}</div>
        : taskboard.phase === 'pending' || workspaces.phase === 'pending' ? <div className={css.centerMessage} role="status">{props.t('loading')}</div>
          : workspaces.items.length === 0 ? <div className={css.centerMessage}>{props.t('noWorkspace')}</div>
            : showArchived ? (
              <div className={css.archiveViewport}>
                <section className={css.archivePanel} aria-label={props.t('archiveTitle')}>
                  <div className={css.archiveHeader}>
                    <h2>{props.t('archiveTitle')}</h2>
                    <span className={css.count}>{tasks.length}</span>
                  </div>
                  <div className={css.archiveList}>{tasks.map(renderCard)}</div>
                  {tasks.length === 0 && <div className={css.empty}>{props.t('archiveEmpty')}</div>}
                </section>
              </div>
            ) : (
              <div className={css.boardViewport}>
                <div className={css.board}>
                  {TASK_STATUSES.map((status) => {
                    const columnTasks = tasks.filter(task => task.status === status)
                    return (
                      <section key={status} className={css.column} data-status={status}>
                        <div className={css.columnHeader}>
                          <span className={css.statusDot} />
                          <strong>{statusLabel(props.t, status)}</strong>
                          <span className={css.count}>{columnTasks.length}</span>
                        </div>
                        <div
                          className={css.cards}
                          onDragOver={(event) => { event.preventDefault() }}
                          onDrop={(event) => { event.preventDefault(); drop(status, event) }}
                        >
                          {columnTasks.map(renderCard)}
                          {columnTasks.length === 0 && <div className={css.empty}>{props.t('empty')}</div>}
                        </div>
                      </section>
                    )
                  })}
                </div>
              </div>
            )}
      {newTaskStatus !== undefined && creationWorkspace !== undefined && (
        <NewTaskDialog
          key={`${creationWorkspace}:${newTaskStatus}`}
          workspaceId={creationWorkspace}
          workspaces={workspaces}
          status={newTaskStatus}
          t={props.t}
          error={error}
          listAgencyCopilotSessions={props.listAgencyCopilotSessions}
          onCancel={() => { setNewTaskStatus(undefined) }}
          onCreate={request => attempt(async () => {
            const created = await props.createTask(request)
            setNewTaskStatus(undefined)
            setShowArchived(false)
            setSelectedId(created.id)
          })}
        />
      )}
      {selected !== undefined && (
        <TaskDetailsDialog
          key={`${selected.id}:${selected.archivedAt ?? ''}`}
          task={selected}
          sessions={sessions}
          workspaces={workspaces}
          agencyStatus={taskboard.agencyState === 'error' ? 'unavailable' : taskboard.agencyByTask[selected.id]?.status}
          isLoopback={props.isLoopback && hostCopilotLaunch}
          t={props.t}
          now={now}
          error={error}
          notice={notice}
          listAgencyCopilotSessions={props.listAgencyCopilotSessions}
          onClose={() => { setSelectedId(undefined) }}
          onSave={(title, description, priority, labels, agencyCopilotSessionId) => attempt(() => props.updateTask(selected, {
            title,
            description,
            priority: priority ?? null,
            labels,
            ...(agencyCopilotSessionId === undefined ? {} : { agencyCopilotSessionId }),
          }))}
          onMove={status => attempt(() => props.moveTask(selected, status))}
          onArchive={() => attempt(async () => {
            await props.archiveTask(selected)
            setSelectedId(undefined)
          })}
          onDelete={() => attempt(async () => {
            await props.deleteTask(selected)
            setSelectedId(undefined)
          })}
          onStart={() => attempt(() => props.startWork(selected))}
          onOpenSession={() => {
            if (selected.sessionId !== undefined) props.openSession(selected.sessionId)
          }}
          onStartAgencyCopilot={() => attempt(async () => {
            await props.startAgencyCopilot(selected)
            setNotice(props.t('copilotStartAccepted'))
          })}
          onOpenAgencyCopilot={() => attempt(async () => {
            const outcome = await props.openAgencyCopilot(selected)
            setNotice(outcome === 'launch-pending'
              ? props.t('copilotLaunchPending')
              : outcome === 'already-running' ? props.t('copilotAlreadyRunning')
                : outcome === 'resume-accepted' ? props.t('copilotResumeAccepted') : props.t('copilotRetryAccepted'))
          })}
          onClearAgencyCopilot={() => attempt(() => props.clearAgencyCopilot(selected))}
          onRefreshAgencyCopilot={() => attempt(() => props.refreshAgencyCopilot([selected]))}
        />
      )}
    </div>
  )
}
