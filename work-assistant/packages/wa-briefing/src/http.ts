/** Loopback, same-origin Inbox endpoint for the published alpha.2 Web host. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type BriefingScheduler from './index.ts'

/** Feature endpoint; neither GET nor POST starts a briefing. */
export const BRIEFING_PATH = '/api/work-assistant/briefing'
const MAX_ACTION_BYTES = 1024
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }).strict(),
  z.object({ action: z.literal('resume') }).strict(),
  z.object({ action: z.literal('read'), id: z.string().min(1).max(200).transform(SessionId) }).strict(),
  z.object({ action: z.literal('dismiss'), id: z.string().min(1).max(200).transform(SessionId) }).strict(),
])

/**
 * Register only on a Web host. Loopback Host validation blocks DNS rebinding; the
 * custom header and Origin check reject cross-origin browser reads and mutations.
 * @param ctx - Optional Web-host injection context, owning the reversible route.
 * @param briefing - Already initialized durable scheduler.
 */
export function installBriefingHttp(ctx: Context, briefing: BriefingScheduler): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: BRIEFING_PATH,
    handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (!isSameOrigin(req)) return respond(res, 403, { error: 'Same-origin loopback request required' })
      if (req.method === 'GET') return respond(res, 200, briefing.snapshot())
      if (req.method !== 'POST') return respond(res, 405, { error: 'Use GET or POST' })
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        return respond(res, 415, { error: 'JSON action required' })
      }
      let action: z.infer<typeof actionSchema>
      try {
        action = actionSchema.parse(JSON.parse(await readAction(req)))
      } catch {
        // Only body/JSON/schema errors reach this block; internal failures use 500 below.
        return respond(res, 400, { error: 'Invalid briefing action' })
      }
      try {
        if (action.action === 'pause' || action.action === 'resume') await briefing.setPaused(action.action === 'pause')
        else await briefing.updateItem(action.id, action.action)
        respond(res, 200, briefing.snapshot())
      } catch {
        // Storage and cancellation details can contain local paths; do not return them.
        respond(res, 500, { error: 'Briefing action failed; refresh before retrying' })
      }
    },
  }), 'workassist.briefing.http')
}

function isSameOrigin(req: IncomingMessage): boolean {
  if (req.headers['x-dsh-assistant'] !== '1') return false
  const host = req.headers.host
  if (host === undefined || !/^(localhost|127[.]0[.]0[.]1)(:[0-9]+)?$/u.test(host)) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'http://' + host) return false
  if (req.method === 'POST' && origin === undefined) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin'
}

async function readAction(req: IncomingMessage): Promise<string> {
  let length = 0
  const parts: Buffer[] = []
  for await (const value of req) {
    // This route never sets a text encoding; IncomingMessage yields binary chunks.
    const part = value as Buffer
    length += part.length
    if (length > MAX_ACTION_BYTES) throw new Error('Briefing action is too large')
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}
