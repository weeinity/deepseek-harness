import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
const root = new URL('.', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
})
const client = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  write: false,
  minify: true,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
})
const js = client.outputFiles.find((f) => f.path.endsWith('.js')).text
const css = client.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? ''
await writeFile(
  new URL('lib/client.js', root),
  'window.__ModuleLoader__.load({id:"dsh-stocks",factory:(require)=>{var module={exports:{}};var exports=module.exports;' +
    js +
    ';const entry=module.exports;return {...entry,apply(ctx){ctx.effect(()=>{const tag=document.createElement("style");tag.dataset.plugin="dsh-stocks";tag.textContent=' +
    JSON.stringify(css) +
    ';document.head.appendChild(tag);return()=>tag.remove()});return entry.apply(ctx)}};}});\n',
)
const files = {}
async function collect(dir) {
  for (const item of await readdir(new URL(dir, root), { withFileTypes: true })) {
    const path = dir + item.name
    if (item.isDirectory()) await collect(path + '/')
    else files[path] = await readFile(new URL(path, root), 'utf8')
  }
}
await collect('src/')
await collect('tests/')
for (const path of [
  'package.json',
  'build.mjs',
  'tsconfig.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY-NOTICES.txt',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.prettierrc.json',
  'README.zh.md',
])
  files[path] = await readFile(new URL(path, root), 'utf8')
await writeFile(
  new URL('lib/source.json', root),
  JSON.stringify({ license: 'AGPL-3.0-only', files }, null, 2) + '\n',
)
console.log('Built Stocks host, client, and corresponding source archive')
