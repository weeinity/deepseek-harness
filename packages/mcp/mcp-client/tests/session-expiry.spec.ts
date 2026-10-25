/** Stateful legacy HTTP session expiration through the real MCP SDK. */
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as McpClient from '../src/index.ts'
import { createServer } from 'node:http'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

interface RpcRequest { id?: string | number; method: string }

describe('expired Streamable HTTP sessions', () => {
  it('reinitializes a rejected session before executing the pending tool once', async () => {
    let session = 0
    let expired = false
    let calls = 0
    const methods: string[] = []
    const server = createServer((request, response) => {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      void (async () => {
        let body = ''
        for await (const chunk of request) body += String(chunk)
        const message = JSON.parse(body) as RpcRequest
        methods.push(message.method)
        const reply = (result: object, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
        }
        if (message.method === 'server/discover') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' },
          }))
        } else if (message.method === 'initialize') {
          session++
          expired = false
          response.setHeader('mcp-session-id', String(session))
          reply({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'expiry', version: '1' } })
        } else if (message.id === undefined) {
          response.writeHead(202).end()
        } else if (expired || request.headers['mcp-session-id'] !== String(session)) {
          response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
            jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Session not found' },
          }))
        } else if (message.method === 'tools/list') {
          reply({ tools: [{ name: 'write', inputSchema: { type: 'object' } }] })
        } else if (message.method === 'tools/call') {
          calls++
          reply({ content: [{ type: 'text', text: 'written once' }] })
        } else {
          reply({})
        }
      })().catch((error: unknown) => { response.writeHead(500).end(String(error)) })
    })
    onTestFinished(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Missing fixture address')
    const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-expiry-loader-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['expiry-prompt'] = SystemPrompt
    ctx.loader.builtins['expiry-tools'] = ToolRuntime
    ctx.loader.builtins['expiry-mcp'] = McpClient
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([
      { id: 'prompt', name: 'cordis:expiry-prompt' },
      { id: 'tools', name: 'cordis:expiry-tools' },
      { id: 'mcp', name: 'cordis:expiry-mcp', config: {
        transport: 'streamable-http', serverName: 'expiry', url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {}, toolCallTimeoutMs: 10_000, failOnStartupError: true,
      } },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect(ctx.tools.get('mcp__expiry__write')).toBeDefined()
    expired = true
    const result = await executeToolFixture(ctx, {
      name: 'mcp__expiry__write', arguments: {}, callId: ToolCallId('expired-http'), signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'written once' }] } })
    expect(session).toBe(2)
    expect(calls).toBe(1)
    expect(methods.filter(method => method === 'ping')).toHaveLength(2)
    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.schemas()).toEqual([])
  })
})
