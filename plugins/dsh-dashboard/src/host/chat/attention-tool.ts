/** Native proposal receipts; item changes belong to authenticated confirmation routes. */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { attentionProposalSchema, attentionToolInputSchema, type AttentionProposal,
  type AttentionToolInput } from '../../shared/attention.ts'

/** Only the Personal Host-owned Agent registers this name. */
export const ATTENTION_TOOL_NAME = 'dashboard_attention_propose'

/** Define a proposal-only native tool with shared input and receipt validation.
 * @param propose Owner-checked durable proposal admission; it must not mutate an item.
 * @returns A scope-local definition with replayable versioned receipt metadata.
 */
export function attentionTool(
  propose: (input: AttentionToolInput, exec: ToolRunContext) => Promise<AttentionProposal>,
): ToolDefinition {
  return defineTool({
    name: ATTENTION_TOOL_NAME,
    description: 'Propose one local Personal Work attention adjustment requested by the human. No change is applied until the human explicitly confirms. Use a captured attention key; never modify source records.',
    parameters: {
      itemKey: { type: 'string', required: true, description: 'Exact attention key from the captured Personal evidence.' },
      intent: {
        required: true,
        oneOf: [
          { type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', const: 'hide', required: true } } },
          { type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', const: 'handle', required: true } } },
          { type: 'object', additionalProperties: false,
            properties: { kind: { type: 'string', const: 'restore', required: true } } },
          { type: 'object', additionalProperties: false, properties: {
            kind: { type: 'string', const: 'snooze', required: true },
            until: { type: 'string', required: true, description: 'Explicit ISO 8601 time including its UTC offset.' },
          } },
        ],
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'integer', const: 1, required: true },
        proposal: { type: 'json', required: true },
      } },
      render(_args, value) {
        const proposal = attentionProposalSchema.parse(value.proposal)
        const subject = `${proposal.id}: ${proposal.intent.kind} "${proposal.target.title}".`
        return [{ type: 'text', text: proposal.status === 'pending'
          ? `Pending attention proposal ${subject} Not applied. Explicit human confirmation is required; source records are unchanged.`
          : `Existing attention proposal ${subject} Recorded status: ${proposal.status}. This proposal is not pending confirmation. This call applied no change; source records are unchanged.` }]
      },
      presentationMeta: (_args, value) => ({ dashboardAttention: value }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const input = attentionToolInputSchema.parse(args)
      const proposal = attentionProposalSchema.parse(await propose(input, exec))
      exec.signal.throwIfAborted()
      exec.concludeTurn()
      return { version: 1 as const, proposal }
    },
  })
}
