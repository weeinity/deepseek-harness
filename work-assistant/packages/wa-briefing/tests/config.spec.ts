/** Configuration is rejected before creating Agents or scheduling timers. */
import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BriefingScheduler, { type Config } from '../src/index.ts'
import { temporaryDirectory } from '../../../tests/support.ts'
import { mountRealBriefing, ToolCallingAdapter } from './harness.ts'

function enabled(workspace = process.cwd()): Config {
  return { enabled: true, cron: '0 9 * * *', timeZone: 'UTC', workspace, provider: 'fixture', model: 'fixture' }
}

describe('briefing configuration', () => {
  it.each(['cron', 'timeZone', 'workspace', 'provider', 'model'] as const)('requires a nonblank %s only for enabled schedules', async field => {
    for (const value of ['', undefined]) {
      const ctx = new Context()
      try { expect(() => new BriefingScheduler(ctx, { ...enabled(), [field]: value })).toThrow('required') }
      finally { await ctx.fiber.dispose() }
    }
    const disabled = new Context()
    try { await expect(new BriefingScheduler(disabled, { enabled: false, [field]: '' }).trigger()).resolves.toEqual({ status: 'skipped', reason: 'disabled' }) }
    finally { await disabled.fiber.dispose() }
  })

  it.each(['99 99 * * *', '* * * * * *'])('rejects invalid five-field schedule %s', async cron => {
    const ctx = new Context()
    try { expect(() => new BriefingScheduler(ctx, { ...enabled(), cron })).toThrow('five-field') }
    finally { await ctx.fiber.dispose() }
  })

  it('rejects a file or link as its working directory', async () => {
    const root = await temporaryDirectory()
    const file = join(root, 'file.txt')
    const link = join(root, 'link')
    await writeFile(file, 'not a directory')
    await symlink(root, link, 'junction')
    for (const workspace of [file, link]) {
      const ctx = new Context()
      try { expect(() => new BriefingScheduler(ctx, enabled(workspace))).toThrow('real directory') }
      finally { await ctx.fiber.dispose() }
    }
  })

  it('validates configured bounds and accepts the supported limits', () => {
    for (const field of ['lookAheadMinutes', 'createTimeoutMs', 'turnTimeoutMs', 'maxPromptBytes', 'maxInboxItems', 'maxPreviewChars'] as const) {
      expect(() => BriefingScheduler.Config({ [field]: 0 })).toThrow()
    }
    expect(BriefingScheduler.Config({ maxInboxItems: 200, maxPreviewChars: 8000 })).toMatchObject({ maxInboxItems: 200, maxPreviewChars: 8000 })
    expect(() => BriefingScheduler.Config({ maxInboxItems: 201 })).toThrow()
    expect(() => BriefingScheduler.Config({ maxPreviewChars: 8001 })).toThrow()
  })

  it('rejects invalid trigger instants without starting work', async () => {
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model)
    await expect(h.ctx.workAssistBriefing.trigger(new Date(NaN))).rejects.toThrow('valid')
    await expect(h.ctx.workAssistBriefing.trigger(new Date(-1))).rejects.toThrow('epoch')
    expect(model.calls).toEqual([])
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })

  it('refuses an oversized scheduled prompt and preserves the failed occurrence', async () => {
    const model = new ToolCallingAdapter()
    const h = await mountRealBriefing(model, { config: { maxPromptBytes: 512, reasoningEffort: 'low', maxTokens: 128 } })
    await expect(h.ctx.workAssistBriefing.trigger(new Date('2026-03-01T08:00:00Z'))).rejects.toThrow('prompt exceeds')
    expect(model.calls).toEqual([])
    expect(h.ctx.workAssistBriefing.snapshot().items).toEqual([])
  })
})
