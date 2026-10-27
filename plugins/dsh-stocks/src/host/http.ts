/** JSON framing only; DSH Connection owns authentication, Host and Origin enforcement. */
import type { StockEndpoint, ApiReply } from '../shared/api.ts'
import { safeError } from './errors.ts'
export type StocksHandler = (
  endpoint: StockEndpoint,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ApiReply<unknown>>
export function stocksFetch(endpoint: StockEndpoint, handle: StocksHandler) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    const failure = (status: number, message: string) =>
      new Response(JSON.stringify({ ok: false, error: { code: 'stocks/invalid-input', message } }), {
        status,
        headers,
      })
    if (request.method !== 'POST') return failure(405, 'Use POST for stock operations.')
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return failure(415, 'Stock requests require application/json.')
    try {
      const text = await request.text()
      if (Buffer.byteLength(text, 'utf8') > 32768) return failure(413, 'Stock request exceeds 32 KiB.')
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch (error) {
        return failure(400, 'Stock request is not valid JSON.')
      }
      return new Response(JSON.stringify(await handle(endpoint, payload, request.signal)), { headers })
    } catch (error) {
      return new Response(JSON.stringify({ ok: false, error: safeError(error) }), { status: 500, headers })
    }
  }
}
