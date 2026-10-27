import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as stocks from '../src/host/index.ts'

/** Fake carrier retains the real registration types; authentication is Connection-owned. */
class TestConnection extends Service {
  routes = new Map<string, ConnectionFetchRoute>()
  fetch = {
    register: (route: ConnectionFetchRoute) => {
      assert.equal(this.routes.has(route.path), false)
      this.routes.set(route.path, route)
      return async () => {
        this.routes.delete(route.path)
      }
    },
  }
  constructor(ctx: Context) {
    super(ctx, 'connection')
  }
}
/** Deterministic scheduler implements the verified callback/disposer overload. */
class TestTimer extends Service {
  callbacks = new Set<() => void>()
  delays: number[] = []
  constructor(ctx: Context) {
    super(ctx, 'timer')
    ctx.mixin('timer', ['interval'])
  }
  interval(callback: () => void, delay: number) {
    this.delays.push(delay)
    this.callbacks.add(callback)
    return () => {
      this.callbacks.delete(callback)
    }
  }
}

test('actual Cordis fiber registers exact POST routes and unload removes routes and timer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stocks-lifecycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const statePath = join(directory, 'state.json')
  await writeFile(statePath, JSON.stringify({ version: 1, revision: 0, watchlist: [], alerts: [] }))
  const ctx = new Context()
  let connection!: TestConnection, timer!: TestTimer
  const services = ctx.plugin((context) => {
    connection = new TestConnection(context)
    timer = new TestTimer(context)
  })
  t.after(() => services.dispose())
  await services.await()
  const fiber = ctx.plugin(stocks, { statePath, alertCheckSeconds: 300 })
  t.after(() => fiber.dispose())
  await fiber.await()
  assert.equal(connection.routes.size, 10)
  assert.deepEqual(timer.delays, [300000])
  assert.equal(timer.callbacks.size, 1)
  for (const route of connection.routes.values()) {
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.match(
      route.path,
      /^\/api\/dsh-stocks\/(settings|state|watchlist|quotes|search|news|profile|alerts|sentiment|source)$/,
    )
  }
  const stateRoute = connection.routes.get('/api/dsh-stocks/state')!
  const response = await stateRoute.fetch(
    new Request('http://localhost/api/dsh-stocks/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  assert.deepEqual(await response.json(), {
    ok: true,
    value: { version: 1, revision: 0, watchlist: [], alerts: [] },
  })
  await fiber.dispose()
  assert.equal(connection.routes.size, 0)
  assert.equal(timer.callbacks.size, 0)
  const after = await stateRoute.fetch(
    new Request('http://localhost/api/dsh-stocks/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  const result = await after.json()
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'stocks/cancelled')
})
