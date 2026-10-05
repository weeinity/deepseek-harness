/** Policy decisions are exercised through the real registry and approval service. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { runtime, temporaryDirectory } from '../../../tests/support.ts'

type ActionBody = (args: unknown, exec: ToolRunContext) => Promise<string>

function action(name: string, body: ActionBody = async () => 'done') {
  const spy = vi.fn(body)
  return {
    body: spy,
    tool: defineTool({
      name, description: 'Test assistant action',
      parameters: { text: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: (args, exec) => spy(args, exec),
    }),
  }
}

function humanMessage(text = 'new request') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function relayMessage(text = 'delegated context') {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test-relay', form: 'relay' },
  })
}

function emitHumanInput(ctx: Context, agent: Agent, text?: string): void {
  ctx.emit(scopeTarget(agent, agent), 'agent/inbox/inserted', { agent, message: humanMessage(text) })
}

describe('personal action gateway', () => {
  it('audits reads using host identity without storing argument bodies', async () => {
    const h = await runtime()
    const { tool, body } = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read', externalContent: true })
    const result = await h.run(tool.name, { text: 'private-calendar-data', userId: 'spoofed', sessionId: 'spoofed', tainted: false })
    expect(result.isError).toBe(false)
    expect(body).toHaveBeenCalledOnce()
    expect(h.ctx.workAssistGateway.records()).toEqual([expect.objectContaining({
      ownerId: 'test-owner', sessionId: h.session.id, connector: 'calendar',
      decision: 'allow', status: 'succeeded', tainted: true,
    })])
    expect(JSON.stringify(h.ctx.workAssistGateway.records())).not.toContain('private-calendar-data')
    expect(JSON.stringify(h.ctx.workAssistGateway.records())).not.toContain('spoofed')
  })

  it('blocks unknown tools even if another policy force-allows them', async () => {
    const h = await runtime()
    const { tool, body } = action('shell')
    h.ctx.tools.register(tool)
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
    expect((await h.run('shell')).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('does not admit a tool merely because it has an assistant-like name', async () => {
    const h = await runtime()
    const { tool, body } = action('wa_read_shell')
    h.ctx.tools.register(tool)
    expect((await h.run(tool.name)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('denies a scoped tool shadowing a gateway-owned name', async () => {
    const h = await runtime()
    const registered = action('calendar_list')
    const shadow = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, registered.tool, { connector: 'calendar', method: 'list', kind: 'read' })
    await h.ctx.plugin(Object.assign((ctx: Context) => {
      const scope = createScope(ctx, h.agent)
      ctx.effect(() => () => scope.dispose(), 'test.scope')
      scope.ctx.tools.register(shadow.tool)
    }, { inject: ['tools'] }))
    expect((await h.run('calendar_list')).isError).toBe(true)
    expect(shadow.body).not.toHaveBeenCalled()
    expect(registered.body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()).toEqual([])
  })

  it('returns independent audit snapshots', async () => {
    const h = await runtime()
    const { tool } = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    await h.run(tool.name)
    const record = h.ctx.workAssistGateway.records()[0]!
    record.status = 'failed'
    expect(h.ctx.workAssistGateway.records()[0]?.status).toBe('succeeded')
  })

  it('fails closed without an approval answerer', async () => {
    const h = await runtime()
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })
    expect((await h.run(tool.name)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'deny', status: 'denied' })
    expect(h.session.snapshotEvents().filter(event => event.type === 'approval/decided')).toHaveLength(1)
  })

  it('requires a new grant for every write, including an externally exposed session', async () => {
    const h = await runtime()
    const read = action('calendar_list')
    const write = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, read.tool, { connector: 'calendar', method: 'list', kind: 'read', externalContent: true })
    h.ctx.workAssistGateway.register(h.ctx, write.tool, { connector: 'memory', method: 'write', kind: 'write' })
    const answer = vi.fn(() => Promise.resolve('allowed-once' as const))
    h.ctx.on('approval/request', answer)
    await h.run(read.tool.name)
    expect((await h.run(write.tool.name)).isError).toBe(false)
    expect((await h.run(write.tool.name)).isError).toBe(false)
    expect(answer).toHaveBeenCalledTimes(2)
    expect(write.body).toHaveBeenCalledTimes(2)
    expect(h.ctx.workAssistGateway.records().every(record => record.tainted)).toBe(true)
  })

  it('dispatches the immutable payload that approval reviewed', async () => {
    const h = await runtime()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<'allowed-once'>()
    h.ctx.on('approval/request', () => {
      entered.resolve()
      return release.promise
    })
    const body = vi.fn(async (args?: unknown) => {
      return JSON.stringify(args)
    })
    const { tool } = action('memory_write', body)
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })
    const args = { text: 'reviewed' }
    const running = h.run(tool.name, args)
    await entered.promise
    args.text = 'mutated'
    release.resolve('allowed-once')

    expect(await running).toMatchObject({ isError: false, value: '{"text":"reviewed"}' })
    expect(body).toHaveBeenCalledWith(expect.objectContaining({ text: 'reviewed' }), expect.anything())
  })

  it('invalidates a pending write approval when the same agent receives newer human input', async () => {
    const h = await runtime()
    const entered = Promise.withResolvers<{ signal: AbortSignal | undefined }>()
    h.ctx.on('approval/request', request => {
      entered.resolve({ signal: request.signal })
      return new Promise<'cancelled'>(resolve => {
        request.signal?.addEventListener('abort', () => { resolve('cancelled' as const) }, { once: true })
      })
    })
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })

    const running = h.run(tool.name)
    const request = await entered.promise
    emitHumanInput(h.ctx, h.agent)

    expect(await running).toMatchObject({ isError: true })
    expect(request.signal?.aborted).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'deny', status: 'denied' })
  })

  it('invalidates a pending write when newer human input arrives during initial audit admission', async () => {
    const h = await runtime()
    const approve = vi.fn(async () => 'allowed-once' as const)
    h.ctx.on('approval/request', approve)
    let emitted = false
    h.ctx.on('domain/changed', () => {
      if (emitted) return
      if (!h.ctx.workAssistGateway.records().some(record => record.tool === 'memory_write' && record.status === 'pending')) return
      emitted = true
      emitHumanInput(h.ctx, h.agent, 'replace the pending write')
    })
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })

    expect(await h.run(tool.name)).toMatchObject({ isError: true })
    expect(approve).not.toHaveBeenCalled()
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'deny', status: 'denied' })
  })

  it('invalidates after approval when newer human input arrives during running audit admission', async () => {
    const h = await runtime()
    const approve = vi.fn(async () => 'allowed-once' as const)
    h.ctx.on('approval/request', approve)
    let emitted = false
    h.ctx.on('domain/changed', () => {
      if (emitted) return
      if (!h.ctx.workAssistGateway.records().some(record => record.tool === 'memory_write' && record.status === 'running')) return
      emitted = true
      emitHumanInput(h.ctx, h.agent, 'change after approval')
    })
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })

    expect(await h.run(tool.name)).toMatchObject({ isError: true })
    expect(approve).toHaveBeenCalledOnce()
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'deny', status: 'denied' })
  })

  it('does not stale-deny reads when direct human input arrives during admission', async () => {
    const h = await runtime()
    let emitted = false
    h.ctx.on('domain/changed', () => {
      if (emitted) return
      if (!h.ctx.workAssistGateway.records().some(record => record.tool === 'calendar_list' && record.status === 'pending')) return
      emitted = true
      emitHumanInput(h.ctx, h.agent, 'new read context')
    })
    const { tool, body } = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })

    expect(await h.run(tool.name)).toMatchObject({ isError: false })
    expect(body).toHaveBeenCalledOnce()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'allow', status: 'succeeded' })
  })

  it('does not cancel a write that has already started dispatching', async () => {
    const h = await runtime()
    h.ctx.on('approval/request', async () => 'allowed-once' as const)
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    const body = vi.fn(async (_args: unknown, exec: ToolRunContext) => {
      entered.resolve(exec.signal)
      await release.promise
      return 'done'
    })
    const { tool } = action('memory_write', body)
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })

    const running = h.run(tool.name)
    const dispatchSignal = await entered.promise
    emitHumanInput(h.ctx, h.agent, 'too late to invalidate dispatched write')
    expect(dispatchSignal.aborted).toBe(false)
    release.resolve()

    expect(await running).toMatchObject({ isError: false })
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'allow', status: 'succeeded' })
  })

  it('keeps waiting when relay or another agent receives input during approval', async () => {
    const h = await runtime()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<'allowed-once'>()
    h.ctx.on('approval/request', () => {
      entered.resolve()
      return release.promise
    })
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })

    const running = h.run(tool.name)
    await entered.promise
    h.ctx.emit(scopeTarget(h.agent, h.agent), 'agent/inbox/inserted', { agent: h.agent, message: relayMessage() })
    const otherAgent = { id: h.agent.id, session: h.session } as typeof h.agent
    emitHumanInput(h.ctx, otherAgent, 'other agent')
    release.resolve('allowed-once')

    expect(await running).toMatchObject({ isError: false })
    expect(body).toHaveBeenCalledOnce()
    expect(h.ctx.workAssistGateway.records()[0]).toMatchObject({ decision: 'allow', status: 'succeeded' })
  })

  it('does not dispatch an aborted approval and records the denial', async () => {
    const h = await runtime()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    h.ctx.on('approval/request', () => {
      entered.resolve()
      return new Promise(() => {})
    })
    const { tool, body } = action('memory_write')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'memory', method: 'write', kind: 'write' })
    const running = h.run(tool.name, {}, controller.signal)
    await entered.promise
    controller.abort()
    expect((await running).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]?.status).toBe('denied')
  })

  it('records action failure without automatically retrying it', async () => {
    const h = await runtime()
    const body = vi.fn(async (): Promise<string> => { throw new Error('provider failed') })
    const { tool } = action('calendar_list', body)
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    expect((await h.run(tool.name)).isError).toBe(true)
    expect(body).toHaveBeenCalledOnce()
    expect(h.ctx.workAssistGateway.records()[0]?.status).toBe('failed')
  })

  it('does not dispatch when cancellation arrives during the durable admission write', async () => {
    const h = await runtime()
    const controller = new AbortController()
    const { tool, body } = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    h.ctx.on('domain/changed', () => {
      if (h.ctx.workAssistGateway.records().some(record => record.status === 'running')) controller.abort()
    })
    expect((await h.run(tool.name, {}, controller.signal)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(h.ctx.workAssistGateway.records()[0]?.status).toBe('interrupted')
  })

  it('refuses dispatch if the audit store cannot accept the initial record', async () => {
    const h = await runtime()
    const { tool, body } = action('calendar_list')
    h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    await h.ctx.storageDomain.get('workassist')!.close()
    expect((await h.run(tool.name)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('revokes a disposed tool registration', async () => {
    const h = await runtime()
    const { tool, body } = action('calendar_list')
    const dispose = h.ctx.workAssistGateway.register(h.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    dispose()
    dispose()
    expect((await h.run(tool.name)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('persists audit metadata across a complete service restart', async () => {
    const database = join(await temporaryDirectory(), `${randomUUID()}.db`)
    const first = await runtime(database)
    const { tool } = action('calendar_list')
    first.ctx.workAssistGateway.register(first.ctx, tool, { connector: 'calendar', method: 'list', kind: 'read' })
    await first.run(tool.name)
    const records = first.ctx.workAssistGateway.records()
    await first.ctx.fiber.dispose()
    const second = await runtime(database)
    expect(second.ctx.workAssistGateway.records()).toEqual(records)
  })
})
