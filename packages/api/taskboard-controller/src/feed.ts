/** Reconnect-safe Taskboard baseline and increment producer. */
import type { Context } from '@deepseek-ai/cordis'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { TaskId, taskboardTaskView, taskRecord } from '@deepseek-ai/dsh-taskboard'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { TaskboardBaseline, TaskboardFollowFrame } from './types.ts'
import type { TaskboardRuntimeState } from './runtime-types.ts'

const MAX_PENDING_FRAMES = 1024

/** Owns Taskboard domain observation and all active follow generations. */
export class TaskboardFeed {
  private readonly followers = new Set<TaskboardFollower>()

  /**
   * @param ctx - Host context containing the authoritative Taskboard service.
   * @param runtime - Current immutable Host runtime observation.
   */
  constructor(private readonly ctx: Context, private readonly runtime: () => TaskboardRuntimeState) {
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'taskboard-controller.feed')
  }

  /** Read the complete current Taskboard projection.
   * @param workspaceId - Optional Workspace filter.
   * @returns active and archived tasks belonging to registered Workspaces.
   */
  baseline(workspaceId?: WorkspaceId): TaskboardBaseline {
    return {
      tasks: this.ctx.taskboard.list(workspaceId, true)
        .filter(task => this.ctx.workspaceRegistry.get(task.workspaceId) !== undefined),
      runtime: this.runtime(),
    }
  }

  /**
   * Publish a committed Host runtime observation to active followers.
   * @param value - Immutable settings, scheduler, and power state.
   */
  runtimeChanged(value: TaskboardRuntimeState): void {
    this.publish({ type: 'runtime', value })
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - Generation cancellation.
   * @returns baseline followed by ordered task increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame> {
    signal.throwIfAborted()
    const follower = new TaskboardFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (this.followers.size === 0) return
    if (change.domain === 'workspace' && change.table === 'workspaces' && change.operation === 'deleted') {
      for (const task of this.ctx.taskboard.list(WorkspaceId(change.key), true)) {
        this.publish({ type: 'remove', taskId: task.id, revision: Number.MAX_SAFE_INTEGER })
      }
      return
    }
    if (change.domain !== 'taskboard' || change.table !== 'tasks') return
    if (change.operation === 'deleted') {
      this.publish({ type: 'remove', taskId: TaskId(change.key), revision: Number.MAX_SAFE_INTEGER })
      return
    }
    const taskId = TaskId(change.key)
    const task = taskboardTaskView(taskId, taskRecord.parse(change.value))
    if (this.ctx.workspaceRegistry.get(task.workspaceId) === undefined) {
      this.publish({ type: 'remove', taskId, revision: Number.MAX_SAFE_INTEGER })
    } else {
      this.publish({ type: 'upsert', task })
    }
  }

  private publish(frame: Exclude<TaskboardFollowFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

class TaskboardFollower {
  private readonly frames: TaskboardFollowFrame[] = []
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: TaskboardFollowFrame): void {
    if (this.closed) return
    if (this.frames.length >= MAX_PENDING_FRAMES) {
      this.close()
      return
    }
    this.frames.push(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<TaskboardFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) { yield frame; continue }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
    })
  }
}
