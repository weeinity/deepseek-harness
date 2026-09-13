/** Session-exact visibility policies for Conversation Views. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One optional reactive allowlist per View, owned by its registering plugin. */
export class ConversationVisibilityRegistry {
  private readonly policies = new Map<string, ObservableSnapshot<Readonly<Record<string, boolean>>>>()
  private readonly listeners = new Set<() => void>()

  /** @param ctx - Context whose effects own policy registrations. */
  constructor(private readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, { value: { property: 'ctx' } })
  }

  /**
   * Restrict a View to exact Session ids whose snapshot value is true.
   * Missing policies leave Views unrestricted; missing or false entries hide
   * a restricted View. Parent and subagent Sessions never inherit permission.
   * Register before the corresponding Slot row to prevent unrestricted selection.
   * Duplicate View policies throw; unloading the caller removes its policy and
   * source subscription. Both source and unchanged snapshot identities stay stable.
   * @param viewId - Conversation View id; its Slot row need not exist yet.
   * @param source - Reactive Session-id allowlist owned by the caller.
   * @returns idempotent disposer restoring unrestricted visibility.
   */
  register(
    viewId: string,
    source: ObservableSnapshot<Readonly<Record<string, boolean>>>,
  ): () => void {
    if (this.policies.has(viewId)) {
      throw new Error(`conversation visibility policy "${viewId}" is already registered`)
    }
    const dispose = this.ctx.effect(function* (this: ConversationVisibilityRegistry) {
      this.policies.set(viewId, source)
      yield () => {
        this.policies.delete(viewId)
        this.refresh()
      }
      yield source.subscribe(() => { this.refresh() })
      this.refresh()
    }.bind(this), `uiConversation.visibility.register(${JSON.stringify(viewId)})`)
    return () => { void dispose() }
  }

  /**
   * Test one exact Session against the current policy.
   * @internal
   * @param viewId - View or target id.
   * @param sessionId - Exact Session identity.
   * @returns whether the View is unrestricted or explicitly enabled.
   */
  allows(viewId: string, sessionId: SessionId): boolean {
    const source = this.policies.get(viewId)
    return source === undefined || source.getSnapshot()[sessionId] === true
  }

  /**
   * Observe policy registration, source updates, and disposal.
   * @internal
   * @param listener - Synchronous invalidation callback.
   * @returns unsubscribe callback.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private refresh(): void {
    notifySubscribers(this.listeners, '[ui-conversation] visibility registry')
  }
}
