/** Exact Personal Work identity; positional row IDs and retrieval clocks never enter saved decisions. */
import { createHash } from 'node:crypto'
import type { AttentionKey, AttentionTarget } from '../shared/attention.ts'
import type { DashboardItem } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'

function normalized(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** Hash an ordered tuple of JSON data, preserving field and value distinctions.
 * @param values Explicitly ordered identity or receipt fields.
 * @returns SHA-256 hexadecimal digest.
 */
export function attentionHash(values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

/** Identify one row by source kind, canonical safe URL, and case-sensitive normalized title.
 * URLs retain their paths, queries, and fragments; shared entity links do not imply shared items.
 * Content fingerprints include title, detail, and severity, but exclude source/fetch/as-of clocks.
 * @param item A source-owned Personal Work row.
 * @returns A durable target independent of the row's positional ID.
 */
export function attentionTarget(item: DashboardItem): AttentionTarget {
  const url = safeSourceUrl(item.url)
  if (url === undefined) throw new Error('Attention item requires a safe source URL.')
  const title = normalized(item.title)
  return {
    key: `attention:${attentionHash([item.source, url, title])}` as AttentionKey,
    title,
    url,
    fingerprint: attentionHash([title, normalized(item.detail), item.severity ?? null]),
  }
}

/** Verify persisted target identity without retaining the source row's detail.
 * @param target Target loaded from authoritative storage.
 * @returns Whether its URL/title produce its key under a supported Personal Work source kind.
 */
export function validAttentionTarget(target: AttentionTarget): boolean {
  return target.title === normalized(target.title) && safeSourceUrl(target.url) === target.url
    && ['live', 'reference'].some(source =>
      target.key === `attention:${attentionHash([source, target.url, target.title])}`)
}
