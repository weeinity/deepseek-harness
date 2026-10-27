/** JSON framing for routes whose authentication and origin checks belong to DSH Connection. */
export type DashboardEndpoint = 'settings' | 'snapshot' | 'ado-history' | 'chat-open' | 'chat-send'
  | 'attention-read' | 'attention-write'
export type DashboardHandler = (endpoint: DashboardEndpoint, payload: unknown, signal: AbortSignal) => Promise<unknown>

/**
 * Validate media type, UTF-8 bytes and JSON before admitting source or chat work.
 * @param endpoint Fixed operation chosen at route registration, never from browser data.
 * @param handle Authenticated operation handler.
 * @returns A no-store fetch handler for the registered POST route.
 */
export function dashboardFetch(endpoint: DashboardEndpoint, handle: DashboardHandler) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    const failure = (status: number, message: string) => new Response(JSON.stringify({
      ok: false, error: { code: 'dashboard/invalid-input', message, details: {} },
    }), { status, headers })
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return failure(415, 'Dashboard requests require application/json')
    }
    const text = await request.text()
    if (Buffer.byteLength(text, 'utf8') > 32_768) return failure(413, 'Dashboard request exceeds 32 KiB')
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return failure(400, 'Dashboard request is not valid JSON')
    }
    return new Response(JSON.stringify(await handle(endpoint, payload, request.signal)), { headers })
  }
}
