/** Durable Inbox tests retain the real scheduler, tools, Session log, and SQLite backend. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockingAdapter, calendarResponse, mountRealBriefing, readPersistedSessions, ScriptedAdapter, textResponse, ToolCallingAdapter } from './harness.ts'

const due = new Date('2026-03-01T08:00:00Z')
const later = new Date('2026-03-01T08:01:00Z')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('durable proactive briefing Inbox', () => {
  it('publishes exactly the committed assistant message with plugin provenance and no write grant', async () => {
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model)
    expect(h.ctx.workAssistBriefing.snapshot()).toEqual({ version: 1, enabled: true, paused: false, running: false, items: [] })
    const result = await h.ctx.workAssistBriefing.trigger(due)
    expect(result.status).toBe('completed')
    const [item] = h.ctx.workAssistBriefing.snapshot().items
    const [session] = await readPersistedSessions(h.ctx)
    expect(item).toMatchObject({ sessionId: session!.header.id, read: false, dismissed: false, createdAt: due.toISOString(), text: 'Briefing complete: Morning planning.' })
    const reply = session!.events.find(event => event.type === 'assistant/message' && event.data.message.id === item!.messageId)
    expect(reply?.type).toBe('assistant/message')
    const inputs = session!.events.filter(event => event.type === 'user/message')
    const scheduled = inputs.filter(event => event.data.source.kind === 'plugin' && event.data.source.plugin === 'wa-briefing')
    expect(scheduled).toHaveLength(1)
    expect(inputs.every(event => event.data.source.kind === 'plugin')).toBe(true)
    expect(scheduled[0]!.data.source).toMatchObject({ kind: 'plugin', plugin: 'wa-briefing', form: 'notice' })
    expect(h.ctx.workAssistGateway.records()).toEqual([expect.objectContaining({ kind: 'read', tool: 'calendar_list', status: 'succeeded' })])
    expect(model.calls[0]!.tools!.map(tool => tool.name).sort()).toEqual(['calendar_find_conflicts', 'calendar_list'])
    expect(h.ctx.agents.list()).toEqual([])
    item!.text = 'caller mutation'
    expect(h.ctx.workAssistBriefing.snapshot().items[0]!.text).toBe('Briefing complete: Morning planning.')
  })

  it('deduplicates the same minute and older occurrences without another model request', async () => {
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model)
    await h.ctx.workAssistBriefing.trigger(due)
    for (const tick of [due, new Date(due.getTime() + 59_999), new Date(due.getTime() - 60_000)]) {
      await expect(h.ctx.workAssistBriefing.trigger(tick)).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })
    }
    expect(model.calls).toHaveLength(2)
    expect(h.ctx.workAssistBriefing.snapshot().items).toHaveLength(1)
    await h.ctx.workAssistBriefing.trigger(later)
    expect(model.calls).toHaveLength(4)
    expect(h.ctx.workAssistBriefing.snapshot().items).toHaveLength(2)
  })

  it('retains unread/read/dismissed state and dedupe across host restart', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    await h.ctx.workAssistBriefing.trigger(due)
    await h.ctx.workAssistBriefing.trigger(later)
    const before = h.ctx.workAssistBriefing.snapshot().items
    await h.ctx.workAssistBriefing.updateItem(before[1]!.id, 'read')
    await h.ctx.workAssistBriefing.updateItem(before[0]!.id, 'dismiss')
    await h.ctx.fiber.dispose()
    const model = new ToolCallingAdapter()
    const restored = await mountRealBriefing(model, { directory: h.directory })
    expect(restored.ctx.workAssistBriefing.snapshot().items).toEqual([{ ...before[1]!, read: true }])
    await expect(restored.ctx.workAssistBriefing.trigger(later)).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })
    expect(model.calls).toEqual([])
    await expect(restored.ctx.workAssistBriefing.updateItem(SessionId('not-retained'), 'read')).rejects.toThrow('no longer retained')
    await restored.ctx.workAssistBriefing.updateItem(before[1]!.id, 'dismiss')
    await restored.ctx.workAssistBriefing.updateItem(before[1]!.id, 'read')
    expect(restored.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it('pauses an active run, joins cancellation, and suppresses its pending response', async () => {
    const model = new BlockingAdapter()
    const h = await mountRealBriefing(model)
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await Promise.race([model.entered.promise, run])
    expect(h.ctx.workAssistBriefing.snapshot().running).toBe(true)
    await h.ctx.workAssistBriefing.setPaused(true)
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.ctx.workAssistBriefing.snapshot()).toMatchObject({ paused: true, running: false, items: [] })
    expect(h.ctx.agents.list()).toEqual([])
    await expect(h.ctx.workAssistBriefing.trigger(later)).resolves.toEqual({ status: 'skipped', reason: 'paused' })
    model.release.resolve()
    await h.ctx.fiber.dispose()
    const restored = await mountRealBriefing(new ToolCallingAdapter(), { directory: h.directory })
    expect(restored.ctx.workAssistBriefing.snapshot().paused).toBe(true)
    await restored.ctx.workAssistBriefing.setPaused(false)
    expect(restored.ctx.workAssistBriefing.snapshot().items).toEqual([])
    await expect(restored.ctx.workAssistBriefing.trigger(due)).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })
    await expect(restored.ctx.workAssistBriefing.trigger(later)).resolves.toMatchObject({ status: 'completed' })
  })

  it('does not publish a completed response when pause races persistence flush', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
    vi.spyOn(h.ctx.sessions, 'flush').mockImplementation(async session => {
      const result = await flush(session)
      entered.resolve()
      await release.promise
      return result
    })
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await Promise.race([entered.promise, run])
    const pause = h.ctx.workAssistBriefing.setPaused(true)
    release.resolve()
    await pause
    expect(await outcome).toBeInstanceOf(Error)
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    expect(h.ctx.agents.list()).toEqual([])
    expect((await readPersistedSessions(h.ctx))[0]?.events.some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('cancels before admission reaches a model request', async () => {
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model)
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await h.ctx.workAssistBriefing.setPaused(true)
    expect(await outcome).toBeInstanceOf(Error)
    expect(model.calls).toEqual([])
    expect(h.ctx.workAssistBriefing.snapshot()).toMatchObject({ paused: true, items: [] })
  })

  it('cancels during the owned turn deadline and publishes no partial briefing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = new BlockingAdapter()
    const h = await mountRealBriefing(model, { config: { turnTimeoutMs: 3456 } })
    const deadline = new AbortController()
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 3456 ? deadline.signal : timeout(ms))
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await Promise.race([model.entered.promise, run])
    deadline.abort(new Error('fixture deadline'))
    expect(await outcome).toMatchObject({ message: 'Personal briefing turn exceeded 3456 ms' })
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    expect(h.ctx.agents.list()).toEqual([])
  })

  it('bounds agent creation and joins the cancelled setup before disposal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model, { config: { createTimeoutMs: 2345 } })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mount = h.ctx.agentPresets.mount.bind(h.ctx.agentPresets)
    vi.spyOn(h.ctx.agentPresets, 'mount').mockImplementation(async (...args) => {
      const preset = await mount(...args)
      entered.resolve()
      await release.promise
      return preset
    })
    const deadline = new AbortController()
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 2345 ? deadline.signal : timeout(ms))
    const run = h.ctx.workAssistBriefing.trigger(due)
    const outcome = run.catch(error => error)
    await Promise.race([entered.promise, run])
    deadline.abort(new Error('fixture creation deadline'))
    release.resolve()
    expect(await outcome).toMatchObject({ message: 'Personal briefing agent creation exceeded 2345 ms' })
    expect(model.calls).toEqual([])
    expect(h.ctx.agents.list()).toEqual([])
  })

  it('honors the last pause change and does not use resume as deployment opt-in', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter(), { config: { enabled: false } })
    await Promise.all([h.ctx.workAssistBriefing.setPaused(true), h.ctx.workAssistBriefing.setPaused(false), h.ctx.workAssistBriefing.setPaused(true)])
    expect(h.ctx.workAssistBriefing.snapshot().paused).toBe(true)
    await h.ctx.workAssistBriefing.setPaused(false)
    await expect(h.ctx.workAssistBriefing.trigger(due)).resolves.toEqual({ status: 'skipped', reason: 'disabled' })
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it('bounds retained previews by Unicode code points and trims old items on restart', async () => {
    const full = '🙂🙂🙂Today has one planning meeting.'
    const h = await mountRealBriefing(new ScriptedAdapter(options => calendarResponse(options, full)), { config: { maxPreviewChars: 2, maxInboxItems: 2 } })
    for (let index = 0; index < 3; index++) await h.ctx.workAssistBriefing.trigger(new Date(due.getTime() + index * 60_000))
    expect(h.ctx.workAssistBriefing.snapshot().items.map(item => item.text)).toEqual(['🙂🙂', '🙂🙂'])
    expect((await readPersistedSessions(h.ctx)).every(session => session.events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === full)))).toBe(true)
    await h.ctx.fiber.dispose()
    const restored = await mountRealBriefing(new ToolCallingAdapter(), { directory: h.directory, config: { maxInboxItems: 1 } })
    expect(restored.ctx.workAssistBriefing.snapshot().items).toHaveLength(1)
  })

  it('consumes failed occurrence admission durably without retrying after restart', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ScriptedAdapter(() => textResponse('Unverified claim without a calendar read')))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow('verified calendar')
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    await h.ctx.fiber.dispose()
    const model = new ToolCallingAdapter()
    const restored = await mountRealBriefing(model, { directory: h.directory })
    await expect(restored.ctx.workAssistBriefing.trigger(due)).resolves.toEqual({ status: 'skipped', reason: 'duplicate' })
    expect(model.calls).toEqual([])
  })

  it('rejects an owned run contaminated by human-sourced input', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ToolCallingAdapter())
    let inserted = false
    h.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (inserted || message.source.kind !== 'plugin') return
      inserted = true
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A separate user request' }] }))
    })
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow('verified calendar')
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it('reports scheduled failure through Cron without accepting an empty answer', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-03-01T08:59:59.000Z'))
    const model = new ScriptedAdapter(() => textResponse('No verified calendar read'))
    const h = await mountRealBriefing(model, { config: { timeZone: 'UTC' } })
    const logged = Promise.withResolvers<void>()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => logged.resolve())
    const trigger = vi.spyOn(h.ctx.workAssistBriefing, 'trigger')
    await vi.advanceTimersByTimeAsync(1000)
    const result = trigger.mock.results[0]!.value
    await expect(result).rejects.toThrow('verified calendar')
    await logged.promise
    expect(warn).toHaveBeenCalled()
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
    await h.schedulerFiber.dispose()
  })

  it('reports ordinary setup rejection without disguising it as a timeout', async () => {
    const h = await mountRealBriefing(new ToolCallingAdapter())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(h.ctx.agentPresets, 'mount').mockRejectedValueOnce(new Error('fixture preset missing'))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow('fixture preset missing')
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it('starts due Cron work without human input and leaves no timer after disposal', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-03-01T08:59:59.000Z'))
    const h = await mountRealBriefing(new ToolCallingAdapter(), { config: { timeZone: 'UTC' } })
    const trigger = vi.spyOn(h.ctx.workAssistBriefing, 'trigger')
    await vi.advanceTimersByTimeAsync(1000)
    expect(trigger).toHaveBeenCalledOnce()
    await expect(trigger.mock.results[0]!.value).resolves.toMatchObject({ status: 'completed' })
    expect(h.ctx.workAssistBriefing.snapshot().items).toHaveLength(1)
    await h.schedulerFiber.dispose()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(trigger).toHaveBeenCalledOnce()
  })
})
