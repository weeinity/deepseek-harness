/** Global navigation row in both wide and rail sidebar modes. */
import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LauncherProps } from './contract.ts'

export function DashboardLauncher({ size }: LauncherProps) {
  return <IconGaugeOutlineRegular size={size} />
}
