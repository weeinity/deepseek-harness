/** Package-owned invariant companion for the Taskboard UI. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-taskboard'
/** Cordis companion plugin name. */
export const name = 'ui-taskboard-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']
/** No runtime invariant: slot declaration and controller injection fail loud during activation. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
