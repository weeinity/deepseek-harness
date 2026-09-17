/** Real profile/Loader/MCP lifecycle with only the external MCP transport replaced. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Context } from '@deepseek-ai/cordis'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import {
  boot, installProfileConnectorControl, loadOptionalPatches, watchUserPatches,
  type ProfileConnectorControl,
} from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import PluginInventoryGateway, { ConnectorsGateway } from '../src/index.ts'
import type { ConnectorSetEnabledRequest, PluginEntryId } from '../src/types.ts'

const { transports } = vi.hoisted(() => ({
  transports: new Map<string, () => Transport>(),
}))
vi.mock('@deepseek-ai/dsh-mcp-client/src/transport.ts', () => ({
  createTransport: (config: { url: string }) => {
    const factory = transports.get(config.url)
    if (factory === undefined) throw new Error('No test transport owns this endpoint')
    return factory()
  },
}))

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  transports.clear()
})

const MCP = '@deepseek-ai/dsh-mcp-client'
const MCP_ID = 'include:mcp' as PluginEntryId

interface Fixture {
  readonly ctx: Context
  readonly gateway: ConnectorsGateway
  readonly control: ProfileConnectorControl
  readonly patch: string
  readonly homePatch: string
  readonly configPath: string
  readonly bootAgain: () => Promise<Fixture>
  readonly connections: { opened: number; closed: number; closeGate?: Promise<void>; closeStarted?: () => void; fail?: boolean }
}

async function fixture(options: {
  user?: string
  home?: string
  overlays?: PatchOptions[]
  disabled?: boolean
  live?: boolean
  host?: '127.0.0.1' | '0.0.0.0'
  extra?: string
  origin?: 'base' | 'bundle' | 'profile'
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(process.cwd(), '.connector-test-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const patch = join(dir, 'cordis.patch.yml')
  const homePatch = join(dir, 'home.patch.yml')
  const configPath = join(dir, 'cordis.yml')
  if (options.user !== undefined) await writeFile(patch, options.user)
  if (options.home !== undefined) await writeFile(homePatch, options.home)
  const url = `https://fixture.invalid/${encodeURIComponent(dir)}`
  const insertion: PatchOptions = { insert: [{
    id: 'mcp', name: MCP, disabled: options.disabled ?? false,
    config: {
      serverName: 'fixture', transport: 'streamable-http', url,
      headers: { Authorization: 'secret-header' }, failOnStartupError: true, reconnect: { enabled: false },
    },
  }] }
  const bundlePatches = options.origin === 'bundle' ? [insertion] : []
  if (options.origin === 'profile') await writeFile(patch, JSON.stringify([insertion]) + '\n')
  const connections: Fixture['connections'] = { opened: 0, closed: 0 }
  transports.set(url, () => {
    connections.opened += 1
    const [client, server] = InMemoryTransport.createLinkedPair()
    if (connections.fail) client.start = async () => { throw new Error('private transport failure token=not-for-remote') }
    const mcp = new McpServer({ name: 'fixture', version: '1' })
    mcp.registerTool('ping', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
    const ready = mcp.connect(server)
    cleanup.push(async () => { await ready; await mcp.close() })
    const close = client.close.bind(client)
    let closing = false
    client.close = async () => {
      if (closing) return
      closing = true
      connections.closeStarted?.()
      await connections.closeGate
      await close()
      connections.closed += 1
    }
    return client
  })
  await writeFile(configPath, [
    '- id: prompt\n  name: cordis:prompt',
    '- id: tools\n  name: cordis:tools',
    '- id: inventory\n  name: cordis:inventory',
    `- id: web\n  name: cordis:web\n  config:\n    host: ${options.host ?? '127.0.0.1'}\n    port: 0`,
    ...options.origin === undefined || options.origin === 'base' ? [
      `- id: mcp\n  name: "${MCP}"\n  disabled: ${String(options.disabled ?? false)}`,
      '  config:',
      '    serverName: fixture',
      '    transport: streamable-http',
      `    url: ${JSON.stringify(url)}`,
      '    headers: { Authorization: "secret-header" }',
      '    failOnStartupError: true',
      '    reconnect: { enabled: false }',
    ] : [],
    options.extra ?? '',
    '',
  ].join('\n'))
  let restoreModules: (() => void) | undefined
  const bootAgain = async (): Promise<Fixture> => {
    const overlays = options.overlays ?? []
    const patches = [...bundlePatches, ...loadOptionalPatches('test', patch) ?? [], ...loadOptionalPatches('test', homePatch) ?? [], ...overlays]
    const ctx = await boot('connectors-test', configPath, structuredClone(patches), (host) => {
      cleanup.push(() => host.fiber.dispose())
      host.loader.builtins.prompt = SystemPrompt
      host.loader.builtins.tools = ToolRuntime
      host.loader.builtins.inventory = PluginInventoryGateway
      host.loader.builtins.web = WebServer
      // Keep the test runner's source-plane module instance while the real Loader owns every row.
      if (restoreModules !== undefined) return
      const modules = host.loader.internal!
      const original = modules.import.bind(modules)
      const replace = vi.spyOn(modules, 'import').mockImplementation((name: string, parent: string, attributes: ImportAttributes) =>
        name === MCP ? Promise.resolve(mcpClient) : original(name, parent, attributes))
      restoreModules = () => { replace.mockRestore() }
      cleanup.push(async () => { restoreModules?.() })
    })
    const control = installProfileConnectorControl(ctx, {
      configPath, profilePatchPath: patch, homePatchPath: homePatch,
      bundlePatches, overlays, live: options.live ?? true,
      readPatches: filename => loadOptionalPatches('test', filename) ?? [],
    })
    const gateway = ctx.get('connectors') as ConnectorsGateway
    return { ctx, gateway, control, patch, homePatch, configPath, bootAgain, connections }
  }
  return bootAgain()
}

async function request(f: Fixture, enabled: boolean, id: PluginEntryId = MCP_ID): Promise<ConnectorSetEnabledRequest> {
  return { id, enabled, expectedRevision: (await f.gateway.list()).revision }
}

describe('profile connector control', () => {
  it('redacts disabled expressions and private config; excludes non-MCP and preset-only rows', async () => {
    const f = await fixture({ extra: [
      `- id: opaque\n  name: "${MCP}"\n  disabled: true`,
      '  config: !!js (() => { throw new Error("must not evaluate disabled config") })()',
      `- id: stdio\n  name: "${MCP}"\n  disabled: true`,
      '  config:',
      '    serverName: !!js (() => { throw new Error("must not evaluate metadata") })()',
      '    transport: stdio',
      '    command: "private-command"',
      '    args: ["private-argument"]',
      '    env: { TOKEN: "private-env" }',
    ].join('\n') })
    f.ctx.provide('agentPresets', { compositionInventory: async () => [{ rows: [{ moduleName: MCP }] }] } as never)
    const snapshot = await f.gateway.list()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toContainEqual({
      id: MCP_ID, serverName: 'fixture', transport: 'streamable-http',
      enabled: true, fiberPhase: 'active', canToggle: true,
    })
    expect(snapshot.entries).toContainEqual({
      id: 'include:opaque', serverName: 'include:opaque', transport: null,
      enabled: false, fiberPhase: null, canToggle: true,
    })
    expect(snapshot.entries.find(row => row.id === 'include:stdio')).toMatchObject({
      serverName: 'include:stdio', transport: 'stdio', enabled: false,
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-header|private-|https:|must not evaluate|__jsExpr/)
  })

  it('disables, awaits transport teardown, re-enables, and retains the flag across a fresh boot', async () => {
    const user = '# user comment\n- id: prompt\n  config:\n    custom: !!js 1+1\n- id: absent\n  disabled: false\n'
    const f = await fixture({ user })
    const input = await request(f, false)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    cleanup.push(async () => { gate.resolve() })
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    f.connections.closeGate = gate.promise
    f.connections.closeStarted = started.resolve
    let settled = false
    const write = f.gateway.setEnabled(input).then((result) => { settled = true; return result })
    await started.promise
    expect(settled).toBe(false)
    expect(f.connections.closed).toBe(0)
    gate.resolve()
    const disabled = await write
    expect(disabled).toMatchObject({ persisted: true, applied: true, restartRequired: false })
    expect(f.connections.closed).toBe(1)
    expect(f.ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
    expect((await readFile(f.patch, 'utf8')).startsWith(user)).toBe(true)
    expect((await readFile(f.configPath, 'utf8'))).not.toContain('disabled: true')
    await f.ctx.fiber.dispose()
    const restarted = await f.bootAgain()
    expect((await restarted.gateway.list()).entries[0]).toMatchObject({ enabled: false })
    expect(f.connections.opened).toBe(1)
    const enabled = await restarted.gateway.setEnabled(await request(restarted, true))
    expect(enabled).toMatchObject({ persisted: true, applied: true, restartRequired: false })
    expect(f.connections.opened).toBe(2)
    expect(restarted.ctx.tools.get('mcp__fixture__ping')?.name).toBe('mcp__fixture__ping')
    expect((await readFile(f.patch, 'utf8')).startsWith(user)).toBe(true)
    await restarted.ctx.fiber.dispose()
    const enabledRestart = await f.bootAgain()
    expect((await enabledRestart.gateway.list()).entries[0]).toMatchObject({ enabled: true })
    expect(f.connections.opened).toBe(3)
  })

  it.each(['bundle', 'profile'] as const)('persists the local identity of an MCP row inserted by %s', async (origin) => {
    const f = await fixture({ origin })
    const originalRoot = await readFile(f.configPath, 'utf8')
    const receipt = await f.gateway.setEnabled(await request(f, false))
    expect(receipt).toMatchObject({ persisted: true, applied: true, restartRequired: false })
    expect(loadOptionalPatches('test', f.patch)?.at(-1)).toEqual({ id: 'mcp', name: MCP, disabled: true })
    expect(await readFile(f.configPath, 'utf8')).toBe(originalRoot)
    await f.ctx.fiber.dispose()
    const next = await f.bootAgain()
    expect((await next.gateway.list()).entries[0]).toMatchObject({ id: MCP_ID, enabled: false })
  })

  it.each(['mcp', 'include:tools', 'include:missing', 'include:mcp:extra'])('rejects wrong or non-MCP identity %s', async (id) => {
    const f = await fixture()
    await expect(f.gateway.setEnabled(await request(f, false, id as PluginEntryId)))
      .rejects.toMatchObject({ code: 'connectors/rejected' })
    await expect(readFile(f.patch)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fences concurrent callers and manual edits before their watcher runs', async () => {
    const f = await fixture()
    const input = await request(f, false)
    const writes = await Promise.allSettled([f.gateway.setEnabled(input), f.gateway.setEnabled(input)])
    expect(writes.map(row => row.status)).toEqual(['fulfilled', 'rejected'])
    expect(writes[1]).toMatchObject({ reason: { code: 'connectors/conflict' } })
    const stale = await request(f, true)
    const edited = `${await readFile(f.patch, 'utf8')}# external edit\n`
    await writeFile(f.patch, edited)
    await expect(f.gateway.setEnabled(stale)).rejects.toMatchObject({ code: 'connectors/conflict' })
    expect(await readFile(f.patch, 'utf8')).toBe(edited)
    await f.control.refresh()
    expect((await f.gateway.list()).entries[0]?.enabled).toBe(false)
  })

  it('serializes a real self-write watcher callback behind the awaited disable', async () => {
    const f = await fixture()
    await f.ctx.plugin(Timer)
    await f.ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0, usePolling: true })
    const callback: PromiseWithResolvers<void> = Promise.withResolvers()
    const watching = await watchUserPatches(f.ctx, {
      binName: 'test',
      filename: f.patch,
      refresh: () => {
        callback.resolve()
        return f.control.refresh()
      },
    })
    cleanup.push(watching)
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    cleanup.push(async () => { gate.resolve() })
    f.connections.closeGate = gate.promise
    f.connections.closeStarted = started.resolve
    let settled = false
    const write = f.gateway.setEnabled(await request(f, false)).then((value) => { settled = true; return value })
    await started.promise
    await callback.promise
    expect(settled).toBe(false)
    gate.resolve()
    expect(await write).toMatchObject({ applied: true })
    await f.control.read()
    expect(f.connections.closed).toBe(1)
    expect(f.ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
  })

  it('keeps a committed receipt redacted if an editor writes invalid YAML during teardown', async () => {
    const f = await fixture()
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const started: PromiseWithResolvers<void> = Promise.withResolvers()
    cleanup.push(async () => { gate.resolve() })
    f.connections.closeGate = gate.promise
    f.connections.closeStarted = started.resolve
    const write = f.gateway.setEnabled(await request(f, false))
    await started.promise
    const manualEdit = 'private-secret: [invalid\n'
    await writeFile(f.patch, manualEdit)
    gate.resolve()
    const receipt = await write
    expect(receipt).toMatchObject({ persisted: true, applied: false, restartRequired: true })
    expect(JSON.stringify(receipt)).not.toContain('private-secret')
    expect(await readFile(f.patch, 'utf8')).toBe(manualEdit)
    await expect(f.gateway.list()).rejects.toMatchObject({ code: 'connectors/rejected' })
  })

  it.each([
    { home: '- id: mcp\n  disabled: false\n' },
    { overlays: [{ id: 'mcp', disabled: false }] },
  ])('refuses a higher-precedence disabled override even when equal', async (options) => {
    const f = await fixture(options)
    expect((await f.gateway.list()).entries[0]).toMatchObject({ canToggle: false, blockedReason: 'higher-precedence' })
    await expect(f.gateway.setEnabled(await request(f, false))).rejects.toMatchObject({ code: 'connectors/rejected' })
  })

  it('keeps nested and generated identities read-only', async () => {
    const f = await fixture({ extra: [
      '- id: group\n  name: cordis:group\n  group: true\n  config:',
      `    - id: child\n      name: "${MCP}"\n      disabled: true`,
      `- name: "${MCP}"\n  disabled: true`,
    ].join('\n') })
    const rows = (await f.gateway.list()).entries
    expect(rows.slice(1).map(row => row.blockedReason)).toEqual(['unsupported-target', 'unsupported-target'])
    for (const row of rows.slice(1)) {
      await expect(f.gateway.setEnabled(await request(f, true, row.id))).rejects.toMatchObject({ code: 'connectors/rejected' })
    }
  })

  it('refuses a mounted target whose authored config changed before reconciliation', async () => {
    const f = await fixture()
    await writeFile(f.configPath, (await readFile(f.configPath, 'utf8')).replace('serverName: fixture', 'serverName: edited'))
    expect((await f.gateway.list()).entries[0]).toMatchObject({ canToggle: false, blockedReason: 'unsupported-target' })
    await expect(f.gateway.setEnabled(await request(f, false))).rejects.toMatchObject({ code: 'connectors/rejected' })
  })

  it('rejects an ambiguous composition id without guessing which row to patch', async () => {
    const f = await fixture()
    const duplicate = '\n- id: nested\n  name: cordis:group\n  group: true\n  config:\n'
      + `    - id: mcp\n      name: "${MCP}"\n      disabled: true\n`
    await writeFile(f.configPath, await readFile(f.configPath, 'utf8') + duplicate)
    expect((await f.gateway.list()).entries[0]).toMatchObject({ canToggle: false, blockedReason: 'unsupported-target' })
    await expect(f.gateway.setEnabled(await request(f, false))).rejects.toMatchObject({ code: 'connectors/rejected' })
  })

  it('refuses a flag whose YAML alias would also change another plugin configuration', async () => {
    const f = await fixture({ extra: [
      `- &shared\n  id: linked\n  name: "${MCP}"\n  disabled: true`,
      '- id: observer\n  name: cordis:unused\n  disabled: true\n  config: *shared',
    ].join('\n') })
    const id = 'include:linked' as PluginEntryId
    expect((await f.gateway.list()).entries.find(row => row.id === id)).toMatchObject({
      canToggle: false, blockedReason: 'unsupported-target',
    })
    await expect(f.gateway.setEnabled(await request(f, true, id))).rejects.toMatchObject({ code: 'connectors/rejected' })
  })

  it('rejects a malformed authored root without disclosing its contents', async () => {
    const f = await fixture()
    await writeFile(f.configPath, 'private-root: true\n')
    await expect(f.gateway.list()).rejects.toMatchObject({
      code: 'connectors/rejected', message: 'Connector configuration cannot be read',
    })
  })

  it('refuses queued writes and watcher refreshes after the root is disposed', async () => {
    const f = await fixture()
    const input = await request(f, false)
    await f.ctx.fiber.dispose()
    expect(await f.control.setEnabled(input.id, input.enabled, input.expectedRevision)).toEqual({ kind: 'rejected' })
    await f.control.refresh()
    expect((await f.control.read()).live).toBe(false)
    await expect(readFile(f.patch)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([{ live: false }, { host: '0.0.0.0' as const }])('refuses unsupported launch policy before writing', async (options) => {
    const f = await fixture(options)
    expect((await f.gateway.list()).capability).toBe('read-only')
    await expect(f.gateway.setEnabled(await request(f, false))).rejects.toMatchObject({
      code: options.live === false ? 'connectors/rejected' : 'connectors/local-only',
    })
    await expect(readFile(f.patch)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies persistence failure without changing running tools', async () => {
    const f = await fixture()
    const input = await request(f, false)
    await mkdir(f.patch)
    await expect(f.gateway.setEnabled(input)).rejects.toMatchObject({ code: 'connectors/persist-failed' })
    expect(f.ctx.tools.get('mcp__fixture__ping')?.name).toBe('mcp__fixture__ping')
    expect(f.connections.closed).toBe(0)
  })

  it('reports persisted but not applied when the real MCP startup fails', async () => {
    const f = await fixture({ disabled: true })
    f.connections.fail = true
    const receipt = await f.gateway.setEnabled(await request(f, true))
    expect(receipt).toMatchObject({ persisted: true, applied: false, restartRequired: true })
    expect(JSON.stringify(receipt)).not.toContain('token=')
    expect(await readFile(f.patch, 'utf8')).toContain('disabled: false')
    expect(f.ctx.tools.get('mcp__fixture__ping')).toBeUndefined()
    expect(await f.gateway.setEnabled(await request(f, false))).toMatchObject({
      persisted: true, applied: true, restartRequired: false,
    })
    f.connections.fail = false
    expect(await f.gateway.setEnabled(await request(f, true))).toMatchObject({ applied: true })
    expect((await f.gateway.list()).entries[0]).toMatchObject({ enabled: true, fiberPhase: 'active' })
  })

  it.each(['[]\n', '[{ id: mcp, disabled: false }]\n'])('updates flow-style patches while preserving their other text', async (user) => {
    const f = await fixture({ user: `# retained\n${user}` })
    expect(await f.gateway.setEnabled(await request(f, false))).toMatchObject({ applied: true })
    expect(await readFile(f.patch, 'utf8')).toMatch(/^# retained\n/)
    expect(loadOptionalPatches('test', f.patch)?.at(-1)?.disabled).toBe(true)
  })
})
