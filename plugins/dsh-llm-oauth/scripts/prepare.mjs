/**
 * Self-contained prepare build for `dsh plugin add github:…`.
 * Bundles host src/ → lib/index.js and optional client → lib/client.js with
 * the locally installed tsdown; does not typecheck against DSH peers.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)

function localBin(packageName, relativePath) {
  return join(dirname(require.resolve(`${packageName}/package.json`)), relativePath)
}

const tsdown = localBin('tsdown', 'dist/run.mjs')
if (!existsSync(tsdown)) {
  console.error('prepare: tsdown is not installed; run pnpm install first')
  process.exit(1)
}

function run(config) {
  const result = spawnSync(process.execPath, [tsdown, '--config', config], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) {
    console.error(`prepare: ${result.error.message}`)
    process.exit(1)
  }
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

mkdirSync(join(root, 'lib'), { recursive: true })
run(existsSync(join(root, 'tsdown.prepare.config.ts'))
  ? 'tsdown.prepare.config.ts'
  : 'tsdown.config.ts')

// Client bundle needs lightningcss; skip quietly when it is not installed yet.
try {
  require.resolve('lightningcss')
  run('tsdown.client.config.ts')
} catch {
  console.warn('prepare: lightningcss missing — skipped client bundle (host-only install)')
}
