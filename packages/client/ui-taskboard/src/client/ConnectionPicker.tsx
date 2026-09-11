/** Workspace-scoped selection of one existing conversation without dispatch. */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TaskConnection } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import { CopilotSessionPicker } from './CopilotSessionPicker.tsx'
import css from './Taskboard.module.css'

interface ConnectionPickerProps {
  readonly kind: TaskConnection['kind']
  readonly value: TaskConnection | undefined
  readonly workspaceId: WorkspaceId
  readonly workspaces: WorkspaceSnapshot
  readonly sessions: SessionListState
  readonly disabled: boolean
  readonly t: TaskboardSurfaceProps['t']
  readonly listSessions: TaskboardSurfaceProps['listAgencyCopilotSessions']
  readonly onChange: (value: TaskConnection | undefined) => void
}

/**
 * Render only the selected provider's same-Workspace conversation picker.
 * @param props - Available sessions and a component-local selection callback.
 * @returns a no-dispatch connection selector.
 */
export function ConnectionPicker(props: ConnectionPickerProps) {
  if (props.kind === 'copilot') return <CopilotSessionPicker
    workspaceId={props.workspaceId} value={props.value?.kind === 'copilot' ? props.value.sessionId : undefined}
    disabled={props.disabled} t={props.t} listSessions={props.listSessions}
    onChange={(sessionId) =>{  props.onChange(sessionId === undefined ? undefined : { kind: 'copilot', sessionId }) }}
  />
  const ids = props.workspaces.items.find(item => item.workspaceId === props.workspaceId)?.sessionIds ?? []
  return <label className={css.field}>{props.t('linkedSession')}
    <select value={props.value?.kind === 'dsh' ? props.value.sessionId : ''} disabled={props.disabled}
      onChange={(event) => {
        const sessionId = ids.find(id => id === event.target.value)
        props.onChange(sessionId === undefined ? undefined : { kind: 'dsh', sessionId })
      }}>
      <option value="">{props.t('noSession')}</option>
      {ids.map(id => <option key={id} value={id}>{props.sessions.byId[id]?.displayTitle ?? id}</option>)}
    </select>
  </label>
}
