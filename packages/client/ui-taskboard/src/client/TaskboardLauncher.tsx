/** Sidebar icon for the Taskboard global panel. */
import { IconListPenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskboardLauncherProps } from './contract.ts'

/**
 * Render the Taskboard glyph at the size requested by the sidebar.
 * @param props - Global-panel icon presentation.
 * @returns the decorative Taskboard icon.
 */
export function TaskboardLauncher({ size }: TaskboardLauncherProps) {
  return <IconListPenOutlineRegular size={size} />
}
