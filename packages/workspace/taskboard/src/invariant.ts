/** Package-owned invariant companion for the Taskboard service. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-taskboard'
/** Cordis companion plugin name. */
export const name = 'taskboard-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']
/** No runtime invariant: the domain schema and service CAS enforce durable Taskboard writes. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
