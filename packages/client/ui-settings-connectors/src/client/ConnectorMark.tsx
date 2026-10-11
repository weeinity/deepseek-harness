/** Decorative connector identities; transport and enablement never select a mark. */
import {
  BirdIcon, BrainIcon, BriefcaseIcon, MagnifyingGlassIcon, PlugIcon,
} from '@phosphor-icons/react/ssr'
import logos from './connector-logos.ts'
import css from './ConnectorMark.module.css'

const MARKS = new Map<string, string | { glyph: typeof BirdIcon; size: 18 | 19 }>([
  ...Object.entries(logos),
  ['workiq', { glyph: BriefcaseIcon, size: 18 }],
  ['reference_memory', { glyph: BrainIcon, size: 18 }],
  ['exa', { glyph: MagnifyingGlassIcon, size: 18 }],
  ['bluebird', { glyph: BirdIcon, size: 19 }],
])

/**
 * Render bundled logo artwork, a filled glyph, name initials, or an unnamed connector's plug.
 * @param name - Displayed server name; lookup ignores surrounding whitespace and case.
 * @param logoSrc - Optional application-owned logo asset, never server-supplied metadata.
 * @returns A decorative 34px tile; the adjacent row supplies its accessible name.
 */
export function ConnectorMark({ name, logoSrc }: { name?: string; logoSrc?: string }) {
  const normalized = name?.trim().toLowerCase() ?? ''
  const mark = MARKS.get(normalized)
  const image = logoSrc ?? (typeof mark === 'string' ? mark : undefined)
  const glyph = typeof mark === 'object' ? mark : undefined
  const identity = logoSrc !== undefined ? 'logo' : mark !== undefined ? normalized : normalized ? 'monogram' : 'unnamed'
  const Glyph = glyph?.glyph ?? PlugIcon
  return <span className={css.tile} data-connector-mark={identity} aria-hidden="true">
    {image !== undefined
      ? <img className={css.logo} src={image} alt="" width={34} height={34} />
      : glyph !== undefined || normalized === ''
        ? <Glyph size={glyph?.size ?? 18} weight="fill" aria-hidden="true" focusable="false" />
        : Array.from(normalized.toUpperCase()).slice(0, 2).join('')}
  </span>
}
