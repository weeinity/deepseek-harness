/** Taskboard-specific adapter for the Gateway-owned snapshot stream lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import {
  RemoteSnapshotStream, RemoteStreamCarrierError, type ClientRemote,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { TaskboardFollowFrame, TaskboardFollowIncrement } from '../types.ts'
import { ClientTaskboardModel } from './model.ts'
import type { TaskboardFollowSink, TaskboardRemote } from './model.ts'
import { TaskboardClientController } from './service.ts'

export { ClientTaskboardModel } from './model.ts'
export type { TaskboardFollowSink, TaskboardListPhase, TaskboardRemote, TaskboardSnapshot } from './model.ts'
export { TaskboardClientController, TaskboardCommandError } from './service.ts'
export type { ITaskboard } from './service.ts'
export type * from '../types.ts'

type TaskboardStreamRemote = Pick<ClientRemote, '$stream'> & { readonly taskboard: TaskboardRemote }
type TaskboardBaselineFrame = Extract<TaskboardFollowFrame, { type: 'baseline' }>

/** Gateway-owned snapshot stream configured for Taskboard state. */
export type TaskboardStateStream = RemoteSnapshotStream<TaskboardBaselineFrame, TaskboardFollowIncrement>

declare module '@deepseek-ai/cordis' {
  interface Context { /** React-free Client Taskboard state and commands. */ taskboard: import('./service.ts').ITaskboard }
}

/** Required Client Remote services. */
export const inject = ['remote', 'remote.taskboard']

/** Install Client Taskboard state, commands, and reconnecting follow control. */
export function apply(ctx: Context): void {
  const remote = ctx.remote as TaskboardStreamRemote
  const model = new ClientTaskboardModel(remote.taskboard)
  new TaskboardClientController(ctx, model)
  const control = createTaskboardStateStream(remote, {
    accept: model,
    carrierFailed: () => { model.handleCarrierFailure() },
    failed: (error) => { model.handleStreamFailure(error) },
  })
  control.start()
  ctx.effect(() => async () => { await control.dispose() }, 'taskboard-controller.client.control')
}

/** Domain sinks and failure hooks used by the Taskboard stream. */
export interface TaskboardStateStreamOptions {
  readonly accept: TaskboardFollowSink
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
  readonly failed: (error: unknown) => void
}

/**
 * Create the reconnecting Taskboard state stream.
 * @param remote - Generated namespace and Gateway stream factory.
 * @param options - Taskboard state sinks and failure hooks.
 * @returns an unstarted reconnecting Taskboard stream.
 */
export function createTaskboardStateStream(
  remote: TaskboardStreamRemote,
  options: TaskboardStateStreamOptions,
): TaskboardStateStream {
  const stream = remote.$stream<TaskboardFollowFrame>({
    name: 'Taskboard state stream',
    open: signal => remote.taskboard.follow(signal),
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('Taskboard state stream ended without a terminal result')
      : new Error('Taskboard state stream ended before its opening snapshot'),
    ...(options.carrierFailed === undefined ? {} : { carrierFailed: options.carrierFailed }),
  })
  return new RemoteSnapshotStream<TaskboardBaselineFrame, TaskboardFollowIncrement>(stream, {
    name: 'Taskboard state stream',
    isSnapshot: (frame): frame is TaskboardBaselineFrame => frame.type === 'baseline',
    replace: (frame) => { options.accept.replaceBaseline(frame.value) },
    update: (frame) => { acceptIncrement(options.accept, frame) },
    failed: options.failed,
  })
}

function acceptIncrement(accept: TaskboardFollowSink, frame: TaskboardFollowIncrement): void {
  switch (frame.type) {
    case 'upsert': accept.upsertTask(frame.task); return
    case 'remove': accept.removeTask(frame.taskId, frame.revision); return
    case 'runtime': accept.replaceRuntime(frame.value); return
    default: return assertNever(frame)
  }
}

function assertNever(value: never): never {
  throw new Error(`unreachable Taskboard increment: ${JSON.stringify(value)}`)
}
