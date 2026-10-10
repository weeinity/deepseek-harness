import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { JobsSnapshot } from '@deepseek-ai/dsh-api-job-controller/client'
import type {
  TaskboardExecutionOptionsValue, TaskboardRuntimeState, TaskboardTask, TaskConnection, TaskExecution,
} from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { TASK_STATUSES } from '../src/client/view.ts'

export const dsh: Extract<TaskConnection, { kind: 'dsh' }> = { kind: 'dsh', sessionId: 'dsh-one' as Extract<TaskConnection, { kind: 'dsh' }>['sessionId'] }
export const copilot: Extract<TaskConnection, { kind: 'copilot' }> = { kind: 'copilot', sessionId: '13e59df5-bd3a-46e6-bfd5-b61e22ff0491' as Extract<TaskConnection, { kind: 'copilot' }>['sessionId'] }
export function task(overrides: Partial<TaskboardTask> = {}): TaskboardTask {
  const status = overrides.status ?? 'todo'
  return {
    id: 'task' as TaskboardTask['id'], workspaceId: 'workspace' as TaskboardTask['workspaceId'],
    revision: 1, ordinal: 1, title: 'Investigate', description: 'Collect evidence', status: 'todo', rank: 0, labels: [],
    prompt: '', executionSettings: { kind: 'dsh' }, executions: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
    allowedManualStatuses: TASK_STATUSES.filter(candidate => candidate !== status),
  }
}
export function execution(status: TaskExecution['status'], overrides: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: status as TaskExecution['id'], requestId: status as TaskExecution['requestId'], trigger: 'manual',
    requestedAt: '2026-01-01T01:00:00.000Z', status, workspaceId: task().workspaceId, createsConnection: false,
    prompt: 'Saved run prompt', executionSettings: { kind: 'dsh' },
    ...(status === 'pending' ? {} : { connection: dsh, startedAt: '2026-01-01T01:01:00.000Z' }),
    ...(['pending', 'running'].includes(status) ? {} : { endedAt: '2026-01-01T01:02:00.000Z' }), ...overrides,
  }
}
export const options: TaskboardExecutionOptionsValue = {
  presets: [{ id: 'default', name: 'Standard agent', isDefault: true }, { id: 'broken', name: 'Broken agent', isDefault: false, broken: 'Missing plugin' }],
  permissions: [{ name: 'read-only' }, { name: 'workspace-write' }, { name: 'full-access' }],
  models: [{ provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat' }], timeZone: 'Asia/Shanghai', copilotAvailable: true,
}
export const runtime: TaskboardRuntimeState = {
  settings: { enabled: true, announceToAgent: false, preventIdleSleep: false }, timeZone: 'Asia/Shanghai',
  power: { phase: 'disabled', platform: 'win32', runningSessions: 0, enabledSchedules: 0, sessionStateKnown: true }, scheduler: {},
}
export function sessions(): SessionListState {
  return {
    ids: [dsh.sessionId], phase: 'ready',
    byId: {
      [dsh.sessionId]: {
        id: dsh.sessionId, displayTitle: 'Existing DSH', running: false, retainedBy: {}, blank: false, updatedAt: 1,
      },
    },
    projectionsBySession: {},
  }
}
export function jobs(): JobsSnapshot {
  return { rows: {}, observed: {} }
}
export function workspaces(): WorkspaceSnapshot {
  return {
    items: [{ workspaceId: task().workspaceId, title: 'Workspace', path: 'Q:\\workspace', sessionIds: [dsh.sessionId],
      createdAt: '', updatedAt: '' }],
    archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
}
export function translate(dictionary: typeof en | typeof zh = en): TaskboardSurfaceProps['t'] {
  return ((key: keyof typeof en, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce< string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dictionary[key])
  ) as TaskboardSurfaceProps['t']
}
