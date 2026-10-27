/** Calendar dates use the configured IANA zone; Graph can also return Windows zone names. */
import { DateTime, IANAZone } from 'luxon'
import { z } from 'zod'
import type { AllocationCategory, CalendarItem, DashboardItem, PersonalOptions } from '../shared/types.ts'
import { safeSourceUrl } from '../shared/urls.ts'

const address = z.object({ name: z.string().nullable().optional(), address: z.string().nullable().optional() })
const graphTime = z.object({ dateTime: z.string(), timeZone: z.string() })
const eventSchema = z.object({
  id: z.string().min(1),
  subject: z.string().nullable(),
  start: graphTime,
  end: graphTime,
  responseStatus: z.object({ response: z.enum(['none', 'organizer', 'tentativelyAccepted', 'accepted', 'declined', 'notResponded']) }),
  organizer: z.object({ emailAddress: address }).nullable().optional(),
  isOnlineMeeting: z.boolean(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  showAs: z.enum(['free', 'tentative', 'busy', 'oof', 'workingElsewhere', 'unknown']),
  webLink: z.string().nullable().optional(),
  bodyPreview: z.string().nullable().optional(),
  categories: z.array(z.string()).optional(),
})

// Graph's default UTC and common Windows zones are not IANA identifiers.
const windowsZones: Record<string, string> = {
  UTC: 'UTC',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
}

export interface CalendarWindow {
  now: DateTime
  today: DateTime
  nextBusinessDay: DateTime
  weekStart: DateTime
  start: DateTime
  end: DateTime
}

export interface ParsedEvent {
  item: CalendarItem
  start: DateTime
  end: DateTime
  meeting: boolean
  oof: boolean
  focus: boolean
  category: AllocationCategory
  showAs: string
}

/** Include the displayed workweek and all of next week for absence notices.
 * @param options Injected clock and configured timezone.
 * @returns Local calendar dates and exclusive query end.
 */
export function calendarWindow(options: Pick<PersonalOptions, 'now' | 'timeZone'>): CalendarWindow {
  const now = DateTime.fromJSDate(options.now(), { zone: options.timeZone })
  if (!now.isValid) throw new Error('Personal dashboard requires a valid clock and IANA timezone.')
  const today = now.startOf('day')
  let nextBusinessDay = today.plus({ days: 1 })
  while (nextBusinessDay.weekday > 5) nextBusinessDay = nextBusinessDay.plus({ days: 1 })
  const weekStart = nextBusinessDay.startOf('week')
  const start = DateTime.min(today, weekStart)
  const end = today.startOf('week').plus({ weeks: 2 })
  return { now, today, nextBusinessDay, weekStart, start, end }
}

function eventTime(value: z.infer<typeof graphTime>, displayZone: string): DateTime | undefined {
  const zone = windowsZones[value.timeZone] ?? value.timeZone
  const explicitOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime)
  if (!explicitOffset && !IANAZone.isValidZone(zone) && zone !== 'UTC') return undefined
  const result = DateTime.fromISO(value.dateTime, { zone, setZone: true })
  return result.isValid ? result.setZone(displayZone) : undefined
}

function classify(subject: string, categories: string[], focus: boolean): AllocationCategory {
  const label = `${subject} ${categories.join(' ')}`
  if (focus) return 'focus'
  if (/\b(training|learning|workshop|course|webinar|certification)\b/i.test(label)) return 'training'
  if (/\b(customer|client|external|partner)\b/i.test(label)) return 'customer'
  if (/\b(admin|administration|expense|timesheet|inbox|planning time)\b/i.test(label)) return 'admin'
  return 'internal'
}

function isFocusLabel(label: string): boolean {
  return /^(?:focus|no[- ]meetings?)$/i.test(label.trim())
    || /\b(?:focus[- ](?:time|blocks?|days?|fridays?)|deep[- ]work|no[- ]meetings?[- ](?:days?|fridays?|blocks?|time))\b/i.test(label)
}

/** Validate calendar rows and retain only active, correctly timed events.
 * @param rows Untrusted Graph event records.
 * @param timeZone Display timezone.
 * @param warnings Destination for incomplete or unsafe-source diagnostics.
 * @returns Valid events; invalid rows are omitted rather than represented as free time.
 */
export function parseEvents(rows: unknown[], timeZone: string, warnings: string[]): ParsedEvent[] {
  const events: ParsedEvent[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const parsed = eventSchema.safeParse(row)
    if (!parsed.success) {
      warnings.push('Calendar contained an invalid or incomplete event; calendar totals are partial.')
      continue
    }
    const event = parsed.data
    if (event.isCancelled || event.responseStatus.response === 'declined') continue
    const start = eventTime(event.start, timeZone)
    const end = eventTime(event.end, timeZone)
    if (!start || !end || end <= start) {
      warnings.push('Calendar contained an invalid time or unsupported timezone; calendar totals are partial.')
      continue
    }
    const identity = `${event.id}:${start.toMillis()}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const title = event.subject?.trim() || '(Untitled event)'
    const categories = event.categories ?? []
    const focus = isFocusLabel(title) || categories.some(isFocusLabel)
    const oof = event.showAs === 'oof' || /\b(?:oof|ooo|out[- ]of[- ]office|pto|vacation|annual leave)\b/i.test(title)
    let url = safeSourceUrl(event.webLink)
    if (!url) {
      if (event.webLink) warnings.push('Calendar contained an unsafe source link; the event uses its Outlook item link.')
      url = `https://outlook.office.com/calendar/item/${encodeURIComponent(event.id)}`
    }
    events.push({
      start,
      end,
      meeting: !event.isAllDay && !oof && !focus,
      oof,
      focus,
      category: classify(title, categories, focus),
      showAs: event.showAs,
      item: {
        id: event.id,
        title,
        start: start.toISO()!,
        end: end.toISO()!,
        url,
        organizer: event.organizer?.emailAddress.name ?? event.organizer?.emailAddress.address ?? '',
        response: event.responseStatus.response,
        online: event.isOnlineMeeting,
        allDay: event.isAllDay,
        free: event.showAs === 'free',
        conflict: false,
        optionalOverlap: false,
        preview: event.bodyPreview ?? '',
      },
    })
  }
  events.sort((a, b) => a.start.toMillis() - b.start.toMillis() || a.item.id.localeCompare(b.item.id))
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    if (!event.meeting) continue
    for (let j = i + 1; j < events.length; j += 1) {
      const other = events[j]!
      if (other.start >= event.end) break
      if (!other.meeting || other.end <= event.start) continue
      const uncertain = [event, other].some((entry) => entry.item.free || entry.showAs === 'tentative' || entry.showAs === 'unknown' || entry.item.response === 'tentativelyAccepted')
      if (uncertain) {
        event.item.optionalOverlap = true
        other.item.optionalOverlap = true
      } else {
        event.item.conflict = true
        other.item.conflict = true
      }
    }
  }
  return events
}

/** Test overlap against an exclusive-end interval.
 * @param event Parsed calendar event.
 * @param start Inclusive interval start.
 * @param end Exclusive interval end.
 * @returns Whether any of the event occurs in the interval.
 */
export function occursDuring(event: ParsedEvent, start: DateTime, end: DateTime): boolean {
  return event.start < end && event.end > start
}

/** Convert one live calendar record into a source-linked section item.
 * @param event Parsed calendar event.
 * @returns Calendar evidence without inferring attendance or obligations.
 */
export function calendarCard(event: ParsedEvent): DashboardItem {
  return {
    id: `calendar-${event.item.id}`,
    title: event.item.title,
    detail: `${event.start.toFormat('ccc, LLL d · HH:mm')} — ${event.end.toFormat('ccc, LLL d · HH:mm')}${event.item.organizer ? ` · Organizer: ${event.item.organizer}` : ''}${event.item.preview ? ` · ${event.item.preview}` : ''}`,
    url: event.item.url,
    source: 'live',
    sourceDate: event.start.toISO()!,
  }
}
