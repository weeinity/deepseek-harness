/** Editable saved execution inputs shared by creation and task details. */
import type { TaskConnection, TaskExecutionSettings, TaskHandover, TaskSchedule } from '@deepseek-ai/dsh-api-taskboard-controller/client'
import type { ExecutionDraft, TaskboardSurfaceProps } from './contract.ts'
import css from './Taskboard.module.css'

interface ExecutionFieldsProps {
  readonly value: ExecutionDraft
  readonly options: Awaited<ReturnType<TaskboardSurfaceProps['executionOptions']>> | undefined
  readonly disabled: boolean
  readonly compositionLocked: boolean
  readonly sourceConnections: readonly TaskConnection[]
  readonly t: TaskboardSurfaceProps['t']
  readonly onChange: (value: ExecutionDraft) => void
}

const SCHEDULES = { daily9: '0 9 * * *', hourly: '0 * * * *', every10: '*/10 * * * *', monday9: '0 9 * * 1' } as const

/**
 * Render provider options, schedule, and frozen context without submitting work.
 * @param props - Local draft, authoritative option catalog, and change callback.
 * @returns saved-input controls.
 */
export function ExecutionFields(props: ExecutionFieldsProps) {
  const { value, t, options } = props
  const settings = value.executionSettings
  const changeSettings = (executionSettings: TaskExecutionSettings) => { props.onChange({ ...value, executionSettings }) }
  const changeSchedule = (patch: Partial<TaskSchedule>) => {
    /* v8 ignore next -- Schedule controls are disabled until the options load. */
    if (options === undefined) return
    props.onChange({ ...value, schedule: {
      enabled: false, cron: SCHEDULES.daily9, timeZone: options.timeZone, ...value.schedule, ...patch,
    } })
  }
  const changeHandover = (patch: Partial<TaskHandover>) => {
    props.onChange({ ...value, handover: {
      goal: '', progress: '', next: '', references: [], ...value.handover, ...patch, frozenAt: new Date().toISOString(),
    } })
  }
  const models = options?.models ?? []
  const modelValue = settings.kind === 'dsh' && settings.model !== undefined
    ? JSON.stringify([settings.model.provider, settings.model.model]) : ''
  const sourceValue = value.handover?.source === undefined ? '' : JSON.stringify(value.handover.source)
  const sources = [...props.sourceConnections]
  if (value.handover?.source !== undefined && !sources.some(item => JSON.stringify(item) === sourceValue)) {
    sources.push(value.handover.source)
  }
  const dshModel = settings.kind === 'dsh' ? settings.model : undefined
  return <>
    <label className={css.field}>{t('prompt')}
      <textarea disabled={props.disabled} value={value.prompt} placeholder={t('promptHint')}
        onChange={(event) =>{  props.onChange({ ...value, prompt: event.target.value }) }} />
    </label>
    <fieldset className={css.executionFields} disabled={props.disabled || options === undefined}>
      <legend className={css.sectionLabel}>{t('executionOptions')}</legend>
      {options === undefined && <p role="status">{t('optionsLoading')}</p>}
      {settings.kind === 'dsh' && <>
        <label className={css.field}>{t('preset')}
          <select disabled={props.compositionLocked} value={settings.presetId ?? ''} onChange={(event) => {
            const { presetId: _presetId, ...rest } = settings
            const selected = options?.presets.find(item => item.id === event.target.value)
            changeSettings(selected === undefined ? rest : { ...rest, presetId: selected.id })
          }}>
            <option value="">{t('defaultOption')}</option>
            {settings.presetId !== undefined && !options?.presets.some(item => item.id === settings.presetId)
              && <option value={settings.presetId}>{settings.presetId}</option>}
            {options?.presets.map(preset => <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>
              {preset.name}{preset.broken === undefined ? '' : `: ${preset.broken}`}
            </option>)}
          </select>
        </label>
        <label className={css.field}>{t('permission')}
          <select value={settings.permission ?? ''} onChange={(event) => {
            const { permission: _permission, ...rest } = settings
            changeSettings(event.target.value === '' ? rest : { ...rest, permission: event.target.value })
          }}>
            <option value="">{t('defaultOption')}</option>
            {settings.permission !== undefined && !options?.permissions.some(item => item.name === settings.permission)
              && <option value={settings.permission}>{settings.permission}</option>}
            {options?.permissions.map(permission => <option key={permission.name}>{permission.name}</option>)}
          </select>
        </label>
        <label className={css.field}>{t('model')}
          <select value={modelValue} onChange={(event) => {
            const { model: _model, ...rest } = settings
            const selected = models.find(item => JSON.stringify([item.provider, item.model]) === event.target.value)
            changeSettings(selected === undefined ? rest : { ...rest, model: { provider: selected.provider, model: selected.model } })
          }}>
            <option value="">{t('defaultOption')}</option>
            {modelValue !== '' && !models.some(item => JSON.stringify([item.provider, item.model]) === modelValue)
              && <option value={modelValue}>{settings.model?.provider}: {settings.model?.model}</option>}
            {models.map(model => <option key={JSON.stringify([model.provider, model.model])}
              value={JSON.stringify([model.provider, model.model])}>
              {model.name}
            </option>)}
          </select>
        </label>
        {models.length === 0 && <p className={css.fieldHint}>{t('noModels')}</p>}
        {dshModel !== undefined && <label className={css.field}>{t('reasoningEffort')}
          <input value={dshModel.reasoningEffort ?? ''} onChange={(event) => {
            const { reasoningEffort: _reasoningEffort, ...model } = dshModel
            changeSettings({ ...settings, model: event.target.value === '' ? model
              : { ...model, reasoningEffort: event.target.value as NonNullable<typeof dshModel.reasoningEffort> } })
          }} />
        </label>}
      </>}
      {settings.kind === 'copilot' && <>
        <label className={css.field}>{t('permission')}
          <select value={settings.permission ?? 'read-only'} onChange={(event) =>{  changeSettings({
            ...settings, permission: event.target.value as NonNullable<typeof settings.permission>,
          }) }}>
            {(['read-only', 'workspace-write', 'full-access'] as const).map(permission =>
              <option key={permission} value={permission}>{t(`permission.${permission}`)}</option>)}
          </select>
        </label>
        <label className={css.field}>{t('modelId')}
          <input value={settings.model ?? ''} placeholder={t('modelIdHint')} onChange={(event) => {
            const { model: _model, ...rest } = settings
            changeSettings(event.target.value === '' ? rest : { ...rest, model: event.target.value })
          }} />
        </label>
      </>}
    </fieldset>
    <fieldset className={css.executionFields} disabled={props.disabled || options === undefined}>
      <legend className={css.sectionLabel}>{t('schedule')}</legend>
      <label className={css.checkbox}><input type="checkbox" checked={value.schedule?.enabled ?? false}
        onChange={(event) =>{  changeSchedule({ enabled: event.target.checked }) }} />{t('scheduleEnabled')}</label>
      <label className={css.field}>{t('schedulePreset')}
        <select value={Object.entries(SCHEDULES).find(([, cron]) => cron === value.schedule?.cron)?.[0] ?? ''}
          onChange={(event) => {
            const selected = Object.entries(SCHEDULES).find(([key]) => key === event.target.value)
            if (selected !== undefined) changeSchedule({ cron: selected[1] })
          }}>
          <option value="">{t('customSchedule')}</option>
          {Object.keys(SCHEDULES).map(key => <option key={key} value={key}>{t(key as keyof typeof SCHEDULES)}</option>)}
        </select>
      </label>
      <div className={css.propertyGrid}>
        <label className={css.field}>{t('cron')}
          <input value={value.schedule?.cron ?? ''} onChange={(event) =>{  changeSchedule({ cron: event.target.value }) }} />
        </label>
        <label className={css.field}>{t('timeZone')}
          <input value={value.schedule?.timeZone ?? options?.timeZone ?? ''} onChange={(event) =>{  changeSchedule({ timeZone: event.target.value }) }} />
        </label>
      </div>
      <p className={css.fieldHint}>{t('nextRun', { time: value.schedule?.nextRunAt ?? t('notScheduled') })}</p>
      <p className={css.fieldHint}>{t('lastRun', { time: value.schedule?.lastTriggeredAt ?? t('neverTriggered') })}</p>
      {value.schedule !== undefined && <button type="button" className={css.secondaryButton}
        onClick={() =>{  props.onChange({ ...value, schedule: undefined }) }}>{t('removeSchedule')}</button>}
    </fieldset>
    <fieldset className={css.executionFields} disabled={props.disabled}>
      <legend className={css.sectionLabel}>{t('handover')}</legend>
      {(['goal', 'progress', 'next'] as const).map(field => <label key={field} className={css.field}>{t(field)}
        <textarea value={value.handover?.[field] ?? ''} onChange={(event) =>{  changeHandover({ [field]: event.target.value }) }} />
      </label>)}
      <label className={css.field}>{t('references')}
        <textarea value={value.handover?.references.join('\n') ?? ''}
          onChange={(event) => { changeHandover({ references: event.target.value.split('\n') }) }} />
      </label>
      <label className={css.field}>{t('source')}
        <select value={sourceValue} onChange={(event) => {
          const source = sources.find(item => JSON.stringify(item) === event.target.value)
          if (source !== undefined) changeHandover({ source })
          else {
            /* v8 ignore next -- Without handover, the empty option is already selected and cannot change to itself. */
            if (value.handover !== undefined) {
              const { source: _source, ...handover } = value.handover
              props.onChange({ ...value, handover: { ...handover, frozenAt: new Date().toISOString() } })
            }
          }
        }}>
          <option value="">{t('noSource')}</option>
          {sources.map(source => <option key={JSON.stringify(source)} value={JSON.stringify(source)}>
            {t(source.kind)}: {source.sessionId}
          </option>)}
        </select>
      </label>
      {value.handover !== undefined && <>
        <p className={css.fieldHint}>{t('frozenAt', { time: value.handover.frozenAt })}</p>
        <button type="button" className={css.secondaryButton}
          onClick={() =>{  props.onChange({ ...value, handover: undefined }) }}>{t('clearHandover')}</button>
      </>}
    </fieldset>
  </>
}
