/** Atomic JSON persistence. Missing/corrupt data is never replaced or implicitly initialized. */
import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { stockStateSchema, type StockState } from '../shared/api.ts'
import { StocksError, cancelled } from './errors.ts'
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
export class StockStorage {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(run, run)
    this.tail = work.then(
      () => {},
      () => {},
    )
    return work
  }
  private async load(): Promise<StockState> {
    let text: string
    try {
      if ((await stat(this.path)).size > 1048576)
        throw new StocksError(
          'stocks/storage-corrupt',
          'Stock storage is oversized. Restore a valid backup; no changes were written.',
        )
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error instanceof StocksError) throw error
      if (hasCode(error, 'ENOENT'))
        throw new StocksError(
          'stocks/storage-missing',
          'Stock storage is missing. Explicitly initialize a new state file or restore a backup before editing.',
        )
      throw new StocksError(
        'stocks/storage-unavailable',
        'Stock storage cannot be read. Check permissions; no changes were written.',
      )
    }
    try {
      return stockStateSchema.parse(JSON.parse(text))
    } catch (error) {
      throw new StocksError(
        'stocks/storage-corrupt',
        'Stock storage is invalid. Restore a valid backup; no changes were written.',
      )
    }
  }
  read(): Promise<StockState> {
    return this.serial(() => this.load())
  }
  /** Serializes plugin writers across instances via an exclusive sidecar; never removes another owner's lock. */
  mutate(
    revision: number | undefined,
    change: (state: StockState) => boolean,
    signal: AbortSignal,
  ): Promise<StockState> {
    return this.serial(async () => {
      cancelled(signal)
      // Read before acquiring a sidecar so absent storage reports as missing, not as a lock failure.
      await this.load()
      const lockPath = this.path + '.lock'
      let lock
      try {
        lock = await open(lockPath, 'wx', 0o600)
      } catch (error) {
        throw new StocksError(
          'stocks/storage-busy',
          'Stock storage is locked or not writable. Wait for its writer; inspect a stale lock only after stopping all plugin instances.',
        )
      }
      let temporary: string | undefined
      try {
        const state = await this.load()
        if (revision !== undefined && revision !== state.revision)
          throw new StocksError(
            'stocks/conflict',
            'Stock state changed. Reload it before trying your edit again.',
          )
        if (!change(state)) return state
        state.revision++
        const next = stockStateSchema.parse(state)
        cancelled(signal)
        temporary = this.path + '.' + randomUUID() + '.tmp'
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(JSON.stringify(next) + '\n', 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
        cancelled(signal)
        await rename(temporary, this.path)
        temporary = undefined
        return next
      } catch (error) {
        if (error instanceof StocksError) throw error
        throw new StocksError(
          'stocks/storage-unavailable',
          'Stock state was not saved. Check storage permissions and reload before retrying.',
        )
      } finally {
        if (temporary) {
          try {
            await unlink(temporary)
          } catch (error) {
            if (!hasCode(error, 'ENOENT'))
              console.warn('[dsh-stocks] Could not remove an uncommitted temporary state file.')
          }
        }
        await lock.close()
        try {
          await unlink(lockPath)
        } catch (error) {
          throw new StocksError(
            'stocks/storage-unavailable',
            'The storage lock could not be released. Reload to check whether your edit committed; stop plugin instances before repairing the lock.',
          )
        }
      }
    })
  }
  async dispose(): Promise<void> {
    await this.tail
  }
}
