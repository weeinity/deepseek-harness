/** Host-owned Taskboard execution through the shipped Web profile and unchanged genuine model replay. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller'
import type { TaskboardListValue, TaskboardTaskValue } from '@deepseek-ai/dsh-api-taskboard-controller'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import {
  captureWorkspaceSnapshot, formatSystemPromptSnapshot, normalizedSystemPrompts,
  normalizeSessionSnapshots, parseSnapshotManifest,
} from '@deepseek-ai/dsh-session-snapshot'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  normalizeWebSessionVolatiles, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT } from './support.ts'
import {
  expectedTaskboardPrompt, savedTask, setTaskboardRuntimeSwitch, taskboardPersistedSessions, taskboardRpc, withTaskboardWorld,
} from './taskboard-harness.ts'

const SCENARIO = fileURLToPath(new URL('../../../snapshots/web/taskboard-start-work', import.meta.url))
const REPLAY_GATES = fileURLToPath(new URL('./fixtures/taskboard/replay-gates.mjs', import.meta.url))
const MODE = webSnapshotMode()
const ANNOUNCEMENT = 'Taskboard keeps saved task definitions, connected conversations, and execution history. '
  + 'A task has one current DSH or Copilot conversation. Repeated runs continue that conversation. '
  + 'New tasks start in Todo. Run moves a task to In Progress; waiting for user input, failure, or cancellation moves it to In Review. '
  + 'Resumed work returns to In Progress, and successful execution moves the task to Done. '
  + 'Active tasks can be moved manually to any column without running them. '
  + 'Supplied handover context and references do not grant additional permissions.'
const HANDOVER = {
  goal: 'Reply with the single word LIGHTHOUSE only.',
  progress: 'One harmless response completed.',
  next: 'Repeat that same one-word response without using tools.',
  references: [],
  frozenAt: '2026-01-01T00:00:00.000Z',
}

function comparableSession(content: string): string {
  const header = JSON.parse(content.split('\n')[0]!) as SessionHeader
  const normalized = normalizeSessionSnapshots(
    [normalizeWebSessionVolatiles(content)], { sessionIds: [header.id], cwd: header.cwd! },
  )[0]
  if (normalized === undefined) throw new Error('Taskboard Session normalization produced no parent')
  return JSON.stringify(normalized.trim().split('\n').map(line => JSON.parse(line) as unknown), null, 2)
}

async function releaseRunning(page: Page, title: string, root: string, sequence: number): Promise<void> {
  await expect.poll(() => existsSync(join(root, `model-${sequence}.ready`)), { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await savedTask(page, title)).status, { timeout: 30_000 }).toBe('in_progress')
  await page.getByRole('button', { name: 'Open Task', exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Task details' })
  expect(await details.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe(title)
  await expect.poll(() => details.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await details.getByRole('button', { name: 'In Progress', exact: true, pressed: true }).waitFor()
  expect(await details.getByRole('button', { name: 'Run Again', exact: true }).isDisabled()).toBe(true)
  await details.getByRole('button', { name: 'Open session', exact: true }).click()
  await details.waitFor({ state: 'detached' })
  await writeFile(join(root, `model-${sequence}.release`), '')
}

it.skipIf(MODE === 'record')('Taskboard moves Todo through In Progress to Done on same-Session reruns, with announcement and handover but no Open/reload dispatch', async () => {
  const manifestPath = join(SCENARIO, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  if (manifest.session === undefined) throw new Error('Taskboard snapshot must borrow its recorded Session')
  const fixture = await selectedSessionFixture(resolve(SCENARIO, manifest.session.source))
  const fixtureContent = await readFile(fixture, 'utf8')
  const fixturePrompts = fixtureUserPrompts(fixtureContent)
  expect(fixturePrompts).toHaveLength(1)
  const prompt = fixturePrompts[0]!
  const description = 'Do not use tools.'
  const defaultPrompt = `${prompt}\n\n${description}`
  const fixtureEvents = parseSessionLog(fixtureContent)
  expect(fixtureEvents.filter(event => event.type === 'tool/call')).toEqual([])
  const fixtureAssistants = fixtureEvents.filter(event => event.type === 'assistant/message')
  expect(fixtureAssistants).toHaveLength(1)
  const reply = fixtureAssistants[0]!.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const script = deriveReplayScript(fixtureEvents)
  expect(script).toHaveLength(1)

  await withTaskboardWorld({
    name: 'taskboard-start-work',
    patches: ({ root }) => [
      join(SCENARIO, 'cordis.yml'), join(SCENARIO, 'cordis.snapshot.yml'), join(root, 'replay-gates.patch.yml'),
    ],
    prepare: async ({ root }) => {
      const override = join(root, 'repeat-replay.json')
      // Authored repetition borrows the same genuine stream twice; no new live recording is claimed.
      await writeFile(override, JSON.stringify([...script, ...script]) + '\n')
      await writeFile(join(root, 'replay-gates.patch.yml'), JSON.stringify([
        { insert: [{ id: 'taskboard-replay-gates', name: REPLAY_GATES }] },
      ]))
      return { DSH_SNAPSHOT_FILE: fixture, DSH_SNAPSHOT_OVERRIDE: override, DSH_TASKBOARD_FIXTURE_ROOT: root }
    },
  }, async ({ page, home, root, workspace, requests, pageErrors, stop }) => {
    const webUrl = new URL(page.url()).origin
    const initialWorkspace = await captureWorkspaceSnapshot(workspace)
    await connectFreshWorkspace(page, root)
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    const beforeCreate = (await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New task' })
    expect(await create.getByRole('button', { name: 'Archive', exact: true }).count()).toBe(0)
    expect(await create.getByRole('button', { name: 'Delete', exact: true }).count()).toBe(0)
    await create.getByRole('textbox', { name: 'Title', exact: true }).fill('Discarded draft')
    await create.getByRole('textbox', { name: 'Description', exact: true }).fill('Do not save or run this draft.')
    await create.getByRole('button', { name: 'Cancel', exact: true }).click()
    await create.waitFor({ state: 'detached' })
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toEqual(beforeCreate)
    expect(requests.filter(request => request.method === 'taskboard/create')).toHaveLength(0)
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    expect(await create.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe('')
    await create.getByRole('textbox', { name: 'Title', exact: true }).fill(prompt)
    await create.getByRole('textbox', { name: 'Description', exact: true }).fill(description)
    expect(await create.getByRole('textbox', { name: 'Run prompt', exact: true }).getAttribute('placeholder'))
      .toBe('Leave blank to use the task title and description. An explicit prompt overrides both.')
    await create.getByRole('button', { name: 'Save and Close', exact: true }).click()
    await create.waitFor({ state: 'detached' })
    expect(await page.getByRole('dialog').count()).toBe(0)
    const saved = await savedTask(page, prompt)
    expect(saved).toMatchObject({
      title: prompt, description, prompt: '', status: 'todo',
      allowedManualStatuses: ['backlog', 'in_progress', 'in_review', 'done'], executions: [],
    })
    expect(saved.connection).toBeUndefined()
    await page.getByRole('article', { name: prompt, exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Task details' })
    await details.getByRole('button', { name: 'Archive', exact: true }).waitFor()
    await details.getByRole('button', { name: 'Delete', exact: true }).waitFor()
    expect(await details.getByRole('button', { name: 'Todo', exact: true }).getAttribute('aria-pressed')).toBe('true')
    for (const destination of ['In Progress', 'In Review', 'Done']) {
      expect(await details.getByRole('button', { name: destination, exact: true }).isDisabled()).toBe(false)
    }
    expect(await details.getByRole('button', { name: 'Backlog', exact: true }).isDisabled()).toBe(false)
    expect(await savedTask(page, prompt)).toEqual(saved)
    await details.getByRole('button', { name: 'Run', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    await releaseRunning(page, prompt, root, 1)
    await page.getByText(reply, { exact: true }).waitFor({ timeout: 120_000 })
    await expect.poll(async () => (await savedTask(page, prompt)).executions.map(run => run.status),
      { timeout: 30_000 }).toEqual(['succeeded'])
    const first = await savedTask(page, prompt)
    expect(first).toMatchObject({
      id: saved.id, status: 'done', connection: { kind: 'dsh' },
      executions: [{ status: 'succeeded', trigger: 'manual', prompt: defaultPrompt, connection: first.connection }],
    })
    const firstExecution = first.executions[0]!
    expect(firstExecution.receipt).toMatchObject({ kind: 'dsh' })
    const connection = first.connection!

    const taskButton = page.getByRole('button', { name: 'Open Task', exact: true })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')))
        .toBe(colorScheme === 'dark')
      const sessionLogHeight = await page.getByRole('button', { name: 'Session log', exact: true })
        .evaluate(element => element.getBoundingClientRect().height)
      expect(sessionLogHeight).toBe(26)
      await expect.poll(() => taskButton.evaluate((element) => {
        const style = getComputedStyle(element)
        const buttonBounds = element.getBoundingClientRect()
        const icon = element.querySelector('svg')!
        const iconBounds = icon.getBoundingClientRect()
        return {
          background: style.backgroundColor, color: style.color, radius: style.borderRadius,
          height: buttonBounds.height, fontSize: style.fontSize, gap: style.gap, iconColor: getComputedStyle(icon).color,
          iconCentered: Math.abs(iconBounds.y + iconBounds.height / 2 - buttonBounds.y - buttonBounds.height / 2) < 0.5,
        }
      })).toEqual({
        background: 'rgb(15, 108, 189)', color: 'rgb(255, 255, 255)', radius: '8px',
        height: sessionLogHeight, fontSize: '12px', gap: '6px', iconColor: 'rgb(255, 255, 255)', iconCentered: true,
      })
      await taskButton.hover()
      await expect.poll(() => taskButton.evaluate(element => getComputedStyle(element).backgroundColor))
        .toBe('rgb(17, 94, 163)')
      await page.mouse.move(0, 0)
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await taskButton.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    expect(await taskButton.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await taskButton.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid')
    expect(await taskButton.evaluate(element => getComputedStyle(element).outlineWidth)).toBe('2px')
    await page.keyboard.press('Enter')
    const card = page.getByRole('article', { name: prompt, exact: true })
    await details.getByRole('button', { name: 'Done', exact: true, pressed: true }).waitFor()
    await details.getByText('Succeeded', { exact: true }).waitFor()
    await details.getByRole('button', { name: 'Open session', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    await page.getByText(reply, { exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.getByText(reply, { exact: true }).waitFor()
    expect(await savedTask(page, prompt)).toEqual(first)
    expect(requests.filter(request => request.method === 'taskboard/run')).toHaveLength(1)

    await page.getByRole('button', { name: 'Open Task', exact: true }).click()
    expect(await details.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe(prompt)
    await details.getByRole('button', { name: 'Close', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Taskboard settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Taskboard settings' })
    expect(await settings.getByRole('switch', { name: 'Announce Taskboard to agents', exact: true }).isChecked()).toBe(false)
    await setTaskboardRuntimeSwitch(settings, 'Announce Taskboard to agents', true)
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    const { task: secondInput } = await taskboardRpc<TaskboardTaskValue>(page, 'taskboard/update', {
      request: { taskId: first.id, expectedRevision: first.revision, patch: { prompt, handover: HANDOVER } },
    })
    expect(secondInput.handover).toEqual(HANDOVER)
    expect(secondInput.description).toBe(description)
    const submitted = expectedTaskboardPrompt(prompt, HANDOVER)
    await card.click()
    expect(await details.getByRole('textbox', { name: 'Goal', exact: true }).inputValue()).toBe(HANDOVER.goal)
    await details.getByRole('button', { name: 'Run Again', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    await releaseRunning(page, prompt, root, 2)
    await expect.poll(async () => (await savedTask(page, prompt)).executions.map(run => run.status),
      { timeout: 30_000 }).toEqual(['succeeded', 'succeeded'])
    const repeated = await savedTask(page, prompt)
    expect(repeated.connection).toEqual(connection)
    expect(repeated.status).toBe('done')
    expect(repeated.executions[0]).toEqual(firstExecution)
    expect(new Set(repeated.executions.map(run => run.id)).size).toBe(2)
    expect(new Set(repeated.executions.map(run => run.requestId)).size).toBe(2)
    expect(repeated.executions.map(run => run.connection)).toEqual([connection, connection])
    expect(repeated.executions.map(run => run.prompt)).toEqual([defaultPrompt, submitted])
    expect(repeated.executions[1]!.handover).toEqual(HANDOVER)
    await expect.poll(async () => {
      const { items } = await taskboardRpc<SessionListValue>(page, 'session/list', { _request: {} })
      return items.find(item => item.sessionId === connection.sessionId)?.running
    }, { timeout: 15_000 }).toBe(false)
    const ui = await captureStableAria(page, '[class*="centerCol"]', workspace)

    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    await page.getByRole('heading', { name: 'Taskboard', exact: true }).waitFor()
    expect(await details.count()).toBe(0)
    await card.click()
    expect(await details.getByText('Succeeded', { exact: true }).count()).toBe(2)
    const historyButtons = details.getByRole('button', { name: `DSH: ${connection.sessionId}`, exact: true })
    expect(await historyButtons.count()).toBe(2)
    await historyButtons.first().click()
    await details.waitFor({ state: 'detached' })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(async () => page.getByText(reply, { exact: true }).count()).toBe(2)
    expect(await savedTask(page, prompt)).toEqual(repeated)
    const runs = requests.filter(request => request.method === 'taskboard/run')
    expect(runs.map(request => request.data)).toMatchObject(repeated.executions.map((run, index) => ({
      payload: { args: { request: {
        taskId: saved.id, expectedRevision: index === 0 ? saved.revision : secondInput.revision, requestId: run.requestId,
      } } },
    })))
    expect(runs).toHaveLength(2)
    const { task: related } = await taskboardRpc<TaskboardTaskValue>(page, 'taskboard/create', {
      request: { workspaceId: repeated.workspaceId, title: 'Related planning task', connection },
    })
    const openTask = page.getByRole('button', { name: 'Open Task', exact: true })
    await expect.poll(() => openTask.getAttribute('aria-haspopup')).toBe('menu')
    const relatedLabel = `DSH-${String(related.ordinal).padStart(3, '0')}: ${related.title}`
    await openTask.click()
    expect(await page.getByRole('menuitem').count()).toBe(2)
    await page.getByRole('menuitem', { name: relatedLabel, exact: true }).click()
    expect(await details.getByRole('textbox', { name: 'Title', exact: true }).inputValue()).toBe(related.title)
    await expect.poll(() => details.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await details.getByRole('button', { name: 'Archive', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    const archived = await savedTask(page, related.title)
    expect(archived.archivedAt).toBeDefined()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await openTask.click()
    await page.getByRole('menuitem', { name: relatedLabel, exact: true }).click()
    expect(await details.getByRole('textbox', { name: 'Title', exact: true }).isDisabled()).toBe(true)
    await details.getByRole('button', { name: 'Open session', exact: true }).click()
    await details.waitFor({ state: 'detached' })
    await taskboardRpc(page, 'taskboard/delete', { request: { taskId: archived.id, expectedRevision: archived.revision } })
    await expect.poll(() => openTask.getAttribute('aria-haspopup')).toBeNull()
    await taskboardRpc(page, 'taskboard/disconnect', { request: { taskId: repeated.id, expectedRevision: repeated.revision } })
    await expect.poll(() => openTask.count()).toBe(0)
    expect((await savedTask(page, prompt)).executions).toEqual(repeated.executions)
    expect(requests.filter(request => request.method === 'taskboard/run')).toHaveLength(2)
    expect(requests.filter(request => request.method === 'session/prompt')).toEqual([])
    expect(pageErrors).toEqual([])
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(initialWorkspace)

    const ownerLock = join(home, 'locks', 'taskboard', 'owner.lock')
    expect((await stat(ownerLock)).isFile()).toBe(true)
    await stop()
    expect((await stat(ownerLock)).isFile()).toBe(true)
    const logs = (await taskboardPersistedSessions(home)).filter(log => fixtureUserPrompts(log.content).length > 0)
    expect(logs).toHaveLength(1)
    const log = logs[0]!
    expect(log.header.id).toBe(connection.sessionId)
    expect(log.header.cwd).toBe(workspace)
    expect(fixtureUserPrompts(log.content)).toEqual([defaultPrompt, submitted])
    const events = parseSessionLog(log.content)
    const systems = events.filter(event => event.type === 'system/message')
      .map(event => event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(systems).toHaveLength(2)
    expect(systems[0]).not.toContain(ANNOUNCEMENT)
    expect(systems[1]!.split(ANNOUNCEMENT)).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/call')).toEqual([])
    expect(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content))
      .toEqual([fixtureAssistants[0]!.data.message.content, fixtureAssistants[0]!.data.message.content])
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'completed'])
    expect(await readFile(fixture, 'utf8')).toBe(fixtureContent)
    const systemPrompts = normalizedSystemPrompts(normalizeWebSessionVolatiles(log.content), {
      sessionIds: [log.header.id], cwd: workspace,
    }).map(value => value.split(REPO_ROOT).join('{{sourceRoot}}').split(webUrl).join('{{webUrl}}'))
    expect(systemPrompts).toHaveLength(2)
    await compareOrRefreshGolden(join(SCENARIO, 'system-prompts.expected.md'),
      formatSystemPromptSnapshot(systemPrompts[0]!, systemPrompts.slice(1)).replace(/\n$/u, ''), MODE)
    await compareOrRefreshGolden(join(SCENARIO, 'execution.expected.json'), comparableSession(log.content), MODE)
    await compareOrRefreshGolden(join(SCENARIO, 'ui.expected.md'), ui, MODE)
    await assertFixtureInventory(SCENARIO, [
      'cordis.yml', 'cordis.snapshot.yml', 'execution.expected.json', 'system-prompts.expected.md', 'ui.expected.md',
    ])
  })
})
