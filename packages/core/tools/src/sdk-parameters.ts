/** JSON parameter declarations for opaque PTC bindings. @module @deepseek-ai/dsh-tools/src/sdk-parameters */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { renderJsonValue } from './json-render.ts'

/**
 * Preserve parameter schemas that a language's argument types cannot describe.
 * @param schemas - opaque bindings in SDK declaration order.
 * @returns a JSON-schema appendix, or empty text when every binding has typed arguments.
 * @throws when a parameter schema cannot be preserved as lossless JSON.
 */
export function renderRawParameterSchemas(schemas: readonly ToolSchema[]): string {
  if (schemas.length === 0) return ''
  const entries = schemas.map((schema) => {
    const parameters = snapshotJsonValue(schema.parameters) as JsonValue | undefined
    if (parameters === undefined) {
      throw new Error(`Cannot render parameters for tool ${JSON.stringify(schema.name)}: schema must be lossless JSON`)
    }
    return [schema.name, parameters] as const
  })
  const json = renderJsonValue(Object.fromEntries(entries))
  return `\n\n## Tool argument JSON schemas\n\nUse these JSON schemas to construct arguments for the named bindings. Their \`unknown\` or \`Any\` argument types do not describe the required fields or constraints.\n\n\`\`\`json\n${json}\n\`\`\``
}
