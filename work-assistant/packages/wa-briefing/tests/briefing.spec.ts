/** Scheduled briefings use the real agent loop, Session log, preset mount, and tool registry. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import BriefingScheduler from '../src/index.ts'
import { BlockingAdapter, ToolCallingAdapter, mountRealBriefing, readPersistedSessionText } from './harness.ts'

const consoleWarnings: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  consoleWarnings.length = 0
})

describe('wa-briefing', () => {
  it('is disabled by default and validates enabled schedules before startup', async () => {
    await expect(new BriefingScheduler(new Context(), {}).trigger()).resolves.toEqual({ status: 'skipped', reason: 'disabled' })
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * * *', timeZone: 'UTC', workspace: process.cwd(), provider: 'p', model: 'm' })).toThrow('five-field')
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * *', timeZone: 'Mars/Base', workspace: process.cwd(), provider: 'p', model: 'm' })).toThrow('IANA')
    expect(() => new BriefingScheduler(new Context(), { enabled: true, cron: '0 9 * * *', timeZone: 'UTC', workspace: 'relative', provider: 'p', model: 'm' })).toThrow('absolute')
  })

  it('runs a real Agent with the personal preset, read-only tools, calendar data, and persisted Session evidence', async () => {
    const adapter = new ToolCallingAdapter()
    const h = await mountRealBriefing(adapter, { includeMemory: true })

    const result = await h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))

    expect(result).toMatchObject({ status: 'completed', window: { start: '2026-03-01T08:00:00.000Z', end: '2026-03-01T10:00:00.000Z', timeZone: 'America/Los_Angeles' } })
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[0]?.tools?.map(tool => tool.name).sort()).toEqual(['calendar_find_conflicts', 'calendar_list', 'memory_list', 'memory_read'])
    expect(adapter.calls[0]?.tools?.some(tool => tool.name === 'memory_write')).toBe(false)
    const firstMessages = JSON.stringify(adapter.calls[0]?.messages)
    expect(firstMessages).toContain('You are a personal assistant for one user')
    expect(firstMessages).not.toContain('coding agent')
    const scheduledPrompt = adapter.calls[0]?.messages
      .flatMap(message => message.content)
      .find(block => block.type === 'text' && block.text.includes('Scheduled personal briefing request.'))
    expect(scheduledPrompt).toMatchSnapshot('scheduled personal briefing')
    const persisted = await readPersistedSessionText(h.sessionsRoot)
    expect(persisted).toContain('Scheduled personal briefing request.')
    expect(persisted).toContain('Window start: 2026-03-01T08:00:00.000Z')
    expect(persisted).toContain('Morning planning')
    expect(persisted).toContain('Briefing complete: Morning planning.')
  })

  it('skips overlapping runs without queueing a backlog', async () => {
    const adapter = new BlockingAdapter()
    const h = await mountRealBriefing(adapter)
    const first = h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))
    await Promise.race([adapter.entered.promise, first])

    await expect(h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:01:00Z'))).resolves.toEqual({ status: 'skipped', reason: 'overlap' })

    adapter.release.resolve()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
    expect(adapter.calls).toHaveLength(2)
  })

  it('cancels and joins owned work during scheduler disposal', async () => {
    const adapter = new BlockingAdapter()
    const h = await mountRealBriefing(adapter)
    const warn = vi.spyOn(console, 'warn').mockImplementation(message => { consoleWarnings.push(String(message)) })
    const run = h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))
    await Promise.race([adapter.entered.promise, run])
    const agents = h.ctx.agents

    await h.ctx.fiber.dispose()
    adapter.release.resolve()

    await expect(run).rejects.toThrow('unloading')
    expect(warn).not.toHaveBeenCalled()
    expect(agents.list()).toHaveLength(0)
  })
})
