import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { toPiContext } from '../src/context.ts'

describe('current DSH tool history', () => {
  it.each([false, true])('preserves a tool result with isError=%s', isError => {
    const id = ToolCallId('call-demo')
    const context = toPiContext({
      provider: 'github-copilot',
      model: 'test-model',
      messages: [
        createAssistantMessage({
          content: [{ type: 'tool-call', id, name: 'read_file', arguments: '{"path":"demo.txt"}' }],
          source: { provider: 'github-copilot', model: 'test-model' },
        }),
        createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'demo result' }], isError }),
      ],
    })
    expect(context.messages[1]).toEqual({
      role: 'toolResult', toolCallId: id, toolName: 'read_file',
      content: [{ type: 'text', text: 'demo result' }], isError, timestamp: 0,
    })
  })
})
