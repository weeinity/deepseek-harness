import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openMainSurface: vi.fn(),
    closeMainSurface: vi.fn(),
    toggleMainSurface: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
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
