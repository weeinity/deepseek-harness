/** Lazy read-only MCP connections own their subprocess through physical exit. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { ReadOnlyMcp } from '../shared/types.ts'

export type Provider = 'workiq' | 'ado'
export interface McpOptions {
  command: string
  args: string[]
  timeoutMs: number
}

const actions: Readonly<Record<string, readonly string[]>> = {
  wit_query: ['get', 'get_results', 'wiql'],
  wit_work_item: ['get', 'get_batch', 'get_type', 'list_for_iteration', 'list_revisions'],
  work: ['list_team_iterations', 'get_team_settings', 'get_team_capacity'],
}

/** Reject mutations before even starting a connector. */
export function assertReadOperation(provider: Provider, operation: string, args: Record<string, unknown>): void {
  if (provider === 'workiq') {
    if (operation !== 'fetch') throw new Error(`WorkIQ operation is not allowed: ${operation}`)
    const paths = z.array(z.string().min(1).max(8000)).min(1).max(12).parse(args['entityUrls'])
    for (const path of paths) {
      if (!/^\/me(?:\/|\?|$)/.test(path) || path.includes('#')) throw new Error('Dashboard WorkIQ reads must use a /me path')
    }
    if (Object.keys(args).some(key => key !== 'entityUrls')) throw new Error('Unexpected WorkIQ arguments')
    return
  }
  if (!actions[operation]?.includes(String(args['action']))) throw new Error(`ADO operation is not allowed: ${operation}/${String(args['action'])}`)
  if (typeof args['orgName'] !== 'string' || !args['orgName'].trim()) throw new Error('ADO reads require an explicit organization')
  if (typeof args['project'] !== 'string' || !args['project'].trim()) throw new Error('ADO reads require an explicit project')
}

/** Decode MCP JSON without treating error text or missing data as an empty result. */
export function decodeMcpResult(value: unknown): unknown {
  const result = z.object({
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough().parse(value)
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
  if (result.isError) throw new Error(`MCP provider refused the read: ${safeError(text || 'no diagnostic detail')}`)
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!text) throw new Error('MCP provider returned no structured data')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`MCP provider returned non-JSON data: ${safeError(text)}`)
  }
}

/** Keep provider diagnostics concise and remove common authentication values. */
export function safeError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|access_token|code|sig)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 600)
}

class OwnedStdio extends StdioClientTransport {
  private started = false
  private settleExit!: () => void
  private readonly exited = new Promise<void>(resolve => { this.settleExit = resolve })
  private closing: Promise<void> | undefined

  override async start(): Promise<void> {
    this.started = true
    const notify = this.onclose
    this.onclose = () => {
      this.settleExit()
      notify?.()
    }
    try {
      await super.start()
    } catch (error) {
      if (this.pid === null) this.settleExit()
      throw error
    }
  }

  override close(): Promise<void> {
    this.closing ??= (async () => {
      await super.close()
      if (this.started) await this.exited
    })()
    return this.closing
  }
}

interface Generation {
  client: Client
  transport: OwnedStdio
  tools: Map<string, string>
}

export class DashboardMcp implements ReadOnlyMcp {
  private ready: Promise<Generation> | undefined
  private current: Generation | undefined
  private disposed = false
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  constructor(private readonly provider: Provider, private readonly options: McpOptions) {}

  private connect(): Promise<Generation> {
    if (this.disposed) return Promise.reject(new Error('Dashboard connector has been disposed'))
    this.ready ??= this.open().catch(error => {
      this.ready = undefined
      throw error
    })
    return this.ready
  }

  private async open(): Promise<Generation> {
    const client = new Client({ name: `dsh-dashboard-${this.provider}`, version: '0.1.0' })
    const transport = new OwnedStdio({
      command: this.options.command,
      args: this.options.args,
      stderr: 'pipe',
      maxBufferSize: 16 * 1024 * 1024,
    })
    // SDK's safe inherited environment excludes ambient API keys and tokens.
    transport.stderr?.on('data', () => {
      // Authentication helpers may print private URLs; RPC errors carry diagnostics.
    })
    const generation: Generation = { client, transport, tools: new Map() }
    this.current = generation
    client.onclose = () => {
      if (this.current === generation) {
        this.current = undefined
        this.ready = undefined
      }
    }
    try {
      await client.connect(transport, { timeout: this.options.timeoutMs, signal: this.lifetime.signal })
      let cursor: string | undefined
      const allNames = new Set<string>()
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: this.options.timeoutMs, signal: this.lifetime.signal })
        for (const tool of page.tools) allNames.add(tool.name)
        cursor = page.nextCursor
      } while (cursor !== undefined)
      for (const operation of this.provider === 'workiq' ? ['fetch'] : Object.keys(actions)) {
        const candidates = [...allNames].filter(name => name === operation || name.endsWith(`-${operation}`) || name.endsWith(`_${operation}`))
        if (candidates.length !== 1) throw new Error(`${this.provider} does not expose one unambiguous ${operation} operation`)
        generation.tools.set(operation, candidates[0]!)
      }
      this.lifetime.signal.throwIfAborted()
      return generation
    } catch (error) {
      await transport.close()
      if (this.current === generation) this.current = undefined
      throw error
    }
  }

  call(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    assertReadOperation(this.provider, operation, args)
    const run = async (): Promise<unknown> => {
      signal.throwIfAborted()
      const generation = await this.connect()
      const combined = AbortSignal.any([signal, this.lifetime.signal])
      combined.throwIfAborted()
      const name = generation.tools.get(operation)
      if (!name) throw new Error(`Missing ${this.provider} operation: ${operation}`)
      const result = await generation.client.callTool({ name, arguments: args }, undefined, { timeout: this.options.timeoutMs, signal: combined })
      combined.throwIfAborted()
      return decodeMcpResult(result)
    }
    const pending = run()
    this.pending.add(pending)
    void pending.then(() => { this.pending.delete(pending) }, () => { this.pending.delete(pending) })
    return pending
  }

  /** Stop new requests, cancel existing work, and wait for the owned process exit. */
  dispose(): Promise<void> {
    this.closing ??= (async () => {
      this.disposed = true
      this.lifetime.abort(new Error('Dashboard connector stopped'))
      const transport = this.current?.transport
      if (transport) await transport.close()
      await Promise.allSettled([...this.pending, ...(this.ready ? [this.ready] : [])])
    })()
    return this.closing
  }
}
