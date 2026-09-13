import { describe, expect, it } from 'vitest'
import { renderToolsSdk } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import { renderToolsSdkPy } from '@deepseek-ai/dsh-tools/src/py-types.ts'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'

const search: ToolSdkSchema = {
  name: 'mcp__catalog__search',
  description: 'Search a catalog.',
  parameters: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: { type: 'array', items: { type: 'string' }, description: 'Search phrases.' },
      cursor: { type: ['string', 'null'] },
      collections: {
        type: ['array', 'null'],
        items: {
          type: ['object', 'null'],
          properties: { name: { type: 'string', enum: ['notes', 'messages'] } },
        },
      },
      includeDetails: { type: 'boolean', default: false },
    },
  },
  output: { type: 'string' },
}

function parameterSchemas(text: string): Record<string, unknown> {
  const json = text.split('\n```json\n')[1]?.split('\n```')[0]
  expect(json).toBeDefined()
  return JSON.parse(json!) as Record<string, unknown>
}

describe.each([
  ['TypeScript', renderToolsSdk],
  ['Python', renderToolsSdkPy],
] as const)('%s PTC parameter schemas', (_language, render) => {
  it('preserves complete nullable parameter schemas beside opaque argument types', () => {
    const text = render([search])
    expect(text).toContain('## Tool argument JSON schemas')
    expect(text).toContain('Use these JSON schemas to construct arguments for the named bindings.')
    expect(parameterSchemas(text)).toEqual({ [search.name]: search.parameters })
  })

  it('retains references, overlapping alternatives, constraints, and schema descriptions', () => {
    const parameters = {
      type: 'object',
      $defs: { label: { type: 'string', pattern: '^[a-z]+$' } },
      properties: {
        label: { $ref: '#/$defs/label', description: 'A label: */\n```python\n"quoted"\\' },
        count: { anyOf: [{ type: 'number' }, { type: 'integer' }], minimum: 0 },
      },
      additionalProperties: { type: 'string' },
    }
    const text = render([{ ...search, parameters }])
    expect(parameterSchemas(text)).toEqual({ [search.name]: parameters })
    expect(text.match(/^```/gm)).toHaveLength(4)
  })

  it('omits the appendix for typed parameters and empty tool sets', () => {
    const parameters = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    expect(render([{ ...search, parameters }])).not.toContain('## Tool argument JSON schemas')
    expect(render([])).not.toContain('## Tool argument JSON schemas')
  })

  it('orders fallback schemas by exact tool name and excludes typed neighbors', () => {
    const exotic = { ...search, name: 'a.tool' }
    const prototype = { ...search, name: '__proto__' }
    const typed = { ...search, name: 'typed', parameters: { type: 'object' } }
    const text = render([search, typed, exotic, prototype])
    expect(text).toBe(render([prototype, exotic, typed, search]))
    expect(Object.keys(parameterSchemas(text))).toEqual(['__proto__', 'a.tool', search.name])
    expect(parameterSchemas(text)['__proto__']).toEqual(search.parameters)
  })

  it('renders deeply nested external schemas without recursion or truncation', () => {
    let parameters: Record<string, unknown> = { type: ['string', 'null'], description: 'Leaf constraint.' }
    const depth = 5_000
    for (let index = 0; index < depth; index++) parameters = { type: 'array', items: parameters }
    const text = render([{ ...search, parameters }])
    let parsed = parameterSchemas(text)[search.name] as Record<string, unknown>
    for (let index = 0; index < depth; index++) {
      expect(parsed['type']).toBe('array')
      parsed = parsed['items'] as Record<string, unknown>
    }
    expect(parsed).toEqual({ type: ['string', 'null'], description: 'Leaf constraint.' })
  })

  it('rejects parameter schemas that cannot be preserved as lossless JSON', () => {
    const cycle: Record<string, unknown> = { type: 'object' }
    cycle['properties'] = { child: cycle }
    for (const parameters of [cycle, { type: 'object', unsupported: undefined }]) {
      expect(() => render([{ ...search, parameters }]))
        .toThrow(`Cannot render parameters for tool "${search.name}": schema must be lossless JSON`)
    }
  })
})
