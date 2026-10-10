/** Linked ordinary chat attention through the shipped Web profile, genuine human answerer, and recorded model streams. */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller'
import type { TaskboardListValue, TaskboardTask } from '@deepseek-ai/dsh-api-taskboard-controller'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { captureWorkspaceSnapshot, parseSnapshotManifest } from '@deepseek-ai/dsh-session-snapshot'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, selectedSessionFixture, webSnapshotMode,
} from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import {
  savedTask, taskboardPersistedSessions, taskboardRpc, withTaskboardWorld, type TaskboardWorld,
} from './taskboard-harness.ts'

const SCENARIO = join(REPO_ROOT, 'snapshots', 'web', 'taskboard-start-work')
const FIXTURES = fileURLToPath(new URL('./fixtures/taskboard', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/taskboard-linked-attention.md', import.meta.url))
const MODE = webSnapshotMode()
const TITLE = 'Linked ordinary conversation'

interface QuestionOwner {
  readonly sessionId: SessionId
  readonly turn: number
  readonly requestIds: readonly string[]
}

async function submitQuestion(page: Page, root: string, prompt: string, sequence: number): Promise<QuestionOwner> {
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor()
  await input.fill(prompt)
  await input.press('Enter')
  const composer = page.locator('[data-question-key]')
  await composer.getByText('Continue this ordinary conversation?', { exact: true }).waitFor({ timeout: 30_000 })
  const owner = JSON.parse(await readFile(join(root, `question-${sequence}.ready.json`), 'utf8')) as QuestionOwner
  expect(owner.requestIds).toHaveLength(1)
  expect(owner.requestIds[0]).not.toMatch(/^taskboard:/u)
  return owner
}

async function answerQuestion(page: Page, root: string, question: number, model: number): Promise<void> {
  const composer = page.locator('[data-question-key]')
  const input = composer.getByRole('textbox')
  await input.fill('Continue')
  await input.press('Enter')
  await composer.waitFor({ state: 'detached' })
  await expect.poll(() => existsSync(join(root, `model-${model}.ready`)), { timeout: 30_000 }).toBe(true)
  const answered = JSON.parse(await readFile(join(root, `question-${question}.answered.json`), 'utf8')) as {
    readonly answer: unknown
  }
  expect(answered.answer).toEqual({ answers: [{ id: 'continue', selected: [], custom: 'Continue' }] })
}

async function openLinkedSession(page: Page): Promise<void> {
  await page.getByRole('article', { name: TITLE, exact: true }).click()
  const details = page.getByRole('dialog', { name: 'Task details' })
  await details.getByRole('button', { name: 'Open session', exact: true }).click()
  await details.waitFor({ state: 'detached' })
}

async function sessionLog(home: string, sessionId: SessionId): Promise<string> {
  const logs = (await taskboardPersistedSessions(home)).filter(log => log.header.id === sessionId)
  expect(logs).toHaveLength(1)
  return logs[0]!.content
}

async function settledLog(page: Page, home: string, owner: QuestionOwner): Promise<string> {
  await expect.poll(async () => {
    const { items } = await taskboardRpc<SessionListValue>(page, 'session/list', { _request: {} })
    return items.find(item => item.sessionId === owner.sessionId)?.running
  }, { timeout: 30_000 }).toBe(false)
  await expect.poll(async () => parseSessionLog(await sessionLog(home, owner.sessionId))
    .filter(event => event.type === 'turn/end')
    .filter(event => event.data.turn === owner.turn)
    .map(event => event.data.reason.kind), { timeout: 30_000 }).toEqual(['completed'])
  return sessionLog(home, owner.sessionId)
}

async function recordedStream() {
  const manifestPath = join(SCENARIO, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  if (manifest.session === undefined) throw new Error('Taskboard attention must borrow its genuine recorded Session')
  const fixture = await selectedSessionFixture(resolve(SCENARIO, manifest.session.source))
  const fixtureContent = await readFile(fixture, 'utf8')
  const prompts = fixtureUserPrompts(fixtureContent)
  expect(prompts).toHaveLength(1)
  const prompt = prompts[0]!
  const fixtureEvents = parseSessionLog(fixtureContent)
  expect(fixtureEvents.filter(event => event.type === 'tool/call')).toEqual([])
  const assistants = fixtureEvents.filter(event => event.type === 'assistant/message')
  expect(assistants).toHaveLength(1)
  const script = deriveReplayScript(fixtureEvents)
  expect(script).toHaveLength(1)
  return { fixture, fixtureContent, prompt, assistants, script }
}

async function withAttentionWorld(
  modelCalls: number,
  run: (world: TaskboardWorld, recording: Awaited<ReturnType<typeof recordedStream>>) => Promise<void>,
): Promise<void> {
  const recording = await recordedStream()
  await withTaskboardWorld({
    name: 'taskboard-linked-attention',
    patches: ({ root }) => [
      join(SCENARIO, 'cordis.yml'), join(SCENARIO, 'cordis.snapshot.yml'), join(root, 'linked-attention.patch.yml'),
    ],
    prepare: async ({ root }) => {
      const override = join(root, 'repeat-replay.json')
      // Repetition reuses genuine chunks; the pre-step question is not an invented model tool call.
      await writeFile(override, JSON.stringify(Array.from({ length: modelCalls }, () => recording.script).flat()) + '\n')
      await writeFile(join(root, 'linked-attention.patch.yml'), JSON.stringify([
        { insert: [
          { id: 'taskboard-replay-gates', name: join(FIXTURES, 'replay-gates.mjs') },
          { id: 'taskboard-linked-attention', name: join(FIXTURES, 'linked-attention.mjs') },
        ] },
      ]))
      return { DSH_SNAPSHOT_FILE: recording.fixture, DSH_SNAPSHOT_OVERRIDE: override, DSH_TASKBOARD_FIXTURE_ROOT: root }
    },
  }, world => run(world, recording))
}

it.skipIf(MODE === 'record')('an unlinked ordinary chat question does not create or connect a Taskboard task', async () => {
  await withAttentionWorld(1, async ({ page, root, home, workspace, requests, pageErrors, stop }, { fixture, fixtureContent, prompt }) => {
    const initialWorkspace = await captureWorkspaceSnapshot(workspace)
    const unlinked = await submitQuestion(page, root, prompt, 1)
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toEqual([])
    await answerQuestion(page, root, 1, 1)
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toEqual([])
    await writeFile(join(root, 'model-1.release'), '')
    const unlinkedContent = await settledLog(page, home, unlinked)
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toEqual([])
    expect(requests.filter(request => request.method === 'session/prompt')).toHaveLength(1)
    expect(requests.filter(request => request.method === 'taskboard/run')).toEqual([])
    expect(pageErrors).toEqual([])
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(initialWorkspace)
    await stop()
    expect(await sessionLog(home, unlinked.sessionId)).toBe(unlinkedContent)
    expect(await readFile(fixture, 'utf8')).toBe(fixtureContent)
  })
})

it.skipIf(MODE === 'record')('linked chat questions move Todo and settled tasks through In Review, In Progress, and Done without new executions', async () => {
  await withAttentionWorld(3, async ({ page, root, home, workspace, requests, pageErrors, stop }, {
    fixture, fixtureContent, prompt, assistants,
  }) => {
    const initialWorkspace = await captureWorkspaceSnapshot(workspace)
    let linkedId: SessionId | undefined
    await expect.poll(async () => {
      const { items } = await taskboardRpc<SessionListValue>(page, 'session/list', { _request: {} })
      linkedId = items.find(item => item.blank)?.sessionId
      return linkedId
    }).toBeDefined()
    await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
    await page.getByRole('button', { name: 'New task', exact: true }).click()
    const create = page.getByRole('dialog', { name: 'New task' })
    await create.getByRole('textbox', { name: 'Title', exact: true }).fill(TITLE)
    await create.getByRole('textbox', { name: 'Run prompt', exact: true }).fill(prompt)
    await create.getByRole('combobox', { name: 'Linked DSH session', exact: true }).selectOption(linkedId!)
    await create.getByRole('button', { name: 'Save and Close', exact: true }).click()
    await create.waitFor({ state: 'detached' })
    const saved = await savedTask(page, TITLE)
    expect(saved).toMatchObject({
      status: 'todo', executions: [], connection: { kind: 'dsh', sessionId: linkedId },
    })
    await openLinkedSession(page)
    const goldens: string[] = []
    const owners: QuestionOwner[] = []
    let history: TaskboardTask['executions'] = []

    for (const [index, question, model] of [[0, 1, 1], [1, 2, 3]] as const) {
      const runsBefore = requests.filter(request => request.method === 'taskboard/run')
      const owner = await submitQuestion(page, root, prompt, question)
      owners.push(owner)
      expect(owner.sessionId).toBe(linkedId)
      expect(owner.turn).toBe(index === 0 ? 1 : 3)
      await expect.poll(async () => (await savedTask(page, TITLE)).status, { timeout: 30_000 }).toBe('in_review')
      const waiting = await savedTask(page, TITLE)
      expect(waiting.executions).toEqual(history)
      expect(waiting.connection).toEqual(saved.connection)
      await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
      const reviewColumn = page.locator('section[data-status="in_review"]')
      await reviewColumn.getByRole('article', { name: TITLE, exact: true }).waitFor()
      goldens.push(`## ${index === 0 ? 'No execution history' : 'Settled execution history'}\n`
        + await captureStableAria(page, 'section[data-status="in_review"]', workspace, {
          normalizeAge: true,
          replacements: [[String(linkedId).slice(0, 6), '{{linkedSession}}']],
        }))
      await openLinkedSession(page)
      await answerQuestion(page, root, question, model)
      await expect.poll(async () => (await savedTask(page, TITLE)).status, { timeout: 30_000 }).toBe('in_progress')
      expect((await savedTask(page, TITLE)).executions).toEqual(history)
      const held = parseSessionLog(await sessionLog(home, owner.sessionId))
      expect(held.filter(event => event.type === 'turn/end').map(event => event.data.turn))
        .toEqual(index === 0 ? [] : [1, 2])
      expect(held.filter(event => event.type === 'turn/start').at(-1)?.data.turn).toBe(owner.turn)
      await writeFile(join(root, `model-${model}.release`), '')
      await settledLog(page, home, owner)
      await expect.poll(async () => (await savedTask(page, TITLE)).status, { timeout: 30_000 }).toBe('done')
      expect((await savedTask(page, TITLE)).executions).toEqual(history)
      expect(requests.filter(request => request.method === 'taskboard/run')).toEqual(runsBefore)

      if (index === 0) {
        expect(runsBefore).toEqual([])
        await page.getByRole('button', { name: 'Taskboard', exact: true }).click()
        await page.locator('section[data-status="done"]').getByRole('article', { name: TITLE, exact: true }).click()
        const details = page.getByRole('dialog', { name: 'Task details' })
        await details.getByRole('button', { name: 'Run', exact: true }).click()
        await details.waitFor({ state: 'detached' })
        await expect.poll(() => existsSync(join(root, 'model-2.ready')), { timeout: 30_000 }).toBe(true)
        await expect.poll(async () => (await savedTask(page, TITLE)).status).toBe('in_progress')
        expect(await page.locator('[data-question-key]').count()).toBe(0)
        await writeFile(join(root, 'model-2.release'), '')
        await expect.poll(async () => (await savedTask(page, TITLE)).executions.map(run => run.status),
          { timeout: 30_000 }).toEqual(['succeeded'])
        await settledLog(page, home, { ...owner, turn: 2 })
        history = (await savedTask(page, TITLE)).executions
        expect(history[0]!.connection).toEqual(saved.connection)
      }
    }

    const final = await savedTask(page, TITLE)
    expect(final.status).toBe('done')
    expect(final.executions).toEqual(history)
    expect((await taskboardRpc<TaskboardListValue>(page, 'taskboard/list')).tasks).toEqual([final])
    expect(final.connection).toEqual(saved.connection)
    expect(requests.filter(request => request.method === 'session/prompt')).toHaveLength(2)
    expect(requests.filter(request => request.method === 'taskboard/run')).toHaveLength(1)
    expect(pageErrors).toEqual([])
    expect(await captureWorkspaceSnapshot(workspace)).toEqual(initialWorkspace)
    await stop()
    const content = await sessionLog(home, linkedId!)
    expect(fixtureUserPrompts(content)).toEqual([prompt, prompt, prompt])
    const events = parseSessionLog(content)
    expect(events.filter(event => event.type === 'tool/call')).toEqual([])
    expect(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.content))
      .toEqual([assistants[0]!.data.message.content, assistants[0]!.data.message.content, assistants[0]!.data.message.content])
    const ended = events.filter(event => event.type === 'turn/end')
    expect(ended.map(event => [event.data.turn, event.data.reason.kind])).toEqual([
      [1, 'completed'], [2, 'completed'], [3, 'completed'],
    ])
    expect(owners.map(owner => owner.requestIds[0])).toEqual(events.filter(event => event.type === 'user/message')
      .flatMap((event) => {
        const source = event.data.source
        return source.kind === 'user' && 'rpcId' in source && !source.rpcId.startsWith('taskboard:') ? [source.rpcId] : []
      }))
    expect(await readFile(fixture, 'utf8')).toBe(fixtureContent)
    await compareOrRefreshGolden(EXPECTED, goldens.join('\n\n'), MODE)
  })
})
