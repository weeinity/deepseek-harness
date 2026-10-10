/** Session-linked task navigation through the existing Taskboard details dialog. */
import { useEffect, useState } from 'react'
import { Button, IconChecklistOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskId } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardSessionActionProps, TaskboardSessionButtonProps } from './contract.ts'
import { taskCode } from './view.ts'
import css from './Taskboard.module.css'

/**
 * Resolve current DSH associations for the header's bound Session.
 * @param props - Session identity, task snapshot, and owned root-scoped control.
 * @returns navigation for current links, including archived tasks, or no control.
 */
export function TaskSessionAction(props: TaskboardSessionActionProps) {
  const tasks = props.useTaskboard(snapshot => snapshot.tasks)
    .filter(task => task.connection?.kind === 'dsh' && task.connection.sessionId === props.sessionId)
  const [first, ...rest] = tasks
  if (first === undefined) return null
  return props.renderSlot('conversation.session.header.utilities.taskboard', { tasks: [first, ...rest] })
}

/**
 * Open one linked task directly or let the user choose among several.
 * @param props - Linked tasks, shared root navigation actions, and localized copy.
 * @returns a compact blue checkbox-icon action with an optional task-selection menu.
 */
export function TaskSessionButton(props: TaskboardSessionButtonProps) {
  const { tasks, actions, t } = props
  const [open, setOpen] = useState(false)
  const multiple = tasks.length > 1
  useEffect(() => { if (!multiple) setOpen(false) }, [multiple])
  const openTask = (taskId: TaskId) => {
    setOpen(false)
    actions.openTask(taskId)
    props.openSurface()
  }
  return (
    <Menu
      open={multiple && open}
      portal
      align="end"
      anchor={(
        <Button
          size="sm"
          variant="primary"
          className={css.sessionTaskButton}
          icon={<span className={css.sessionTaskIcon} aria-hidden="true"><IconChecklistOutlineRegular size={16} /></span>}
          title={t(multiple ? 'chooseTask' : 'openTaskHint')}
          aria-haspopup={multiple ? 'menu' : undefined}
          aria-expanded={multiple ? open : undefined}
          onClick={() => { if (multiple) setOpen(!open); else openTask(tasks[0].id) }}
        >{t('openTask')}</Button>
      )}
      items={tasks.map(task => ({
        id: task.id,
        label: t('taskOption', { id: taskCode(t, task), title: task.title }),
      }))}
      onSelect={(id) => { openTask(id as TaskId) }}
      onClose={() => { setOpen(false) }}
    />
  )
}
