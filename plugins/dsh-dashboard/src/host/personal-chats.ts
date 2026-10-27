/** Chat previews are read-only evidence; collection samples cannot establish tenant-wide counts. */
import { load } from 'cheerio'
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { DashboardItem } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'

const chatSchema = z.object({
  id: z.string().min(1),
  topic: z.string().nullable().optional(),
  chatType: z.enum(['oneOnOne', 'group', 'meeting', 'unknownFutureValue']),
  webUrl: z.string(),
  viewpoint: z.unknown().optional(),
  lastMessagePreview: z.unknown().optional(),
})
const viewpointSchema = z.object({ lastMessageReadDateTime: z.string().nullable().optional() })
const previewSchema = z.object({
  body: z.object({ content: z.string().nullable().optional(), contentType: z.enum(['html', 'text']) }).nullable().optional(),
  createdDateTime: z.string().nullable().optional(),
  from: z.object({
    user: z.object({ displayName: z.string().nullable().optional(), id: z.string().nullable().optional() }).nullable().optional(),
  }).nullable().optional(),
  isDeleted: z.boolean().optional(),
  messageType: z.string().nullable().optional(),
})
const MAX_PREVIEW_CHARACTERS = 280

export interface ChatProjection {
  items: DashboardItem[]
  unreadFound: number
  completeUnreadEvidence: boolean
  warnings: string[]
}

function timestamp(value: string | null | undefined): DateTime | undefined {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined
  const parsed = DateTime.fromISO(value, { setZone: true })
  return parsed.isValid ? parsed : undefined
}

function previewText(body: z.infer<typeof previewSchema>['body']): string {
  if (!body?.content) return ''
  let text = body.content
  if (body.contentType === 'html') {
    const $ = load(body.content)
    $('script,style,iframe,object,embed,template,svg,math,form,input,button,noscript').remove()
    $('br').replaceWith(' ')
    $('p,div,li,section,article,h1,h2,h3,h4,h5,h6,tr').append(' ')
    text = $('body').text()
  }
  text = text.replace(/\s+/g, ' ').trim()
  const characters = Array.from(text)
  return characters.length > MAX_PREVIEW_CHARACTERS ? `${characters.slice(0, MAX_PREVIEW_CHARACTERS - 1).join('').trimEnd()}…` : text
}

/** Compare each latest incoming message with that chat's last-read timestamp.
 * A newer excluded latest message leaves earlier incoming-message state unknown.
 * @param rows Untrusted chat metadata with verified viewpoint/preview fields.
 * @param currentUserId Current /me identity used to exclude self-sent messages.
 * @returns Unread-first plain-text cards, sample count, and completeness of row evidence.
 */
export function projectChats(rows: unknown[], currentUserId: string | undefined): ChatProjection {
  const cards: { item: DashboardItem; unread: boolean; timestamp: number }[] = []
  const warnings: string[] = []
  let completeUnreadEvidence = true
  let missingEvidence = 0
  let inconclusiveLatestCount = 0
  const seen = new Set<string>()
  for (const row of rows) {
    const parsed = chatSchema.safeParse(row)
    const url = parsed.success ? safeSourceUrl(parsed.data.webUrl) : undefined
    if (!parsed.success || !url) {
      warnings.push('chats: a chat with invalid metadata or a missing/unsafe source link was omitted.')
      completeUnreadEvidence = false
      continue
    }
    const chat = parsed.data
    if (seen.has(chat.id)) continue
    seen.add(chat.id)
    const viewpoint = viewpointSchema.safeParse(chat.viewpoint)
    const previewResult = previewSchema.safeParse(chat.lastMessagePreview)
    const preview = previewResult.success ? previewResult.data : undefined
    const readAt = timestamp(viewpoint.success ? viewpoint.data.lastMessageReadDateTime : undefined)
    const createdAt = timestamp(preview?.createdDateTime)
    const sender = preview?.from?.user
    const selfSent = Boolean(sender?.id && currentUserId && sender.id.toLowerCase() === currentUserId.toLowerCase())
    const systemMessage = preview?.messageType === 'systemEventMessage'
    const known = Boolean(readAt && createdAt && currentUserId && sender?.id && preview && typeof preview.isDeleted === 'boolean'
      && (preview.messageType === 'message' || systemMessage))
    const newerThanRead = Boolean(readAt && createdAt && createdAt > readAt)
    const excludedLatest = Boolean(preview?.isDeleted || systemMessage || selfSent)
    const inconclusiveLatest = known && newerThanRead && excludedLatest
    if (!known) {
      completeUnreadEvidence = false
      missingEvidence += 1
    } else if (inconclusiveLatest) {
      completeUnreadEvidence = false
      inconclusiveLatestCount += 1
    }
    const unread = known && newerThanRead && !excludedLatest
    const label = unread
      ? 'Unread latest message'
      : preview?.isDeleted
        ? 'Recent chat · Latest message deleted; not counted as unread'
        : systemMessage
          ? 'Recent chat · Latest message is a system event; not counted as unread'
          : selfSent
            ? 'Recent chat · Latest message sent by you; not counted as unread'
            : known
              ? 'Recent chat · Latest message is not newer than the read timestamp'
              : 'Recent chat · Unread state unknown'
    const content = preview?.isDeleted ? '' : previewText(preview?.body)
    const author = !preview?.isDeleted && sender?.displayName ? ` · From: ${sender.displayName}` : ''
    const fallbackTitle = chat.chatType === 'oneOnOne'
      ? !selfSent && sender?.displayName ? `Chat with ${sender.displayName}` : 'One-to-one chat'
      : chat.chatType === 'meeting' ? 'Meeting chat' : chat.chatType === 'group' ? 'Group chat' : 'Teams chat'
    cards.push({
      unread,
      timestamp: createdAt?.toMillis() ?? 0,
      item: {
        id: `chat-${chat.id}`,
        title: chat.topic?.trim() || fallbackTitle,
        detail: `${label}${inconclusiveLatest ? ' · Earlier incoming unread messages may exist' : ''}${author}${content ? ` · ${content}` : ' · Preview unavailable.'}`,
        url,
        source: 'live',
        ...(createdAt ? { sourceDate: createdAt.toISO()! } : {}),
        ...(unread ? { severity: 'active' as const } : {}),
      },
    })
  }
  if (missingEvidence) warnings.push(`chats: unread state is unknown for ${missingEvidence} chat(s) because read/latest-message evidence is missing or invalid.`)
  if (inconclusiveLatestCount) warnings.push(`chats: unread state is unknown for ${inconclusiveLatestCount} chat(s) because a newer self-sent, system, or deleted latest message may conceal earlier incoming unread messages.`)
  cards.sort((a, b) => Number(b.unread) - Number(a.unread) || b.timestamp - a.timestamp)
  return {
    items: cards.map(({ item }) => item),
    unreadFound: cards.filter(({ unread }) => unread).length,
    completeUnreadEvidence,
    warnings,
  }
}
