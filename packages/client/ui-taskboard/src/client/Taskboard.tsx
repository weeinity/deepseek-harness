/** Native five-column Taskboard surface. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { IconPlusOutline16, IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  TaskboardCreateRequest, TaskboardExecutionOptionsValue, TaskboardTask, TaskId, TaskStatus,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { NewTaskDialog } from './NewTaskDialog.tsx'
import { TaskCard } from './TaskCard.tsx'
import { TaskDetailsDialog } from './TaskDetailsDialog.tsx'
import { TaskboardSettings } from './TaskboardSettings.tsx'
import { statusLabel, taskActivity, taskboardErrorText, TASK_STATUSES } from './view.ts'
import css from './Taskboard.module.css'

const TASK_DRAG_MIME = 'application/x-dsh-taskboard-task'

/**
 * Render the native root-scoped Taskboard surface.
 * @param props - Live task, Session, and Workspace sources with task operations.
 * @returns the board, filters, and selected task dialog.
 */
export function Taskboard(props: TaskboardSurfaceProps) {
  const taskboard = props.useTaskboard(snapshot => snapshot)
  const sessions = props.useSessions(snapshot => snapshot)
  const workspaces = props.useWorkspaces(snapshot => snapshot)
  const requestedTaskId = props.useStore(state => state.requestedTaskId)
  const currentSession = sessions.current
  const currentWorkspace = currentSession === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(currentSession))?.workspaceId
  const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceId | 'all'>(currentWorkspace ?? 'all')
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState<TaskId>()
  const [draggedId, setDraggedId] = useState<TaskId>()
  const [dropStatus, setDropStatus] = useState<TaskStatus>()
  const [movingId, setMovingId] = useState<TaskId>()
  const [newTaskStatus, setNewTaskStatus] = useState<TaskStatus>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [hostCopilotLaunch, setHostCopilotLaunch] = useState(false)
  const [options, setOptions] = useState<TaskboardExecutionOptionsValue>()
  const [optionsError, setOptionsError] = useState<string>()
  const [optionsRefresh, setOptionsRefresh] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [copy, setCopy] = useState<{ source: TaskboardTask; initial: TaskboardCreateRequest }>()
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
    task.connection?.kind === 'dsh' && taskActivity(task, sessions).running ? [task.connection.sessionId] : [],
  ))
  const runningCopilot = new Set(tasks.flatMap(task =>
    task.connection?.kind === 'copilot' && taskboard.agencyByTask[task.id]?.status === 'in_use'
      ? [task.connection.sessionId]
      : [],
  ))
  const running = runningDsh.size + runningCopilot.size
  const dragEnabled = !showArchived && movingId === undefined
  const reorderEnabled = workspaceFilter !== 'all' && search.trim() === ''
  const draggedTask = tasks.find(task => task.id === draggedId)
  const sourceError = taskboard.state === 'error'
    ? taskboard.error
    : workspaces.state === 'error' ? workspaces.error : null
  const creationWorkspace = workspaceFilter === 'all'
    ? currentWorkspace ?? workspaces.items[0]?.workspaceId
    : workspaceFilter
  const agencyTasks = taskboard.tasks.filter(task => task.archivedAt === undefined && task.connection?.kind === 'copilot')
  const agencyTaskKey = agencyTasks.map(task => `${task.id}:${task.connection?.sessionId}`).join('|')

  useEffect(() => {
    if (selectedId !== undefined && selected === undefined) setSelectedId(undefined)
  }, [selected, selectedId])
  useEffect(() => { rootRef.current?.focus() }, [])
  useEffect(() => {
    if (requestedTaskId === undefined || taskboard.phase !== 'ready') return
    const task = taskboard.tasks.find(row => row.id === requestedTaskId)
    props.actions.completeTaskRequest(requestedTaskId)
    setNewTaskStatus(undefined)
    setCopy(undefined)
    setSettingsOpen(false)
    setNotice(undefined)
    setSelectedId(task?.id)
    if (task === undefined) {
      setError(props.t('taskMissing'))
      return
    }
    setError(undefined)
    setSearch('')
    setWorkspaceFilter(task.workspaceId)
    setShowArchived(task.archivedAt !== undefined)
  }, [requestedTaskId, taskboard.phase, taskboard.tasks, props.actions, props.t])
  useEffect(() => {
    let active = true
    setOptionsError(undefined)
    props.executionOptions().then(
      (value) => { if (active) setOptions(value) },
      (reason: unknown) => { if (active) setOptionsError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => { active = false }
  }, [props.executionOptions, optionsRefresh])
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
      setError(props.t('error', { message: taskboardErrorText(reason) }))
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

  const endDrag = () => {
    setDraggedId(undefined)
    setDropStatus(undefined)
  }
  const canDrop = (status: TaskStatus) => dragEnabled && draggedTask !== undefined
    && (draggedTask.status === status ? reorderEnabled : draggedTask.allowedManualStatuses.includes(status))
  const dragOver = (status: TaskStatus, event: DragEvent<HTMLElement>) => {
    if (!canDrop(status)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropStatus(status)
  }
  const drop = (status: TaskStatus, event: DragEvent<HTMLElement>, beforeTaskId?: TaskId) => {
    const task = draggedTask
    endDrag()
    if (!canDrop(status) || task === undefined || event.dataTransfer.getData(TASK_DRAG_MIME) !== task.id) return
    const effectiveBeforeTaskId = reorderEnabled ? beforeTaskId : undefined
    if (task.id === effectiveBeforeTaskId) return
    setMovingId(task.id)
    void attempt(async () => {
      try {
        await props.moveTask(task, status, effectiveBeforeTaskId)
      } finally {
        setMovingId(undefined)
      }
    })
  }
  const dragStart = (task: TaskboardTask, event: DragEvent<HTMLElement>) => {
    setDropStatus(undefined)
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
      dragging={draggedId === task.id}
      moving={movingId === task.id}
      onOpen={() => {
        setError(undefined)
        setNotice(undefined)
        setSelectedId(task.id)
      }}
      onDragStart={(event) => { dragStart(task, event) }}
      onDragEnd={endDrag}
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
          <button type="button" className={css.secondaryButton} onClick={() =>{  setSettingsOpen(true) }}>{props.t('settings')}</button>
          <button type="button" className={showArchived ? css.primaryButton : css.secondaryButton} onClick={() => {
            setShowArchived(!showArchived)
            setSelectedId(undefined)
            endDrag()
          }}>{showArchived ? props.t('backToBoard') : props.t('archivedCount', { count: archiveCount })}</button>
          <button
            type="button"
            className={css.primaryButton}
            disabled={creationWorkspace === undefined || taskboard.runtime?.settings.enabled !== true || options === undefined}
            onClick={() => {
              setError(undefined)
              setNotice(undefined)
              setNewTaskStatus('todo')
            }}
          ><IconPlusOutline16 />{props.t('newTask')}</button>
        </div>
      </header>
      {error !== undefined && <div className={css.errorBanner} role="alert">{error}</div>}
      {notice !== undefined && <div className={css.noticeBanner}>{notice}</div>}
      {taskboard.runtime?.error !== undefined && <div className={css.errorBanner} role="alert">
        {props.t('runtimeError', { message: taskboard.runtime.error })}
      </div>}
      {optionsError !== undefined && <div className={css.errorBanner} role="alert">
        {props.t('optionsError', { message: optionsError })}
        <button type="button" className={css.secondaryButton} onClick={() =>{  setOptionsRefresh(value => value + 1) }}>{props.t('optionsRetry')}</button>
      </div>}
      {sourceError !== null ? <div className={css.errorBanner} role="alert">{taskboardErrorText(sourceError)}</div>
        : taskboard.phase === 'pending' || workspaces.phase === 'pending' || taskboard.runtime === undefined
          ? <div className={css.centerMessage} role="status">{props.t('loading')}</div>
          : !taskboard.runtime.settings.enabled ? <div className={css.centerMessage}>{props.t('boardDisabled')}</div>
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
                        <section
                          key={status}
                          className={css.column}
                          data-status={status}
                          data-drop-target={dropStatus === status && canDrop(status) || undefined}
                          onDragOver={(event) => { dragOver(status, event) }}
                          onDragLeave={(event) => {
                            if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                            setDropStatus(current => current === status ? undefined : current)
                          }}
                          onDrop={(event) => { event.preventDefault(); drop(status, event) }}
                        >
                          <div className={css.columnHeader}>
                            <span className={css.statusDot} />
                            <strong>{statusLabel(props.t, status)}</strong>
                            <span className={css.count}>{columnTasks.length}</span>
                          </div>
                          <div className={css.cards}>
                            {columnTasks.map(renderCard)}
                            {columnTasks.length === 0 && <div className={css.empty}>{props.t('empty')}</div>}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>
              )}
      {settingsOpen && <TaskboardSettings runtime={taskboard.runtime} updateSettings={props.updateSettings}
        t={props.t} onClose={() =>{  setSettingsOpen(false) }} />}
      {newTaskStatus !== undefined && creationWorkspace !== undefined && (
        <NewTaskDialog
          key={`${creationWorkspace}:${newTaskStatus}`}
          workspaceId={creationWorkspace}
          workspaces={workspaces}
          sessions={sessions}
          options={options}
          status={newTaskStatus}
          t={props.t}
          listAgencyCopilotSessions={props.listAgencyCopilotSessions}
          {...(copy === undefined ? {} : { initial: copy.initial, sourceTask: copy.source })}
          onCancel={() => { setNewTaskStatus(undefined); setCopy(undefined) }}
          onCreate={props.createTask}
          onArchiveOriginal={props.archiveTask}
          onCreated={(created, closeAfterSave) => {
            setNewTaskStatus(undefined)
            setCopy(undefined)
            setShowArchived(false)
            setSelectedId(closeAfterSave ? undefined : created.id)
          }}
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
          options={options}
          listAgencyCopilotSessions={props.listAgencyCopilotSessions}
          onClose={() => { setSelectedId(id => id === selected.id ? undefined : id) }}
          onSave={(patch, expectedRevision) => props.updateTask({ ...selected, revision: expectedRevision }, patch)}
          onMove={status => props.moveTask(selected, status)}
          onArchive={async () => {
            await props.archiveTask(selected)
            setSelectedId(undefined)
          }}
          onDelete={async () => {
            await props.deleteTask(selected)
            setSelectedId(undefined)
          }}
          onRestore={async () => {
            await props.restoreTask(selected)
            setSelectedId(undefined)
          }}
          onDuplicate={(patch) => {
            const schedule = patch.schedule === null ? undefined : patch.schedule ?? selected.schedule
            const handover = patch.handover ?? undefined
            setCopy({ source: selected, initial: {
              workspaceId: patch.workspaceId, title: patch.title,
              description: patch.description, prompt: patch.prompt,
              executionSettings: patch.executionSettings, labels: patch.labels,
              ...(patch.priority == null ? {} : { priority: patch.priority }),
              ...(schedule === undefined ? {} : { schedule: { cron: schedule.cron, timeZone: schedule.timeZone, enabled: false } }),
              ...(handover === undefined ? {} : { handover }),
            } })
            setNewTaskStatus(selected.status)
            setSelectedId(undefined)
          }}
          onStart={requestId => props.startWork(selected, requestId)}
          onConnect={(connection, settings) => props.connectTask(selected, connection, settings)}
          onDisconnect={() => props.disconnectTask(selected)}
          onConfirmPermissions={() => props.confirmPermissions(selected)}
          onOpenSession={props.openSession}
          onOpenAgencyCopilot={async (executionId) => {
            const outcome = await props.openAgencyCopilot(selected, executionId)
            const messages = {
              'launch-pending': 'copilotLaunchPending',
              'already-running': 'copilotAlreadyRunning',
              'resume-accepted': 'copilotResumeAccepted',
            } as const
            setNotice(props.t(messages[outcome]))
          }}
          onRefreshAgencyCopilot={() => props.refreshAgencyCopilot([selected])}
        />
      )}
    </div>
  )
}
