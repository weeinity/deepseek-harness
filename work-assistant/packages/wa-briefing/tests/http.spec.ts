/** The Inbox route runs over the real ephemeral-port Web server and durable scheduler. */
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from '@deepseek-ai/cordis'
import type { Config as WebConfig } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it } from 'vitest'
import { BRIEFING_PATH } from '../src/http.ts'
import { mountRealBriefing, ToolCallingAdapter } from './harness.ts'

async function server() {
  const h = await mountRealBriefing(new ToolCallingAdapter())
  const require = createRequire(resolve('packages', 'wa-briefing', 'package.json'))
  const { default: WebServer } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-host-webserver')).href) as { default: Plugin.Object<WebConfig> }
  await h.ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const origin = 'http://127.0.0.1:' + h.ctx.webServer.port
  const request = (method = 'GET', body?: string, overrides: Record<string, string> = {}) => fetch(origin + BRIEFING_PATH, {
    method,
    headers: { 'x-dsh-assistant': '1', origin, 'content-type': 'application/json', ...overrides },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(10_000),
  })
  return { ...h, origin, request }
}

describe('briefing same-origin HTTP', () => {
  it('reads, pauses, resumes, marks read, and dismisses without triggering work', async () => {
    const h = await server()
    const get = await h.request()
    expect(get.status).toBe(200)
    expect(get.headers.get('cache-control')).toBe('no-store')
    expect(get.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await get.json()).toMatchObject({ version: 1, enabled: true, items: [] })
    const pause = await h.request('POST', JSON.stringify({ action: 'pause' }))
    expect(await pause.json()).toMatchObject({ paused: true, items: [] })
    const resume = await h.request('POST', JSON.stringify({ action: 'resume' }))
    expect(await resume.json()).toMatchObject({ paused: false, items: [] })
    expect(h.ctx.agents.list()).toEqual([])
    await h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))
    const [item] = h.ctx.workAssistBriefing.snapshot().items
    const read = await h.request('POST', JSON.stringify({ action: 'read', id: item!.id }))
    expect((await read.json()).items).toEqual([{ ...item, read: true }])
    const dismiss = await h.request('POST', JSON.stringify({ action: 'dismiss', id: item!.id }))
    expect((await dismiss.json()).items).toEqual([])
    await h.schedulerFiber.dispose()
    expect((await h.request()).status).toBe(404)
  })

  it.each([
    { 'x-dsh-assistant': '0' },
    { origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects untrusted browser context %j', async headers => {
    const h = await server()
    const response = await h.request('POST', '{"action":"pause"}', headers)
    expect(response.status).toBe(403)
    expect(h.ctx.workAssistBriefing.snapshot().paused).toBe(false)
  })

  it('rejects a raw mismatched Host header without trusting the request URL', async () => {
    const h = await server()
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(h.origin + BRIEFING_PATH, { headers: { Host: 'attacker.example', 'x-dsh-assistant': '1' } }, response => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      })
      request.on('error', reject)
      request.end()
    })
    expect(status).toBe(403)
  })

  it('allows non-browser reads with the custom header but requires Origin on writes', async () => {
    const h = await server()
    const read = await fetch(h.origin + BRIEFING_PATH, { headers: { 'x-dsh-assistant': '1' } })
    expect(read.status).toBe(200)
    const write = await fetch(h.origin + BRIEFING_PATH, { method: 'POST', headers: { 'x-dsh-assistant': '1', 'content-type': 'application/json' }, body: '{"action":"pause"}' })
    expect(write.status).toBe(403)
  })

  it('rejects unsupported methods and media types', async () => {
    const h = await server()
    expect((await h.request('DELETE')).status).toBe(405)
    expect((await h.request('POST', '{}', { 'content-type': 'text/plain' })).status).toBe(415)
  })

  it.each(['{', '{}', '{"action":"trigger"}', '{"action":"pause","extra":true}', '{"action":"read","id":""}', ' '.repeat(1025)])('rejects malformed, unsupported, or oversized actions', async body => {
    const h = await server()
    const response = await h.request('POST', body)
    expect(response.status).toBe(400)
    expect(h.ctx.workAssistBriefing.snapshot()).toMatchObject({ paused: false, items: [] })
  })

  it('reports missing retained items without leaking internal details', async () => {
    const h = await server()
    const response = await h.request('POST', '{"action":"read","id":"missing"}')
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Briefing action failed; refresh before retrying' })
  })
})
