/** Ask through the shipped human answerer before ordinary chat steps; model replay remains unchanged. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const inject = ['userQuestions']

/**
 * Ask only for direct Session prompts, retaining the exact Agent and turn as fixture evidence.
 * @param ctx - Shipped Web Host context.
 * @returns nothing; disposal cancels and drains every owned question.
 */
export function apply(ctx) {
  const root = process.env.DSH_TASKBOARD_FIXTURE_ROOT
  if (root === undefined) throw new Error('Linked attention requires a private Taskboard fixture root')
  const lifetime = new AbortController()
  const pending = new Set()
  let sequence = 0
  ctx.effect(() => {
    const remove = ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
      if (step !== 1 || !messages.some(message =>
        message.source.kind === 'user' && typeof message.source.rpcId === 'string'
          && !message.source.rpcId.startsWith('taskboard:'))) return next()
      const id = ++sequence
      const question = (async () => {
        const owner = {
          sessionId: agent.session.id,
          turn,
          requestIds: messages.filter(message => message.source.kind === 'user').map(message => message.source.rpcId),
        }
        await writeFile(join(root, `question-${id}.ready.json`), JSON.stringify(owner))
        const answer = await ctx.userQuestions.ask({
          agent,
          signal: AbortSignal.any([lifetime.signal, signal]),
          questions: [{ id: 'continue', header: 'Conversation checkpoint', question: 'Continue this ordinary conversation?' }],
        })
        await writeFile(join(root, `question-${id}.answered.json`), JSON.stringify({ ...owner, answer }))
      })()
      pending.add(question)
      try { await question }
      finally { pending.delete(question) }
      return next()
    })
    return async () => {
      remove()
      lifetime.abort(new Error('Linked attention fixture disposed'))
      await Promise.allSettled(pending)
    }
  })
}
