/**
 * Serializable configuration and defaults.
 *
 * Composition and the optional `llm-oauth` settings section share this shape:
 * - `catalog` — OAuth-capable pi-ai ids this plugin may offer
 * - `providers` — enabled profiles (key present ⇒ route registered / models listed)
 *
 * Default `providers` is empty so installing the plugin does not dump every
 * catalog model into the picker. Enable via Settings → OAuth / 订阅, or by
 * writing a profile under `llm-oauth.providers.<id>`, or automatically on a
 * successful `/oauth login`.
 *
 * @module dsh-llm-oauth/config
 */

import '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PROVIDERS } from './catalog.ts'

/** One enabled OAuth provider profile (reserved for future knobs). */
export interface OAuthProviderProfile {
  /** Optional display override; defaults to the pi-ai catalog name. */
  displayName?: string
}

/** Serializable plugin options supplied by the profile composition. */
export interface Options {
  /**
   * pi-ai catalog provider ids that declare OAuth and may be enabled.
   * Defaults: xai, github-copilot, openai-codex, anthropic, openrouter, kimi-coding.
   */
  catalog?: string[]
  /**
   * Enabled OAuth routes. Presence of a key under `providers` turns that
   * catalog id on (registers the adapter route and lists its models).
   *
   * Legacy (v0.1) accepted a string array here meaning “always-on catalog”;
   * that form is still accepted and normalized to `catalog` + empty enablement
   * so upgrades stop flooding the model picker.
   */
  providers?: Record<string, OAuthProviderProfile> | string[]
  /** Override path for the durable OAuth credential file. */
  authPath?: string
}

/** Cordis-resolved configuration; provider enablement updates without remounting. */
export type Config = ReturnType<typeof Config>

/** Configuration after defaults. */
export interface ResolvedConfig {
  catalog: string[]
  providers: Record<string, OAuthProviderProfile>
  authPath?: string
}

/** Empty enabled-profile object accepted by the settings form. */
const ProviderProfileSchema: z<OAuthProviderProfile> = z.object({
  displayName: z.string(),
})

/**
 * Loader-visible configuration schema.
 * Shared by composition entry config and the `llm-oauth` settings section.
 */
export const Config = z.object({
  catalog: z.array(z.string()).default([...DEFAULT_PROVIDERS]),
  // Dict = enabled profiles. Array = legacy v0.1 “always register these ids”.
  providers: z.union([
    z.dict(ProviderProfileSchema),
    z.array(z.string()),
  ]).default({}).volatile(),
  authPath: z.string(),
})

function isProviderList(value: Options['providers']): value is string[] {
  return Array.isArray(value)
}

/**
 * Normalize composition input; legacy provider lists remain dormant.
 * @param config - partial or legacy configuration.
 * @returns catalog and enabled provider profiles.
 */
export function resolveConfig(config: Options = {}): ResolvedConfig {
  const legacyList = isProviderList(config.providers) ? config.providers : undefined
  const catalog = config.catalog
    ?? (legacyList !== undefined && legacyList.length > 0 ? [...legacyList] : [...DEFAULT_PROVIDERS])
  const providers = isProviderList(config.providers)
    ? {}
    : config.providers ?? {}
  return {
    catalog,
    providers,
    ...config.authPath === undefined ? {} : { authPath: config.authPath },
  }
}

/** Sorted list of enabled provider route ids. */
export function enabledProviderIds(config: Options | ResolvedConfig): string[] {
  const providers = resolveConfig(config).providers
  return Object.keys(providers).sort((a, b) => a.localeCompare(b))
}
