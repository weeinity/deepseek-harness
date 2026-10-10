/** Real Loader, gateway, durable domain, and browser forms; only model/Copilot/OS effects are substituted. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Locator, Page } from 'playwright'
import { expect, it } from 'vitest'
import type { TaskboardExecutionOptionsValue, TaskboardListValue, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller'
import { captureWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, selectedSessionFixture, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import {
  expectedTaskboardPrompt, savedTask, taskboardPersistedSessions, taskboardRpc, updateTaskboardSettings, withTaskboardWorld,
} from './taskboard-harness.ts'

const SCENARIO = join(REPO_ROOT, 'snapshots', 'web', 'taskboard-start-work')
const FIXTURES = fileURLToPath(new URL('./fixtures/taskboard', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/taskboard-management.md', import.meta.url))
const MODE = webSnapshotMode()
const DSH = 'taskboard-fixture-dsh'
const COPILOT = '13e59df5-bd3a-46e6-bfd5-b61e22ff0491'
const SECOND_COPILOT = '2eb3dbf2-8b82-4863-b505-520708dcce80'
const TITLE = 'Browser-only task definition'
const PROMPT = 'Inspect only this fixture definition; no external work.'

function field(dialog: Locator, name: string): Locator { return dialog.getByRole('textbox', { name, exact: true }) }
function select(dialog: Locator, name: string): Locator { return dialog.getByRole('combobox', { name, exact: true }) }
function button(dialog: Locator, name: string): Locator { return dialog.getByRole('button', { name, exact: true }) }

async function save(page: Page, title = TITLE): Promise<TaskboardTask> {
  const before = await savedTask(page, title)
  await button(page.getByRole('dialog', { name: 'Task details' }), 'Save').click()
  await expect.poll(async () => (await savedTask(page, title)).revision).toBeGreaterThan(before.revision)
  return savedTask(page, title)
}

async function detailsGolden(page: Page, workspace: string, task: TaskboardTask): Promise<string> {
  const timestamps = [
    task.createdAt, task.updatedAt, task.schedule?.nextRunAt, task.permissionConfirmedAt, task.handover?.frozenAt,
    ...task.executions.flatMap(run => [run.requestedAt, run.startedAt, run.endedAt, run.handover?.frozenAt]),
  ].filter((value): value is string => value !== undefined)
  return captureStableAria(page, '[role="dialog"]', workspace, {
    normalizeAge: true,
    replacements: timestamps.map(value => [value, '{{timestamp}}'] as const),
  })
}

it('Taskboard drags update every column, retain filtered moves, and survive reload without running work', async () => {
  const fixture = await selectedSessionFixture(join(REPO_ROOT, 'snapshots', 'web', 'lifecycle-chrome', 'session.v3.jsonl'))
  await withTaskboardWorld({
    name: 'taskboard-drag',
    patches: [join(SCENARIO, 'cordis.yml'), join(SCENARIO, 'cordis.snapshot.yml')],
    prepare: async () => ({ DSH_SNAPSHOT_FILE: fixture, DSH_SNAPSHOT_OVERRIDE: undefined }),
  }, async ({ page, workspace, requests, pageErrors }) => {
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New task' })
    const title = 'Organize a task by dragging'
    await field(create, 'Title').fill(title)
    await field(create, 'Description').fill('Manual moves do not start execution.')
    await button(create, 'Save and Close').click()
    await create.waitFor({ state: 'detached' })
    const initial = await savedTask(page, title)
    await taskboardRpc(page, 'taskboard/create', {
      request: { workspaceId: initial.workspaceId, title: 'Backlog anchor', status: 'backlog' },
    })
    const workspaceFilter = page.getByRole('combobox', { name: 'Workspace', exact: true })
    await workspaceFilter.selectOption('all')
    const card = page.getByRole('article', { name: title, exact: true })
    const column = (status: TaskboardTask['status']) => page.locator(`section[data-status="${status}"]`)
    const progress = column('in_progress')
    const beforeHighlight = await progress.evaluate(element => getComputedStyle(element).backgroundColor)
    await card.hover()
    await page.mouse.down()
    await progress.getByText('In Progress', { exact: true }).hover()
    await progress.getByText('In Progress', { exact: true }).hover()
    await expect.poll(() => progress.getAttribute('data-drop-target')).toBe('true')
    expect(await progress.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(beforeHighlight)
    expect(await card.evaluate(element => getComputedStyle(element).cursor)).toBe('grabbing')
    await page.mouse.up()
    await expect.poll(async () => (await savedTask(page, title)).status).toBe('in_progress')
    await expect.poll(() => card.getAttribute('draggable')).toBe('true')
    expect(await progress.getAttribute('data-drop-target')).toBeNull()
    expect(await savedTask(page, title)).toMatchObject({ revision: initial.revision + 1, executions: [] })

    const move = async (status: TaskboardTask['status'], destination: Locator): Promise<void> => {
      const before = await savedTask(page, title)
      await card.dragTo(destination)
      await expect.poll(async () => (await savedTask(page, title)).status).toBe(status)
      await expect.poll(() => card.getAttribute('draggable')).toBe('true')
      expect(await card.evaluate(element => element.closest('section')?.getAttribute('data-status'))).toBe(status)
      expect(await savedTask(page, title)).toMatchObject({ revision: before.revision + 1, executions: [] })
      expect(await page.getByRole('dialog').count()).toBe(0)
    }
    const search = page.getByPlaceholder('Search tasks…', { exact: true })
    await search.fill(title)
    await move('in_review', column('in_review').getByText('No tasks in this column', { exact: true }))
    await move('done', column('done').getByText('Done', { exact: true }))
    await search.fill('')
    const anchor = page.getByRole('article', { name: 'Backlog anchor', exact: true })
    await move('backlog', anchor)
    await workspaceFilter.selectOption(initial.workspaceId)
    const backlogOrder = () => column('backlog').getByRole('article')
      .evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    await card.dragTo(anchor)
    await expect.poll(backlogOrder).toEqual([title, 'Backlog anchor'])
    await expect.poll(() => card.getAttribute('draggable')).toBe('true')
    const backlogBounds = await column('backlog').boundingBox()
    if (backlogBounds === null) throw new Error('Backlog column is not visible')
    await card.dragTo(column('backlog'), { targetPosition: { x: 20, y: backlogBounds.height - 12 } })
    await expect.poll(backlogOrder).toEqual(['Backlog anchor', title])
    await expect.poll(() => card.getAttribute('draggable')).toBe('true')
    await move('todo', column('todo'))
    await move('done', column('done'))
    const saved = await savedTask(page, title)
    expect(saved.connection).toBeUndefined()
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    await column('done').getByRole('article', { name: title, exact: true }).waitFor()
    expect(await savedTask(page, title)).toEqual(saved)
    await compareOrRefreshGolden(
      join(REPO_ROOT, 'apps', 'web', 'tests', 'expected', 'taskboard-drag.md'),
      await captureStableAria(page, 'div:has(> section[data-status])', workspace, { normalizeAge: true }),
      MODE,
    )
    expect(requests.filter(request => request.method === 'taskboard/move')).toHaveLength(8)
    expect(requests.filter(request => request.method === 'taskboard/run' || request.method === 'session/prompt')).toEqual([])
    expect(pageErrors).toEqual([])
  })
})

it('Taskboard status colors distinguish every column and remain consistent on archived cards in both themes', async () => {
  const fixture = await selectedSessionFixture(join(REPO_ROOT, 'snapshots', 'web', 'lifecycle-chrome', 'session.v3.jsonl'))
  const palette = [
    { status: 'backlog', color: 'rgb(156, 163, 175)' },
    { status: 'todo', color: 'rgb(99, 102, 241)' },
    { status: 'in_progress', color: 'rgb(37, 99, 235)' },
    { status: 'in_review', color: 'rgb(245, 158, 11)' },
    { status: 'done', color: 'rgb(34, 197, 94)' },
  ] as const
  await withTaskboardWorld({
    name: 'taskboard-palette',
    patches: [join(SCENARIO, 'cordis.yml'), join(SCENARIO, 'cordis.snapshot.yml')],
    prepare: async () => ({ DSH_SNAPSHOT_FILE: fixture, DSH_SNAPSHOT_OVERRIDE: undefined }),
  }, async ({ page, requests, pageErrors }) => {
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    const workspaceId = await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue()
    expect(workspaceId).not.toBe('all')
    for (const { status } of palette) {
      await taskboardRpc(page, 'taskboard/create', {
        request: { workspaceId, title: `Palette ${status}`, status },
      })
      await page.getByRole('article', { name: `Palette ${status}`, exact: true }).waitFor()
    }
    for (const archived of [false, true]) {
      if (archived) {
        for (const { status } of palette) {
          const task = await savedTask(page, `Palette ${status}`)
          await taskboardRpc(page, 'taskboard/archive', {
            request: { taskId: task.id, expectedRevision: task.revision },
          })
        }
        await page.getByRole('button', { name: 'Archived (5)', exact: true }).click()
      }
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')))
          .toBe(colorScheme === 'dark')
        for (const { status, color } of palette) {
          if (!archived) {
            const dot = page.locator(`section[data-status="${status}"] > div > span`).first()
            expect(await dot.evaluate(element => getComputedStyle(element).backgroundColor), `${status} column`).toBe(color)
          }
          const badge = page.getByRole('article', { name: `Palette ${status}`, exact: true }).locator('[data-status]')
          expect(await badge.evaluate(element => getComputedStyle(element).color), `${status} badge`).toBe(color)
          expect(await badge.evaluate(element => getComputedStyle(element).borderTopColor), `${status} badge border`).toBe(color)
        }
      }
    }
    expect(requests.filter(request => request.method === 'taskboard/run' || request.method === 'session/prompt')).toEqual([])
    expect(pageErrors).toEqual([])
  })
})

it('Taskboard preserves saved inputs and history while success, failure, waiting, resumed work, and cancellation update its column', async () => {
  const fixture = await selectedSessionFixture(join(REPO_ROOT, 'snapshots', 'web', 'lifecycle-chrome', 'session.v3.jsonl'))
  await withTaskboardWorld({
    name: 'taskboard-management',
    patches: ({ root }) => [
      join(SCENARIO, 'cordis.yml'), join(SCENARIO, 'cordis.snapshot.yml'), join(root, 'management.patch.yml'),
    ],
    prepare: async ({ root, home, workspace }) => {
      const controller = join(root, 'controller')
      const original = join(REPO_ROOT, 'packages', 'api', 'taskboard-controller')
      const manifest = JSON.parse(await readFile(join(original, 'package.json'), 'utf8')) as { name: string; dsh: unknown }
      await mkdir(controller)
      // Preserve the real Client module identity while replacing only Host native effects.
      await writeFile(join(controller, 'package.json'), JSON.stringify({
        name: manifest.name, private: true, type: 'module', dsh: manifest.dsh,
        exports: { './client': relative(controller, join(original, 'lib', 'client.js')) },
      }))
      await writeFile(join(controller, 'index.mjs'),
        `export { default } from ${JSON.stringify(pathToFileURL(join(FIXTURES, 'controller.mjs')).href)}\n`)
      await writeFile(join(root, 'agency-state.json'), JSON.stringify({ sessions: [
        { session_id: COPILOT, folder: workspace, status: 'idle', summary: 'Fixture conversation one' },
        { session_id: SECOND_COPILOT, folder: workspace, status: 'idle', summary: 'Fixture conversation two' },
      ] }))
      await writeFile(join(root, 'external-calls.jsonl'), '')
      await writeFile(join(root, 'management.patch.yml'), JSON.stringify([
        { id: 'subprocess', disabled: true },
        { id: 'taskboard-controller', disabled: true },
        {
          insert: [
            { id: 'taskboard-fixture-subprocess', name: join(FIXTURES, 'subprocess.mjs') },
            {
              id: 'taskboard-fixture-controller', name: join(controller, 'index.mjs'),
              config: { agencyCopilotLaunch: true, timeZone: 'UTC', lockPath: join(home, 'locks', 'taskboard') },
            },
          ],
        },
      ]))
      return {
        DSH_SNAPSHOT_FILE: fixture, DSH_SNAPSHOT_OVERRIDE: undefined,
        DSH_TASKBOARD_FIXTURE_ROOT: root, DSH_TASKBOARD_FIXTURE_WORKSPACE: workspace,
      }
    },
  }, async ({ page, root, home, workspace, requests, pageErrors, stop }) => {
    const workspaceBefore = await captureWorkspaceSnapshot(workspace)
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New task' })
    const options = await taskboardRpc<TaskboardExecutionOptionsValue>(page, 'taskboard/executionOptions', {})
    const preset = options.presets.find(item => item.isDefault)!
    expect(preset).toBeDefined()
    const model = options.models[0]!
    expect(model).toBeDefined()
    await field(create, 'Title').fill(TITLE)
    await field(create, 'Description').fill('Planning description is separate from the run prompt.')
    await select(create, 'Priority').selectOption('high')
    await field(create, 'Labels').fill('fixture, browser')
    await field(create, 'Run prompt').fill(PROMPT)
    await select(create, 'Agent preset').selectOption(preset.id)
    await select(create, 'Permission').selectOption('workspace-write')
    await select(create, 'Model').selectOption(JSON.stringify([model.provider, model.model]))
    await field(create, 'Reasoning effort ID').fill('high')
    await create.getByRole('checkbox', { name: 'Enable schedule', exact: true }).check()
    await select(create, 'Schedule preset').selectOption('hourly')
    expect(await field(create, 'Cron (5 fields)').inputValue()).toBe('0 * * * *')
    await field(create, 'Cron (5 fields)').fill('15 9 * * 1')
    await field(create, 'Time zone').fill('UTC')
    await field(create, 'Goal').fill('Keep the saved definition')
    await field(create, 'Progress').fill('Browser fields are filled')
    await field(create, 'Next').fill('Review only the fixture')
    await field(create, 'References (one per line)').fill('fixture:first\nfixture:second')
    await select(create, 'Source conversation').selectOption(JSON.stringify({ kind: 'dsh', sessionId: DSH }))
    await select(create, 'Linked DSH session').selectOption(DSH)
    await field(create, 'Cron (5 fields)').fill('* * * * * *')
    await button(create, 'Save and Close').click()
    await create.getByRole('alert').waitFor()
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toHaveLength(2)
    await field(create, 'Cron (5 fields)').fill('15 9 * * 1')
    await button(create, 'Save').click()
    await create.waitFor({ state: 'detached' })
    const details = page.getByRole('dialog', { name: 'Task details' })
    const beforeEdit = await savedTask(page, TITLE)
    await field(details, 'Description').fill('Planning description saved and closed.')
    await button(details, 'Save and Close').click()
    await details.waitFor({ state: 'detached' })
    expect(await savedTask(page, TITLE)).toMatchObject({
      description: 'Planning description saved and closed.', revision: beforeEdit.revision + 1,
    })
    await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('all')
    const card = page.getByRole('article', { name: TITLE, exact: true })
    await card.dragTo(page.locator('section[data-status="in_progress"] > div:nth-child(2)'))
    await expect.poll(async () => (await savedTask(page, TITLE)).status).toBe('in_progress')
    expect(await card.evaluate(element => element.closest('section')?.getAttribute('data-status'))).toBe('in_progress')
    await page.getByRole('article', { name: TITLE, exact: true }).click()
    const saved = await savedTask(page, TITLE)
    expect(saved).toMatchObject({
      status: 'in_progress', allowedManualStatuses: ['backlog', 'todo', 'in_review', 'done'],
      priority: 'high', labels: ['fixture', 'browser'], prompt: PROMPT,
      connection: { kind: 'dsh', sessionId: DSH }, executions: [],
      executionSettings: {
        kind: 'dsh', presetId: preset.id, permission: 'workspace-write',
        model: { provider: model.provider, model: model.model, reasoningEffort: 'high' },
      },
      schedule: { enabled: true, cron: '15 9 * * 1', timeZone: 'UTC' },
      handover: {
        goal: 'Keep the saved definition', progress: 'Browser fields are filled', next: 'Review only the fixture',
        references: ['fixture:first', 'fixture:second'], source: { kind: 'dsh', sessionId: DSH },
      },
    })
    expect(Date.parse(saved.schedule!.nextRunAt!)).toBeGreaterThan(Date.parse(saved.createdAt))
    expect(Number.isNaN(Date.parse(saved.handover!.frozenAt))).toBe(false)
    expect(await select(details, 'Workspace').isDisabled()).toBe(true)
    expect(await select(details, 'Agent preset').isDisabled()).toBe(true)
    expect(await select(details, 'Execution type').count()).toBe(0)
    expect(await button(details, 'In Progress').isDisabled()).toBe(true)
    for (const destination of ['Backlog', 'Todo', 'In Review', 'Done']) {
      expect(await button(details, destination).isDisabled()).toBe(false)
    }
    const sections = ['## Saved DSH definition\n' + await detailsGolden(page, workspace, saved)]
    await expect(taskboardRpc(page, 'taskboard/connect', { request: {
      taskId: saved.id, expectedRevision: saved.revision,
      connection: { kind: 'copilot', sessionId: COPILOT }, executionSettings: { kind: 'copilot', permission: 'read-only' },
    } })).rejects.toThrow('taskboard/execution-error: Disconnect before selecting another conversation')
    expect((await savedTask(page, TITLE)).connection).toEqual(saved.connection)

    await field(details, 'Run prompt').fill(PROMPT + ' Unsaved.')
    expect(await button(details, 'Run').isDisabled()).toBe(true)
    await field(details, 'Run prompt').fill(PROMPT)
    await button(details, 'Disconnect').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).connection).toBeUndefined()
    await select(details, 'Execution type').selectOption('copilot')
    await select(details, 'Permission').selectOption('full-access')
    await field(details, 'Copilot model ID').fill('fixture-model')
    await save(page)
    await select(details, 'Copilot CLI session (optional)').selectOption(COPILOT)
    expect(await button(details, 'Run').isDisabled()).toBe(true)
    await button(details, 'Connect').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).connection).toEqual({ kind: 'copilot', sessionId: COPILOT })
    const unconfirmed = await savedTask(page, TITLE)
    await button(details, 'Run').click()
    await details.getByRole('alert').filter({ hasText: 'confirm' }).waitFor()
    expect((await savedTask(page, TITLE)).executions).toEqual([])
    expect((await savedTask(page, TITLE)).status).toBe('in_progress')
    await details.getByRole('checkbox', { name: 'I reviewed the permission and frozen handover', exact: true }).check()
    await button(details, 'Confirm permission and handover').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).permissionConfirmedAt).toBeDefined()
    await button(details, 'Run').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).executions.map(run => run.status)).toEqual(['succeeded'])
    const completed = await savedTask(page, TITLE)
    expect(completed.status).toBe('done')
    await details.getByRole('button', { name: 'Done', exact: true, pressed: true }).waitFor()
    expect(completed.executions[0]).toMatchObject({
      prompt: expectedTaskboardPrompt(PROMPT, unconfirmed.handover), connection: unconfirmed.connection, handover: unconfirmed.handover,
      executionSettings: { kind: 'copilot', permission: 'full-access', model: 'fixture-model' },
    })
    await field(details, 'Run prompt').fill('FAIL: exercise provider rejection without external work.')
    await field(details, 'Goal').fill('Current edited goal')
    await save(page)
    expect((await savedTask(page, TITLE)).permissionConfirmedAt).toBeUndefined()
    await details.getByRole('checkbox', { name: 'I reviewed the permission and frozen handover', exact: true }).check()
    await button(details, 'Confirm permission and handover').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).permissionConfirmedAt).toBeDefined()
    await button(details, 'Run Again').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).executions.map(run => run.status)).toEqual(['succeeded', 'failed'])
    const failed = await savedTask(page, TITLE)
    expect(failed.status).toBe('in_review')
    await details.getByRole('button', { name: 'In Review', exact: true, pressed: true }).waitFor()
    expect(failed.connection).toEqual(completed.connection)
    expect(failed.executions[0]).toEqual(completed.executions[0])
    expect(failed.executions[1]!.handover!.goal).toBe('Current edited goal')
    expect(failed.executions[1]!.prompt).toBe(expectedTaskboardPrompt(failed.prompt, failed.handover))
    await details.getByText('Mock provider rejected the run', { exact: false }).waitFor()
    for (const summary of await details.getByText('Input for this run', { exact: true }).all()) await summary.click()
    sections.push('## Immutable execution history\n' + await detailsGolden(page, workspace, failed))

    await field(details, 'Run prompt').fill('WAIT: pause for fixture user input, resume, then cancel without external work.')
    const waitingInput = await save(page)
    await button(details, 'Run Again').click()
    await expect.poll(async () => {
      const task = await savedTask(page, TITLE)
      return { status: task.status, executions: task.executions.map(run => run.status) }
    }).toEqual({ status: 'in_review', executions: ['succeeded', 'failed', 'running'] })
    const waiting = await savedTask(page, TITLE)
    const waitingExecution = waiting.executions[2]!
    expect(waiting.executions.slice(0, 2)).toEqual(failed.executions)
    expect(waitingExecution.prompt).toBe(expectedTaskboardPrompt(waitingInput.prompt, waitingInput.handover))
    await details.getByText('Running', { exact: true }).waitFor()
    await details.getByRole('button', { name: 'In Review', exact: true, pressed: true }).waitFor()
    expect(await button(details, 'Run Again').isDisabled()).toBe(true)
    sections.push('## Waiting for user input\n' + await detailsGolden(page, workspace, waiting))

    await writeFile(join(root, `resume-${waitingExecution.id}.release`), '')
    await expect.poll(async () => (await savedTask(page, TITLE)).status).toBe('in_progress')
    await details.getByRole('button', { name: 'In Progress', exact: true, pressed: true }).waitFor()
    expect((await savedTask(page, TITLE)).executions.map(run => run.status)).toEqual(['succeeded', 'failed', 'running'])
    await writeFile(join(root, `cancel-${waitingExecution.id}.release`), '')
    await expect.poll(async () => (await savedTask(page, TITLE)).executions.map(run => run.status))
      .toEqual(['succeeded', 'failed', 'cancelled'])
    const cancelled = await savedTask(page, TITLE)
    expect(cancelled.status).toBe('in_review')
    expect(cancelled.connection).toEqual(completed.connection)
    expect(cancelled.executions.slice(0, 2)).toEqual(failed.executions)
    await details.getByRole('button', { name: 'In Review', exact: true, pressed: true }).waitFor()
    await details.getByText('Cancelled', { exact: true }).waitFor()
    sections.push('## Cancelled after resumed work\n' + await detailsGolden(page, workspace, cancelled))
    await writeFile(join(root, 'agency-state.json'), JSON.stringify({ sessions: [
      { session_id: SECOND_COPILOT, folder: workspace, status: 'idle', summary: 'Fixture conversation two' },
    ] }))
    await details.getByRole('button', { name: `Copilot: ${COPILOT}`, exact: true }).first().click()
    await details.getByRole('alert').filter({ hasText: 'was not recreated' }).waitFor()
    expect((await savedTask(page, TITLE)).executions).toEqual(cancelled.executions)
    await writeFile(join(root, 'agency-state.json'), JSON.stringify({ sessions: [
      { session_id: COPILOT, folder: workspace, status: 'idle', summary: 'Fixture conversation one' },
      { session_id: SECOND_COPILOT, folder: workspace, status: 'idle', summary: 'Fixture conversation two' },
    ] }))
    await button(details, 'Open/Resume Copilot').click()
    await expect.poll(async () => {
      const calls = (await readFile(join(root, 'external-calls.jsonl'), 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as { type: string })
      return calls.filter(call => call.type === 'terminal').length
    }).toBe(1)
    expect((await savedTask(page, TITLE)).executions).toEqual(cancelled.executions)
    await button(details, 'Disconnect').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).connection).toBeUndefined()
    await select(details, 'Copilot CLI session (optional)').selectOption(SECOND_COPILOT)
    await button(details, 'Connect').click()
    await expect.poll(async () => (await savedTask(page, TITLE)).connection).toEqual({ kind: 'copilot', sessionId: SECOND_COPILOT })
    expect((await savedTask(page, TITLE)).executions).toEqual(cancelled.executions)

    await button(details, 'Duplicate task').click()
    const copy = page.getByRole('dialog', { name: 'Duplicate task' })
    await field(copy, 'Title').fill('Definition copy')
    expect(await copy.getByRole('checkbox', { name: 'Enable schedule', exact: true }).isChecked()).toBe(false)
    await copy.getByRole('checkbox', { name: 'Archive original after creating', exact: true }).check()
    await button(copy, 'Save').click()
    await copy.waitFor({ state: 'detached' })
    const copied = await savedTask(page, 'Definition copy')
    expect(copied).toMatchObject({ status: 'in_review', executions: [], schedule: { enabled: false }, prompt: cancelled.prompt })
    expect(copied.connection).toBeUndefined()
    expect(copied.permissionConfirmedAt).toBeUndefined()
    expect((await savedTask(page, TITLE)).archivedAt).toBeDefined()
    expect((await savedTask(page, TITLE)).schedule!.enabled).toBe(false)
    await field(details, 'Description').fill('Unsaved description belongs only to the new copy.')
    await button(details, 'Edit as copy').click()
    await field(copy, 'Title').fill('Unsaved draft copy')
    await button(copy, 'Save').click()
    await copy.waitFor({ state: 'detached' })
    expect((await savedTask(page, 'Definition copy')).description).toBe(copied.description)
    expect(await savedTask(page, 'Unsaved draft copy')).toMatchObject({
      description: 'Unsaved description belongs only to the new copy.', executions: [], schedule: { enabled: false },
    })
    await button(details, 'Close').click()
    await page.getByRole('button', { name: 'Archived (1)', exact: true }).click()
    await page.getByRole('article', { name: TITLE, exact: true }).click()
    expect(await field(details, 'Run prompt').isDisabled()).toBe(true)
    await button(details, 'Restore').click()
    await details.waitFor({ state: 'detached' })
    const restored = await savedTask(page, TITLE)
    expect(restored.archivedAt).toBeUndefined()
    expect(restored.schedule!.enabled).toBe(false)
    expect(restored.executions).toEqual(cancelled.executions)
    expect(restored.connection).toEqual({ kind: 'copilot', sessionId: SECOND_COPILOT })
    await page.getByRole('button', { name: 'Back to board', exact: true }).click()

    for (const [index, kind] of ['dsh', 'copilot'].entries()) {
      const title = `Legacy dual links ${index + 1}`
      const legacy = await savedTask(page, title)
      expect(legacy.unresolvedConnections).toHaveLength(2)
      await page.getByRole('article', { name: title, exact: true }).click()
      expect(await button(details, 'Run').isDisabled()).toBe(true)
      const choice = legacy.unresolvedConnections!.find(connection => connection.kind === kind)!
      await button(details, `${kind === 'dsh' ? 'DSH' : 'Copilot'}: ${choice.sessionId}`).click()
      await expect.poll(async () => (await savedTask(page, title)).connection).toEqual(choice)
      const resolved = await savedTask(page, title)
      expect(resolved.unresolvedConnections).toBeUndefined()
      expect(resolved.status).toBe('in_review')
      expect(resolved.executions).toEqual([])
      await button(details, 'Close').click()
    }

    expect(await page.getByRole('button', { name: 'Taskboard settings', exact: true }).count()).toBe(0)
    const runtime = await updateTaskboardSettings(page, { announceToAgent: true, preventIdleSleep: true })
    expect(runtime.settings).toEqual({ enabled: true, announceToAgent: true, preventIdleSleep: true })
    sections.push('## Host runtime settings\n```json\n' + JSON.stringify(runtime.settings, null, 2) + '\n```')
    await updateTaskboardSettings(page, { enabled: false })
    await page.getByText('Taskboard is disabled by the Host.', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'New task', exact: true }).isDisabled()).toBe(true)
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    const disabled = await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')
    expect(disabled.runtime.settings).toEqual({ enabled: false, announceToAgent: true, preventIdleSleep: true })
    expect(await page.getByRole('button', { name: 'Taskboard settings', exact: true }).count()).toBe(0)
    await updateTaskboardSettings(page, { enabled: true })
    await page.getByRole('article', { name: TITLE, exact: true }).waitFor()

    const { tasks } = await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')
    expect(tasks).toHaveLength(5)
    expect(tasks.flatMap(task => task.executions)).toHaveLength(3)
    expect(requests.filter(request => request.method === 'session/prompt')).toEqual([])
    expect(pageErrors).toEqual([])
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(workspaceBefore)
    await stop()
    expect((await taskboardPersistedSessions(home)).flatMap(log => fixtureUserPrompts(log.content))).toEqual([])
    const calls = (await readFile(join(root, 'external-calls.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as {
        type: string
        sessionId?: string
        state?: string
        args?: string[]
        execution?: { prompt: string }
      })
    const dispatches = calls.filter(call => call.type === 'dispatch')
    expect(dispatches.map(call => call.sessionId)).toEqual([COPILOT, COPILOT, COPILOT])
    expect(dispatches.map(call => call.execution!.prompt)).toEqual(cancelled.executions.map(run => run.prompt))
    expect(calls.filter(call => call.type === 'observation').map(call => call.state)).toEqual(['waiting', 'running', 'cancelled'])
    const terminals = calls.filter(call => call.type === 'terminal')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.args!.slice(-2)).toEqual(['copilot', `--resume=${COPILOT}`])
    expect(terminals[0]!.args).not.toContain('--interactive')
    await compareOrRefreshGolden(EXPECTED, sections.join('\n\n'), MODE)
  })
})
