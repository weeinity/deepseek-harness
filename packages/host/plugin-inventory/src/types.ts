import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable Loader-tree identity of one configured plugin entry. */
export type PluginEntryId = Branded<'PluginEntryId'>

/** Opaque revision of the profile layers and mounted composition. */
export type ConnectorRevision = Branded<'ConnectorRevision'>

/** A configured global MCP server; fiber phase is not connection health. */
export interface ConnectorEntry {
  readonly id: PluginEntryId
  readonly serverName: string
  readonly transport: 'stdio' | 'streamable-http' | null
  /** Effective Loader enablement, not persisted intent or MCP connection health. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
  readonly canToggle: boolean
  readonly blockedReason?: 'unsupported-context' | 'unsupported-target' | 'higher-precedence' | 'local-only'
}

/** Redacted MCP inventory and this launch's editing capability. */
export interface ConnectorSnapshot {
  readonly revision: ConnectorRevision
  readonly capability: 'live' | 'read-only'
  readonly entries: readonly ConnectorEntry[]
}

/** One revision-fenced profile flag write. */
export interface ConnectorSetEnabledRequest {
  readonly id: PluginEntryId
  readonly enabled: boolean
  readonly expectedRevision: ConnectorRevision
}

/** Persistence succeeds before application is attempted; failed application does not roll back disk. */
export interface ConnectorMutationReceipt {
  /** The requested flag reached the profile patch before application was attempted. */
  readonly persisted: true
  /** The Loader applied the requested flag and completed its activation or teardown; not connection health. */
  readonly applied: boolean
  /** The saved change needs restart or configuration repair because application was not confirmed. */
  readonly restartRequired: boolean
  /**
   * Observed Loader state, which may retain the previous enabled value after failed application.
   * The caller retains its requested enabled intent separately and must not substitute it for these rows.
   */
  readonly snapshot: ConnectorSnapshot
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'connectors/conflict': Record<never, never>
    'connectors/rejected': Record<never, never>
    'connectors/persist-failed': Record<never, never>
    'connectors/local-only': Record<never, never>
  }
}

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Effective enablement of one preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row an agent preset's composition names. */
export interface AgentPresetPluginRow {
  /** Composition row id, or null when the row declares none. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /**
   * Effective enablement, including disabled ancestor groups. `'conditional'`
   * marks a `!!js` disabled expression on a composition no session has
   * mounted, which only a Loader context can decide.
   */
  readonly enabled: PresetPluginEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber phase when the composition is live; null otherwise. */
  readonly fiberPhase: PluginFiberPhase
}

/** One agent preset's identity and flattened composition in the inventory. */
export interface AgentPresetPluginGroup {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: 'system' | 'user'
  /** Display name the preset published; a reader falls back to the id. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  /** Plugin rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetPluginRow[]
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * Per-preset compositions, present only when an agent-preset roster is
   * composed in this deployment.
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}
