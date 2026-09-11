/** Hold genuine replay responses until the browser observes the admitted Taskboard column. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForGate } from './gates.mjs'

/**
 * Install one instance-local barrier per model request without changing any stream chunks.
 * @param ctx - Shipped-profile plugin context.
 * @returns nothing; context disposal cancels and drains pending barriers.
 */
export function apply(ctx) {
  const root = process.env.DSH_TASKBOARD_FIXTURE_ROOT
  if (root === undefined) throw new Error('Replay gates require a private Taskboard fixture root')
  const lifetime = new AbortController()
  const pending = new Set()
  let sequence = 0
  ctx.effect(() => {
    const remove = ctx.on('llm/stream', async function* (options, next) {
      const id = ++sequence
      const signal = AbortSignal.any([lifetime.signal, ...(options.signal === undefined ? [] : [options.signal])])
      const barrier = (async () => {
        await writeFile(join(root, `model-${id}.ready`), '')
        await waitForGate(join(root, `model-${id}.release`), signal)
      })()
      pending.add(barrier)
      try { await barrier }
      finally { pending.delete(barrier) }
      yield* next()
    })
    return async () => {
      remove()
      lifetime.abort(new Error('Taskboard replay fixture disposed'))
      await Promise.allSettled(pending)
    }
  })
}
