/**
 * Host half for @deepseek-ai/dsh-wa-ui.
 * Publishes only validated display fields through the Web server's boot table.
 * @module @deepseek-ai/dsh-wa-ui
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { CLIENT_CONFIG_KEY, resolveClientConfig, type Config } from './config.ts'
export { Config } from './config.ts'

/**
 * Supply page-local display configuration without exposing other Host settings.
 * @param ctx - Host plugin context.
 * @param config - Profile-owned assistant UI settings.
 */
export function apply(ctx: Context, config: Config): void {
  const value = resolveClientConfig(config)
  ctx.on('webserver/index-inject', table => {
    table.push({ kind: 'global', name: CLIENT_CONFIG_KEY, value })
  })
}
