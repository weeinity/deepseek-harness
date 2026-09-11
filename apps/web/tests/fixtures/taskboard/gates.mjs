/** Private file barriers for subprocess-owned external providers; no polling or shared paths. */
import { on } from 'node:events'
import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Wait for a driver-owned marker, closing the watcher before completion.
 * @param path - Marker beneath this case's private root.
 * @param signal - Provider or fixture cancellation.
 * @returns resolution on release; cancellation rejects after the watcher closes.
 */
export async function waitForGate(path, signal) {
  signal.throwIfAborted()
  const watcher = watch(dirname(path))
  const closed = new Promise(resolve => watcher.once('close', resolve))
  const changes = on(watcher, 'change', { signal })
  try {
    while (!existsSync(path)) {
      await changes.next()
      signal.throwIfAborted()
    }
  } finally {
    await changes.return()
    watcher.close()
    await closed
  }
}
