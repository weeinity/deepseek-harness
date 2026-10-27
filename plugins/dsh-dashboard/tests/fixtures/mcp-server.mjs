import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'dashboard-fixture', version: '1.0.0' })
server.registerTool('fetch', { inputSchema: { entityUrls: z.array(z.string()) } }, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, ok: true }) }],
}))
await server.connect(new StdioServerTransport())
