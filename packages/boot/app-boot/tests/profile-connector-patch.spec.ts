import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { installProfileConnectorControl } from '../src/index.ts'
import { patchProfileConnectorFlag } from '../src/profile-connectors.ts'

describe('MCP patch source preservation', () => {
  it('refuses to publish controls without a boot-owned Include', async () => {
    const ctx = new Context()
    try {
      expect(() => installProfileConnectorControl(ctx, {
        configPath: join(process.cwd(), 'unbooted.yml'),
        profilePatchPath: join(process.cwd(), 'unbooted.patch.yml'),
        homePatchPath: join(process.cwd(), 'unbooted.home.yml'),
        bundlePatches: [], overlays: [], live: true, readPatches: () => [],
      })).toThrow('Profile connector control requires the root Include')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['invalid: [', 'mapping: true'])('rejects a non-sequence patch document: %s', (text) => {
    expect(() => patchProfileConnectorFlag(text, 'target', true)).toThrow('Profile patches must be a YAML sequence')
  })

  it.each([
    '- insert: []\n- id: target\n  name: other\n  disabled: false\n',
    '- id: target\n  disabled: !!js false\n',
    '- id: target\n  disabled: null\n',
    '- id: target\n  disabled: &flag false\n- id: unrelated\n  disabled: *flag\n',
    '- &row\n  id: target\n  disabled: false\n- id: unrelated\n  config: *row\n',
    '- id: target',
    '[{ id: target }]\n',
  ])('changes only the new override when the existing node must stay literal', (text) => {
    const output = patchProfileConnectorFlag(text, 'target', true)
    const rows = load(output, { schema: entryListSchema }) as { id: string; disabled: boolean }[]
    expect(rows.at(-1)).toMatchObject({ id: 'target', disabled: true })
    if (!text.startsWith('[')) expect(output.startsWith(text)).toBe(true)
  })

  it('does not change another row through an anchored disabled value', () => {
    const output = patchProfileConnectorFlag('- id: target\n  disabled: &flag false\n- id: other\n  disabled: *flag\n', 'target', true)
    const rows = load(output, { schema: entryListSchema }) as { id: string; disabled: boolean }[]
    expect(rows[1]?.disabled).toBe(false)
    expect(rows.at(-1)?.disabled).toBe(true)
  })
})
