// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReceiptBadge, ReceiptMark, type ReceiptBadgeProps } from '../src/client/ReceiptBadge.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

const unusedHook = (() => { throw new Error('Unexpected receipt data dependency') }) as never

function receiptProps(preset: string | null | undefined, overrides: Partial<ReceiptBadgeProps> = {}): ReceiptBadgeProps {
  return {
    sessionId: 'session-1' as ReceiptBadgeProps['sessionId'],
    messageId: 'message-1' as ReceiptBadgeProps['messageId'],
    seq: 12,
    time: 1_000,
    placement: 'user',
    browserPromptRequestId: 'web-request-1' as NonNullable<ReceiptBadgeProps['browserPromptRequestId']>,
    assistantReaction: {
      assistantMessageId: 'assistant-1' as ReceiptBadgeProps['messageId'],
      emoji: '\u{1f44d}',
    },
    useSession: unusedHook,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    useSessionPendingInteraction: unusedHook,
    useConversation: unusedHook,
    useProjection: vi.fn((key: string) => {
      expect(key).toBe('agentPreset')
      return preset
    }) as ReceiptBadgeProps['useProjection'],
    policy: { presetIds: ['personal-assistant'], style: 'thumbs-up' },
    t: key => en[key],
    ...overrides,
  }
}

describe('Session-scoped acknowledgement replies', () => {
  it('does not react merely because a user message was admitted', () => {
    const { assistantReaction, ...props } = receiptProps('personal-assistant')
    expect(assistantReaction).toBeDefined()
    const { container } = render(<ReceiptBadge {...props} />)
    expect(container.childElementCount).toBe(0)
  })

  it('does not replace a different plugin reaction with a thumbs-up', () => {
    const props = receiptProps('personal-assistant', {
      assistantReaction: { assistantMessageId: 'assistant-1' as ReceiptBadgeProps['messageId'], emoji: '\u{1f44e}' },
    })
    const { container } = render(<ReceiptBadge {...props} />)
    expect(container.childElementCount).toBe(0)
  })
  it.each([undefined, null, 'another-agent'])('hides receipts for unresolved or non-target preset %s', preset => {
    const { container } = render(<ReceiptBadge {...receiptProps(preset)} />)
    expect(container.childElementCount).toBe(0)
  })

  it('requires proven browser ingress even when the preset matches', () => {
    const { browserPromptRequestId, ...props } = receiptProps('personal-assistant')
    expect(browserPromptRequestId).toBeDefined()
    const { container } = render(<ReceiptBadge {...props} />)
    expect(container.childElementCount).toBe(0)
  })

  it.each(['user', 'steering'] as const)('binds each %s receipt to its exact message identity', placement => {
    const props = receiptProps('personal-assistant', { placement })
    const { rerender } = render(<ReceiptBadge {...props} />)
    expect(screen.getByTestId('wa-message-receipt').getAttribute('data-message-id')).toBe('message-1')
    expect(screen.getByTestId('wa-message-receipt').getAttribute('data-assistant-message-id')).toBe('assistant-1')
    rerender(<ReceiptBadge {...props} />)
    expect(screen.getAllByTestId('wa-message-receipt')).toHaveLength(1)
  })

  it('does not share preset eligibility or message identity between Sessions', () => {
    render(
      <>
        <ReceiptBadge {...receiptProps('personal-assistant')} />
        <ReceiptBadge {...receiptProps('other', { sessionId: 'session-2' as ReceiptBadgeProps['sessionId'] })} />
        <ReceiptBadge {...receiptProps('personal-assistant', { messageId: 'message-2' as ReceiptBadgeProps['messageId'] })} />
      </>,
    )
    expect(screen.getAllByTestId('wa-message-receipt').map(node => node.getAttribute('data-message-id'))).toEqual(['message-1', 'message-2'])
  })

  it('applies neutral and disabled presentation to loaded history', () => {
    const props = receiptProps('personal-assistant', { policy: { presetIds: ['personal-assistant'], style: 'neutral' } })
    const { rerender, container } = render(<ReceiptBadge {...props} />)
    expect(screen.getByTestId('wa-message-receipt').textContent).toBe('Received')
    rerender(<ReceiptBadge {...props} policy={{ ...props.policy, style: 'off' }} />)
    expect(container.childElementCount).toBe(0)
  })
})

describe('receipt presentation', () => {
  it.each([en, zh])('names the receipt in the active locale without making it an action', locale => {
    const { container } = render(
      <ReceiptMark style="thumbs-up" meaning={locale['receipt.meaning']} neutralLabel={locale['receipt.neutral']} />,
    )
    const receipt = screen.getByRole('img', { name: locale['receipt.meaning'] })
    expect(receipt.textContent).toBe('\u{1f44d}')
    expect(receipt.getAttribute('title')).toBe(locale['receipt.meaning'])
    expect(receipt.tabIndex).toBe(-1)
    expect(container.querySelector('[aria-live], [role="status"], [role="button"], button')).toBeNull()
  })

  it('shows neutral text instead of an emoji', () => {
    render(<ReceiptMark style="neutral" meaning={en['receipt.meaning']} neutralLabel={en['receipt.neutral']} />)
    expect(screen.getByRole('img', { name: en['receipt.meaning'] }).textContent).toBe('Received')
  })

  it('renders no element when disabled', () => {
    const { container } = render(
      <ReceiptMark style="off" meaning={en['receipt.meaning']} neutralLabel={en['receipt.neutral']} />,
    )
    expect(container.childElementCount).toBe(0)
  })
})
