/**
 * Cordis activation: dormant-by-default OAuth adapter, settings section,
 * optional `/oauth` command, and optional HTTP API for the Settings panel.
 *
 * @module dsh-llm-oauth/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {
  AdapterRegistrationHandle,
} from '@deepseek-ai/dsh-llm'
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { OAuthPiAiAdapter } from './adapter.ts'
import { SETTINGS_NS, resolveOAuthProviders } from './catalog.ts'
import { handleOauthCommand } from './command.ts'
import {
  Config,
  enabledProviderIds,
  resolveConfig,
  type Options,
  type ResolvedConfig,
} from './config.ts'
import { defaultAuthPath } from './home.ts'
import { OAUTH_HTTP_PREFIX, handleOauthHttp } from './http.ts'
import { OAuthController } from './service.ts'
import { FileCredentialStore } from './store.ts'

const NS = SETTINGS_NS

/**
 * Apply the plugin to its Cordis context.
 * @param ctx - scoped plugin context; registrations are effects.
 * @param config - configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  const snapshot = (): ResolvedConfig => resolveConfig({ ...config, providers: config.providers.get() as NonNullable<Options['providers']> })
  const entry = snapshot()
  resolveOAuthProviders(entry.catalog)

  const authPath = entry.authPath ?? defaultAuthPath()
  const store = new FileCredentialStore(authPath)
  const adapter = new OAuthPiAiAdapter({
    authPath,
    store,
    catalog: entry.catalog,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })

  const settingsNs = ctx.fiber.entry?.options.id ?? NS
  let registration: AdapterRegistrationHandle | undefined
  let registeredRoutes: string[] = []

  const catalogIds = (): readonly string[] => snapshot().catalog

  const enabledIds = (): string[] => {
    const allowed = new Set(catalogIds())
    return enabledProviderIds(snapshot()).filter(id => allowed.has(id))
  }

  const ensureRoutes = (): void => {
    const routes = enabledIds()
    if (deepEqualJson(routes, registeredRoutes)) return
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredRoutes = routes
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredRoutes = routes
  }

  const refresh = (): void => {
    try {
      ensureRoutes()
    } catch (error) {
      ctx.logger.error('llm-oauth: keeping previous adapter routes after a refused update')
      ctx.logger.error(error)
    }
  }

  const assertServiceable = (value: Options): void => {
    const resolved = resolveConfig(value)
    resolveOAuthProviders(resolved.catalog)
    const allowed = new Set(resolved.catalog)
    for (const id of Object.keys(resolved.providers)) {
      if (!allowed.has(id)) {
        throw new Error(
          `dsh-llm-oauth: enabled provider "${id}" is not in catalog [${resolved.catalog.join(', ')}]`,
        )
      }
      resolveOAuthProviders([id])
      if (!registeredRoutes.includes(id) && ctx.llm.listProviders().some(provider => provider.id === id)) {
        throw new LlmError(`Provider "${id}" already has an adapter; remove its other provider configuration before enabling OAuth.`, 'DUPLICATE_ADAPTER')
      }
    }
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })

  assertServiceable(entry)
  ctx.on('internal/config', function (this: import('@deepseek-ai/cordis').Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    const candidate = Config(raw as Options)
    assertServiceable({ ...candidate, providers: candidate.providers.get() as NonNullable<Options['providers']> })
    return raw
  })
  ctx.on('loader/volatile-update', refresh)

  refresh()

  const controller = new OAuthController(adapter, {
    listEnabled: () => enabledIds(),
    enable: async (provider) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error(
          `dsh-llm-oauth: settings service is unavailable; add config.providers to entry "${settingsNs}" in cordis.patch.yml`,
        )
      }
      await settings.mutate(settingsNs, [
        { op: 'set', path: ['providers', provider], value: {} },
      ])
      ensureRoutes()
    },
    disable: async (provider) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error(
          `dsh-llm-oauth: settings service is unavailable; remove the provider from entry "${settingsNs}" in cordis.patch.yml`,
        )
      }
      await settings.mutate(settingsNs, [
        { op: 'unset', path: ['providers', provider] },
      ])
      ensureRoutes()
    },
  })

  const commands = ctx.get('commands') as {
    register(definition: {
      name: string
      description: string
      input?: { hint: string }
      handler: (invocation: { rawInput: string, signal?: AbortSignal }) => Promise<{ kind: string, text?: string }>
    }): void
  } | undefined
  if (commands !== undefined) {
    commands.register({
      name: 'oauth',
      description: 'OAuth / subscription providers: status, enable, login, logout',
      input: { hint: '[status|list|enable <provider>|disable <provider>|login <provider>|logout <provider>]' },
      handler: async (invocation) => {
        const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
        const action = (parts[0] ?? 'status').toLowerCase()
        const target = parts[1]

        if (action === 'enable') {
          if (target === undefined) return { kind: 'error', text: 'Usage: /oauth enable <provider>' }
          try {
            await controller.enable(target)
            return {
              kind: 'success',
              text: `Enabled ${target}. Its models appear in the picker; run /oauth login ${target} if you are not signed in.`,
            }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        }
        if (action === 'disable') {
          if (target === undefined) return { kind: 'error', text: 'Usage: /oauth disable <provider>' }
          try {
            await controller.disable(target)
            return { kind: 'success', text: `Disabled ${target}. Stored credentials (if any) were kept.` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        }
        if (action === 'login' && target !== undefined) {
          try {
            await controller.enable(target)
          } catch (error) {
            ctx.logger.warn(`[llm-oauth] could not auto-enable ${target} before login: ${String(error)}`)
          }
        }
        return handleOauthCommand(adapter, invocation.rawInput, invocation.signal)
      },
    })
  }

  // Optional HTTP API for the Settings panel. Connection applies the same
  // Host/Origin checks and browser-session authentication as the shared API.
  ctx.inject(['webServer', 'connection'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'prefix',
      path: OAUTH_HTTP_PREFIX,
      handler: (req, res) => {
        const rejection = httpCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        void handleOauthHttp(controller, req, res)
      },
    }), 'llm-oauth: http api')
  })

  ctx.logger.info(
    `[llm-oauth] catalog=[${adapter.catalogIds().join(', ')}] `
    + `enabled=[${enabledIds().join(', ') || '(none)'}] auth=${authPath}`,
  )
}
