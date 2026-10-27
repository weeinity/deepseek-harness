/** Private Dashboard policy; ordinary preset selection authorizes neither input nor attention proposals. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'
import { ATTENTION_TOOL_NAME } from './attention-tool.ts'
import { DASHBOARD_CHAT_PERSONA, DashboardChatError } from './capture.ts'

const authorized = new WeakSet<Agent>()
interface AttentionAuthorization {
  allows(exec: Readonly<ToolExecution>): boolean
  persona(): string
}
const attention = new WeakMap<Agent, AttentionAuthorization>()

/** Private preset identity recorded by native Session metadata. */
export const DASHBOARD_CHAT_PRESET = 'dashboard-analysis'
/** Loader builtin owned by the private Host plugin. */
export const DASHBOARD_CHAT_BUILTIN = 'dashboard-chat-policy'
/** Cordis function-plugin name. */
export const name = DASHBOARD_CHAT_BUILTIN
/** Native registries contributed to by this preset. */
export const inject = ['systemPrompt', 'tools']

/**
 * Admit one unpublished Host-owned Agent to the standing private preset.
 * @param agent - native Agent prepared by the Dashboard owner.
 * @param capability Optional exact-execution authorization and its current Personal persona.
 * @returns scope-owned authorization revocation.
 */
export function authorizeDashboardAgent(
  agent: Agent, capability?: AttentionAuthorization,
): () => void {
  authorized.add(agent)
  if (capability !== undefined) attention.set(agent, capability)
  return () => { authorized.delete(agent); attention.delete(agent) }
}

/** Check the exact live Agent's revocable Host capability, not a scope or tool-name exemption.
 * @param exec Native execution identity and current cancellation.
 * @returns Whether the owner admits this execution of its proposal tool.
 */
export function allowsAttentionExecution(exec: Readonly<ToolExecution>): boolean {
  return exec.agent !== undefined && attention.get(exec.agent)?.allows(exec) === true
}

/** Select only a live owner-authorized persona for the native complete prompt.
 * @param agent Native assembly owner, absent for a global assembly.
 * @returns The current Personal persona or the standing analysis-only text.
 */
export function dashboardPersona(agent: Agent | undefined): string {
  return agent === undefined ? DASHBOARD_CHAT_PERSONA : attention.get(agent)?.persona() ?? DASHBOARD_CHAT_PERSONA
}

/** @param ctx - standing preset scope; it provides no new services. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const native = new NativeToolExecutor(ctx)
    return ctx.tools.setExecutor({
      describe: tools => native.describe(tools.filter(tool => tool.name === ATTENTION_TOOL_NAME)),
      execute: input => native.execute(input),
    })
  }, 'dashboardChat.presetExecutor()')
  ctx.effect(() => ctx.tools.restrict({ allow: [] }), 'dashboardChat.presetTools()')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'dashboard:analysis', order: 0, text: context => dashboardPersona(context.agent), complete: true,
  }), 'dashboardChat.presetPersona()')
  ctx.systemPrompt.suppressRuntimeContext()
  ctx.on('agent/pre-step', async ({ agent }, next) => authorized.has(agent) ? next() : { kind: 'reject' },
    { prepend: true })
  ctx.effect(() => ctx.tools.guard(exec => allowsAttentionExecution(exec) ? undefined
    : 'Dashboard conversations provide analysis only; tools are disabled.'), 'dashboardChat.presetGuard()')
  ctx.on('tools/pre-execute', async (exec, next) => allowsAttentionExecution(exec) ? next() : ({
    kind: 'deny', reason: 'Dashboard conversations provide analysis only; tools are disabled.',
  }), { prepend: true })
  ctx.on('tools/execute', async (exec, next) => {
    if (allowsAttentionExecution(exec)) return next()
    throw new DashboardChatError('TOOLS_DISABLED', 'Dashboard conversations cannot execute tools.')
  }, { prepend: true })
}
