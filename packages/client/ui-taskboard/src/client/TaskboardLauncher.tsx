/** Sidebar launcher for the first-class Taskboard surface. */
import { IconListPenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskboardLauncherProps } from './contract.ts'
import css from './TaskboardLauncher.module.css'

/**
 * Render the Taskboard navigation row in wide and rail sidebar modes.
 * @param props - Sidebar mode, active main surface, task source, and navigation callback.
 * @returns the localized launcher with its active-task count.
 */
export function TaskboardLauncher({ wide, mainSurface, useTaskboard, toggleSurface, t }: TaskboardLauncherProps) {
  const count = useTaskboard(snapshot => snapshot.tasks.filter(task => task.archivedAt === undefined).length)
  const active = mainSurface === 'taskboard'
  return (
    <button
      type="button"
      className={css.trigger}
      data-wide={wide || undefined}
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      aria-label={t('launcher')}
      title={wide ? undefined : t('launcher')}
      onClick={toggleSurface}
    >
      <IconListPenOutline16 size={wide ? 16 : 18} />
      {wide && <><span className={css.label}>{t('launcher')}</span><span className={css.count}>{count}</span></>}
    </button>
  )
}
