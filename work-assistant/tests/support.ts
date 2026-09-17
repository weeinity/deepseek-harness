/** Real DSH services over an isolated SQLite file; no model or external account is used. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as Sqlite from '@deepseek-ai/dsh-storage-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import { afterEach } from 'vitest'
import Gateway from '../packages/wa-gateway/src/index.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

/** Allocate a private test directory and register cleanup immediately. */
export async function temporaryDirectory(): Promise<string> {
  const root = join(process.cwd(), '.test-tmp')
  await mkdir(root, { recursive: true })
  const path = await mkdtemp(join(root, 'work-assistant-'))
  directories.push(path)
  return path
}

/** Create a Cordis context whose fiber is disposed before test directories are removed. */
export function trackedContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** Open real DSH tools, approval, credential, and SQLite-backed audit services. */
export async function runtime(databasePath?: string) {
  const ctx = trackedContext()
  const directory = await temporaryDirectory()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { mode: 'native' })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(Credentials, { path: join(directory, 'credentials.yaml'), watch: false })
  await ctx.plugin(Storage)
  await ctx.plugin(Sqlite, { path: databasePath ?? join(directory, 'workassist.db'), journalMode: 'wal' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite', routes: {} })
  const gatewayFiber = ctx.plugin(Gateway, { ownerId: 'test-owner' })
  await gatewayFiber

  const session = Session.create(SessionId(randomUUID()))
  session.append('turn/start', { turn: 1 })
  // These registry paths use identity and the real Session, not an agent loop.
  const agent = { id: session.id, session } as Agent
  const run = (name: string, args: unknown = {}, signal = new AbortController().signal) => ctx.tools.execute({
    name, arguments: args, callId: ToolCallId(randomUUID()), agent, signal,
  })
  return { ctx, agent, session, run, gatewayFiber, directory }
}
