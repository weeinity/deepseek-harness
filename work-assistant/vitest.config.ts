/** Tests are limited to this independent plugin workspace. */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.spec.{ts,tsx}', 'tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
