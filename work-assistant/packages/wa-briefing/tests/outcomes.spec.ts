/** Completion is checked against real durable turns, not the Agent's idle status. */
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { calendarResponse, mountRealBriefing, readPersistedSessions, ScriptedAdapter, textResponse } from './harness.ts'

const due = new Date('2026-03-01T08:00:00Z')

afterEach(() => vi.restoreAllMocks())

describe('briefing outcome admission', () => {
  it.each(['', '   \n\t'])('rejects a completed turn without visible text (%j)', async text => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ScriptedAdapter(options => calendarResponse(options, text)))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow()
    expect(h.ctx.agents.list()).toEqual([])
    const [session] = await readPersistedSessions(h.ctx)
    expect(session?.events.some(event => event.type === 'turn/end')).toBe(true)
  })

  it('rejects token-limited partial output after the real driver becomes idle', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ScriptedAdapter(options => calendarResponse(options, 'Incomplete briefing', 'max-tokens')))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow()
    const [session] = await readPersistedSessions(h.ctx)
    expect(session?.events.some(event => event.type === 'turn/end' && event.data.reason.kind !== 'completed')).toBe(true)
    expect(h.ctx.agents.list()).toEqual([])
  })

  it('rejects model failure rather than reporting a ready briefing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await mountRealBriefing(new ScriptedAdapter(async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      throw new Error('fixture provider unavailable')
    }))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow()
    const [session] = await readPersistedSessions(h.ctx)
    expect(session?.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
    expect(h.ctx.agents.list()).toEqual([])
  })

  it('rejects a turn refused before its first model request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = new ScriptedAdapter(() => textResponse('must not run'))
    const h = await mountRealBriefing(model)
    h.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow('verified calendar')
    expect(model.calls).toEqual([])
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it.each(['memory_write', 'ask_user_question', 'run_code'])('rejects model calls to unauthorized %s without performing an effect', async name => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const model = new ScriptedAdapter(async function* (options) {
      if (options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        yield* textResponse('I could not perform that action.')
        return
      }
      const id = ToolCallId('forbidden-briefing-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    const h = await mountRealBriefing(model)
    await expect(h.ctx.workAssistBriefing.trigger(due)).rejects.toThrow()
    expect(model.calls[0]?.tools?.some(tool => tool.name === name)).toBe(false)
    expect(h.ctx.workAssistGateway.records()).toEqual([])
    const [session] = await readPersistedSessions(h.ctx)
    expect(session?.events.filter(event => event.type === 'tool/result').some(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError))).toBe(true)
    expect(session?.events.filter(event => event.type === 'user/message').every(event => event.data.source.kind === 'plugin')).toBe(true)
  })
})
