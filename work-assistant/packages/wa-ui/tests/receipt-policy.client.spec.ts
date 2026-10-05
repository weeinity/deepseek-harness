import { describe, expect, it } from 'vitest'
import { resolveReceiptPolicy } from '../src/receipt-policy.ts'

describe('receipt display policy', () => {
  it('requires explicit nonempty and distinct preset IDs', () => {
    for (const presetIds of [[], [''], [' '], [' personal-assistant'], ['personal-assistant '], ['personal-assistant', 'personal-assistant']]) {
      expect(() => resolveReceiptPolicy({ presetIds, style: 'thumbs-up' })).toThrow()
    }
  })

  it.each(['thumbs-up', 'neutral', 'off'] as const)('captures the %s policy independently of the caller', style => {
    const presetIds = ['personal-assistant']
    const policy = resolveReceiptPolicy({ presetIds, style })
    presetIds.push('another-agent')
    expect(policy).toEqual({ presetIds: ['personal-assistant'], style })
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.presetIds)).toBe(true)
  })
})
