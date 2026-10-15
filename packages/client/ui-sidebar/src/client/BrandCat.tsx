/** Three-state brand companion driven by observed Session running transitions. */
import { useEffect, useRef, useState } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { catArtwork } from './cat-artwork.ts'
import css from './SidebarRoot.module.css'

type BrandCatProps = Pick<SidebarRootComponentProps, 'useSessionStatus' | 't'> & { wide: boolean }

/** Render Session activity with a ten-second, user-requested animation preview.
 * @param props - Session status hook, localized labels, and sidebar visibility.
 * @returns the brand companion image.
 */
export function BrandCat({ useSessionStatus, t, wide }: BrandCatProps) {
  const statuses = useSessionStatus(snapshot => snapshot)
  const previous = useRef(statuses)
  const [activeUntil, setActiveUntil] = useState(0)
  const [previewUntil, setPreviewUntil] = useState(0)
  const running = [...statuses.values()].some(status => status.running === true)
  useEffect(() => {
    const completed = [...statuses].some(([id, status]) =>
      status.running === false && previous.current.get(id)?.running === true)
    previous.current = statuses
    if (completed) setActiveUntil(Date.now() + 5 * 60 * 1000)
  }, [statuses])
  useEffect(() => {
    if (activeUntil === 0) return
    const timer = window.setTimeout(() => { setActiveUntil(0) }, Math.max(0, activeUntil - Date.now()))
    return () => { window.clearTimeout(timer) }
  }, [activeUntil])
  useEffect(() => {
    if (previewUntil === 0) return
    const timer = window.setTimeout(() => { setPreviewUntil(0) }, Math.max(0, previewUntil - Date.now()))
    return () => { window.clearTimeout(timer) }
  }, [previewUntil])
  const previewing = previewUntil > 0
  const state = previewing ? 'active' : running ? 'working' : activeUntil > 0 ? 'active' : 'sleeping'
  const labels = { sleeping: 'cat.sleeping', working: 'cat.working', active: 'cat.active' } as const
  const actionLabel = t(previewing ? 'cat.preview.stop' : 'cat.preview.start')
  return <Tooltip label={actionLabel} delayMs={500} side="bottom" portal>
    <button type="button" className={css.brandCat} hidden={!wide} aria-label={actionLabel}
      aria-pressed={previewing} onClick={() => { setPreviewUntil(previewing ? 0 : Date.now() + 10000) }}>
      <picture>
        {state === 'active' && !previewing && <source media="(prefers-reduced-motion: reduce)" srcSet={catArtwork.activeStill} />}
        <img src={catArtwork[state]} alt={t(previewing ? 'cat.previewing' : labels[state])}
          data-cat-state={state} hidden={!wide} width={40} height={32} />
      </picture>
    </button>
  </Tooltip>
}
