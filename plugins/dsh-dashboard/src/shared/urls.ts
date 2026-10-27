/** Source links must not execute code or disclose credentials embedded in a URL. */
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    // Malformed source links are not usable navigation targets.
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'mailto:') {
    return /^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(url.pathname) && !url.search ? url.href : undefined
  }
  if (url.protocol !== 'https:') return undefined
  const credentialKeys = new Set(['token', 'access_token', 'id_token', 'sig', 'authkey', 'code'])
  if ([...url.searchParams.keys()].some(key => credentialKeys.has(key.toLowerCase()))) return undefined
  const host = url.hostname.toLowerCase()
  const allowed = ['outlook.office.com', 'outlook.office365.com', 'teams.microsoft.com', 'teams.cloud.microsoft', 'dev.azure.com', 'onedrive.live.com']
  if (allowed.includes(host) || host.endsWith('.sharepoint.com') || host.endsWith('.sharepoint-df.com') || host.endsWith('.visualstudio.com')) return url.href
  return undefined
}
