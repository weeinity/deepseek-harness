// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionDraft } from '../src/client/contract.ts'
import { ExecutionFields } from '../src/client/ExecutionFields.tsx'
import { en } from '../src/client/locales.ts'
import { copilot, dsh, options, translate } from './fixtures.client.ts'

type DshModel = NonNullable<Extract<ExecutionDraft['executionSettings'], { kind: 'dsh' }>['model']>
afterEach(cleanup)

function mount(initial: Partial<ExecutionDraft> = {}, extra: Partial<Parameters<typeof ExecutionFields>[0]> = {}) {
  let value: ExecutionDraft = { prompt: '', executionSettings: { kind: 'dsh' }, schedule: undefined, handover: undefined, ...initial }
  const changed = vi.fn((next: ExecutionDraft) => { value = next; view.rerender(<ExecutionFields {...props} value={value} />) })
  const props = { value, options, disabled: false, compositionLocked: false, sourceConnections: [dsh, copilot],
    t: translate(), onChange: changed, ...extra }
  const view = render(<ExecutionFields {...props} />)
  return { changed, get value() { return value } }
}

const select = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name }), { target: { value } })
const text = (name: string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } })

describe('saved execution input fields', () => {
  it('keeps unavailable saved choices visible and clears individual overrides without changing the provider', () => {
    const b = mount({ executionSettings: { kind: 'dsh', presetId: 'removed-preset', permission: 'custom-permission',
      model: { provider: 'offline', model: 'old-model', reasoningEffort: 'high' as NonNullable<DshModel['reasoningEffort']> } } })
    screen.getByRole('option', { name: 'removed-preset' })
    screen.getByRole('option', { name: 'custom-permission' })
    screen.getByRole('option', { name: 'offline: old-model' })
    text(en.reasoningEffort, 'low')
    expect(b.value.executionSettings).toMatchObject({ model: { reasoningEffort: 'low' } })
    text(en.reasoningEffort, '')
    expect(b.value.executionSettings).toMatchObject({ model: { provider: 'offline', model: 'old-model' } })
    expect(b.value.executionSettings.model).not.toHaveProperty('reasoningEffort')
    select(en.preset, '')
    select(en.permission, '')
    select(en.model, '')
    expect(b.value.executionSettings).toEqual({ kind: 'dsh' })
  })

  it('selects authoritative routes and leaves reasoning effort unset until explicitly entered', () => {
    const b = mount()
    select(en.preset, 'default')
    select(en.permission, 'read-only')
    select(en.model, JSON.stringify(['deepseek', 'deepseek-chat']))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.reasoningEffort }).value).toBe('')
    expect(b.value.executionSettings).toEqual({ kind: 'dsh', presetId: 'default', permission: 'read-only',
      model: { provider: 'deepseek', model: 'deepseek-chat' } })
    expect(screen.getByRole<HTMLOptionElement>('option', { name: 'Broken agent: Missing plugin' }).disabled).toBe(true)
  })

  it('displays an empty authoritative model roster without manufacturing options', () => {
    mount({}, { options: { ...options, presets: [], permissions: [], models: [] } })
    screen.getByText(en.noModels)
    expect(screen.queryByRole('option', { name: 'DeepSeek Chat' })).toBeNull()
  })

  it('allows explicit Copilot permissions and clearing its model identifier', () => {
    const b = mount({ executionSettings: { kind: 'copilot' } })
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.permission }).value).toBe('read-only')
    select(en.permission, 'full-access')
    text(en.modelId, 'operator-model')
    expect(b.value.executionSettings).toEqual({ kind: 'copilot', permission: 'full-access', model: 'operator-model' })
    text(en.modelId, '')
    expect(b.value.executionSettings).toEqual({ kind: 'copilot', permission: 'full-access' })
  })

  it('creates a schedule from Host timezone defaults, edits cron/timezone, and removes it explicitly', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('checkbox', { name: en.scheduleEnabled }))
    expect(b.value.schedule).toEqual({ enabled: true, cron: '0 9 * * *', timeZone: options.timeZone })
    for (const [preset, cron] of [['hourly', '0 * * * *'], ['every10', '*/10 * * * *'],
      ['monday9', '0 9 * * 1'], ['daily9', '0 9 * * *']] as const) {
      select(en.schedulePreset, preset)
      expect(b.value.schedule?.cron).toBe(cron)
    }
    select(en.schedulePreset, '')
    expect(b.value.schedule?.cron).toBe('0 9 * * *')
    text(en.cron, '15 14 * * 2')
    text(en.timeZone, 'Europe/Paris')
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: en.schedulePreset }).value).toBe('')
    expect(b.value.schedule).toEqual({ enabled: true, cron: '15 14 * * 2', timeZone: 'Europe/Paris' })
    fireEvent.click(screen.getByRole('button', { name: en.removeSchedule }))
    expect(b.value.schedule).toBeUndefined()
  })

  it('shows derived schedule times without replacing them during a local enable edit', () => {
    const schedule = { enabled: true, cron: '0 * * * *', timeZone: 'UTC',
      nextRunAt: '2026-09-09T19:00:00Z', lastTriggeredAt: '2026-09-09T18:00:00Z' }
    const b = mount({ schedule })
    screen.getByText(translate()('nextRun', { time: schedule.nextRunAt }))
    screen.getByText(translate()('lastRun', { time: schedule.lastTriggeredAt }))
    fireEvent.click(screen.getByRole('checkbox', { name: en.scheduleEnabled }))
    expect(b.value.schedule).toEqual({ ...schedule, enabled: false })
  })

  it('edits every handover field, clears its source independently, and removes the whole handover', () => {
    const b = mount()
    text(en.goal, 'Goal')
    text(en.progress, 'Progress')
    text(en.next, 'Next action')
    text(en.references, 'README.md\nsrc/index.ts')
    select(en.source, JSON.stringify(copilot))
    expect(b.value.handover).toMatchObject({
      goal: 'Goal', progress: 'Progress', next: 'Next action', references: ['README.md', 'src/index.ts'], source: copilot,
    })
    expect(b.value.handover?.frozenAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/)
    select(en.source, '')
    expect(b.value.handover).not.toHaveProperty('source')
    expect(b.value.handover?.goal).toBe('Goal')
    fireEvent.click(screen.getByRole('button', { name: en.clearHandover }))
    expect(b.value.handover).toBeUndefined()
  })

  it('retains a frozen source absent from the current connection roster', () => {
    const b = mount({ handover: { goal: 'Keep', progress: '', next: '', references: [], source: copilot,
      frozenAt: '2026-01-01T00:00:00Z' } }, { sourceConnections: [dsh] })
    screen.getByRole('option', { name: `${en.copilot}: ${copilot.sessionId}` })
    select(en.source, JSON.stringify(dsh))
    expect(b.value.handover?.source).toEqual(dsh)
    expect(b.value.handover?.frozenAt).not.toBe('2026-01-01T00:00:00Z')
  })

  it('keeps unavailable execution catalogs disabled without substituting browser defaults', () => {
    mount({}, { options: undefined })
    screen.getByText(en.optionsLoading)
    expect(screen.getByRole('combobox', { name: en.model }).closest('fieldset')?.disabled).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: en.timeZone }).value).toBe('')
    expect(screen.getByRole('checkbox', { name: en.scheduleEnabled }).closest('fieldset')?.disabled).toBe(true)
  })
})
