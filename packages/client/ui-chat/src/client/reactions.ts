/** Registry backing Chat acknowledgement-reaction opt-ins. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ChatReactionPolicy, ChatReactions } from './contract/reactions.ts'

interface ReactionPolicyRecord {
  readonly id: number
  readonly policy: ChatReactionPolicy
}

/** Root Chat reaction registry exposed as `ctx.chatReactions`. */
export class ChatReactionRegistry extends Service implements ChatReactions {
  private readonly records: ReactionPolicyRecord[] = []
  private nextId = 1
  readonly policies: SnapshotStore<readonly ChatReactionPolicy[]> = createSnapshotStore<readonly ChatReactionPolicy[]>([])

  /** @param ctx - owning Chat plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'chatReactions')
  }

  register(policy: ChatReactionPolicy): () => void {
    const normalized: ChatReactionPolicy = {
      presetIds: [...policy.presetIds],
      emoji: policy.emoji,
    }
    const dispose = this.ctx.effect(() => {
      const record: ReactionPolicyRecord = { id: this.nextId++, policy: normalized }
      this.records.push(record)
      this.publish()
      return () => {
        const index = this.records.findIndex(candidate => candidate.id === record.id)
        if (index < 0) return
        this.records.splice(index, 1)
        this.publish()
      }
    }, 'chatReactions.register()')
    return () => { void dispose() }
  }

  private publish(): void {
    this.policies.set(this.records.map(record => record.policy))
  }
}
