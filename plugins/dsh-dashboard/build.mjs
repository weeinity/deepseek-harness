import { build, transform } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const shared = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']
await mkdir(join(root, 'lib'), { recursive: true })
const fontRoot = dirname(fileURLToPath(import.meta.resolve('@fontsource-variable/inter/package.json')))
const font = await readFile(join(fontRoot, 'files', 'inter-latin-wght-normal.woff2'))
const fontCss = `@font-face{font-family:dsh-dashboard-inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');}`
await mkdir(join(root, 'lib', 'licenses'), { recursive: true })
await cp(join(fontRoot, 'LICENSE'), join(root, 'lib', 'licenses', 'inter-OFL.txt'))
await rm(join(root, 'lib', 'presets'), { recursive: true, force: true })
const host = await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/host/index.ts' },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  metafile: true,
})
await writeFile(join(root, 'lib/host.meta.json'), JSON.stringify(host.metafile))
const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: shared,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  minifySyntax: true,
  minifyWhitespace: true,
  metafile: true,
  plugins: [{
    name: 'shared-client-imports',
    setup(builder) {
      builder.onResolve({ filter: /^@deepseek-ai\// }, ({ path }) => {
        if (!shared.includes(path)) throw new Error(`Unsupported browser value import: ${path}`)
        return { path, external: true }
      })
    },
  }],
})
const javascript = client.outputFiles.find(file => file.path.endsWith('.js'))?.text
const css = fontCss + (client.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '')
if (!javascript) throw new Error('Dashboard client build produced no JavaScript')
// Preserve plugin-qualified CSS module names while minifying JavaScript identifiers.
const minified = await transform(javascript, { minify: true, format: 'cjs', target: 'es2022' })
const wrapper = `window.__ModuleLoader__.load({id:"dsh-dashboard",factory:(require)=>{var module={exports:{}};var exports=module.exports;
const css=${JSON.stringify(css)};
${minified.code}
const entry=module.exports;
return {...entry,apply(ctx,...args){ctx.effect(()=>{const tag=document.createElement('style');tag.dataset.plugin="dsh-dashboard";tag.textContent=css;document.head.appendChild(tag);return()=>tag.remove();},"dsh-dashboard: stylesheet");return entry.apply(ctx,...args);}};}});\n`
await writeFile(join(root, 'lib/client.js'), wrapper)
await writeFile(join(root, 'lib/client.meta.json'), JSON.stringify(client.metafile))
console.log(`Dashboard built: client ${Math.round(Buffer.byteLength(wrapper) / 1024)} KiB; host lib/index.js`)
