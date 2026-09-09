/** Cross-plugin panel actions and first-class main-surface selection. */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set delivered by the root registration. */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/** The outward layout face used by feature plugins and sidebar launchers. */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /**
   * Register one available main surface for this plugin lifetime.
   * @param id - Stable keyed-slot entry id.
   * @returns disposer that removes the id and closes it when active.
   */
  registerMainSurface(id: string): () => void
  /**
   * Select a registered surface while preserving underlying panel geometry.
   * @param id - Registered surface id.
   */
  openMainSurface(id: string): void
  /** Return to the Conversation surface. */
  closeMainSurface(): void
  /**
   * Toggle one registered surface against the Conversation.
   * @param id - Registered surface id.
   */
  toggleMainSurface(id: string): void
  /**
   * Report the right panel's presentation without changing its expanded state.
   * @param track - whether the normal panel width reserves a grid track,
   *   including beneath a fullscreen overlay.
   * @param fullscreen - whether the panel covers the frame and hides its outer
   *   resize handle; independent of the underlying grid track.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void
}

/** Cross-plugin viewing-state and panel-action service. */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #surfaceIds = new Set<string>()

  /**
   * Adopt the root entry's bound store actions.
   * @param actions - bound actions of the root layout store.
   */
  attachPanels(actions: PanelActions): void { this.#panels = actions }

  toggleSidebar(): void { this.#require().toggleSidebar() }

  registerMainSurface(id: string): () => void {
    if (id === '' || this.#surfaceIds.has(id)) {
      throw new Error(`layout: main surface id '${id}' is empty or already registered`)
    }
    this.#surfaceIds.add(id)
    return () => {
      if (!this.#surfaceIds.delete(id)) return
      this.#panels?.closeMainSurface(id)
    }
  }

  openMainSurface(id: string): void {
    if (!this.#surfaceIds.has(id)) throw new Error(`layout: main surface '${id}' is not registered`)
    this.#require().openMainSurface(id)
  }

  closeMainSurface(): void { this.#require().closeMainSurface() }
  toggleMainSurface(id: string): void {
    if (!this.#surfaceIds.has(id)) throw new Error(`layout: main surface '${id}' is not registered`)
    this.#require().toggleMainSurface(id)
  }

  /** Report the right panel's track and fullscreen presentation. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.#require().openRightbar(track, fullscreen)
  }

  /** Report the right panel as hidden: no track, no handle. */
  closeRightbar(): void {
    this.#require().closeRightbar()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
