/**
 * Resolve `$DSH_HOME` the same way first-party packages do, without depending
 * on `@deepseek-ai/dsh-home-paths` (keeps this plugin installable against any
 * profile that only exposes `ctx.llm`).
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Default Harness home directory name under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Environment override for the Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Expand `~` / `~/` prefixes.
 * @param path - configured path that may begin with a tilde.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the Harness home.
 * Precedence: explicit path, `$DSH_HOME`, then `~/.dsh`.
 * @param configured - explicit override.
 * @param env - environment mapping.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured
    ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME))
  return resolve(expandHomePath(selected))
}

/**
 * Default path of the durable OAuth credential file.
 * @param configuredHome - optional explicit Harness home.
 */
export function defaultAuthPath(configuredHome?: string): string {
  return join(resolveDshHome(configuredHome), 'pi-ai-oauth.json')
}
