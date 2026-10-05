/** CSS text owned by one stylesheet module. */
export interface PluginStyleSheet {
  /** Stable stylesheet id under the plugin package id. */
  readonly id: string
  /** Compiled stylesheet text. */
  readonly css: string
}

/** Attach plugin styles for one Cordis effect lifetime. */
export function installPluginStyles(pluginId: string, sheets: readonly PluginStyleSheet[]): () => void {
  if (typeof document === 'undefined') return () => {}
  const tags: HTMLStyleElement[] = []
  for (const sheet of sheets) {
    const tagId = `${pluginId}/${sheet.id}`
    document.querySelectorAll(`style[data-plugin-css=${JSON.stringify(tagId)}]`)
      .forEach(node => { node.remove() })
    const tag = document.createElement('style')
    tag.dataset.plugin = pluginId
    tag.dataset.pluginCss = tagId
    tag.textContent = sheet.css
    document.head.append(tag)
    tags.push(tag)
  }
  return () => {
    for (const tag of tags) tag.remove()
  }
}
