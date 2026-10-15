/** Deterministic MCP resources and literal instructions for headless Session snapshots. */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

class ExpiringTransport extends StdioServerTransport {
  override async start(): Promise<void> {
    await super.start()
    const receive = this.onmessage
    if (receive === undefined) throw new Error('Missing stdio receiver')
    const marker = join(process.cwd(), '.dsh', 'mcp-expired-once')
    this.onmessage = (message) => {
      if ('method' in message && 'id' in message && message.method === 'server/discover' && !existsSync(marker)) {
        void this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
      } else if ('method' in message && 'id' in message && message.method === 'ping' && !existsSync(marker)) {
        writeFileSync(marker, '', { flag: 'wx' })
        void this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'Session not found' } })
      } else {
        receive(message)
      }
    }
  }
}

serveStdio(() => {
  const server = new McpServer(
    { name: 'snapshot-resources', version: '1.0.0' },
    { instructions: 'MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal. Read resources from the catalog server.' },
  )
  server.registerResource('memo', 'memo://text', {
    description: 'Deterministic text memo.', mimeType: 'text/plain',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'MCP resource text with {{braces}} intact.' }],
  }))
  server.registerResource('binary', 'memo://binary', {
    description: 'Binary content for programmatic callers.', mimeType: 'application/octet-stream',
  }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: 'bWNwLXJlc291cmNlLWJpbmFyeQ==' }],
  }))
  server.registerResource('greeting', new ResourceTemplate('memo://greeting/{name}', { list: undefined }), {
    description: 'A greeting for the named reader.', mimeType: 'text/plain',
  }, async (uri, variables) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: `Hello, ${String(variables.name)}.` }],
  }))
  return server
}, process.env.DSH_MCP_EXPIRE_ONCE === '1' ? { transport: new ExpiringTransport() } : undefined)
