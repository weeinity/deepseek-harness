/**
 * OAuth-aware pi-ai LlmAdapter.
 *
 * Unlike first-party dsh-llm-pi-ai, Models is constructed with a CredentialStore
 * so streamSimple can refresh subscription tokens under the store lock.
 *
 * The adapter always knows the full OAuth catalog (login/status/listModels for
 * owned routes). Which routes are *registered* with `ctx.llm` is decided by
 * the runtime from the enabled settings profiles — dormant providers stay off
 * the model picker until the user turns them on.
 */

import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  AuthInteraction,
  Credential,
  CredentialStore,
  Model,
  Models,
  MutableModels,
  Provider,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { resolveOAuthProviders } from './catalog.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

export interface OAuthAdapterOptions {
  /** Absolute path of the durable auth file (diagnostics). */
  authPath: string
  /** Shared with the login CLI and `/oauth` command. */
  store: CredentialStore
  /** Full OAuth catalog this adapter can own (not necessarily registered). */
  catalog: readonly string[]
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Resolve current tool access for one durable image attachment. */
  resolveImageAccess?: (
    attachments: AttachmentStore,
    ref: ImageAttachmentRef,
  ) => ImageAttachmentAccess | undefined
}

/** OAuth-backed multi-provider adapter. */
export class OAuthPiAiAdapter extends LlmAdapter {
  private readonly providers: readonly Provider[]
  private readonly models: Models
  private readonly byId: ReadonlyMap<string, Provider>
  private copilotRefresh: Promise<unknown> = Promise.resolve()
  private copilotModels: readonly Model<Api>[] | undefined

  constructor(private readonly options: OAuthAdapterOptions) {
    super()
    this.providers = resolveOAuthProviders(options.catalog)
    const mutable: MutableModels = createModels({ credentials: options.store })
    for (const provider of this.providers) mutable.setProvider(provider)
    this.models = mutable
    this.byId = new Map(this.providers.map(provider => [provider.id, provider]))
  }

  /** Full catalog route ids (settings directory), not only registered ones. */
  catalogIds(): string[] {
    return this.providers.map(provider => provider.id)
  }

  /**
   * @deprecated Use {@link catalogIds}. Kept for older command helpers.
   * @returns full catalog route ids.
   */
  routeIds(): string[] {
    return this.catalogIds()
  }

  /** Shared Models collection (login/logout/status). */
  modelsApi(): Models {
    return this.models
  }

  /** Durable auth file path. */
  authPath(): string {
    return this.options.authPath
  }

  /** Catalog display name for a route id. */
  displayName(provider: string): string {
    return this.byId.get(provider)?.name ?? provider
  }

  override providerInfo(provider: string): LlmProviderInfo {
    const entry = this.byId.get(provider)
    if (entry === undefined) return { id: provider, name: provider }
    return { id: entry.id, name: entry.name }
  }

  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    this.requireProvider(provider)
    const models = provider === 'github-copilot'
      ? await this.refreshCopilotModels(signal)
      : await this.models.getAvailable(provider, signal === undefined ? {} : { signal })
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const resolved = await this.requireModel(provider, model, signal)
    const levels = getSupportedThinkingLevels(resolved)
    const reasoning = levels.length > 0 && !(levels.length === 1 && levels[0] === 'off')
      ? { efforts: levels.map(level => ({ id: ReasoningEffortId(level), name: level })) }
      : undefined
    return {
      provider,
      id: model,
      name: resolved.name,
      inputModalities: [...resolved.input],
      context: { contextWindow: resolved.contextWindow },
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /**
   * Run an interactive OAuth login and persist the credential.
   * @param provider - catalog provider id.
   * @param interaction - prompt/notify callbacks.
   */
  login(provider: string, interaction: AuthInteraction): Promise<Credential> {
    this.requireProvider(provider)
    return this.models.login(provider, 'oauth', interaction)
  }

  /** Drop the stored credential for one provider. */
  logout(provider: string): Promise<void> {
    this.requireProvider(provider)
    return this.models.logout(provider)
  }

  /** Whether the provider currently has complete auth configuration. */
  checkAuth(provider: string): Promise<{ source?: string, type: 'api_key' | 'oauth' } | undefined> {
    this.requireProvider(provider)
    return this.models.checkAuth(provider)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('dsh-llm-oauth does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    this.requireProvider(options.provider)
    const auth = await this.models.checkAuth(
      options.provider,
      options.signal === undefined ? {} : { signal: options.signal },
    )
    if (auth === undefined) {
      throw new LlmError(
        `dsh-llm-oauth: provider "${options.provider}" is not logged in; `
        + `run \`/oauth login ${options.provider}\` or use Settings → OAuth / 订阅`,
        'MISSING_CREDENTIAL',
      )
    }
    const model = await this.requireModel(options.provider, options.model, options.signal, true)
    let reasoning: ThinkingLevel | undefined
    if (options.reasoningEffort !== undefined) {
      const requested = getSupportedThinkingLevels(model)
        .find(level => level === options.reasoningEffort)
      if (requested === undefined) {
        throw new LlmError(
          `dsh-llm-oauth provider "${options.provider}" model "${options.model}"`
          + ` does not support reasoning effort "${options.reasoningEffort}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
      if (requested !== 'off') reasoning = requested
    }

    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(
        `dsh-llm-oauth model "${model.id}" does not support image input`,
        'UNSUPPORTED_CONTENT',
      )
    }
    const attachments = containsImage ? this.options.resolveAttachments?.() : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError(
        'dsh-llm-oauth image input requires the durable attachment service',
        'UNSUPPORTED_CONTENT',
      )
    }
    const context = attachments === undefined
      ? toPiContext(options)
      : await toPiContext(options, {
        attachments,
        resolveImageAccess: ref => this.options.resolveImageAccess?.(attachments, ref),
      })
    const events = this.models.streamSimple(model, context, {
      maxRetries: 0,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...reasoning === undefined ? {} : { reasoning },
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      ...options.signal === undefined ? {} : { signal: options.signal },
      // pi-ai omits Copilot's default reasoning field; an explicit live "none"
      // selection must instead disable reasoning in the Responses payload.
      ...options.provider === 'github-copilot' && model.api === 'openai-responses'
        && options.reasoningEffort === 'off' && typeof model.thinkingLevelMap?.off === 'string'
        ? { onPayload: (payload: unknown) => ({
          ...payload as Record<string, unknown>,
          reasoning: { effort: model.thinkingLevelMap!.off },
        }) }
        : {},
      headers: attributionHeaders(),
    })
    yield* toStreamChunks(events)
  }

  private requireProvider(provider: string): Provider {
    const entry = this.byId.get(provider)
    if (entry === undefined) {
      throw new LlmError(`dsh-llm-oauth does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return entry
  }

  private async requireModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
    fresh = false,
  ): Promise<Model<Api>> {
    this.requireProvider(provider)
    signal?.throwIfAborted()
    const resolved = provider === 'github-copilot'
      ? (fresh || this.copilotModels === undefined
        ? await this.refreshCopilotModels(signal)
        : this.copilotModels).find(entry => entry.id === model)
      : this.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(
        `dsh-llm-oauth provider "${provider}" has no catalog model "${model}"`,
        'UNKNOWN_MODEL',
      )
    }
    return resolved
  }

  /** Every Copilot listing or request resolves against a fresh account catalog. */
  private refreshCopilotModels(callerSignal?: AbortSignal): Promise<readonly Model<Api>[]> {
    const timeout = AbortSignal.timeout(20_000)
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])
    // pi-ai supersedes concurrent refreshes. Serialize them and capture each result
    // before the next publication so in-flight requests retain their descriptors.
    const refresh = this.copilotRefresh.then(async () => {
      signal.throwIfAborted()
      if (await this.models.checkAuth('github-copilot', { signal }) === undefined) {
        throw new LlmError(
          'dsh-llm-oauth: github-copilot is not logged in; run `/oauth login github-copilot`',
          'MISSING_CREDENTIAL',
        )
      }
      const result = await this.models.refresh({ providers: ['github-copilot'], signal })
      signal.throwIfAborted()
      const error = result.errors.get('github-copilot')
      if (error !== undefined) throw error
      if (result.aborted) throw new Error('dsh-llm-oauth: Copilot model discovery aborted')
      const models = await this.models.getAvailable('github-copilot', { signal })
      signal.throwIfAborted()
      this.copilotModels = models
      return models
    })
    this.copilotRefresh = refresh.catch(() => {
      this.copilotModels = undefined
    })
    return new Promise((resolve, reject) => {
      const abort = (): void => { reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void refresh.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
