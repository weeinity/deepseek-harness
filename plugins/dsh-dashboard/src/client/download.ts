/** Browser-only snapshot downloads with object-URL cleanup deferred beyond the click task. */
import type { DashboardSnapshot } from '../shared/types.ts'

export interface DownloadEnvironment {
  createUrl(html: string): string
  startDownload(url: string, filename: string): void
  revokeUrl(url: string): void
  /** Defer cleanup beyond browser download initiation. */
  afterNavigation(callback: () => void): void
}

/** Own every generated object URL through deferred revocation and plugin teardown. */
export class SnapshotDownloads {
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  constructor(
    private readonly render: (snapshot: DashboardSnapshot) => string,
    private readonly environment: DownloadEnvironment,
  ) {}

  /** Return false when rendering or the browser download fails; no URL survives a failed start. */
  download = (snapshot: DashboardSnapshot): boolean => {
    if (this.disposed) return false
    let url: string | undefined
    try {
      url = this.environment.createUrl(this.render(snapshot))
      this.environment.startDownload(url, 'dashboard.html')
    } catch {
      if (url !== undefined) this.environment.revokeUrl(url)
      return false
    }
    const downloadUrl = url
    const completion = new Promise<void>(resolve => {
      this.environment.afterNavigation(() => {
        this.environment.revokeUrl(downloadUrl)
        resolve()
      })
    })
    this.pending.add(completion)
    void completion.then(() => { this.pending.delete(completion) })
    return true
  }

  /** Do not revoke in the click task, including when a plugin unload follows that click. */
  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([...this.pending])
  }
}
