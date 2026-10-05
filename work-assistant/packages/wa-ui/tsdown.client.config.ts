/** Standalone browser bundle for the personal-assistant UI plugin. */
import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = '@deepseek-ai/dsh-wa-ui'
const CSS_MODULE_PREFIX = '\0wa-ui-css-module:'
const CSS_INLINE_PREFIX = '\0wa-ui-css-inline:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
] as const
const CLIENT_EXTERNAL_SET = new Set<string>(CLIENT_EXTERNALS)

interface CssModuleOutput {
  readonly css: string
  readonly classMap: Record<string, string>
}

async function compileCssModule(fileId: string): Promise<CssModuleOutput> {
  const source = await readFile(fileId)
  const { code, exports: cssExports } = transform({
    filename: fileId,
    code: source,
    cssModules: { pattern: '[hash]_[local]' },
    minify: true,
  })
  const classMap: Record<string, string> = {}
  const exportEntries = Object.entries(cssExports ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  for (const [local, exp] of exportEntries) classMap[local] = exp.name
  return { css: code.toString(), classMap }
}

function resolveCssVirtual(source: string, importer: string | undefined, prefix: string): string {
  const withoutQuery = source.replace(/\?inline$/u, '')
  const abs = importer !== undefined ? resolvePath(dirname(importer), withoutQuery) : withoutQuery
  return prefix + abs + CSS_VIRTUAL_SUFFIX
}

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  fixedExtension: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (specifier: string) => !CLIENT_EXTERNAL_SET.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'wa-ui-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (source.endsWith('.module.css?inline')) return resolveCssVirtual(source, importer, CSS_INLINE_PREFIX)
      if (source.endsWith('.module.css')) return resolveCssVirtual(source, importer, CSS_MODULE_PREFIX)
      return null
    },
    async load(virtualId: string) {
      if (virtualId.startsWith(CSS_MODULE_PREFIX)) {
        const fileId = virtualId.slice(CSS_MODULE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const { classMap } = await compileCssModule(fileId)
        return `export default ${JSON.stringify(classMap)};`
      }
      if (virtualId.startsWith(CSS_INLINE_PREFIX)) {
        const fileId = virtualId.slice(CSS_INLINE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const { css } = await compileCssModule(fileId)
        return `export default ${JSON.stringify(css)};`
      }
      return null
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({id:${JSON.stringify(ID)},factory:(require)=>{`,
    intro: 'var module={exports:{}};var exports=module.exports;',
    footer: 'return module.exports;}});',
  },
})
