import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LlmAdapter, ToolCallId, expandAssistantStream } from '@deepseek-ai/dsh-llm'

export const name = 'wa-profile-test-model'
export const inject = ['llm']

const defaultProvider = 'wa-profile-test'
const defaultModel = 'wa-scripted-receipt'
const duplicatePrompt = 'Receipt identity probe'
const clarifyPrompt = 'Receipt clarify cancel probe'
const streamHoldPrompt = 'Receipt queued hold probe'

export function apply(ctx, config = {}) {
  const adapter = new ScriptedProfileAdapter(config)
  const provider = config.provider ?? defaultProvider
  ctx.effect(() => ctx.llm.registerAdapter([provider], adapter), 'wa-profile-test-model.adapter')
  if (config.briefingTriggerToken !== undefined) {
    ctx.inject(['webServer', 'workAssistBriefing'], ctx => {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact', path: '/__wa-test/briefing',
        handler: async (req, res) => {
          if (req.method !== 'POST' || req.headers['x-wa-test-token'] !== config.briefingTriggerToken) {
            res.writeHead(403).end()
            return
          }
          const url = new URL(req.url, 'http://127.0.0.1')
          const triggeredAt = new Date(url.searchParams.get('at'))
          try {
            const result = await ctx.workAssistBriefing.trigger(triggeredAt)
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result))
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
          }
        },
      }), 'wa-profile-test-model.trigger')
    })
  }
}

export default { name, inject, apply }

class ScriptedProfileAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.provider = config.provider ?? defaultProvider
    this.model = config.model ?? defaultModel
    this.logPath = config.logPath
    this.controlPath = config.controlPath
    this.briefingFixturePath = config.briefingFixturePath
    if (this.logPath !== undefined) mkdirSync(dirname(this.logPath), { recursive: true })
    if (this.controlPath !== undefined) mkdirSync(dirname(this.controlPath), { recursive: true })
    this.log({ type: 'adapter-init', provider: this.provider, model: this.model })
  }

  providerInfo(provider) {
    this.log({ type: 'provider-info', provider })
    return { id: provider, name: 'Work Assistant profile test model' }
  }

  async listModels(provider) {
    this.log({ type: 'list-models', provider })
    return [{ provider, id: this.model, name: 'Work Assistant profile scripted model' }]
  }

  async resolveModel(provider, model) {
    this.log({ type: 'resolve-model', provider, model })
    return { provider, id: model, name: 'Work Assistant profile scripted model' }
  }

  async prepareCall(provider, model, signal) {
    this.log({ type: 'prepare-call', provider, model })
    if (this.consumePrepareHold()) {
      this.log({ type: 'prepare-hold-start', provider, model })
      await waitForAbort(signal)
      this.log({ type: 'prepare-hold-abort', provider, model })
      signal?.throwIfAborted()
      throw new Error('scripted prepare hold ended without an abort')
    }
    return super.prepareCall(provider, model, signal)
  }

  async *stream(options) {
    const briefing = options.messages.find(message => message.role === 'user' && message.source?.kind === 'plugin' && message.source.plugin === 'wa-briefing')
    if (briefing !== undefined) {
      yield* this.briefing(options, briefing)
      return
    }
    const prompt = latestUserText(options)
    const toolResults = currentRequestToolResults(options)
    this.log({
      type: 'request',
      prompt,
      tools: (options.tools ?? []).map(tool => tool.name),
      toolResultCount: toolResults.length,
    })
    if (toolResults.length > 0) {
      yield* textResponse('Question cancelled. No memory write was made.')
      return
    }
    if (prompt.includes(clarifyPrompt)) {
      yield* toolCallResponse('wa-ask-save-memory', 'ask_user_question', {
        questions: [{
          id: 'save-memory',
          question: 'Save this memory note?',
          options: [{ label: 'Save note' }, { label: 'Cancel' }],
        }],
      })
      return
    }
    if (prompt.includes(streamHoldPrompt)) {
      this.log({ type: 'stream-hold-start', prompt })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '\u{1f44d}' }
      await waitForAbort(options.signal)
      this.log({ type: 'stream-hold-abort', prompt })
      options.signal?.throwIfAborted()
      throw new Error('scripted stream hold ended without an abort')
    }
    if (prompt.includes(duplicatePrompt)) {
      const occurrences = options.messages.filter(message => message.role === 'user'
        && message.source?.kind === 'user'
        && message.content.some(block => block.type === 'text' && block.text === prompt)).length
      yield* textResponse(occurrences === 2 ? "You're welcome." : '\u{1f44d}')
      return
    }
    if (/^(?:Neutral|Off) receipt probe/u.test(prompt)) {
      yield* textResponse('\u{1f44d}')
      return
    }
    if (prompt.startsWith('Mixed acknowledgement probe')) {
      yield* textResponse('\u{1f44d} Here is a written reply.')
      return
    }
    if (prompt.startsWith('Greeting probe')) {
      yield* textResponse('Hi! How can I help?')
      return
    }
    yield* textResponse('Scripted profile model response.')
  }

  async *briefing(options, input) {
    const prompt = input.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
    this.log({ type: 'briefing-request', source: input.source, prompt, tools: (options.tools ?? []).map(tool => tool.name), toolResultCount: results.length })
    if (this.briefingFixturePath !== undefined && !this.briefingControlPending()) {
      const events = readFileSync(this.briefingFixturePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const streams = events.filter(event => event.type === 'assistant/message').map(event => event.data.stream)
      const stream = streams[results.length === 0 ? 0 : 1]
      if (stream === undefined) throw new Error('Canonical briefing fixture is missing its model stream')
      for (const { chunk } of expandAssistantStream(stream)) yield chunk
      return
    }
    if (results.length === 0) {
      yield* toolCallResponse('wa-briefing-calendar', 'calendar_list', {
        start: /^Window start: (.+)$/mu.exec(prompt)?.[1],
        end: /^Window end: (.+)$/mu.exec(prompt)?.[1],
        timeZone: /^Time zone: (.+)$/mu.exec(prompt)?.[1],
      })
      return
    }
    if (this.consumeBriefingHold()) {
      this.log({ type: 'briefing-hold-start' })
      await waitForAbort(options.signal)
      this.log({ type: 'briefing-hold-abort' })
      options.signal?.throwIfAborted()
      throw new Error('briefing hold ended without abort')
    }
    yield* textResponse('Synthetic scheduled briefing: your calendar is ready to review. Would you like to plan the day?')
  }

  briefingControlPending() {
    try { return JSON.parse(readFileSync(this.controlPath, 'utf8')).briefingHoldOnce === true } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  consumeBriefingHold() {
    if (this.controlPath === undefined) return false
    let text
    try { text = readFileSync(this.controlPath, 'utf8') } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    const control = JSON.parse(text)
    if (control.briefingHoldOnce !== true) return false
    writeFileSync(this.controlPath, JSON.stringify({ ...control, briefingHoldOnce: false }) + '\n', 'utf8')
    return true
  }

  consumePrepareHold() {
    if (this.controlPath === undefined) return false
    let control
    let text
    try {
      text = readFileSync(this.controlPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    control = JSON.parse(text)
    if (control.prepareHoldOnce !== true) return false
    writeFileSync(this.controlPath, `${JSON.stringify({ ...control, prepareHoldOnce: false })}\n`, 'utf8')
    return true
  }

  log(entry) {
    if (this.logPath === undefined) return
    writeFileSync(this.logPath, `${JSON.stringify({ time: Date.now(), ...entry })}\n`, { flag: 'a' })
  }
}

function latestUserText(options) {
  const index = latestUserMessageIndex(options.messages)
  return index < 0 ? '' : options.messages[index].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function currentRequestToolResults(options) {
  const start = latestUserMessageIndex(options.messages)
  return options.messages
    .slice(start === -1 ? 0 : start)
    .flatMap(message => message.content)
    .filter(block => block.type === 'tool-result')
}

function latestUserMessageIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && messages[index].source?.kind === 'user') return index
  }
  return -1
}

function* textResponse(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: text.length } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCallResponse(id, name, args) {
  const argumentsJson = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argumentsJson }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argumentsJson } }
  yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal === undefined) {
      reject(new Error('scripted hold requires an abort signal'))
      return
    }
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', resolve, { once: true })
  })
}
