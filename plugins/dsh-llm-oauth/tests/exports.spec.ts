import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

describe('loader namespace (source text)', () => {
  it('does not export default (Cordis unwraps default ?? exports)', () => {
    const source = readFileSync(join(root, 'src/index.ts'), 'utf8')
    expect(source).not.toMatch(/export default/)
    expect(source).toMatch(/export const name = 'llm-oauth'/)
    expect(source).toMatch(/export const inject = \['llm'\]/)
    expect(source).toMatch(/export \{ apply \}/)
  })

  it('declares a dsh.bundle patch and dsh.client face', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dsh?: {
        bundle?: { patch?: string }
        client?: { platform?: string, inject?: string[] }
      }
      exports?: Record<string, unknown>
    }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ]))
    expect(pkg.exports?.['./client']).toBeDefined()
  })

  it('ships dormant providers by default in the bundle patch', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/catalog:/)
    expect(patch).toMatch(/providers:\s*\{\}/)
  })
})
