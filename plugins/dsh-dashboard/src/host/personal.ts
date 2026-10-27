/** Independent, read-only M365 sources; missing evidence never becomes a zero count. */
import { DateTime } from 'luxon'
import { z } from 'zod'
import type {
  AllocationCategory,
  DashboardItem,
  DashboardSection,
  PersonalOptions,
  PersonalSnapshot,
  ReadOnlyMcp,
  SectionId,
  SourceStatus,
} from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'
import { calendarCard, calendarWindow, occursDuring, parseEvents } from './personal-calendar.ts'
import { projectChats } from './personal-chats.ts'
import { buildPersonalInsights } from './personal-insights.ts'
import { loadReference } from './reference.ts'
import { safeError } from './mcp.ts'
import { loadAttentionBriefing } from './personal-attention.ts'

const fetchSchema = z.object({
  results: z.array(z.object({ statusCode: z.number().int(), data: z.unknown().optional(), error: z.unknown().optional() })).length(1),
  note: z.string().nullable().optional(),
})
const objectSchema = z.record(z.string(), z.unknown())
const profileSchema = z.object({ id: z.string().min(1), displayName: z.string().min(1), mail: z.string().nullable().optional() })
const inboxSchema = z.object({
  unreadItemCount: z.number().int().nonnegative().optional(),
  totalItemCount: z.number().int().nonnegative().optional(),
})
const addressSchema = z.object({ emailAddress: z.object({ name: z.string().nullable().optional(), address: z.string().nullable().optional() }) })
const mailSchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullable(),
  from: addressSchema.nullable().optional(),
  receivedDateTime: z.string(),
  isRead: z.boolean(),
  importance: z.enum(['low', 'normal', 'high']),
  flag: z.object({ flagStatus: z.enum(['notFlagged', 'complete', 'flagged']) }),
  bodyPreview: z.string().nullable().optional(),
  webLink: z.string().nullable().optional(),
})
const fileSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  folder: objectSchema.nullable().optional(),
  webUrl: z.string(),
  lastModifiedDateTime: z.string().nullable().optional(),
})

interface Resource {
  data?: Record<string, unknown>
  status: SourceStatus
  warnings: string[]
}

interface Collection extends Resource {
  rows: unknown[]
}

function query(path: string, values: Record<string, string | number>): string {
  return `${path}?${Object.entries(values).map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%2F/g, '/')}`).join('&')}`
}

function warn(resource: Resource, message: string): void {
  resource.warnings.push(message)
  if (resource.status.state !== 'unavailable') resource.status.state = 'partial'
  resource.status.message = message
}

function errorDetail(value: unknown): string | undefined {
  if (value instanceof Error || typeof value === 'string') return safeError(value)
  const diagnostic = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(value)
  if (!diagnostic.success) return undefined
  const detail = [diagnostic.data.code, diagnostic.data.message].filter(Boolean).join(': ')
  return detail ? safeError(detail) : undefined
}

function isPageSizeAdvisory(note: string): boolean {
  return /^Results limited to \d+ items per collection\b/i.test(note)
    && !/\b(?:truncat(?:ed|ion)|incomplete|partial|omitted|dropped|unavailable|failed|timeout|timed out|could not|not all)\b/i.test(note)
}

async function fetchResource(mcp: ReadOnlyMcp, id: string, path: string, updatedAt: string, signal: AbortSignal): Promise<Resource> {
  const resource: Resource = { status: { id, state: 'unavailable', updatedAt }, warnings: [] }
  try {
    signal.throwIfAborted()
    const result = fetchSchema.safeParse(await mcp.call('fetch', { entityUrls: [path] }, signal))
    signal.throwIfAborted()
    if (!result.success) {
      warn(resource, `${id}: WorkIQ returned an invalid or missing response.`)
      return resource
    }
    const entity = result.data.results[0]!
    const data = objectSchema.safeParse(entity.data)
    const providerError = entity.error ?? (data.success ? data.data.error : undefined)
    const detail = errorDetail(providerError) ?? errorDetail(entity.data)
    if (entity.statusCode !== 200) {
      warn(resource, `${id}: WorkIQ returned HTTP ${entity.statusCode}${detail ? ` — ${detail}` : ''}; data is unavailable.`)
      return resource
    }
    if (!data.success) {
      warn(resource, `${id}: WorkIQ returned no valid resource data.`)
      return resource
    }
    if (providerError != null) {
      warn(resource, `${id}: WorkIQ returned an error instead of usable resource data${detail ? ` — ${detail}` : ''}.`)
      return resource
    }
    resource.status.state = 'live'
    resource.data = data.data
    const note = result.data.note?.trim()
    if (note) {
      if (isPageSizeAdvisory(note)) resource.status.message = safeError(note)
      else warn(resource, `${id}: ${safeError(note)}`)
    }
  } catch (error) {
    signal.throwIfAborted()
    warn(resource, `${id}: the read request failed — ${safeError(error)}. Other sources are unaffected.`)
  }
  return resource
}

function collection(resource: Resource): Collection {
  if (!resource.data) return { ...resource, rows: [] }
  if (!Array.isArray(resource.data.value)) {
    resource.status.state = 'unavailable'
    warn(resource, `${resource.status.id}: the response has no valid collection; its contents are unknown.`)
    return { ...resource, data: undefined, rows: [] }
  }
  return { ...resource, rows: [...resource.data.value] }
}

/** Admit only continuation URLs for the original calendar collection.
 * @param value Untrusted Graph nextLink.
 * @returns Relative WorkIQ path with its opaque query preserved byte-for-byte.
 */
export function calendarNextPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\s\\#\u0000-\u001f]/.test(value) || value.startsWith('//')) return undefined
  let path = value
  if (!value.startsWith('/')) {
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || url.username || url.password || url.port) return undefined
      path = value.slice(value.indexOf('/', value.indexOf('://') + 3))
    } catch {
      return undefined
    }
  }
  path = path.replace(/^\/v1\.0(?=\/)/i, '')
  if (!/^\/me\/calendarView\?[^#]+$/i.test(path)) return undefined
  return path
}

async function fetchCalendar(mcp: ReadOnlyMcp, path: string, options: PersonalOptions, updatedAt: string, signal: AbortSignal): Promise<Collection> {
  const resource = collection(await fetchResource(mcp, 'calendar', path, updatedAt, signal))
  if (!resource.data) return resource
  const seen = new Set([path])
  let next = resource.data['@odata.nextLink']
  let pages = 1
  while (next !== undefined && next !== null) {
    const nextPath = calendarNextPath(next)
    if (!nextPath) {
      warn(resource, 'Calendar pagination returned an unsafe or unsupported continuation; calendar totals are partial.')
      break
    }
    if (seen.has(nextPath)) {
      warn(resource, 'Calendar pagination repeated a page; calendar totals are partial.')
      break
    }
    if (pages >= options.maxCalendarPages) {
      warn(resource, 'Calendar page limit reached; calendar totals are partial.')
      break
    }
    seen.add(nextPath)
    const page = collection(await fetchResource(mcp, 'calendar', nextPath, updatedAt, signal))
    pages += 1
    resource.warnings.push(...page.warnings)
    if (!page.data) {
      warn(resource, 'A calendar page could not be loaded; earlier calendar events remain visible and totals are partial.')
      break
    }
    if (page.status.state === 'partial') resource.status.state = 'partial'
    resource.rows.push(...page.rows)
    next = page.data['@odata.nextLink']
  }
  return resource
}

function boundCollection(resource: Collection, maxItems: number): void {
  if (resource.data && resource.data['@odata.nextLink'] !== undefined && resource.data['@odata.nextLink'] !== null) {
    warn(resource, `${resource.status.id}: only the bounded first page is shown; more items are available.`)
  }
  if (resource.rows.length > maxItems) {
    resource.rows = resource.rows.slice(0, maxItems)
    warn(resource, `${resource.status.id}: results were limited to the configured item count.`)
  }
}

function eventDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const parsed = DateTime.fromISO(value, { setZone: true })
  return parsed.isValid ? parsed.toISO()! : undefined
}

function isAutomatedMail(message: z.infer<typeof mailSchema>): boolean {
  const sender = message.from?.emailAddress.address?.trim().split('@')[0] ?? ''
  return /(?:^|[._+-])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|alerts?|newsletters?|mailer-daemon|postmaster|icm)(?:$|[._+-])/i.test(sender)
    || /\b(?:newsletter|(?:daily|weekly|monthly)\s+digest)\b/i.test(message.subject ?? '')
    || /^\s*(?:\[IcM\]|IcM\s*[:—-])/i.test(message.subject ?? '')
    || /\b(?:unsubscribe|manage (?:your )?(?:email|notification) preferences)\b/i.test(message.bodyPreview ?? '')
}

function mailCards(resource: Collection, since: DateTime, until: DateTime): { items: DashboardItem[]; replies: DashboardItem[] } {
  const messages: { item: DashboardItem; timestamp: number; replyCandidate: boolean }[] = []
  const seen = new Set<string>()
  for (const row of resource.rows) {
    const parsed = mailSchema.safeParse(row)
    if (!parsed.success) {
      warn(resource, 'mail: an invalid or incomplete message was omitted.')
      continue
    }
    const message = parsed.data
    const sourceDate = eventDate(message.receivedDateTime)
    if (!sourceDate) {
      warn(resource, 'mail: a message with an invalid received date was omitted.')
      continue
    }
    const received = DateTime.fromISO(sourceDate)
    if (received < since || received > until) continue
    if (seen.has(message.id) || (message.isRead && message.importance !== 'high' && message.flag.flagStatus !== 'flagged')) continue
    seen.add(message.id)
    let url = safeSourceUrl(message.webLink)
    if (!url) {
      if (message.webLink) warn(resource, 'mail: an unsafe source link was replaced with the message’s Outlook item link.')
      url = `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(message.id)}`
    }
    const sender = message.from?.emailAddress.name ?? message.from?.emailAddress.address
    const flags = [message.isRead ? '' : 'Unread', message.importance === 'high' ? 'High importance' : '', message.flag.flagStatus === 'flagged' ? 'Flagged' : ''].filter(Boolean)
    const replyCandidate = !isAutomatedMail(message)
    messages.push({
      timestamp: received.toMillis(),
      replyCandidate,
      item: {
        id: `mail-${message.id}`,
        title: message.subject?.trim() || '(Untitled email)',
        detail: `${flags.join(' · ')}${sender ? ` · From: ${sender}` : ''}${message.bodyPreview ? ` · ${message.bodyPreview}` : ''} · ${replyCandidate ? 'Heuristic candidate; may already have been replied to.' : 'Automated message signal; not a reply candidate.'}`,
        url,
        source: 'live',
        sourceDate,
        ...(message.importance === 'high' ? { severity: 'hot' as const } : message.flag.flagStatus === 'flagged' ? { severity: 'watch' as const } : {}),
      },
    })
  }
  messages.sort((a, b) => b.timestamp - a.timestamp)
  return { items: messages.map(({ item }) => item), replies: messages.filter(({ replyCandidate }) => replyCandidate).map(({ item }) => item) }
}

function fileCards(resource: Collection): DashboardItem[] {
  const items: DashboardItem[] = []
  for (const row of resource.rows) {
    const parsed = fileSchema.safeParse(row)
    const url = parsed.success ? safeSourceUrl(parsed.data.webUrl) : undefined
    if (!parsed.success || !url) {
      warn(resource, 'files: an item with invalid metadata or a missing/unsafe source link was omitted.')
      continue
    }
    const file = parsed.data
    const sourceDate = eventDate(file.lastModifiedDateTime)
    if (file.lastModifiedDateTime && !sourceDate) warn(resource, 'files: an invalid last-modified date was omitted.')
    items.push({
      id: `file-${file.id}`,
      title: file.name,
      detail: `${file.folder ? 'Folder' : 'File'} in OneDrive root${sourceDate ? ` · Modified ${sourceDate}` : ''}`,
      url,
      source: 'live',
      ...(sourceDate ? { sourceDate } : {}),
    })
  }
  return items
}

/** Load independent M365 resources and a separately dated, optional saved briefing.
 * @param mcp Fetch-only source transport; no external mutations or model requests.
 * @param options Clock, timezone, local briefing path, and resource bounds.
 * @param signal Cancellation owned by the dashboard host.
 * @returns Evidence-labelled live/partial/reference data without guessed unknown counts.
 */
export async function loadPersonal(mcp: ReadOnlyMcp, options: PersonalOptions, signal: AbortSignal): Promise<PersonalSnapshot> {
  signal.throwIfAborted()
  const window = calendarWindow(options)
  const generatedAt = window.now.toUTC().toISO()!
  const recentMailStart = window.now.toUTC().minus({ days: 7 })
  const calendarPath = query('/me/calendarView', {
    startDateTime: window.start.toISO()!,
    endDateTime: window.end.toISO()!,
    $select: 'id,subject,start,end,responseStatus,organizer,isOnlineMeeting,isAllDay,isCancelled,showAs,webLink,bodyPreview,categories',
    $orderby: 'start/dateTime',
    $top: options.maxItems,
  })
  const profileRead = fetchResource(mcp, 'profile', query('/me', { $select: 'id,displayName,mail' }), generatedAt, signal)
  const attentionRead = profileRead.then(resource => {
    const person = profileSchema.safeParse(resource.data)
    return loadAttentionBriefing(mcp, person.success && person.data.mail
      ? { displayName: person.data.displayName, email: person.data.mail } : null,
      { asOf: generatedAt, timeZone: options.timeZone, ...options.attention }, signal)
  })
  const [profile, inbox, calendar, mailResult, chatResult, fileResult, reference, attention] = await Promise.all([
    profileRead,
    fetchResource(mcp, 'inbox', query('/me/mailFolders/inbox', { $select: 'id,unreadItemCount,totalItemCount' }), generatedAt, signal),
    fetchCalendar(mcp, calendarPath, options, generatedAt, signal),
    fetchResource(mcp, 'mail', query('/me/mailFolders/inbox/messages', {
      $select: 'id,subject,from,receivedDateTime,isRead,importance,flag,bodyPreview,webLink',
      $filter: `receivedDateTime ge ${recentMailStart.toISO()!} and receivedDateTime le ${generatedAt} and (isRead eq false or flag/flagStatus eq 'flagged' or importance eq 'high')`,
      $orderby: 'receivedDateTime desc',
      $top: options.maxItems,
    }), generatedAt, signal),
    fetchResource(mcp, 'chats', query('/me/chats', {
      $select: 'id,topic,chatType,webUrl,viewpoint',
      $expand: 'lastMessagePreview',
      $top: options.maxItems,
    }), generatedAt, signal),
    fetchResource(mcp, 'files', query('/me/drive/root/children', {
      $select: 'id,name,folder,webUrl,lastModifiedDateTime',
      $orderby: 'lastModifiedDateTime desc',
      $top: options.maxItems,
    }), generatedAt, signal),
    loadReference(options.referencePath, options.maxItems, signal),
    attentionRead,
  ])
  signal.throwIfAborted()
  const mail = collection(mailResult)
  const chats = collection(chatResult)
  const files = collection(fileResult)
  for (const resource of [mail, chats, files]) boundCollection(resource, options.maxItems)

  const person = profileSchema.safeParse(profile.data)
  if (profile.data && !person.success) {
    profile.status.state = 'unavailable'
    warn(profile, 'profile: the current-user profile is incomplete or invalid.')
  }
  const counts = inboxSchema.safeParse(inbox.data)
  let unreadEmails: number | null = null
  if (inbox.data) {
    if (counts.success && counts.data.unreadItemCount !== undefined) unreadEmails = counts.data.unreadItemCount
    else warn(inbox, 'inbox: the unread count is missing or invalid; it remains unknown.')
    if (!counts.success || counts.data.totalItemCount === undefined) warn(inbox, 'inbox: the total message count is missing or invalid.')
  }
  const calendarWarnings: string[] = []
  const events = parseEvents(calendar.rows, options.timeZone, calendarWarnings)
  for (const message of calendarWarnings) warn(calendar, message)
  const hasCalendar = calendar.data !== undefined
  const completeCalendar = calendar.status.state === 'live'
  const tomorrowEnd = window.nextBusinessDay.plus({ days: 1 })
  const nextDayEvents = events.filter((event) => occursDuring(event, window.nextBusinessDay, tomorrowEnd))
  const todayEnd = window.today.plus({ days: 1 })
  const weekEnd = window.weekStart.plus({ days: 5 })
  const weekEvents = events.filter((event) => occursDuring(event, window.weekStart, weekEnd))
  const absenceEvents = events.filter((event) => event.oof && occursDuring(event, window.now, window.end))
  const trainingEvents = events.filter((event) => event.category === 'training' && event.meeting && occursDuring(event, window.now, window.end))
  const weekLoad = hasCalendar
    ? Array.from({ length: 5 }, (_, index) => {
        const day = window.weekStart.plus({ days: index })
        const end = day.plus({ days: 1 })
        const meetings = weekEvents.filter((event) => event.meeting && occursDuring(event, day, end))
        return {
          date: day.toISODate()!,
          meetings: meetings.length,
          minutes: meetings.reduce((sum, event) => sum + DateTime.min(event.end, end).diff(DateTime.max(event.start, day), 'minutes').minutes, 0),
        }
      })
    : []
  const categoryMinutes = new Map<AllocationCategory, number>([['customer', 0], ['training', 0], ['internal', 0], ['focus', 0], ['admin', 0]])
  for (const event of weekEvents) {
    if (event.item.allDay || event.oof || event.item.free) continue
    const minutes = DateTime.min(event.end, weekEnd).diff(DateTime.max(event.start, window.weekStart), 'minutes').minutes
    categoryMinutes.set(event.category, categoryMinutes.get(event.category)! + minutes)
  }
  const totalMinutes = [...categoryMinutes.values()].reduce((sum, minutes) => sum + minutes, 0)
  const allocation = hasCalendar && totalMinutes > 0
    ? [...categoryMinutes].map(([category, minutes]) => ({ category, minutes, percent: minutes / totalMinutes * 100 }))
    : []

  const emails = mailCards(mail, recentMailStart, window.now)
  const chatProjection = projectChats(chats.rows, person.success ? person.data.id : undefined)
  for (const message of chatProjection.warnings) warn(chats, message)
  const teamsUnread = chats.data && chats.status.state === 'live' && chatProjection.completeUnreadEvidence ? chatProjection.unreadFound : null
  const chatNote = `${chatProjection.unreadFound} unread chat(s) found among ${chatProjection.items.length} loaded; ${teamsUnread === null ? 'total unknown' : 'all chats loaded'}. Unread means a nondeleted incoming latest message is newer than its last-read timestamp; system/self-sent messages are excluded. ${chatProjection.unreadFound ? 'Other rows are recent-chat fallbacks, not verified unread.' : 'Showing recent-chat fallbacks, not verified unread messages.'} Previews are plain text.`
  const fileItems = fileCards(files)
  const savedSections = new Map(reference.sections.map((section) => [section.id, section]))
  const sections: DashboardSection[] = []
  const liveSection = (id: SectionId, resource: Resource, items: DashboardItem[], note: string): DashboardSection => ({
    id, items, source: resource.status.state, note,
  })
  for (const id of ['urgent', 'prep', 'projects', 'reply', 'actions', 'people'] as const) {
    const saved = savedSections.get(id)
    if (id === 'urgent') sections.push(attention.section)
    else if (saved) sections.push(saved)
    else if (id === 'reply') {
      sections.push(liveSection(id, mail, emails.replies,
        'Inbox reply candidates from the last seven days; automated senders/newsletters are heuristically excluded. Not verified obligations; messages may already have been replied to.'))
    } else if (id === 'prep') {
      sections.push(liveSection(id, calendar, nextDayEvents.filter((event) => event.meeting && event.item.preview).slice(0, options.maxItems).map(calendarCard),
        'Next-business-day calendar descriptions, not inferred preparation requirements.'))
    } else sections.push({ id, items: [], source: 'unavailable', note: 'No dated saved briefing is available for this section.' })
  }
  for (const [id, resource, items, note] of [
    ['training', calendar, trainingEvents.map(calendarCard), 'Calendar titles/categories suggest learning sessions; no course-completion or task status is inferred.'],
    ['oof', calendar, absenceEvents.map(calendarCard), 'Calendar absence notices and your own out-of-office status. An organizer’s name does not prove that person is away.'],
    ['chats', chats, chatProjection.items, chatNote],
    ['files', files, fileItems, 'Bounded OneDrive root children, ordered by last-modified time; not all recent files across Microsoft 365.'],
  ] as const) {
    if (resource.data) sections.push(liveSection(id, resource, items.slice(0, options.maxItems), note))
    else sections.push(savedSections.get(id) ?? liveSection(id, resource, [], note))
  }
  if (hasCalendar) {
    const detail = 'Calendar meeting totals exclude cancelled, declined, all-day, focus, and absence notices. Free/tentative overlaps are separate from busy conflicts. Allocation uses title/category heuristics, counts overlapping events separately, and excludes free/all-day/absence time.'
    calendar.status.message = `${calendar.status.state === 'partial' ? 'Partial calendar: displayed loads and allocation use only loaded events; complete counts are unknown. ' : ''}${detail}`
  }
  const referenceStatus: SourceStatus = {
    id: 'reference',
    state: reference.available ? 'reference' : 'unavailable',
    updatedAt: generatedAt,
    message: reference.available
      ? `Saved briefing only${reference.referenceAsOf ? ` — ${reference.referenceAsOf}` : '; original date unavailable'}. Not verified live or automatically recomputed.`
      : options.referencePath ? 'The saved briefing could not be read.' : 'No saved briefing configured.',
  }
  const resources = [profile, inbox, calendar, mail, chats, files]
  const snapshot: PersonalSnapshot = {
    kind: 'personal',
    generatedAt,
    timeZone: options.timeZone,
    displayName: person.success ? person.data.displayName : 'Personal work',
    ...(person.success && person.data.mail ? { email: person.data.mail } : {}),
    nextBusinessDay: window.nextBusinessDay.toISODate()!,
    sources: [...resources.map((resource) => resource.status), referenceStatus, {
      id: 'attention', state: attention.section.source, updatedAt: generatedAt, message: attention.section.note,
    }],
    metrics: {
      overdueActions: null,
      attentionItems: sections.find((section) => section.id === 'urgent')?.items.length ?? 0,
      unreadEmails,
      meetingsNextDay: completeCalendar ? nextDayEvents.filter((event) => event.meeting).length : null,
      teamsUnread,
      projects: sections.find((section) => section.id === 'projects')?.items.length ?? 0,
      oof: completeCalendar ? absenceEvents.length : null,
    },
    schedule: nextDayEvents.map((event) => event.item),
    todayRemaining: events.filter((event) => occursDuring(event, window.now, todayEnd)).map((event) => event.item),
    weekLoad,
    allocation,
    sections,
    ...(reference.referenceAsOf ? { referenceAsOf: reference.referenceAsOf } : {}),
    warnings: [...new Set([...resources.flatMap((resource) => resource.warnings), ...reference.warnings, ...attention.warnings])],
  }
  snapshot.insights = buildPersonalInsights(snapshot, { events, window, reference, chats: chatProjection, attention: attention.annotations })
  return snapshot
}
