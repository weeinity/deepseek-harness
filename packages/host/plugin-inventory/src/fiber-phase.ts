/** Public lifecycle projection shared by the plugin and connector inventories. */
import type { FiberState } from '@deepseek-ai/cordis'
import type { PluginFiberPhase } from './types.ts'

/** FiberState is a cross-package const enum; these numeric keys mirror its published values. */
export const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>
