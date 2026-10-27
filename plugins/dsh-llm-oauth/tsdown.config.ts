import { defineConfig } from 'tsdown'

/** Host half only; client bundle is `tsdown.client.config.ts`. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  // Do not wipe lib/client.js produced by the client bundle.
  clean: false,
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  tsconfig: 'tsconfig.prepare.json',
  deps: { neverBundle: [/^@deepseek-ai\//, /^@earendil-works\//] },
})
