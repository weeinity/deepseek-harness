/** Client-only connector metadata and typed inputs; no MCP processes are started. */
import type { ConnectorEntry, ConnectorSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ConnectorsSectionInjected, ConnectorsSectionProps } from '../src/client/contract.ts'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

/** Fixed opaque identities used only by the in-memory Remote doubles. */
export const revision = (value: string): ConnectorSnapshot['revision'] => value as ConnectorSnapshot['revision']

/** Build one synthetic global MCP entry. */
export function entry(name: string, enabled: boolean, patch: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    id: `root/mcp-${name.toLowerCase()}` as ConnectorEntry['id'],
    serverName: name,
    transport: 'stdio',
    enabled,
    fiberPhase: enabled ? 'active' : null,
    canToggle: true,
    ...patch,
  }
}

/** Configured order interleaves enabled and disabled connectors. */
export const SNAPSHOT: ConnectorSnapshot = {
  revision: revision('revision-1'),
  capability: 'live',
  entries: [
    entry('WorkIQ', true),
    entry('Obsidian', false, { transport: 'streamable-http' }),
    entry('ECS', true, { fiberPhase: 'failed' }),
  ],
}

/** Supply only test-owned operations; unrelated framework hooks fail if read. */
export function props(operations: ConnectorsSectionInjected): ConnectorsSectionProps {
  const unused = (): never => { throw new Error('Connectors does not read session or workspace hooks') }
  return {
    ...operations,
    t: makeTranslate(en),
    close: unused,
    useSessions: unused,
    useWorkspaces: unused,
    useSessionPendingInteraction: unused,
    useResource: unused,
  }
}

/** A test-owned completion barrier with no timers or process-global mutation. */
export function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
