/** Profile-owned MCP flag writes, serialized with live patch reconciliation. */
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dump, load } from 'js-yaml'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Branded } from '@deepseek-ai/dsh-brand'

const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/** Revision of the authored layers and mounted composition in this process. */
export type ProfileConnectorRevision = Branded<'ConnectorRevision'>

/** Stable Loader-tree identity; never a composition-local id. */
export type ProfileConnectorId = Branded<'PluginEntryId'>

/** Why a configured MCP entry cannot be edited by this profile. */
export type ProfileConnectorBlockedReason = 'unsupported-context' | 'unsupported-target' | 'higher-precedence'

/** Local observation consumed by the redacting Host controller. */
export interface ProfileConnectorSnapshot {
  readonly revision: ProfileConnectorRevision
  readonly live: boolean
  readonly entries: readonly {
    readonly entry: Entry
    readonly blockedReason?: ProfileConnectorBlockedReason
  }[]
}

/** Disk and reconciliation outcomes are independent. */
export type ProfileConnectorWrite =
  | { readonly kind: 'conflict' | 'rejected' | 'persist-failed' }
  | { readonly kind: 'written'; readonly applied: boolean; readonly snapshot: ProfileConnectorSnapshot }

/** Authored inputs fixed by the profile launcher, never supplied by Remote callers. */
export interface ProfileConnectorOptions {
  readonly configPath: string
  readonly profilePatchPath: string
  readonly homePatchPath: string
  readonly bundlePatches: readonly PatchOptions[]
  readonly overlays: readonly PatchOptions[]
  readonly live: boolean
  /** Parse and anchor a user layer with the launcher's ordinary patch parser. */
  readonly readPatches: (filename: string) => PatchOptions[]
}

interface Generation {
  readonly text: string | undefined
  readonly patches: PatchOptions[]
  readonly base: EntryOptions[]
  readonly below: PatchOptions[]
  readonly above: PatchOptions[]
  readonly before: EntryOptions[]
  readonly entries: EntryOptions[]
  readonly revision: ProfileConnectorRevision
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Boot-owned MCP control; absent outside a supported profile launch. */
    profileConnectors?: ProfileConnectorControl
  }
}

function readOptional(filename: string): string | undefined {
  try {
    return readFileSync(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

function entryList(text: string): EntryOptions[] {
  const data: unknown = load(text, { schema: entryListSchema })
  if (!Array.isArray(data)) throw new Error('Profile configuration must be an entry list')
  return data as EntryOptions[]
}

/**
 * Edit one boolean scalar or append a guarded override without rendering other YAML nodes.
 * @param text - Authored patch document, or undefined for a missing file.
 * @param id - Validated composition-local MCP identity.
 * @param disabled - Disabled flag to persist.
 * @returns Patch YAML retaining every untouched source span.
 * @throws when the input cannot be edited as a YAML sequence.
 */
export function patchProfileConnectorFlag(text: string | undefined, id: string, disabled: boolean): string {
  const row = { id, name: MCP_MODULE, disabled }
  const block = dump([row], { noRefs: true })
  if (text === undefined) return block
  const document = parseDocument(text)
  const sequence = document.contents
  if (document.errors.length || !isSeq(sequence)) {
    throw new Error('Profile patches must be a YAML sequence')
  }
  for (const item of [...sequence.items].reverse()) {
    if (!isMap(item) || item.has('insert')) continue
    const identifier: unknown = item.get('id', true)
    if (!isScalar(identifier) || identifier.value !== id) continue
    const name: unknown = item.get('name', true)
    if (name !== undefined && (!isScalar(name) || name.value !== MCP_MODULE)) continue
    const scalar: unknown = item.get('disabled', true)
    if (!item.anchor && isScalar(scalar) && typeof scalar.value === 'boolean'
      && !scalar.anchor && !scalar.tag && scalar.range != null) {
      return text.slice(0, scalar.range[0]) + String(disabled) + text.slice(scalar.range[1])
    }
    break
  }
  if (sequence.flow) {
    const end = sequence.range[1] - 1
    return text.slice(0, end) + (sequence.items.length ? ', ' : '') + JSON.stringify(row) + text.slice(end)
  }
  const end = sequence.range[1]
  const prefix = end > 0 && text[end - 1] !== '\n' ? '\n' : ''
  return text.slice(0, end) + prefix + block + text.slice(end)
}

/**
 * Local capability for one launched profile. Watchers and writes use the same queue.
 * Only explicit, unique top-level MCP rows are mutable; other global rows remain readable.
 */
export class ProfileConnectorControl {
  private operations: Promise<void> = Promise.resolve()
  private closed = false
  private readonly key = randomBytes(32)

  /**
   * @param ctx - Root profile context owning the capability lifetime.
   * @param tree - Exact Include tree mounted by boot.
   * @param options - Authored profile layers and live-reload policy.
   * @param apply - Awaited root Include reconciliation, shared with the file watchers.
   */
  constructor(
    ctx: Context,
    private readonly tree: EntryTree,
    private readonly options: ProfileConnectorOptions,
    private readonly apply: (patches: PatchOptions[]) => Promise<void>,
  ) {
    ctx.effect(() => () => {
      this.closed = true
      return this.operations
    })
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private isClosed(): boolean {
    return this.closed
  }

  private generation(): Generation {
    const config = readFileSync(this.options.configPath, 'utf8')
    const text = readOptional(this.options.profilePatchPath)
    const home = readOptional(this.options.homePatchPath)
    const user = this.options.readPatches(this.options.profilePatchPath)
    const above = [...this.options.readPatches(this.options.homePatchPath), ...this.options.overlays]
    const below = [...this.options.bundlePatches, ...user]
    const patches = structuredClone([...below, ...above])
    const base = entryList(config)
    const before = applyEntryPatches(base, structuredClone(below), () => {})
    const entries = applyEntryPatches(base, structuredClone(patches), () => {})
    const revision = createHmac('sha256', this.key).update(JSON.stringify([
      config, text ?? null, home ?? null, this.options.bundlePatches, this.options.overlays,
      this.tree.root.data,
    ])).digest('hex') as ProfileConnectorRevision
    return { text, patches, base, below, above, before, entries, revision }
  }

  private blocked(entry: Entry, generation: Generation): ProfileConnectorBlockedReason | undefined {
    if (!this.options.live || this.closed) return 'unsupported-context'
    const id = entry.options.id
    if (entry.parent !== this.tree.root || id.includes(':') || !id) return 'unsupported-target'
    const before = generation.before.filter(row => row.id === id)
    const after = generation.entries.filter(row => row.id === id)
    if (before.length !== 1 || after.length !== 1
      || before[0]?.name !== MCP_MODULE || after[0]?.name !== MCP_MODULE
      || before[0].group || after[0].group) return 'unsupported-target'
    const countIds = (rows: readonly EntryOptions[]): number => rows.reduce((count, row) =>
      count + Number(row.id === id)
      + (row.group && Array.isArray(row.config) ? countIds(row.config as EntryOptions[]) : 0), 0)
    if (countIds(generation.entries) !== 1) return 'unsupported-target'
    // Even an equal higher layer's disabled value shadows the next user write.
    const probe = structuredClone([...generation.below,
      { id, name: MCP_MODULE, disabled: !Boolean(after[0].disabled) },
      ...generation.above])
    const changedEntries = applyEntryPatches(generation.base, probe, () => {})
    const changed = changedEntries.find(row => row.id === id)
    if (changed?.disabled !== !Boolean(after[0].disabled)) return 'higher-precedence'
    const expected = generation.entries.map(row => row.id === id ? { ...row, disabled: changed.disabled } : row)
    if (!isDeepStrictEqual(changedEntries, expected)) return 'unsupported-target'
    // A saved flag stays editable when failed application retained its previous value.
    if (!isDeepStrictEqual({ ...after[0], disabled: undefined }, { ...entry.options, disabled: undefined })) {
      return 'unsupported-target'
    }
    return undefined
  }

  private snapshot(generation: Generation, unavailable = false): ProfileConnectorSnapshot {
    const entries = [...this.tree.entries()]
      .filter(entry => entry.options.name === MCP_MODULE && !entry.options.group)
      .map((entry) => {
        const blockedReason = unavailable ? 'unsupported-context' as const : this.blocked(entry, generation)
        return { entry, ...blockedReason === undefined ? {} : { blockedReason } }
      })
    return { revision: generation.revision, live: this.options.live && !this.closed && !unavailable, entries }
  }

  /**
   * Read authored revisions and configured global MCP entries without evaluating their config.
   * @returns Local Loader observations; callers must allowlist fields before sending them remotely.
   */
  read(): Promise<ProfileConnectorSnapshot> {
    return this.enqueue(() => this.snapshot(this.generation()))
  }

  /**
   * Re-read every user layer and await the ordinary Include transaction.
   * @returns Resolves after application and teardown settle, or rejects when the transaction fails.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      await this.apply(this.generation().patches)
    })
  }

  /**
   * Persist one MCP disabled flag with revision fencing, then await reconciliation.
   * @param id - Exact full Loader identity returned by read.
   * @param enabled - Requested enablement, not a connection-health assertion.
   * @param expectedRevision - Opaque revision of the caller's read.
   * @returns A pre-write refusal or independent persistence/application facts.
   */
  setEnabled(id: ProfileConnectorId, enabled: boolean, expectedRevision: ProfileConnectorRevision): Promise<ProfileConnectorWrite> {
    return this.enqueue(async () => {
      if (this.closed || !this.options.live) return { kind: 'rejected' }
      let committed: Generation
      try {
        await mkdir(dirname(this.options.profilePatchPath), { recursive: true, mode: 0o700 })
        const result = await withFileLock(this.options.profilePatchPath, async () => {
          const generation = this.generation()
          if (generation.revision !== expectedRevision) return { kind: 'conflict' as const }
          const target = this.snapshot(generation).entries.find(row => row.entry.id === id)
          if (target === undefined || target.blockedReason !== undefined) return { kind: 'rejected' as const }
          const output = patchProfileConnectorFlag(generation.text, target.entry.options.id, !enabled)
          // Non-cooperating editor changes observed before rename are never overwritten.
          /* v8 ignore next -- Only another process can interleave these synchronous authored-layer reads. */
          if (this.generation().revision !== expectedRevision) return { kind: 'conflict' as const }
          await writeFileAtomic(this.options.profilePatchPath, output, { mode: 0o600, dirMode: 0o700 })
          return { kind: 'saved' as const, generation }
        })
        if (result.kind !== 'saved') return result
        committed = result.generation
      } catch {
        // Parser, filesystem, and lock failures can contain private configuration.
        return { kind: 'persist-failed' }
      }
      /* v8 ignore next -- Shutdown may land during the awaited filesystem commit; settled shutdown is tested before writing. */
      if (this.isClosed()) return { kind: 'written', applied: false, snapshot: this.snapshot(committed, true) }
      let applied: boolean
      try {
        committed = this.generation()
        await this.apply(structuredClone(committed.patches))
        const target = [...this.tree.entries()].find(entry => entry.id === id)
        applied = target !== undefined && !target.disabled === enabled
          && (!enabled || target.fiber?.state === FIBER_ACTIVE)
      } catch {
        applied = false
      }
      try {
        const current = this.generation()
        return {
          kind: 'written',
          applied: applied && isDeepStrictEqual(current.patches, committed.patches),
          snapshot: this.snapshot(current),
        }
      } catch {
        // An editor may leave invalid YAML while an awaited plugin teardown is in flight.
        return { kind: 'written', applied: false, snapshot: this.snapshot(committed, true) }
      }
    })
  }
}
