/** Deployment-owned styling for the assistant's optional acknowledgement reply. */
export interface ReceiptPolicy {
  /** Exact preset IDs whose eligible emoji replies use reaction presentation. */
  readonly presetIds: readonly string[]
  /** Display style; off preserves the ordinary assistant reply. */
  readonly style: 'thumbs-up' | 'neutral' | 'off'
}

/**
 * Validate and capture receipt configuration without retaining mutable inputs.
 * @param policy - Parsed configuration with explicit target presets and style.
 * @returns A detached, immutable display policy.
 */
export function resolveReceiptPolicy(policy: ReceiptPolicy): ReceiptPolicy {
  if (policy.presetIds.length === 0 || policy.presetIds.some(id => id.trim() !== id || id.length === 0)) {
    throw new TypeError('wa-ui.receipt.presetIds must contain nonempty preset IDs without surrounding whitespace')
  }
  if (new Set(policy.presetIds).size !== policy.presetIds.length) {
    throw new TypeError('wa-ui.receipt.presetIds must not contain duplicates')
  }
  return Object.freeze({ style: policy.style, presetIds: Object.freeze([...policy.presetIds]) })
}
