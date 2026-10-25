/**
 * Taskboard delivery through the shared Session Controller. Receipts identify
 * one inbox input and its owning turn, including rejection before model admission.
 * Borrowed Sessions remain owned by their ordinary Host lifecycle.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { DynamicCordisRunnerService } from '@deepseek-ai/dsh-cordis-host-runner'
import type {
  ApprovalRequestId as DynamicApprovalRequestId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type { MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session, SessionEvent, SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { TaskConnection, TaskExecution, TaskExecutionReceipt } from '@deepseek-ai/dsh-taskboard/types'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskConversationObservation, TaskExecutionAdapter, TaskExecutionObservation } from './adapter.ts'

type DshReceipt = Extract<TaskExecutionReceipt, { kind: 'dsh' }>
type DshSettings = Extract<TaskExecution['executionSettings'], { kind: 'dsh' }>
type SettledObservation = Extract<TaskExecutionObservation, { state: 'settled' }>

interface DynamicApproval {
  readonly runner: object
  readonly agent: Agent
  readonly turn: number
  readonly requestId: DynamicApprovalRequestId
  readonly pluginId: CordisDynamicPluginId
  readonly pluginRunId: CordisDynamicPluginRunId
}

class DshExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

interface Evidence {
  readonly messageId?: MessageId
  readonly turn?: number
  readonly admitted: boolean
  readonly removed: boolean
  readonly end?: SessionEvent<'turn/end'>
}

/** Cordis service reads are fresh proxies; their tracker belongs to the providing instance. */
function runnerIdentity(runner: DynamicCordisRunnerService): object {
  return Reflect.get(runner, Service.tracker) as object
}

function requestId(execution: TaskExecution): SessionRequestId {
  return brandString<SessionRequestId>(`taskboard:${execution.id}`)
}

function owns(source: MessageSource, execution: TaskExecution): boolean {
  return source.kind === 'user' && 'rpcId' in source && source.rpcId === requestId(execution)
}

function connectionOf(execution: TaskExecution): Extract<TaskConnection, { kind: 'dsh' }> {
  if (execution.connection?.kind !== 'dsh') {
    throw new DshExecutionError('taskboard/dsh-connection-required', 'Execution requires its reserved DSH Session.')
  }
  return execution.connection
}

function settingsOf(execution: TaskExecution): DshSettings {
  const settings = execution.executionSettings
  if (settings.kind !== 'dsh') {
    throw new DshExecutionError(
      'taskboard/dsh-settings-required', 'DSH execution requires DSH settings.',
    )
  }
  return settings
}

function receiptOf(execution: TaskExecution): DshReceipt {
  if (execution.receipt?.kind !== 'dsh') {
    throw new DshExecutionError('taskboard/dsh-receipt-required', 'Persist the DSH preparation receipt before submission.')
  }
  return execution.receipt
}

function changesExecutionSettings(event: SessionEvent): boolean {
  switch (event.type) {
    case 'model/selection':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy':
    case 'agent-preset/selected':
      return true
    default:
      return false
  }
}

/** Replay normalized splices to recover exact claimed identities; claims are not model admission. */
function evidence(events: readonly SessionEvent[], execution: TaskExecution, receipt: DshReceipt): Evidence {
  if ((events.at(-1)?.seq ?? -1) < receipt.afterSequence) {
    throw new DshExecutionError('taskboard/dsh-history-truncated', 'DSH history ends before the recorded preparation cursor.')
  }
  const queues: Record<'next-step' | 'next-turn', UserMessage[]> = { 'next-step': [], 'next-turn': [] }
  const matching = new Set<MessageId>()
  let openTurn: number | undefined
  let claimedTurn: number | undefined
  let admitted = false
  let removed = false
  let end: SessionEvent<'turn/end'> | undefined
  const remember = (message: UserMessage): boolean => {
    if (!owns(message.source, execution)) return false
    matching.add(message.id)
    return true
  }
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.data.turn
        break
      case 'agent/inbox/spliced': {
        const { target, start, removedCount, inserted, outcome } = event.data
        const taken = queues[target].splice(start, removedCount ?? 0, ...inserted)
        for (const message of inserted) remember(message)
        for (const message of taken) {
          if (!remember(message)) continue
          if (outcome === 'canceled') removed = true
          else claimedTurn ??= openTurn
        }
        break
      }
      case 'user/message':
        if (remember(event.data)) {
          claimedTurn ??= openTurn
          admitted ||= openTurn === claimedTurn
        }
        break
      case 'turn/end':
        if (event.data.turn === claimedTurn) end = event
        openTurn = undefined
        break
      default:
        // Other merge-extensible Session facts do not identify inbox ownership.
        break
    }
  }
  if (matching.size > 1) {
    throw new DshExecutionError('taskboard/dsh-ambiguous-receipt', 'Multiple DSH messages claim this execution identity.')
  }
  const messageId = matching.values().next().value
  const expected = receipt.messageId
  if (expected !== undefined && messageId !== expected) {
    throw new DshExecutionError('taskboard/dsh-receipt-mismatch', 'DSH history does not contain the recorded execution message.')
  }
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(claimedTurn === undefined ? {} : { turn: claimedTurn }),
    admitted, removed,
    ...(end === undefined ? {} : { end }),
  }
}

function failed(code: string, message: string, receipt: DshReceipt): TaskExecutionObservation {
  return {
    state: 'settled', outcome: 'failed', error: { code, message }, receipt,
  }
}

function ending(found: Evidence, receipt: DshReceipt): TaskExecutionObservation | undefined {
  if (found.end === undefined) return undefined
  const reason = found.end.data.reason
  switch (reason.kind) {
    case 'aborted':
      return { state: 'settled', outcome: 'cancelled', receipt }
    case 'error':
      return failed(reason.error.code, reason.error.message, receipt)
    case 'interrupted':
      return failed('taskboard/dsh-interrupted', 'The execution turn was interrupted before its result was recorded.', receipt)
    case 'blocked':
      return failed('taskboard/dsh-blocked', 'The execution turn was blocked.', receipt)
    case 'max-tokens':
      return failed('taskboard/dsh-max-tokens', 'The execution turn reached its output-token limit.', receipt)
    case 'completed':
      return found.admitted
        ? { state: 'settled', outcome: 'succeeded', receipt }
        : failed('taskboard/dsh-not-admitted', 'The execution input was claimed but did not enter a model request.', receipt)
    default:
      // A provider cannot infer success from a plugin-defined turn ending.
      return failed('taskboard/dsh-unknown-ending', 'The execution turn has an unsupported outcome.', receipt)
  }
}

/**
 * Create a Host adapter using shared Session activation, model selection, and
 * durable inbox admission. Each result belongs to the input's exact turn; manual
 * steering may share that turn, but later turns cannot replace its failure.
 * Undefined preset, model, and permission pins preserve connected Session
 * choices; new Sessions inherit normal Session Controller initialization.
 * Terminal evidence remains cached until settlement release; transient history
 * reads and failed durability barriers reject observation without an outcome.
 * Open question and approval waterfalls report waiting only for the exact
 * live Agent and owning turn; their answers resume running observation.
 * An attributed dynamic-package approval defers publishing exact turn success
 * until its registry leaves human approval; another turn cannot change that result.
 * Wait attribution requires requests observed by this mounted adapter; existing
 * waits cannot be reconstructed from Session history alone.
 * Linked-chat attention also follows questions outside Taskboard runs through
 * their exact turn ending, without creating or changing execution receipts.
 * Disposal stops adapter operations, never the borrowed Agent or its work.
 * @param ctx - Host context with Session Controller, Workspace, permission, preset, and persistence services.
 * @returns serialized DSH preparation and delivery with read-only restart observation.
 */
export function createDshExecutionAdapter(ctx: Context): TaskExecutionAdapter {
  const lifetime = new AbortController()
  const tails = new Map<SessionId, Promise<void>>()
  const operations = new Set<Promise<unknown>>()
  const admissions = new Map<TaskExecution['id'], {
    readonly agent: Agent
    readonly receipt: DshReceipt
    submitting: boolean
  }>()
  const observations = new Map<TaskExecution['id'], {
    readonly sessionId: SessionId
    readonly pending: Set<Promise<unknown>>
    terminal?: SettledObservation
    deferredSuccess?: {
      readonly result: SettledObservation
      readonly receipt: DshReceipt
      readonly approvals: readonly DynamicApproval[]
    }
  }>()
  const waiting = new Set<{ readonly agent: Agent; readonly turn: number; readonly stop: () => void }>()
  // Registry-local IDs can repeat after reload; ownership requires the issuing runtime witness.
  const dynamicApprovals = new Map<DynamicApprovalRequestId, DynamicApproval>()
  const openTurns = new WeakMap<Session, number>()
  const latestSettingsChanges = new WeakMap<Session, number>()
  const deliveredEvents = new WeakMap<Session, SessionEvent[]>()
  const listeners = [
    ctx.on('session/event', (session, event) => {
      const events = deliveredEvents.get(session)
      if (events === undefined) deliveredEvents.set(session, [event])
      else events.push(event)
      if (changesExecutionSettings(event)) latestSettingsChanges.set(session, event.seq)
      if (event.type === 'turn/start') openTurns.set(session, event.data.turn)
      else if (event.type === 'turn/end') openTurns.delete(session)
    }),
    ctx.on('user-questions/request', (request, next) => awaitInput(request.agent, request.signal, next), { prepend: true }),
    ctx.on('approval/request', (request, next) => awaitInput(request.agent, request.signal, next), { prepend: true }),
    ctx.on('cordis/request-run', (request) => {
      if (lifetime.signal.aborted) return
      pruneDynamicApprovals()
      if (!request.requiresApproval) return
      const agent = ctx.agents.get(request.agentId)
      const runner = ctx.get('dynamicCordisRunner')
      if (agent === undefined || runner === undefined) return
      const turn = openTurns.get(agent.session)
      if (turn === undefined) return
      const row = runner.inventory().find(candidate => candidate.agentId === agent.id && candidate.pluginId === request.pluginId)
      const attempt = row?.latestRun
      if (attempt?.approvalRequestId !== request.requestId) return
      dynamicApprovals.set(request.requestId, {
        runner: runnerIdentity(runner), agent, turn, requestId: request.requestId,
        pluginId: request.pluginId, pluginRunId: attempt.pluginRunId,
      })
    }),
    ctx.on('cordis/request-run-resolved', () => { pruneDynamicApprovals() }),
  ]

  function pendingDynamicApprovals(approvals: readonly DynamicApproval[]): DynamicApproval[] {
    const runner = ctx.get('dynamicCordisRunner')
    if (runner === undefined) return []
    const identity = runnerIdentity(runner)
    const rows = runner.inventory()
    return approvals.filter(approval => approval.runner === identity && rows.some(row =>
      row.agentId === approval.agent.id && row.pluginId === approval.pluginId
      && row.latestRun?.requiresApproval === true && row.latestRun.status === 'awaiting-approval'
      && row.latestRun.pluginRunId === approval.pluginRunId && row.latestRun.approvalRequestId === approval.requestId))
  }

  function pruneDynamicApprovals(): void {
    const pending = new Set(pendingDynamicApprovals([...dynamicApprovals.values()]))
    for (const [id, approval] of dynamicApprovals) {
      if (!pending.has(approval)) dynamicApprovals.delete(id)
    }
  }

  function ownedDynamicApprovals(sessionId: SessionId, found: Evidence): DynamicApproval[] {
    return [...dynamicApprovals.values()].filter(approval =>
      approval.agent.id === sessionId && approval.turn === found.turn)
  }

  async function awaitInput<T>(
    agent: Agent | undefined, signal: AbortSignal | undefined, next: () => Promise<T>,
  ): Promise<T> {
    if (lifetime.signal.aborted || signal?.aborted || agent === undefined) return next()
    const turn = openTurns.get(agent.session)
    if (turn === undefined) return next()
    const pending = {
      agent, turn,
      stop(this: void): void {
        waiting.delete(pending)
        signal?.removeEventListener('abort', pending.stop)
      },
    }
    waiting.add(pending)
    signal?.addEventListener('abort', pending.stop, { once: true })
    try {
      return await next()
    } finally {
      pending.stop()
    }
  }

  function track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation()
    operations.add(pending)
    void pending.then(() => { operations.delete(pending) }, () => { operations.delete(pending) })
    return pending
  }

  function serialized<T>(id: SessionId, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, lifetime.signal])
    return track(async () => {
      const previous = tails.get(id) ?? Promise.resolve()
      const pending = previous.then(() => {
        combined.throwIfAborted()
        return operation(combined)
      })
      const tail = pending.then(() => {}, () => {})
      tails.set(id, tail)
      try {
        return await pending
      } finally {
        if (tails.get(id) === tail) tails.delete(id)
      }
    })
  }

  function membership(id: SessionId, workspaceId: WorkspaceId, header: SessionHeader): void {
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || !workspace.sessionIds.includes(id) || header.origin === 'subagent') {
      throw new DshExecutionError(
        'taskboard/dsh-workspace-mismatch', 'The connected DSH Session is not an ordinary member of this Workspace.',
      )
    }
  }

  function idle(agent: Agent): void {
    if (ctx.agents.get(agent.id) !== agent || agent.status !== 'idle'
      || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0) {
      throw new DshExecutionError('taskboard/dsh-busy', 'The connected DSH Session already has active or pending input.')
    }
  }

  function reserve<T>(agent: Agent, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return agent.runMaintenance(operation)
    } catch {
      throw new DshExecutionError('taskboard/dsh-busy', 'The connected DSH Session is reserved by another operation.')
    }
  }

  async function flush(session: Session): Promise<void> {
    if (!await ctx.sessions.flush(session)) {
      throw new DshExecutionError('taskboard/dsh-persistence-required', 'DSH execution requires a participating durability listener.')
    }
  }

  async function resolve(execution: TaskExecution, signal: AbortSignal): Promise<Agent> {
    const { sessionId } = connectionOf(execution)
    const result = await ctx.sessionController.resolveAgent(sessionId)
    signal.throwIfAborted()
    if ('error' in result) throw result.error
    membership(sessionId, execution.workspaceId, result.agent.session.header)
    idle(result.agent)
    return result.agent
  }

  async function read(id: SessionId, signal: AbortSignal, synchronizeLive = true): Promise<{
    header: SessionHeader
    events: readonly SessionEvent[]
    session?: Session
  }> {
    const live = ctx.sessions.get(id)
    if (live !== undefined && synchronizeLive) await flush(live)
    const handle = await ctx.sessionPersistence.open(id, 'read', { signal })
    try {
      const { events } = await handle.read(undefined, undefined, { signal })
      if (live === undefined) return { header: handle.header, events }
      const durableEnd = events.at(-1)?.seq ?? -1
      const delivered = deliveredEvents.get(live)?.filter(event => event.seq > durableEnd) ?? []
      if (delivered.length > 0 && delivered[0]?.seq !== durableEnd + 1) {
        throw new Error('Live DSH events do not join the durable Session history.')
      }
      deliveredEvents.set(live, delivered)
      return { header: handle.header, events: [...events, ...delivered], session: live }
    } finally {
      await handle.close()
    }
  }

  return {
    attention(connection, workspaceId) {
      lifetime.signal.throwIfAborted()
      if (connection.kind !== 'dsh') {
        throw new DshExecutionError('taskboard/dsh-connection-required', 'Expected a DSH Session connection.')
      }
      const agent = ctx.agents.get(connection.sessionId)
      if (agent === undefined) return undefined
      const candidates = [
        ...[...waiting].filter(pending => pending.agent === agent
          && pending.turn === openTurns.get(agent.session)),
        ...pendingDynamicApprovals([...dynamicApprovals.values()]).filter(approval => approval.agent === agent),
      ]
      if (candidates.length === 0) return undefined
      membership(connection.sessionId, workspaceId, agent.session.header)
      const turn = Math.max(...candidates.map(candidate => candidate.turn))
      let terminal: TaskConversationObservation | undefined
      return {
        observe(signal) {
          return track(async () => {
            const combined = AbortSignal.any([signal, lifetime.signal])
            combined.throwIfAborted()
            if (terminal !== undefined) return terminal
            const snapshot = await read(connection.sessionId, combined)
            combined.throwIfAborted()
            membership(connection.sessionId, workspaceId, snapshot.header)
            const end = snapshot.events.find(
              (event): event is SessionEvent<'turn/end'> => event.type === 'turn/end' && event.data.turn === turn,
            )
            const approvals = [...dynamicApprovals.values()].filter(approval => approval.agent === agent && approval.turn === turn)
            if ((end === undefined || end.data.reason.kind === 'completed') && pendingDynamicApprovals(approvals).length > 0) {
              return { state: 'waiting' }
            }
            if (end === undefined && ctx.agents.get(connection.sessionId) === agent
              && snapshot.session === agent.session && agent.status === 'running') {
              return {
                state: [...waiting].some(pending => pending.agent === agent && pending.turn === turn) ? 'waiting' : 'running',
              }
            }
            const result: TaskConversationObservation = {
              state: 'settled',
              outcome: end?.data.reason.kind === 'completed' ? 'succeeded'
                : end?.data.reason.kind === 'aborted' ? 'cancelled' : 'failed',
            }
            if (snapshot.session !== undefined) await flush(snapshot.session)
            combined.throwIfAborted()
            terminal = result
            return result
          })
        },
      }
    },

    async validateConnection(connection, workspaceId, signal) {
      if (connection.kind !== 'dsh') {
        throw new DshExecutionError('taskboard/dsh-connection-required', 'Expected a DSH Session connection.')
      }
      await serialized(connection.sessionId, signal, async (combined) => {
        const snapshot = await read(connection.sessionId, combined)
        combined.throwIfAborted()
        membership(connection.sessionId, workspaceId, snapshot.header)
        const live = ctx.agents.get(connection.sessionId)
        if (live !== undefined) idle(live)
        else {
          const queues = { 'next-step': [] as UserMessage[], 'next-turn': [] as UserMessage[] }
          let open = false
          for (const event of snapshot.events) {
            if (event.type === 'turn/start') open = true
            if (event.type === 'turn/end') open = false
            if (event.type === 'agent/inbox/spliced') {
              const { target, start, removedCount, inserted } = event.data
              queues[target].splice(start, removedCount ?? 0, ...inserted)
            }
          }
          if (open || queues['next-step'].length > 0 || queues['next-turn'].length > 0) {
            throw new DshExecutionError('taskboard/dsh-busy', 'The connected DSH history contains unfinished work.')
          }
        }
      })
    },

    create(execution, signal) {
      return serialized(connectionOf(execution).sessionId, signal, async (combined) => {
        if (!execution.createsConnection) {
          throw new DshExecutionError('taskboard/dsh-create-forbidden', 'Only a first execution may create a DSH Session.')
        }
        const settings = settingsOf(execution)
        if (settings.permission !== undefined) ctx.permissionPresets.resolve(settings.permission)
        if (settings.model !== undefined) await ctx.llm.resolveCallConfig(settings.model)
        combined.throwIfAborted()
        await ctx.sessionController.create({
          sessionId: connectionOf(execution).sessionId,
          workspaceId: execution.workspaceId,
          ...(settings.presetId === undefined ? {} : { agentPreset: settings.presetId }),
        })
        combined.throwIfAborted()
        const agent = await resolve(execution, combined)
        await flush(agent.session)
      })
    },

    prepare(execution, signal) {
      return serialized(connectionOf(execution).sessionId, signal, async (combined) => {
        const settings = settingsOf(execution)
        if (settings.permission !== undefined) ctx.permissionPresets.resolve(settings.permission)
        const agent = await resolve(execution, combined)
        if (settings.presetId !== undefined
          && ctx.agentPresets.presetForSession(agent.session) !== settings.presetId) {
          throw new DshExecutionError(
            'taskboard/dsh-preset-mismatch', 'Disconnect before changing the connected DSH Session preset.',
          )
        }
        return reserve(agent, async (maintenanceSignal) => {
          const active = AbortSignal.any([combined, maintenanceSignal])
          if (settings.model !== undefined) {
            await ctx.sessionController.selectModel({
              sessionId: agent.session.header.id,
              ...settings.model,
              saveDefault: false,
            })
          }
          active.throwIfAborted()
          idle(agent)
          if (settings.permission !== undefined) ctx.permissionPresets.set(agent.session, settings.permission)
          const receipt: DshReceipt = { kind: 'dsh', afterSequence: agent.session.seq - 1 }
          await flush(agent.session)
          active.throwIfAborted()
          idle(agent)
          membership(agent.id, execution.workspaceId, agent.session.header)
          if ((latestSettingsChanges.get(agent.session) ?? -1) > receipt.afterSequence) {
            throw new DshExecutionError('taskboard/dsh-settings-changed', 'DSH Session settings changed during preparation.')
          }
          admissions.set(execution.id, { agent, receipt, submitting: false })
          return receipt
        })
      })
    },

    submit(execution, signal) {
      return serialized(connectionOf(execution).sessionId, signal, async (combined) => {
        const receipt = receiptOf(execution)
        const id = connectionOf(execution).sessionId
        const snapshot = await read(id, combined, false)
        combined.throwIfAborted()
        membership(id, execution.workspaceId, snapshot.header)
        const previous = evidence(snapshot.events, execution, receipt)
        if (previous.messageId !== undefined) {
          if (snapshot.session !== undefined) await flush(snapshot.session)
          return { ...receipt, messageId: previous.messageId }
        }
        const admission = admissions.get(execution.id)
        if (admission === undefined || admission.receipt.afterSequence !== receipt.afterSequence) {
          throw new DshExecutionError(
            'taskboard/dsh-acceptance-unknown', 'DSH submission requires this Host activation to prepare the attempt; reconcile it without resending.',
          )
        }
        const { agent } = admission
        idle(agent)
        if ((latestSettingsChanges.get(agent.session) ?? -1) > receipt.afterSequence) {
          throw new DshExecutionError('taskboard/dsh-settings-changed', 'DSH Session settings changed after preparation.')
        }
        admission.submitting = true
        return reserve(agent, async (maintenanceSignal) => {
          const active = AbortSignal.any([combined, maintenanceSignal])
          let competingSequence = Infinity
          let insertionSequence = Infinity
          const insertedMessageIds = new Set<MessageId>()
          const stop = ctx.on('session/event', (session, event) => {
            if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
            for (const message of event.data.inserted) {
              if (!owns(message.source, execution)) {
                competingSequence = Math.min(competingSequence, event.seq)
                continue
              }
              insertionSequence = event.seq
              insertedMessageIds.add(message.id)
            }
          })
          try {
            active.throwIfAborted()
            idle(agent)
            await ctx.sessionController.prompt({
              sessionId: id, requestId: requestId(execution),
              content: [{ type: 'text', text: execution.prompt }], mode: 'queue',
            }, active)
            if (insertedMessageIds.size > 1) {
              throw new DshExecutionError('taskboard/dsh-ambiguous-receipt', 'Multiple DSH messages claim this execution identity.')
            }
            const insertedMessageId = insertedMessageIds.values().next().value
            /* v8 ignore next 3 -- Controller acknowledgement follows a logged insertion or dedupe receipt. */
            if (insertedMessageId === undefined) {
              throw new DshExecutionError('taskboard/dsh-acceptance-unknown', 'DSH accepted no identifiable execution input.')
            }
            // Maintenance prevents either queued input from starting during the
            // Controller's async admission. Drop only this new, unrun input if
            // human input won that race; restart observation never edits queues.
            const admissionFailure = (): Error | undefined => {
              if (active.aborted) {
                const reason: unknown = active.reason
                return reason instanceof Error ? reason : new Error(String(reason))
              }
              if ((latestSettingsChanges.get(agent.session) ?? -1) > receipt.afterSequence) {
                return new DshExecutionError('taskboard/dsh-settings-changed', 'DSH Session settings changed during admission.')
              }
              if (competingSequence < insertionSequence || ctx.agents.get(id) !== agent) {
                return new DshExecutionError('taskboard/dsh-busy', 'Human input or another Agent lifecycle replaced DSH execution admission.')
              }
              return undefined
            }
            const beforeFlush = admissionFailure()
            if (beforeFlush !== undefined) {
              agent.inbox.remove(insertedMessageId)
              await flush(agent.session)
              throw beforeFlush
            }
            try {
              await flush(agent.session)
            } catch (error: unknown) {
              throw new DshExecutionError(
                'taskboard/dsh-acceptance-unknown',
                `DSH input was inserted but its durability is uncertain; do not resend: ${String(error)}`,
              )
            }
            const afterFlush = admissionFailure()
            if (afterFlush !== undefined) {
              agent.inbox.remove(insertedMessageId)
              await flush(agent.session)
              throw afterFlush
            }
            return { ...receipt, messageId: insertedMessageId }
          } finally {
            stop()
          }
        })
      }).finally(() => {
        admissions.delete(execution.id)
      })
    },

    observe(execution, signal) {
      const { sessionId } = connectionOf(execution)
      let retained = observations.get(execution.id)
      if (retained === undefined) {
        retained = { sessionId, pending: new Set() }
        observations.set(execution.id, retained)
      }
      const state = retained
      const publishSuccess = (completion: NonNullable<typeof state.deferredSuccess>): TaskExecutionObservation => {
        if (state.terminal !== undefined) return state.terminal
        if (pendingDynamicApprovals(completion.approvals).length > 0) return { state: 'waiting', receipt: completion.receipt }
        if (observations.get(execution.id) === state) {
          state.terminal = completion.result
          delete state.deferredSuccess
        }
        return completion.result
      }
      const pending = track(async () => {
        const combined = AbortSignal.any([signal, lifetime.signal])
        combined.throwIfAborted()
        const receipt = receiptOf(execution)
        if (state.sessionId !== sessionId) {
          throw new DshExecutionError('taskboard/dsh-receipt-mismatch', 'The execution connection changed before settlement.')
        }
        if (state.terminal !== undefined) return state.terminal
        if (state.deferredSuccess !== undefined) return publishSuccess(state.deferredSuccess)
        let session: Session | undefined
        let result: TaskExecutionObservation
        let knownReceipt = receipt
        let approvals: DynamicApproval[] = []
        try {
          const snapshot = await read(sessionId, combined)
          session = snapshot.session
          combined.throwIfAborted()
          membership(sessionId, execution.workspaceId, snapshot.header)
          const found = evidence(snapshot.events, execution, receipt)
          const enriched = { ...receipt, ...(found.messageId === undefined ? {} : { messageId: found.messageId }) }
          knownReceipt = enriched
          const ended = ending(found, enriched)
          approvals = ownedDynamicApprovals(sessionId, found)
          if (ended !== undefined) {
            result = ended
          } else if (found.removed) {
            result = failed('taskboard/dsh-input-removed', 'The execution input was removed before model admission.', enriched)
          } else if (found.messageId === undefined) {
            result = admissions.get(execution.id)?.submitting === true
              ? { state: 'pending', receipt: enriched }
              : failed(
                'taskboard/dsh-interrupted',
                'No durable acceptance identifies this execution; automatic resubmission is forbidden.',
                enriched,
              )
          } else {
            const agent = ctx.agents.get(sessionId)
            result = session !== undefined && agent?.session === session && agent.status === 'running'
              ? {
                state: pendingDynamicApprovals(approvals).length > 0
                  || [...waiting].some(pending => pending.agent === agent && pending.turn === found.turn)
                  ? 'waiting' : 'running',
                receipt: enriched,
              }
              : failed(
                'taskboard/dsh-interrupted',
                'The execution has no completed turn and is not actively running; its queued input is preserved.',
                enriched,
              )
          }
        } catch (error: unknown) {
          combined.throwIfAborted()
          if (!(error instanceof DshExecutionError) && !(error instanceof SessionPersistenceNotFoundError)
            && !(error instanceof SessionPersistenceCorruptionError)) throw error
          result = failed(
            error instanceof DshExecutionError ? error.code : 'taskboard/dsh-history-unavailable',
            error.message,
            receipt,
          )
        }
        if (result.state === 'settled') {
          if (session !== undefined) await flush(session)
          combined.throwIfAborted()
          if (result.outcome === 'succeeded') {
            const completion = { result, receipt: knownReceipt, approvals }
            if (observations.get(execution.id) === state) state.deferredSuccess ??= completion
            return publishSuccess(state.deferredSuccess ?? completion)
          }
          if (observations.get(execution.id) === state) state.terminal ??= result
          return state.terminal ?? result
        }
        return result
      })
      state.pending.add(pending)
      const complete = () => {
        state.pending.delete(pending)
        if (state.pending.size === 0 && state.terminal === undefined && state.deferredSuccess === undefined
          && observations.get(execution.id) === state) {
          observations.delete(execution.id)
        }
      }
      void pending.then(complete, complete)
      return pending
    },

    release(execution) {
      return track(async () => {
        const { sessionId } = connectionOf(execution)
        if (admissions.get(execution.id)?.agent.id === sessionId) admissions.delete(execution.id)
        const state = observations.get(execution.id)
        if (state?.sessionId !== sessionId) return
        observations.delete(execution.id)
        await Promise.allSettled([...state.pending])
      })
    },

    async dispose() {
      lifetime.abort(new Error('DSH execution adapter disposed'))
      for (const stop of listeners) stop()
      for (const pending of waiting) pending.stop()
      dynamicApprovals.clear()
      await Promise.allSettled([...operations])
      admissions.clear()
      observations.clear()
    },
  }
}
