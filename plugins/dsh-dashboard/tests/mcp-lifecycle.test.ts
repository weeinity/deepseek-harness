import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DashboardMcp } from '../src/host/mcp.ts'

test('concurrent reads share one child and disposal reaches process exit', async () => {
  const mcp = new DashboardMcp('workiq', {
    command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
    timeoutMs: 30_000,
  })
  try {
    const signal = new AbortController().signal
    const results = await Promise.all([
      mcp.call('fetch', { entityUrls: ['/me'] }, signal),
      mcp.call('fetch', { entityUrls: ['/me'] }, signal),
    ])
    assert.deepEqual(results[0], results[1])
    const result = results[0]
    assert.ok(typeof result === 'object' && result !== null && 'pid' in result && typeof result.pid === 'number')
    const pid = result.pid
    await mcp.dispose()
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    await assert.rejects(mcp.call('fetch', { entityUrls: ['/me'] }, signal), /disposed/)
  } finally {
    await mcp.dispose()
  }
})

test('an already cancelled read never starts the executable', async () => {
  const mcp = new DashboardMcp('workiq', { command: 'dashboard-executable-must-not-start', args: [], timeoutMs: 1000 })
  const controller = new AbortController()
  controller.abort(new Error('cancelled before start'))
  try {
    await assert.rejects(mcp.call('fetch', { entityUrls: ['/me'] }, controller.signal), /cancelled before start/)
  } finally {
    await mcp.dispose()
  }
})
