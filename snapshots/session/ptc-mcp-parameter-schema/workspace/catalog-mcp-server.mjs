/** Stdio MCP fixture advertising nullable argument types without schema translation. */
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'

const inputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'array',
      items: { type: 'string' },
      description: 'Search terms.',
    },
    scope: {
      type: ['string', 'null'],
      description: 'Optional catalog scope; null searches all scopes.',
    },
    collections: {
      type: ['array', 'null'],
      items: {
        type: ['object', 'null'],
        properties: { name: { type: 'string', enum: ['notes', 'messages'] } },
        required: ['name'],
        additionalProperties: false,
      },
      description: 'Optional collection filters; null entries leave a filter unspecified.',
    },
  },
  required: ['query'],
  additionalProperties: false,
}

const expectedArguments = {
  query: ['cache'],
  scope: null,
  collections: [null, { name: 'notes' }, { name: 'messages' }],
}

const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let response
  switch (request.method) {
    case 'initialize':
      response = {
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'catalog-fixture', version: '1.0.0' },
        },
      }
      break
    case 'ping':
      response = { result: {} }
      break
    case 'tools/list':
      response = {
        result: {
          tools: [{ name: 'search', description: 'Search the catalog.', inputSchema }],
        },
      }
      break
    case 'tools/call': {
      const accepted = request.params.name === 'search'
        && isDeepStrictEqual(request.params.arguments, expectedArguments)
      response = {
        result: {
          content: [{
            type: 'text',
            text: accepted ? JSON.stringify(request.params.arguments) : 'Unexpected catalog search arguments.',
          }],
          isError: !accepted,
        },
      }
      break
    }
    default:
      response = { error: { code: -32601, message: 'Method not found' } }
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, ...response })}\n`)
}
