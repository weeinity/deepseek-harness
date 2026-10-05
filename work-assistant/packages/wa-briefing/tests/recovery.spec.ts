/** Recovery reuses the durable Session and never reruns a previously admitted model task. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BriefingScheduler from '../src/index.ts'
import { briefingDomain } from '../src/inbox.ts'
import { BlockingAdapter, mountRealBriefing, readPersistedSessions, ToolCallingAdapter } from './harness.ts'

const due = new Date('2026-03-01T08:00:00Z')

afterEach(() => vi.restoreAllMocks())

describe('briefing recovery', () => {
  it('publishes a fully flushed response once after the Inbox commit failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ToolCallingAdapter())
    const update = h.briefingState.update.bind(h.briefingState)
    vi.spyOn(h.briefingState, 'update').mockImplementation((key, transform) => update(key, current => {
      const next = transform(current)
      if (next.items.length > current.items.length) throw new Error('fixture Inbox commit failed')
      return next
    }))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow('Inbox commit failed')
    const pending = h.briefingState.get('current')!.pending
    expect(pending).toMatchObject({ triggeredAt: due.toISOString() })
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    expect((await readPersistedSessions(h.ctx))[0]?.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')).toBe(true)
    await h.ctx.fiber.dispose()
    const model = new ToolCallingAdapter()
    const restored = await mountRealBriefing(model, { directory: h.directory })
    expect(restored.ctx.workAssistBriefing.snapshot().items).toEqual([expect.objectContaining({ sessionId: pending!.sessionId, text: 'Briefing complete: Morning planning.', read: false })])
    expect(restored.briefingState.get('current')!.pending).toBeNull()
    await expect(restored.ctx.workAssistBriefing.trigger(due)).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })
    expect(model.calls).toEqual([])
    await restored.ctx.fiber.dispose()
    const again = await mountRealBriefing(new ToolCallingAdapter(), { directory: h.directory })
    expect(again.ctx.workAssistBriefing.snapshot().items).toHaveLength(1)
  })

  it.each(['missing', 'interrupted', 'already-published', 'paused', 'disabled'])('clears %s reservation without duplicate or unauthorized generation', async state => {
    const model = state === 'interrupted' ? new BlockingAdapter() : new ToolCallingAdapter()
    const h = await mountRealBriefing(model)
    let id = SessionId('missing-briefing')
    if (state === 'interrupted') {
      const run = h.ctx.workAssistBriefing.trigger(due)
      const outcome = run.catch(error => error)
      await Promise.race([(model as BlockingAdapter).entered.promise, run])
      id = h.briefingState.get('current')!.pending!.sessionId
      await h.schedulerFiber.dispose()
      expect(await outcome).toBeInstanceOf(Error)
    } else if (state !== 'missing') {
      await h.ctx.workAssistBriefing.trigger(due)
      id = h.ctx.workAssistBriefing.snapshot().items[0]!.sessionId
      await h.schedulerFiber.dispose()
    } else await h.schedulerFiber.dispose()
    const domain = await h.ctx.storageDomain.open(briefingDomain)
    try {
      await domain.table('state').update('current', current => ({
        ...current, paused: state === 'paused', latestOccurrence: due.getTime() / 60_000,
        pending: { sessionId: id, triggeredAt: due.toISOString() },
        items: state === 'already-published' ? current.items : [],
      }))
    } finally { await domain.close() }
    await h.ctx.fiber.dispose()
    const nextModel = new ToolCallingAdapter()
    const restored = await mountRealBriefing(nextModel, { directory: h.directory, config: { enabled: state !== 'disabled' } })
    expect(restored.ctx.workAssistBriefing.snapshot().items).toHaveLength(state === 'already-published' ? 1 : 0)
    expect(restored.briefingState.get('current')!.pending).toBeNull()
    expect(nextModel.calls).toEqual([])
  })

  it('fails closed on unreadable pending Session instead of clearing recovery evidence', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    await h.ctx.workAssistBriefing.trigger(due)
    const item = h.ctx.workAssistBriefing.snapshot().items[0]!
    await h.schedulerFiber.dispose()
    const domain = await h.ctx.storageDomain.open(briefingDomain)
    try { await domain.table('state').update('current', current => ({ ...current, items: [], pending: { sessionId: item.sessionId, triggeredAt: due.toISOString() } })) }
    finally { await domain.close() }
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('fixture read unavailable'))
    const fiber = h.ctx.plugin(BriefingScheduler, h.config)
    await expect(fiber.await()).rejects.toThrow('fixture read unavailable')
    await fiber.dispose()
    const saved = await h.ctx.storageDomain.open(briefingDomain)
    try { expect(saved.table('state').get('current')!.pending?.sessionId).toBe(item.sessionId) }
    finally { await saved.close() }
  })

  it.each(['pause', 'dispose'])('suppresses recovery publication when %s races a pending read', async action => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    await h.ctx.workAssistBriefing.trigger(due)
    const item = h.ctx.workAssistBriefing.snapshot().items[0]!
    await h.briefingState.update('current', current => ({ ...current, items: [], pending: { sessionId: item.sessionId, triggeredAt: due.toISOString() } }))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const open = h.ctx.sessionPersistence.open.bind(h.ctx.sessionPersistence)
    vi.spyOn(h.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs)
        entered.resolve()
        await release.promise
        return result
      })
      return handle
    })
    const run = h.ctx.workAssistBriefing.trigger(new Date(due.getTime() + 60000))
    const outcome = run.catch(error => error)
    await Promise.race([entered.promise, run])
    const stopped = action === 'pause' ? h.ctx.workAssistBriefing.setPaused(true) : h.schedulerFiber.dispose()
    release.resolve()
    await stopped
    expect(await outcome).toBeInstanceOf(Error)
    if (action === 'pause') {
      expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    } else {
      const domain = await h.ctx.storageDomain.open(briefingDomain)
      try {
        expect(domain.table('state').get('current')!.items).toEqual([])
        expect(domain.table('state').get('current')!.pending?.sessionId).toBe(item.sessionId)
      } finally { await domain.close() }
    }
  })

  it('removes a recovered publication that committed while pause was being requested', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    await h.ctx.workAssistBriefing.trigger(due)
    const item = h.ctx.workAssistBriefing.snapshot().items[0]!
    await h.briefingState.update('current', current => ({ ...current, items: [], pending: { sessionId: item.sessionId, triggeredAt: due.toISOString() } }))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const update = h.briefingState.update.bind(h.briefingState)
    vi.spyOn(h.briefingState, 'update').mockImplementationOnce(async (...args) => {
      const value = await update(...args)
      entered.resolve()
      await release.promise
      return value
    })
    const run = h.ctx.workAssistBriefing.trigger(new Date(due.getTime() + 60000))
    const outcome = run.catch(error => error)
    await Promise.race([entered.promise, run])
    expect(h.ctx.workAssistBriefing.snapshot().items).toHaveLength(1)
    const paused = h.ctx.workAssistBriefing.setPaused(true)
    release.resolve()
    await paused
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.ctx.workAssistBriefing.snapshot()).toMatchObject({ paused: true, items: [] })
  })

  it('joins cancelled work and rolls back optimistic pause state if durability fails', async () => {
    const model = new BlockingAdapter()
    const h = await mountRealBriefing(model)
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await Promise.race([model.entered.promise, run])
    vi.spyOn(h.briefingState, 'update').mockRejectedValueOnce(new Error('fixture pause storage unavailable'))
    await expect(h.ctx.workAssistBriefing.setPaused(true)).rejects.toThrow('pause storage unavailable')
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.ctx.workAssistBriefing.snapshot()).toMatchObject({ paused: false, running: false, items: [] })
    expect(h.ctx.agents.list()).toEqual([])
    await h.ctx.workAssistBriefing.setPaused(true)
    expect(h.ctx.workAssistBriefing.snapshot().paused).toBe(true)
  })
})
