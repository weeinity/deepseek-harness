/** Host-authoritative Taskboard switches and runtime diagnostics. */
import { useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskboardRuntimeState } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { TaskboardSurfaceProps } from './contract.ts'
import css from './Taskboard.module.css'

interface TaskboardSettingsProps {
  readonly runtime: TaskboardRuntimeState | undefined
  readonly updateSettings: TaskboardSurfaceProps['updateSettings']
  readonly t: TaskboardSurfaceProps['t']
  readonly onClose: () => void
}

/**
 * Render settings even when the board is disabled; no defaults stand in for an absent Host snapshot.
 * @param props - Runtime observation and explicit setting mutation callback.
 * @returns settings dialog with power and scheduler status.
 */
export function TaskboardSettings(props: TaskboardSettingsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { runtime, t } = props
  return <Modal open title={t('settings')} closeLabel={t('close')} onClose={props.onClose}>
    <div className={css.settingsPanel}>
      {runtime === undefined ? <p role="status">{t('runtimePending')}</p> : <>
        {runtime.error !== undefined && <p role="alert">{t('runtimeError', { message: runtime.error })}</p>}
        {(['enabled', 'announceToAgent', 'preventIdleSleep'] as const).map(key => <label key={key} className={css.checkbox}>
          <input type="checkbox" role="switch" checked={runtime.settings[key]} disabled={busy} onChange={(event) => {
            setBusy(true)
            setError(undefined)
            void props.updateSettings({ [key]: event.target.checked }).catch((reason: unknown) => {
              setError(t('error', { message: reason instanceof Error ? reason.message : String(reason) }))
            }).finally(() =>{  setBusy(false) })
          }} />{t(key)}
        </label>)}
        <h3 className={css.sectionLabel}>{t('power')}</h3>
        <p role="status">{t(`power.${runtime.power.phase}`)}</p>
        <p>{runtime.power.platform}</p>
        <p>{t('powerDetails', { sessions: runtime.power.runningSessions, schedules: runtime.power.enabledSchedules })}</p>
        {!runtime.power.sessionStateKnown && <p>{t('sessionStateUnknown')}</p>}
        {runtime.power.error !== undefined && <p role="alert">{runtime.power.error}</p>}
        {runtime.scheduler.error !== undefined && <p role="alert">{t('schedulerError', { message: runtime.scheduler.error })}</p>}
      </>}
      {error !== undefined && <p role="alert">{error}</p>}
    </div>
  </Modal>
}
