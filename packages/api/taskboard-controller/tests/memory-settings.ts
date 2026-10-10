/** Minimal settings service for Taskboard runtime tests. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** In-memory settings document indexed by plugin namespace. */
export type SettingsDocument = Record<string, Record<string, unknown>>
const volatileWrite = Symbol.for('cosmokit.volatile.write')

function mergeSection(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch }
}

/** In-memory live settings used by tests that construct the runtime directly. */
export class MemorySettings extends Service {
  doc: SettingsDocument
  persisted: Array<{ ns: string; section: Record<string, unknown> }> = []
  writableFlag: boolean
  private readonly live = new Map<string, Record<string, unknown>>()

  constructor(ctx: Context, options?: { doc?: SettingsDocument; writable?: boolean }) {
    super(ctx, 'settings')
    this.doc = structuredClone(options?.doc ?? {})
    this.writableFlag = options?.writable ?? true
  }

  configure(): () => void {
    return () => {}
  }

  /** Attach the volatile references resolved for one mounted fixture entry. */
  bind(ns: string, config: Record<string, unknown>): void {
    this.live.set(ns, config)
  }

  async update(ns: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.writableFlag) throw new Error('Settings are read-only')
    const section = mergeSection(this.doc[ns], patch)
    this.doc[ns] = structuredClone(section)
    this.writeLive(ns, section)
    this.persisted.push({ ns, section: structuredClone(section) })
  }

  /** Replace the backing document and publish a live-config notification. */
  pushExternal(doc: SettingsDocument): void {
    this.doc = structuredClone(doc)
    for (const [ns, section] of Object.entries(this.doc)) this.writeLive(ns, section)
    this.ctx.emit('loader/volatile-update', [])
  }

  private writeLive(ns: string, section: Record<string, unknown>): void {
    const config = this.live.get(ns)
    if (config === undefined) return
    for (const [key, value] of Object.entries(section)) {
      const ref = config[key] as Record<PropertyKey, unknown> | undefined
      const write = ref?.[volatileWrite]
      if (typeof write === 'function') Reflect.apply(write, ref, [value])
    }
  }
}

/** Return the mounted test settings service or fail when the fixture is incomplete. */
export function memorySettingsOf(ctx: Context): MemorySettings {
  const settings = ctx.get('settings')
  if (!(settings instanceof MemorySettings)) throw new Error('MemorySettings is not mounted')
  return settings
}
