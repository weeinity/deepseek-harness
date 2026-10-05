/**
 * @deepseek-ai/dsh-wa-preset ships the personal-assistant preset assets, profile patch, and scoped interaction wiring.
 * @module @deepseek-ai/dsh-wa-preset
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-wa-gateway'

/** Preset directory and profile default id shipped by this bundle. */
export const PERSONAL_ASSISTANT_PRESET_ID = 'personal-assistant'

/** Cordis function-plugin name used for diagnostics. */
export const name = 'wa-preset'
/** Services required before agent-scoped interaction wiring can run. */
export const inject = ['tools', 'workAssistGateway', 'userQuestions']

const ASK_USER_PLUGIN = '@deepseek-ai/dsh-tool-ask-user'
const ASK_USER_TOOL = 'ask_user_question'

/**
 * Install the published DSH user-question tool in one agent scope and admit only that definition.
 * @param ctx - Agent-scoped preset context.
 * @returns When the scoped tool registration and gateway admission are active.
 */
export async function apply(ctx: Context): Promise<void> {
  const scope = scopeOf(ctx)
  if (scope === undefined) {
    throw new Error('wa-preset interaction wiring requires an agent-scoped context')
  }
  const askUser = await import(ASK_USER_PLUGIN) as Plugin.Object<void>
  await ctx.plugin(askUser)
  const definition = ctx.tools.get(ASK_USER_TOOL, scope)
  if (definition === undefined) {
    throw new Error('wa-preset could not resolve the scoped ask_user_question tool')
  }
  ctx.workAssistGateway.admitUserQuestionTool(ctx, definition)
}
