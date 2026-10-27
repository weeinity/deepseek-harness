/** Standalone DSH stocks host: no startup provider I/O and no profile mutation. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { requestSchemas, type StockEndpoint } from '../shared/api.ts'
import { createBackend } from './service.ts'
import { stocksFetch } from './http.ts'
export { Config } from './config.ts'
export const name = 'dsh-stocks'
export const inject = ['connection', 'timer']
export async function apply(ctx: Context, config: unknown = {}): Promise<void> {
  const backend = await createBackend(config)
  ctx.effect(() => () => backend.dispose(), 'dsh-stocks: requests and storage')
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/dsh-stocks/source',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            const source = await readFile(new URL('./source.json', import.meta.url), 'utf8')
            return new Response(source, {
              headers: {
                'content-type': 'application/json',
                'content-disposition': 'attachment; filename="dsh-stocks-source.json"',
                'cache-control': 'no-store',
              },
            })
          } catch (error) {
            return new Response('Stocks source archive unavailable. Rebuild the plugin.', { status: 503 })
          }
        },
      }),
    'dsh-stocks: corresponding source archive',
  )
  for (const endpoint of Object.keys(requestSchemas) as StockEndpoint[]) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: '/api/dsh-stocks/' + endpoint,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: stocksFetch(endpoint, (operation, payload, signal) =>
            backend.handle(operation, payload, signal),
          ),
        }),
      'dsh-stocks: ' + endpoint,
    )
  }
  ctx.effect(
    () =>
      ctx.interval(() => {
        void backend.checkAlerts()
      }, backend.config.alertCheckSeconds * 1000),
    'dsh-stocks: in-app alert checks',
  )
}
