import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '../src/client/service.ts'
import type { PanelActions } from '../src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    toggleSidebar: vi.fn(),
    openMainSurface: vi.fn(),
    closeMainSurface: vi.fn(),
    toggleMainSurface: vi.fn(),
    setViewportWidth: vi.fn(),
    setRightbar: vi.fn(),
    openRightbar: vi.fn(),
    closeRightbar: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the right column transitions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.openRightbar(true, false)
    service.openRightbar(true, true)
    service.openRightbar(false, true)
    service.closeRightbar()

    expect(panels.openRightbar).toHaveBeenNthCalledWith(1, true, false)
    expect(panels.openRightbar).toHaveBeenNthCalledWith(2, true, true)
    expect(panels.openRightbar).toHaveBeenNthCalledWith(3, false, true)
    expect(panels.closeRightbar).toHaveBeenCalledTimes(1)
    // The drag width stays the frame's own business, never the caller's.
    expect(panels.setRightbar).not.toHaveBeenCalled()
  })

  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
  })

  it('registers, validates, toggles, and expected-id closes main surfaces', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)
    expect(() => { service.openMainSurface('taskboard') }).toThrow(/not registered/)
    expect(() => { service.registerMainSurface('') }).toThrow(/empty or already registered/)
    const dispose = service.registerMainSurface('taskboard')
    expect(() => { service.registerMainSurface('taskboard') }).toThrow(/empty or already registered/)
    service.openMainSurface('taskboard')
    service.toggleMainSurface('taskboard')
    service.closeMainSurface()
    expect(panels.openMainSurface).toHaveBeenCalledWith('taskboard')
    expect(panels.toggleMainSurface).toHaveBeenCalledWith('taskboard')
    expect(panels.closeMainSurface).toHaveBeenCalledWith()
    dispose()
    expect(panels.closeMainSurface).toHaveBeenCalledWith('taskboard')
  })

  it('surface disposal before root wiring is a safe no-op', () => {
    const service = new LayoutController()
    const dispose = service.registerMainSurface('taskboard')
    expect(dispose).not.toThrow()
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
