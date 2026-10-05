import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const modulePath = fileURLToPath(import.meta.url)
const workspaceRoot = path.resolve(path.dirname(modulePath), '..')
const uiRequire = createRequire(path.join(workspaceRoot, 'packages', 'wa-ui', 'package.json'))
const defaultOutputDir = path.join(workspaceRoot, '.receipt-runtime', 'dist')
const tag = 'personal-assistant-receipts-alpha2-backport'

const packages = [
  {
    name: '@deepseek-ai/dsh-client-ui-conversation',
    version: '0.1.5-alpha.2',
    basename: 'deepseek-ai-dsh-client-ui-conversation-0.1.5-alpha.2',
  },
  {
    name: '@deepseek-ai/dsh-client-ui-chat',
    version: '0.1.5-alpha.2',
    basename: 'deepseek-ai-dsh-client-ui-chat-0.1.5-alpha.2',
  },
]

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function verifyPatchedPackage(spec, dir) {
  const packageJson = await readJson(path.join(dir, 'package.json'))
  if (packageJson.name !== spec.name || packageJson.version !== spec.version) {
    throw new Error(`${dir} is ${packageJson.name}@${packageJson.version}; expected ${spec.name}@${spec.version}.`)
  }
  const marker = packageJson.dshReceiptRuntimePatch
  if (marker?.tag !== tag || marker?.base !== `${spec.name}@${spec.version}`) {
    throw new Error(`${spec.name}@${spec.version} is not the tracked receipt patch; run pnpm install in work-assistant.`)
  }
}

function npmPack(dir, outputDir) {
  const npmCli = process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : 'npm'
  const command = process.platform === 'win32' ? process.execPath : npmCli
  const args = process.platform === 'win32'
    ? [npmCli, 'pack', dir, '--pack-destination', outputDir, '--ignore-scripts', '--json']
    : ['pack', dir, '--pack-destination', outputDir, '--ignore-scripts', '--json']
  const result = spawnSync(command, args, { cwd: workspaceRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`npm pack failed for ${dir}\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  const packed = JSON.parse(result.stdout)[0]?.filename
  if (typeof packed !== 'string' || packed.length === 0) throw new Error(`npm pack returned no filename for ${dir}`)
  return path.resolve(outputDir, packed)
}

async function sha256(file) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(file))
  return hash.digest('hex')
}

async function packReceiptPackage(spec, outputDir, scratchRoot) {
  const dir = path.dirname(uiRequire.resolve(`${spec.name}/package.json`))
  await verifyPatchedPackage(spec, dir)
  const packed = npmPack(dir, scratchRoot)
  const digest = await sha256(packed)
  const target = path.resolve(outputDir, `${spec.basename}-sha256-${digest}.tgz`)
  try {
    await fs.link(packed, target)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (await sha256(target) !== digest) throw new Error(`Receipt archive does not match its digest: ${target}`)
  }
  return target
}

/**
 * Pack the patched shared receipt runtime packages.
 * @param {string} [outputDir] Directory that receives immutable digest-named tarballs.
 * @returns {Promise<readonly string[]>} Absolute paths for conversation and chat archives.
 */
export async function buildReceiptRuntime(outputDir = defaultOutputDir) {
  const resolvedOutputDir = path.resolve(outputDir)
  await fs.mkdir(resolvedOutputDir, { recursive: true })
  const scratchRoot = await fs.mkdtemp(path.join(resolvedOutputDir, '.receipt-pack-'))
  try {
    const archives = []
    for (const spec of packages) archives.push(await packReceiptPackage(spec, resolvedOutputDir, scratchRoot))
    return archives
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === modulePath) {
  const outputDir = process.argv[2] ?? defaultOutputDir
  for (const archive of await buildReceiptRuntime(outputDir)) console.log(archive)
}
