/** Configuration and explicitly authorized credentials-file parsing; no dotenv execution. */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { StocksError } from './errors.ts'
const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path')
export const Config = z
  .object({
    statePath: absolutePath.default(() => join(homedir(), '.dsh', 'stocks', 'state.json')),
    credentialsFile: absolutePath.optional(),
    quoteRefreshSeconds: z.number().int().min(15).max(3600).default(60),
    alertCheckSeconds: z.number().int().min(60).max(86400).default(300),
    requestTimeoutMs: z.number().int().min(100).max(60000).default(8000),
    failureCacheSeconds: z.number().int().min(1).max(3600).default(60),
    metadataCacheSeconds: z.number().int().min(1).max(86400).default(3600),
    newsCacheSeconds: z.number().int().min(1).max(3600).default(300),
    cacheEntries: z.number().int().min(1).max(2000).default(512),
    maxResponseBytes: z.number().int().min(1024).max(4000000).default(1000000),
  })
  .strict()
export type StocksConfig = z.infer<typeof Config>
export interface Credentials {
  finnhub: string[]
  sentiment?: string
}
const credentialNames = new Set([
  'FINNHUB_API_KEY',
  'FINNHUB_API_KEYS',
  'NEXT_PUBLIC_FINNHUB_API_KEY',
  'ADANOS_API_KEY',
])
export function parseCredentialsFile(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match || !credentialNames.has(match[1]!)) continue
    let value = match[2]!
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0]!, 1)
      if (end < 0 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1)))
        throw new StocksError(
          'stocks/credentials-invalid',
          'Credentials file contains a malformed supported key. Correct the entry and reload.',
        )
      value = value.slice(1, end)
    } else value = value.replace(/\s+#.*$/, '').trim()
    result[match[1]!] = value
  }
  return result
}
export async function loadCredentials(
  config: StocksConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Credentials> {
  let file: Record<string, string> = {}
  if (config.credentialsFile) {
    let text: string
    try {
      if ((await stat(config.credentialsFile)).size > 131072) throw new Error('oversized')
      text = await readFile(config.credentialsFile, 'utf8')
    } catch (error) {
      throw new StocksError(
        'stocks/credentials-unavailable',
        'Cannot read the configured credentials file. Check its path and permissions, then reload.',
      )
    }
    file = parseCredentialsFile(text)
  }
  const raw =
    env.FINNHUB_API_KEYS ||
    env.FINNHUB_API_KEY ||
    file.FINNHUB_API_KEYS ||
    file.FINNHUB_API_KEY ||
    file.NEXT_PUBLIC_FINNHUB_API_KEY ||
    ''
  const finnhub = [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ]
  if (finnhub.length > 32 || finnhub.some((key) => key.length > 1024 || /[\r\n]/.test(key)))
    throw new StocksError(
      'stocks/credentials-invalid',
      'Finnhub credentials are malformed. Correct them and reload.',
    )
  const sentiment = env.ADANOS_API_KEY || file.ADANOS_API_KEY
  if (sentiment && (sentiment.length > 1024 || /[\r\n]/.test(sentiment)))
    throw new StocksError(
      'stocks/credentials-invalid',
      'Sentiment credentials are malformed. Correct them and reload.',
    )
  return { finnhub, ...(sentiment ? { sentiment } : {}) }
}
