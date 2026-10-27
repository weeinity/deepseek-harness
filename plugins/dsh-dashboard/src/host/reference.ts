/** Saved briefings provide dated text and source links, never live measurements. */
import { readFile } from 'node:fs/promises'
import { load } from 'cheerio'
import type { PersonalInsights } from '../shared/insights.ts'
import type { DashboardItem, DashboardSection, SectionId } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'
import { safeError } from './mcp.ts'
import { classifyAttention } from './personal-insights.ts'

export interface ReferenceResult {
  sections: DashboardSection[]
  referenceAsOf?: string
  warnings: string[]
  available: boolean
  attention?: PersonalInsights['attention']
  captions?: Partial<Record<SectionId, string>>
}

const sectionPatterns: [SectionId, RegExp][] = [
  ['urgent', /needs attention|urgent|attention now/i],
  ['prep', /prep(?:aration)?(?: notes)?/i],
  ['projects', /projects?/i],
  ['reply', /needing a reply|needs? repl|emails? to reply|replies/i],
  ['actions', /action items?|long.term actions?|tasks?/i],
  ['training', /training|learning/i],
  ['oof', /\boof\b|out.of.office|absence/i],
  ['people', /people|follow.up with/i],
  ['chats', /teams|chats/i],
  ['files', /files|documents/i],
]

function text(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Extract plain briefing text; unsafe or missing item links are discarded.
 * @param html User-selected saved dashboard HTML.
 * @param maxItems Maximum retained items per section.
 * @returns Dated, reference-only sections and parsing warnings.
 */
export function parseReferenceHtml(html: string, maxItems = 100): ReferenceResult {
  const $ = load(html)
  $('script,style,iframe,object,embed,template,svg,math,form,input,button,noscript').remove()
  const warnings: string[] = []
  const refresh = $('.refresh,[data-reference-as-of]').first()
  const refreshText = text(refresh.text())
  const refreshNode = $('body').find('*').contents().toArray().find((node) => node.type === 'text' && /Last refreshed\b/i.test(node.data))
  const referenceAsOf = refreshText.match(/Last refreshed\b.*$/i)?.[0]
    ?? (refreshNode?.type === 'text' ? text(refreshNode.data).match(/Last refreshed\b.*$/i)?.[0] : undefined)
  const sections = new Map<SectionId, DashboardSection>()
  const captions: Partial<Record<SectionId, string>> = {}
  let dropped = 0
  let truncated = false
  const containers = $('.urgent-banner,.card,section,[data-section]')

  containers.each((_, container) => {
    const card = $(container)
    const heading = text(card.find('h2,h3,[role=heading]').first().text())
    const marker = `${card.attr('data-section') ?? ''} ${card.attr('id') ?? ''} ${card.attr('class') ?? ''}`
    const id = card.hasClass('urgent-banner')
      ? 'urgent'
      : sectionPatterns.find(([section, pattern]) => pattern.test(heading) || new RegExp(`\\b${section}\\b`, 'i').test(marker))?.[0]
    if (!id) return
    const section = sections.get(id) ?? {
      id,
      source: 'reference' as const,
      note: referenceAsOf
        ? `Saved briefing — ${referenceAsOf}. Not verified live or automatically recomputed.`
        : 'Saved briefing; refresh date unavailable. Not verified live or automatically recomputed.',
      items: [],
    }
    sections.set(id, section)
    const caption = card.find('.caption,.card-caption,.read,p.next').filter((__, node) => (
      $(node).closest('.urgent-banner,.card,section,[data-section]').get(0) === container
      && !$(node).closest('.row,.person,li,a').length
    )).first()
    if (caption.length && !captions[id]) captions[id] = text(caption.text())
    let rows = card.find('.row,.person')
    if (!rows.length) rows = card.find('li')
    if (!rows.length) rows = card.find('a[href]')
    rows.each((__, row) => {
      const item = $(row)
      if (item.parents('.row,.person,li').toArray().some((parent) => rows.toArray().includes(parent))) return
      const closestContainer = item.closest('.urgent-banner,.card,section,[data-section]').get(0)
      if (closestContainer !== container) return
      const anchor = item.is('a[href]') ? item : item.find('a[href]').first()
      const url = safeSourceUrl(anchor.attr('href'))
      if (!url) {
        dropped += 1
        return
      }
      const fullText = text(item.text())
      const titleNode = item.find('.t,.title,[data-title],strong,h3').first()
      const title = text(titleNode.text()) || text(anchor.text()) || fullText
      if (!title) return
      const detailNode = item.find('.m,.detail,.description').first()
      const detail = detailNode.length
        ? text(detailNode.text())
        : fullText.startsWith(title) ? fullText.slice(title.length).trim() : ''
      if (section.items.some((existing) => existing.url === url && existing.title === title)) return
      if (section.items.length >= maxItems) {
        truncated = true
        return
      }
      const severity = id === 'urgent' || item.is('.h-hot,.hot') || item.find('.h-hot,.hot').length
        ? 'hot'
        : item.is('.h-watch,.watch') || item.find('.h-watch,.watch').length
          ? 'watch'
          : undefined
      const initials = text(item.find('.av,.initials').first().text())
      const result: DashboardItem = {
        id: `reference-${id}-${section.items.length}`,
        title,
        detail,
        url,
        source: 'reference',
        ...(referenceAsOf ? { sourceDate: referenceAsOf } : {}),
        ...(initials ? { initials } : {}),
        ...(severity ? { severity } : {}),
      }
      section.items.push(result)
    })
  })
  if (!referenceAsOf) warnings.push('Saved briefing has no identifiable “Last refreshed” date.')
  if (dropped) warnings.push(`Saved briefing: ${dropped} item(s) omitted because their source link is missing or unsafe.`)
  if (truncated) warnings.push('Saved briefing sections were limited to the configured item count.')
  if (!sections.size) warnings.push('Saved briefing has no recognized dashboard sections.')
  const attention = classifyAttention(sections.get('urgent')?.items ?? [])
  return { sections: [...sections.values()], ...(referenceAsOf ? { referenceAsOf } : {}), warnings, available: true, attention, captions }
}

/** Read an optional local briefing without preventing independent live reads.
 * @param path Explicitly configured local HTML path, if any.
 * @param maxItems Maximum retained items per section.
 * @param signal Cancellation shared with the live provider.
 * @returns Parsed reference content or a visible read-failure warning.
 */
export async function loadReference(path: string | undefined, maxItems: number, signal: AbortSignal): Promise<ReferenceResult> {
  if (!path) return { sections: [], warnings: [], available: false }
  try {
    signal.throwIfAborted()
    return parseReferenceHtml(await readFile(path, { encoding: 'utf8', signal }), maxItems)
  } catch (error) {
    signal.throwIfAborted()
    return { sections: [], warnings: [`Saved briefing could not be read — ${safeError(error)}. Live sources are unaffected.`], available: false }
  }
}
