/** Source form validation shares the Host schema and rejects non-ADO URLs before submission. */
import { adoSourceSchema } from '../shared/requests.ts'
import type { AdoSource } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'

export function parseSource(value: unknown): AdoSource | null {
  const result = adoSourceSchema.safeParse(value)
  if (!result.success) return null
  const source = result.data
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:/i.test(source.input)
  if (looksLikeUrl) {
    const safe = safeSourceUrl(source.input)
    if (!safe) return null
    const url = new URL(safe)
    if (url.hostname !== 'dev.azure.com' && !url.hostname.endsWith('.visualstudio.com')) return null
    return source
  }
  if (source.mode === 'query' || !source.orgName || !source.project) return null
  return { ...source, path: source.path ?? source.input }
}
