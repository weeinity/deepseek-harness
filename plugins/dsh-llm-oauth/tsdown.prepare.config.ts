import { defineConfig } from 'tsdown'

/**
 * Git / tarball install bundle. No project references, no typecheck —
 * `@deepseek-ai/*` peers are supplied by the DSH profile, not this package.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  tsconfig: 'tsconfig.prepare.json',
  deps: { neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//] },
})
