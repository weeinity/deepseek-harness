/** Coverage is scoped to the first proactive milestone's changed production modules. */
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.ts'

export default mergeConfig(base, defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/proactive',
      reporter: ['text', 'json-summary', 'json'],
      include: [
        'packages/wa-briefing/src/**/*.ts',
        'packages/wa-ui/src/config.ts',
        'packages/wa-ui/src/client/briefing.ts',
        'packages/wa-ui/src/client/AssistantPanel.tsx',
        'packages/wa-ui/src/client/AssistantToggle.tsx',
        'packages/wa-ui/src/client/index.ts',
        'packages/wa-ui/src/client/locales.ts',
      ],
      thresholds: { perFile: true, lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
}))
