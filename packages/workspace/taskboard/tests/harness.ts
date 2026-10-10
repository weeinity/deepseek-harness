import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId as asWorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskboardService, { AgencyCopilotSessionId, TaskRunRequestId } from '../src/index.ts'
import type { Config, TaskboardTask, TaskConnection, TaskHandover, TaskScheduleInput } from '../src/index.ts'

export const roots: Context[] = []
export const backends: StorageBackend[] = []
export const dsh: TaskConnection = { kind: 'dsh', sessionId: SessionId('s1') }
export const copilot: TaskConnection = {
  kind: 'copilot', sessionId: AgencyCopilotSessionId('13e59df5-bd3a-46e6-bfd5-b61e22ff0491'),
}
export const handover: TaskHandover = {
  goal: 'Implement', progress: 'Located files', next: 'Add tests', references: ['src/index.ts'],
  source: dsh, frozenAt: '2026-01-01T00:00:00.000Z',
}
export const schedule: TaskScheduleInput = {
  enabled: true, cron: '0 * * * *', timeZone: 'UTC',
}

function workspace(id: string, sessions: string[] = []): Workspace {
  return {
    id: asWorkspaceId(id), path: '/fixture', title: id,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    sessionIds: sessions.map(SessionId),
    setTitle: async () => {}, attachSession: async () => {}, insertSessionBefore: async () => {},
    detachSession: async () => {}, status: async () => 'ok',
  }
}

export async function harness(options: { pool?: MemoryMediaPool; backend?: StorageBackend; config?: Config; scoped?: boolean } = {}) {
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = options.backend ?? new MemoryStorageBackend(pool)
  backends.push(backend)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('fixture', backend)
  if (options.scoped) ctx.provide(storageBackendServiceKey('fixture'), backend)
  const domainProvider = options.scoped ? await ctx.plugin(StorageDomain, { backend: 'fixture', routes: {} }) : undefined
  const facility = options.scoped ? ctx.storageDomain : new DomainFacility(ctx, { backend: 'fixture', routes: {} })
  if (!options.scoped) {
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
  }
  const workspaces = new Map<WorkspaceId, Workspace>()
  const first = workspace('w1', ['s1', 's2'])
  workspaces.set(first.id, first)
  const second = workspace('w2', ['s3'])
  workspaces.set(second.id, second)
  const provideWorkspaces = (target: Context) => {
    target.provide('workspaceRegistry', { get: (id: WorkspaceId) => workspaces.get(id) } as never)
  }
  if (options.scoped) await ctx.plugin({ apply: provideWorkspaces })
  else provideWorkspaces(ctx)
  const taskboardProvider = await ctx.plugin(TaskboardService, options.config ?? {})
  return {
    ctx, pool, board: ctx.taskboard, workspaceId: first.id, workspace: first, workspaces,
    facility, domainProvider, taskboardProvider,
  }
}

export async function cleanup(): Promise<void> {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(backends.splice(0).map(backend => backend.close()))
}

export function request(task: TaskboardTask, id = 'request-1') {
  return {
    taskId: task.id, expectedRevision: task.revision,
    trigger: 'manual' as const, requestId: TaskRunRequestId(id), executionSettings: task.executionSettings,
    proposedConnection: task.connection ?? (task.executionSettings.kind === 'dsh' ? dsh : copilot),
  }
}
