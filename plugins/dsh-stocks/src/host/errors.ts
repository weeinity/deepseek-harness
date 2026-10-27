/** Stable, secret-free errors for browser and background operations. */
import { z } from 'zod'
import type { ApiError, ApiReply } from '../shared/api.ts'
export class StocksError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export function safeError(error: unknown): ApiError {
  if (error instanceof StocksError) return { code: error.code, message: error.message }
  if (error instanceof z.ZodError)
    return {
      code: 'stocks/invalid-input',
      message: 'Invalid request fields. Check the symbol, price, and revision.',
    }
  return {
    code: 'stocks/unavailable',
    message: 'The operation is unavailable. Retry after checking the plugin configuration and storage.',
  }
}
export async function reply<T>(run: () => Promise<T>): Promise<ApiReply<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error: safeError(error) }
  }
}
export function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new StocksError('stocks/cancelled', 'The operation was cancelled.')
}
