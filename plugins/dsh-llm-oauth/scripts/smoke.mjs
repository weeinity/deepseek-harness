import { resolveConfig, enabledProviderIds, OAuthController, DEFAULT_PROVIDERS, resolveOAuthProviders } from '../lib/index.js'
import { readFile } from 'node:fs/promises'

let failed = 0
const check = (n, c) => { if (!c) { console.error('FAIL', n); failed++ } else console.log('ok', n) }
check('catalog ok', resolveOAuthProviders(DEFAULT_PROVIDERS).length === DEFAULT_PROVIDERS.length)
check('dormant', enabledProviderIds(resolveConfig()).length === 0)
const enabled = new Set()
const ctl = new OAuthController({
  authPath: () => '/tmp/x', catalogIds: () => ['xai'], routeIds: () => ['xai'],
  displayName: () => 'xAI',
  checkAuth: async () => undefined, logout: async () => undefined, login: async () => ({ type: 'oauth' }),
}, {
  listEnabled: () => [...enabled],
  enable: async (id) => { enabled.add(id) },
  disable: async (id) => { enabled.delete(id) },
})
const snap = await ctl.status()
check('status shape', snap.providers[0].id === 'xai' && snap.providers[0].enabled === false)
const host = await readFile('lib/index.js', 'utf8')
check('webServer inject', host.includes('ctx.inject(["webServer"]'))
check('prefix route', host.includes('kind: "prefix"') && host.includes('/dsh-llm-oauth'))
const client = await readFile('lib/client.js', 'utf8')
check('client intact', client.includes('__ModuleLoader__'))
console.log(failed === 0 ? 'ALL PASSED' : 'FAILED ' + failed)
process.exit(failed ? 1 : 0)
