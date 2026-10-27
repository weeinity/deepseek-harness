import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dashboardFetch, type DashboardEndpoint } from '../src/host/http.ts'

for (const endpoint of [
  'settings', 'snapshot', 'chat-open', 'chat-send', 'attention-read', 'attention-write',
] satisfies DashboardEndpoint[]) {
  test(`${endpoint} requires JSON and forwards only parsed requests with no-store responses`, async () => {
    const calls: { endpoint: DashboardEndpoint; payload: unknown; signal: AbortSignal }[] = []
    const handler = dashboardFetch(endpoint, async (operation, payload, signal) => {
      calls.push({ endpoint: operation, payload, signal })
      return { ok: true, value: 'synthetic' }
    })
    const makeRequest = (body: string, contentType = 'application/json; charset=utf-8') =>
      new Request('http://127.0.0.1/api/dsh-dashboard/example', {
        method: 'POST', headers: { 'content-type': contentType }, body,
      })
    assert.equal((await handler(makeRequest('{}', 'text/plain'))).status, 415)
    assert.equal((await handler(makeRequest('{'))).status, 400)
    assert.equal(calls.length, 0)
    const request = makeRequest('{"scope":"synthetic"}')
    const response = await handler(request)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(calls, [{ endpoint, payload: { scope: 'synthetic' }, signal: request.signal }])
    assert.deepEqual(await response.json(), { ok: true, value: 'synthetic' })
  })
}

test('the exact UTF-8 request byte limit admits 32768 bytes and refuses 32769 before work', async () => {
  let calls = 0
  const handler = dashboardFetch('chat-send', async () => {
    calls++
    return { ok: true }
  })
  const json = '{"question":"中文"}'
  const exact = json + ' '.repeat(32_768 - Buffer.byteLength(json, 'utf8'))
  const request = (body: string) => new Request('http://127.0.0.1/api/dsh-dashboard/chat-send', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  })
  assert.equal((await handler(request(exact))).status, 200)
  assert.equal(calls, 1)
  const rejected = await handler(request(`${exact} `))
  assert.equal(rejected.status, 413)
  assert.equal(rejected.headers.get('cache-control'), 'no-store')
  assert.equal(calls, 1)
})
