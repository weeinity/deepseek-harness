// @vitest-environment jsdom
/** Cat activity transitions use a fake clock; no real five-minute wait. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { BrandCat } from '../src/client/BrandCat.tsx'
import { en } from '../src/client/locales.ts'
import { catArtwork } from '../src/client/cat-artwork.ts'

const id = 'cat-test' as SessionId
const snapshot = (running: boolean): SessionStatusSnapshot => new Map([[id, {
  running, pendingInteraction: undefined, completionUnread: false,
}]])
afterEach(() => { cleanup(); vi.useRealTimers() })

it('automatically keeps the typing GIF selected for the entire working state without a click', () => {
  vi.useFakeTimers()
  let statuses = snapshot(true)
  const tree = () => <BrandCat wide useSessionStatus={selector => selector(statuses)} t={makeTranslate(en)} />
  const view = render(tree())
  const typing = view.getByAltText('Cat working')
  expect(typing.getAttribute('src')).toBe(catArtwork.working)
  expect(catArtwork.working.startsWith('data:image/gif;base64,')).toBe(true)
  expect(view.container.querySelector('source')).toBeNull()
  expect(view.getByRole('button', { name: 'Play cat animation' }).getAttribute('aria-pressed')).toBe('false')
  act(() => { vi.advanceTimersByTime(600000) })
  expect(view.getByAltText('Cat working')).toBe(typing)
  expect(typing.getAttribute('src')).toBe(catArtwork.working)
  statuses = snapshot(false)
  view.rerender(tree())
  expect(view.getByAltText('Cat active: session completed').getAttribute('src')).toBe(catArtwork.active)
  statuses = snapshot(true)
  view.rerender(tree())
  expect(view.getByAltText('Cat working').getAttribute('src')).toBe(catArtwork.working)
})

it.each([false, true])('plays on click even when running=%s, then returns to automatic state', (running) => {
  vi.useFakeTimers()
  const statuses = snapshot(running)
  const view = render(<BrandCat wide useSessionStatus={selector => selector(statuses)} t={makeTranslate(en)} />)
  fireEvent.click(view.getByRole('button', { name: 'Play cat animation' }))
  const preview = view.getByRole('button', { name: 'Stop cat animation preview' })
  expect(preview.getAttribute('aria-pressed')).toBe('true')
  expect(view.getByAltText('Cat waving').getAttribute('src')?.startsWith('data:image/gif;base64,')).toBe(true)
  expect(view.container.querySelector('source')).toBeNull()
  act(() => { vi.advanceTimersByTime(9999) })
  expect(view.getByAltText('Cat waving')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1) })
  expect(view.getByAltText(running ? 'Cat working' : 'Cat sleeping')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: 'Play cat animation' }))
  fireEvent.click(view.getByRole('button', { name: 'Stop cat animation preview' }))
  expect(view.getByAltText(running ? 'Cat working' : 'Cat sleeping')).toBeTruthy()
  expect(vi.getTimerCount()).toBe(0)
  fireEvent.click(view.getByRole('button', { name: 'Play cat animation' }))
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('works during any run, greets for five minutes after completion, then sleeps', () => {
  vi.useFakeTimers()
  let statuses = snapshot(false)
  const tree = () => <BrandCat wide useSessionStatus={selector => selector(statuses)} t={makeTranslate(en)} />
  const view = render(tree())
  expect(view.getByAltText('Cat sleeping')).toBeTruthy()
  statuses = snapshot(true)
  view.rerender(tree())
  expect(view.getByAltText('Cat working')).toBeTruthy()
  statuses = snapshot(false)
  view.rerender(tree())
  const active = view.getByAltText('Cat active: session completed')
  expect(active.getAttribute('src')).toMatch(/^data:image\/gif;base64,/)
  expect(active.parentElement?.querySelector('source')?.getAttribute('media')).toBe('(prefers-reduced-motion: reduce)')
  act(() => { vi.advanceTimersByTime(299999) })
  expect(view.getByAltText('Cat active: session completed')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1) })
  expect(view.getByAltText('Cat sleeping')).toBeTruthy()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('restarts the greeting on another completion and keeps time while collapsed', () => {
  vi.useFakeTimers()
  let statuses = snapshot(true)
  let wide = true
  const tree = () => <BrandCat wide={wide} useSessionStatus={selector => selector(statuses)} t={makeTranslate(en)} />
  const view = render(tree())
  statuses = snapshot(false)
  view.rerender(tree())
  act(() => { vi.advanceTimersByTime(240000) })
  statuses = snapshot(true)
  view.rerender(tree())
  statuses = snapshot(false)
  wide = false
  view.rerender(tree())
  expect(view.getByAltText('Cat active: session completed').hidden).toBe(true)
  act(() => { vi.advanceTimersByTime(60000) })
  wide = true
  view.rerender(tree())
  expect(view.getByAltText('Cat active: session completed')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(240000) })
  expect(view.getByAltText('Cat sleeping')).toBeTruthy()
})

it('keeps working while another session runs and cancels its timer on unmount', () => {
  vi.useFakeTimers()
  let statuses = snapshot(true)
  const tree = () => <BrandCat wide useSessionStatus={selector => selector(statuses)} t={makeTranslate(en)} />
  const view = render(tree())
  statuses = new Map([...snapshot(false), ['other' as SessionId, { running: true, pendingInteraction: undefined, completionUnread: false }]])
  view.rerender(tree())
  expect(view.getByAltText('Cat working')).toBeTruthy()
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
