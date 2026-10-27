import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireOwnership } from '../src/host/chat/ownership.ts'

const ownershipModule = new URL('../src/host/chat/ownership.ts', import.meta.url).href

test('kernel ownership excludes a separate process and survives neither release nor process death', async t => {
  const root = await mkdtemp(join(process.cwd(), '.host-chat-lock-test-'))
  const children: ReturnType<typeof spawn>[] = []
  const exits: Promise<unknown>[] = []
  const owners: Awaited<ReturnType<typeof acquireOwnership>>[] = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    await Promise.all(exits)
    await Promise.all(owners.map(owner => owner.dispose()))
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  })
  function probe(hold: boolean) {
    const script = `
      import { acquireOwnership } from ${JSON.stringify(ownershipModule)};
      try {
        const owner = await acquireOwnership(${JSON.stringify(root)});
        console.log('owned');
        ${hold ? 'process.stdin.resume();' : 'await owner.dispose();'}
      } catch (error) { console.log(error.code); }
    `
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'TSX_TSCONFIG_PATH']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(), env: environment, stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    const exit = once(child, 'exit')
    exits.push(exit)
    let stdout = ''
    let stderr = ''
    child.stderr!.on('data', chunk => { stderr += String(chunk) })
    const line = new Promise<string>((resolve, reject) => {
      child.stdout!.on('data', chunk => {
        stdout += String(chunk)
        if (stdout.includes('\n')) resolve(stdout.trim())
      })
      child.once('error', reject)
      child.once('exit', () => {
        if (!stdout.includes('\n')) reject(new Error(`Lock probe exited without readiness: ${stderr}`))
      })
    })
    return { child, exit, line }
  }
  const first = await acquireOwnership(root)
  owners.push(first)
  const denied = probe(false)
  assert.equal(await denied.line, 'OWNER_UNAVAILABLE')
  assert.deepEqual(await denied.exit, [0, null])
  await first.dispose()
  const held = probe(true)
  assert.equal(await held.line, 'owned')
  await assert.rejects(acquireOwnership(root), { code: 'OWNER_UNAVAILABLE' })
  held.child.kill()
  await held.exit
  const successor = await acquireOwnership(root)
  owners.push(successor)
  await successor.check()
})
