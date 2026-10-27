/** Deterministic interpretations of loaded records; saved statements never qualify live totals. */
import { DateTime } from 'luxon'
import type { AttentionCategory, EvidenceText, PersonalInsights } from '../shared/insights.ts'
import type { DashboardItem, PersonalSnapshot, SectionId, SourceState } from '../shared/types.ts'
import { occursDuring, type CalendarWindow, type ParsedEvent } from './personal-calendar.ts'
import type { ChatProjection } from './personal-chats.ts'
import type { ReferenceResult } from './reference.ts'

const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const namedDate = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi

function datesIn(text: string, year?: number): DateTime[] {
  const values = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?=T\d{2}:|\b)/g)].map((match) => (
    DateTime.fromObject({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }, { zone: 'UTC' })
  ))
  for (const match of text.matchAll(namedDate)) {
    const dateYear = match[3] ? Number(match[3]) : year
    if (dateYear !== undefined) values.push(DateTime.fromObject({
      year: dateYear, month: months.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1, day: Number(match[2]),
    }, { zone: 'UTC' }))
  }
  return values
}

function weekdayAgrees(text: string, date: DateTime): boolean {
  return [...text.matchAll(/\b(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)\b/gi)]
    .every((match) => weekdays.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1 === date.weekday)
}

function singleDate(text: string | undefined): DateTime | undefined {
  if (!text) return undefined
  const dates = datesIn(text)
  const unique = new Set(dates.map((date) => date.toISODate()))
  return unique.size === 1 && dates.every((date) => date.isValid && weekdayAgrees(text, date)) ? dates[0] : undefined
}

function deadline(text: string, basis: DateTime | undefined): { date: DateTime; quote: string } | undefined {
  const clauses = [...text.matchAll(/\b(?:due(?!\s+to\b)(?:\s+(?:on|by))?|deadline(?:\s+is)?\s*:?)\s+([^.;·\n]+)/gi)]
  if (clauses.length !== 1) return undefined
  const quote = clauses[0]![0].trim()
  if (/\bdue\s+to\b/i.test(quote)) return undefined
  if (/\b(?:or|and|between|through|before|after|maybe|possibly|if|estimated|approximately|around|not|no)\b/i.test(quote)) return undefined
  for (const match of quote.matchAll(namedDate)) {
    if (/^\s*(?:[-–—]|to)\s*\d/.test(quote.slice(match.index + match[0].length))) return undefined
  }
  const relative = [...quote.matchAll(/\b(today|tomorrow|yesterday)\b/gi)]
  if (relative.length > 1 || (relative.length && !basis)) return undefined
  const dates = datesIn(quote, basis?.year)
  if (dates.some((date) => !date.isValid)) return undefined
  if (relative.length) {
    const word = relative[0]![1]!.toLowerCase()
    dates.push(basis!.plus({ days: word === 'tomorrow' ? 1 : word === 'yesterday' ? -1 : 0 }))
  }
  if (new Set(dates.map((date) => date.toISODate())).size !== 1) return undefined
  const date = dates[0]
  if (!date || !weekdayAgrees(quote, date)) return undefined
  // A yearless month/day is only resolved inside the reference's nearby week, never across years.
  if (!/\b\d{4}\b/.test(quote) && basis && Math.abs(date.diff(basis, 'days').days) > 7) return undefined
  return { date, quote }
}

function evidence(text: string, source: SourceState, sourceDate: string | undefined, evidenceIds: string[]): EvidenceText {
  return { text, source, ...(sourceDate ? { sourceDate } : {}), evidenceIds: [...new Set(evidenceIds)] }
}

/** Classify explicit source language without upgrading historical statements to current obligations.
 * Relative reference deadlines use only the saved refresh date; ambiguous timing remains unclassified.
 * Due-soon means within seven civil days. Past-due and explicit Sev 0–2 language rank first, followed
 * by due-soon, waiting, standing and unclassified rows; ties retain source order.
 * @param items Retained safe-link attention rows.
 * @param asOf Classification date for live rows; reference rows use their own saved date.
 * @returns One ranked entry per row, including rows without a supported classification.
 */
export function classifyAttention(items: DashboardItem[], asOf?: string): PersonalInsights['attention'] {
  const entries = items.map((item, index) => {
    const label = `${item.title}. ${item.detail}`
    const basis = item.source === 'reference' ? singleDate(item.sourceDate) : undefined
    const comparison = item.source === 'reference' ? basis : singleDate(asOf)
    const due = deadline(label, basis)
    const negated = /\b(?:not|no longer|never)\s+(?:past[- ]due|overdue|waiting|awaiting|due|sev(?:erity)?)|\bno\s+(?:deadline|pending|overdue)\b|\b(?:resolved|completed|cancelled|canceled|withdrawn)\b/i.test(label)
    const past = !negated && label.match(/\bpast[- ]due\b|\boverdue\b|\b(?:review\s+)?window\s+(?:has\s+(?:already\s+)?)?lapsed\b|\bmissed\s+(?:the\s+)?deadline\b/i)?.[0]
    const waiting = !negated && label.match(/\b(?:waiting|awaiting)\b(?:\s+(?:on|for)\s+(?:you|your\s+(?:review|approval|response)))?|\bpending\s+(?:your\s+)?(?:review|approval|response)\b/i)?.[0]
    const standing = !negated && label.match(/\bstanding\s+(?:ownership|sweep|task|KPI)\b|\bongoing\s+(?:\S+\s+)?KPI\b|\brecurring\s+(?:task|sweep)\b/i)?.[0]
    let category: AttentionCategory = 'unclassified'
    let consequence = !negated && due
      ? `Source deadline ${due.date.toISODate()}; ${comparison ? 'outside the seven-day due-soon window' : 'refresh date is not established'}.`
      : 'Timing and consequence are not established by this row.'
    if (!negated && past) {
      category = 'pastDue'
      consequence = `Source says “${past}”.`
    } else if (!negated && due && comparison && due.date < comparison) {
      category = 'pastDue'
      consequence = `Deadline ${due.date.toISODate()} precedes the ${item.source === 'reference' ? 'saved refresh' : 'fetch'} date.`
    } else if (!negated && due && comparison && due.date.diff(comparison, 'days').days <= 7) {
      category = 'dueSoon'
      consequence = `Due ${due.date.toISODate()} — source says “${due.quote}”.`
    } else if (waiting) {
      category = 'waiting'
      consequence = `Source says “${waiting}”; the responsible person is not inferred.`
    } else if (standing) {
      category = 'standing'
      consequence = `Source says “${standing}”.`
    }
    const severity = !negated && label.match(/\b(?:sev(?:erity)?\s*[-:]?\s*([0-2]))(?:\b)(?!\.\d)/i)
    const explicitCritical = Boolean(past || (severity && Number(severity[1]) <= 2))
    if (category === 'unclassified' && explicitCritical && severity) consequence = `Source says “${severity[0]}”; no deadline is established.`
    const weekendBasis = comparison
    const saturday = weekendBasis?.startOf('week').plus({ days: 5 })
    const thisWeekend = Boolean(!negated && due && saturday && due.date >= saturday && due.date < saturday.plus({ days: 2 }))
    const priority = category === 'pastDue' || explicitCritical ? 0 : category === 'dueSoon' ? 1 : category === 'waiting' ? 2 : category === 'standing' ? 3 : 4
    return {
      index, priority,
      itemId: item.id, category, thisWeekend,
      consequence: evidence(consequence, item.source, item.sourceDate, [item.id]),
      tone: priority === 0 ? 'critical' as const : priority === 1 ? 'warning' as const : priority === 2 ? 'accent' as const : 'neutral' as const,
    }
  })
  entries.sort((a, b) => a.priority - b.priority || a.index - b.index)
  return entries.map(({ index: _index, priority: _priority, ...entry }, rank) => ({ ...entry, rank }))
}

interface InsightInputs {
  events: ParsedEvent[]
  window: CalendarWindow
  reference: ReferenceResult
  chats: Pick<ChatProjection, 'unreadFound' | 'items'>
  /** Source-owned priorities retain personal-action order instead of deadline keyword re-ranking. */
  attention?: PersonalInsights['attention']
}

function compactDates(dates: DateTime[]): string {
  const byMonth = new Map<string, { first: DateTime; days: number[] }>()
  for (const date of [...dates].sort((a, b) => a.toMillis() - b.toMillis())) {
    const key = date.toFormat('yyyy-MM')
    const month = byMonth.get(key) ?? { first: date, days: [] }
    month.days.push(date.day)
    byMonth.set(key, month)
  }
  const labels = [...byMonth.values()].map(({ first, days }) => {
    const runs: { start: number; end: number }[] = []
    for (const day of days) {
      const last = runs.at(-1)
      if (last && day === last.end + 1) last.end = day
      else runs.push({ start: day, end: day })
    }
    return `${first.setLocale('en').toFormat('LLL')} ${runs.map(({ start, end }) => start === end ? String(start) : `${start}–${end}`).join(', ')}, ${first.year}`
  })
  return labels.length === 1 ? labels[0]! : `[${labels.join('; ')}]`
}

function clock(date: DateTime): string {
  return date.setLocale('en').toFormat(date.millisecond ? 'HH:mm:ss.SSS' : date.second ? 'HH:mm:ss' : 'HH:mm')
}

function clockWithOffset(date: DateTime): string {
  return `${clock(date)} (UTC${date.setLocale('en').toFormat('ZZ')})`
}

/** Equal daily windows group only across distinct dates; overlaps and duplicate records remain separate. */
function focusIntervals(events: ParsedEvent[]): string {
  const groups: { key?: string; events: ParsedEvent[] }[] = []
  for (const event of events) {
    const key = event.start.hasSame(event.end, 'day')
      ? `${clock(event.start)}|${clock(event.end)}|${event.start.offset}|${event.end.offset}`
      : undefined
    const group = key ? groups.find((candidate) => candidate.key === key
      && !candidate.events.some((other) => other.start.hasSame(event.start, 'day'))) : undefined
    if (group) group.events.push(event)
    else groups.push({ key, events: [event] })
  }
  return groups.map(({ key, events: grouped }) => {
    const { start, end } = grouped[0]!
    if (!key) return `${start.setLocale('en').toFormat('LLL d, yyyy')} ${clockWithOffset(start)}–${end.setLocale('en').toFormat('LLL d, yyyy')} ${clockWithOffset(end)}`
    const times = start.offset === end.offset
      ? `${clock(start)}–${clockWithOffset(end)}`
      : `${clockWithOffset(start)}–${clockWithOffset(end)}`
    return `${compactDates(grouped.map((event) => event.start))} ${times}`
  }).join('; ')
}

/** Derive qualifiers from the same loaded records that supply the snapshot's displayed measurements.
 * Makes no external calls and leaves snapshot measurements unchanged.
 * @param snapshot Fully assembled snapshot, including original warnings and source states.
 * @param inputs Parsed calendar/chat evidence and separately dated reference interpretations.
 * @returns Complete insights and full retained-source category counts, null when attention is unavailable.
 */
export function buildPersonalInsights(snapshot: PersonalSnapshot, inputs: InsightInputs): PersonalInsights {
  const { events, window, reference, chats } = inputs
  const section = (id: SectionId) => snapshot.sections.find((entry) => entry.id === id)
  const state = (id: string): SourceState => snapshot.sources.find((entry) => entry.id === id)?.state ?? 'unavailable'
  const live = (text: string, id: string, ids: string[] = []): EvidenceText => evidence(text, state(id), snapshot.generatedAt, [id, ...ids])
  const sectionRead = (id: SectionId, summary: string): EvidenceText => {
    const value = section(id)
    if (!value || value.source === 'unavailable') return evidence('No usable records available.', 'unavailable', undefined, [])
    const caption = value.source === 'reference' ? reference.captions?.[id] : undefined
    const content = value.source === 'reference'
      ? caption ?? `${value.items.length} saved row(s); current status unverified.`
      : `${value.items.length} loaded row(s). ${summary}`
    return evidence(content, value.source, value.source === 'reference' ? snapshot.referenceAsOf : snapshot.generatedAt, value.items.map((item) => item.id))
  }
  const nextMeetings = events.filter((event) => event.meeting && occursDuring(event, window.nextBusinessDay, window.nextBusinessDay.plus({ days: 1 })))
  const weekEvents = events.filter((event) => occursDuring(event, window.weekStart, window.weekStart.plus({ days: 5 })))
  const absences = events.filter((event) => event.oof && occursDuring(event, window.now, window.end))
  const attentionSection = section('urgent')
  const savedAttention = new Map(reference.attention?.map((entry) => [entry.itemId, entry]))
  const attention = inputs.attention ?? (attentionSection?.source === 'reference'
    ? (attentionSection.items.map((item) => savedAttention.get(item.id) ?? classifyAttention([item])[0]!)).sort((a, b) => a.rank - b.rank)
    : classifyAttention(attentionSection?.items ?? [], window.now.toISO()!).map((entry) => ({
        ...entry, consequence: { ...entry.consequence, source: attentionSection?.source ?? 'unavailable' },
      })))
  const attentionCounts: PersonalInsights['attentionCounts'] = attentionSection && attentionSection.source !== 'unavailable'
    ? { pastDue: 0, dueSoon: 0, waiting: 0, standing: 0, unclassified: 0 }
    : null
  if (attentionCounts) for (const item of attention) attentionCounts[item.category] += 1
  const attentionRead = evidence(
    attentionCounts
      ? `Due soon: seven days from ${attentionSection?.source === 'reference' ? 'saved refresh' : 'fetch date'}; ${attentionCounts.unclassified} unclassified retained. Task status unverified.`
      : 'Attention evidence unavailable; category totals are unknown.',
    attentionSection?.source ?? 'unavailable', attentionSection?.source === 'reference' ? snapshot.referenceAsOf : snapshot.generatedAt, attention.map((entry) => entry.itemId),
  )
  const busy = nextMeetings.filter((event) => event.item.conflict).length
  const uncertain = nextMeetings.filter((event) => event.item.optionalOverlap).length
  const nextIds = nextMeetings.map((event) => event.item.id)
  const meetingQualifier = snapshot.metrics.meetingsNextDay === null
    ? `Total unknown; ${nextMeetings.length} loaded meeting(s), ${busy} in busy conflicts.`
    : `${busy} meeting(s) in busy conflicts; free/tentative overlaps are separate.`
  const partialCalendar = state('calendar') === 'partial' ? 'Partial calendar. ' : ''
  const agendaRead = state('calendar') === 'unavailable'
    ? 'Calendar unavailable; conflicts and meeting priority are unknown.'
    : `${partialCalendar}${busy} meeting(s) in busy conflicts; ${uncertain} in free/tentative/unknown overlaps. Priority not inferred.`
  const weekIds = weekEvents.map((event) => event.item.id)
  const busiest = [...snapshot.weekLoad].sort((a, b) => b.minutes - a.minutes || a.date.localeCompare(b.date))[0]
  const weekRead = !snapshot.weekLoad.length
    ? 'Calendar load is unavailable; missing events are not free time.'
    : `${partialCalendar}${busiest && busiest.minutes > 0 ? `Loaded peak: ${busiest.minutes} minutes on ${snapshot.weekLoad.filter((day) => day.minutes === busiest.minutes).map((day) => day.date).join(', ')}.` : 'No loaded meetings; this does not establish free time.'} Excludes cancelled/declined, all-day, focus and absence records; overlaps count separately.`
  const largest = [...snapshot.allocation].sort((a, b) => b.minutes - a.minutes || a.category.localeCompare(b.category))[0]
  const allocationRead = largest
    ? `${partialCalendar}Largest loaded share: ${snapshot.allocation.filter((row) => row.minutes === largest.minutes).map((row) => row.category).join(', ')} (${largest.percent.toFixed(0)}% each). Titles/categories are heuristics; excludes free/all-day/absence time; overlaps count separately.`
    : 'Loaded records cannot establish allocation; missing records do not establish how time is spent.'
  const projects = section('projects')
  const projectQualifier = evidence(
    projects?.source === 'reference'
      ? `${projects.items.filter((item) => item.severity === 'hot').length} marked hot in saved briefing; current status unverified.`
      : projects?.source === 'live' || projects?.source === 'partial'
        ? 'Loaded project rows; activity and priority unverified.'
        : 'No project records; displayed count is not a verified active-project total.',
    projects?.source ?? 'unavailable', projects?.source === 'reference' ? snapshot.referenceAsOf : snapshot.generatedAt, projects?.items.map((item) => item.id) ?? [],
  )
  const agendaAdvice: PersonalInsights['agendaAdvice'] = []
  for (const event of nextMeetings) {
    if (!event.item.free) continue
    const overlaps = nextMeetings.filter((other) => other !== event && occursDuring(other, event.start, event.end))
    if (!overlaps.length) continue
    agendaAdvice.push({
      eventId: event.item.id,
      recommendation: 'optional',
      reason: live(`Marked free; overlaps ${overlaps.length} loaded meeting(s). Optional, not attendance priority or a decline.`, 'calendar', [event.item.id, ...overlaps.map((other) => other.item.id)]),
    })
  }
  const focus = weekEvents.filter((event) => event.focus && event.showAs === 'busy' && !event.oof && !event.item.allDay)
  const protectedTime = focus.length ? live(
    `Busy focus/no-meeting labels: ${focusIntervals(focus)}. No uninterrupted-time guarantee.`,
    'calendar', focus.map((event) => event.item.id),
  ) : undefined
  const sourceCounts = { unavailable: 0, partial: 0, reference: 0 }
  for (const source of snapshot.sources) {
    if (source.state !== 'live') sourceCounts[source.state] += 1
  }
  const warningsSummary = evidence(
    `${snapshot.warnings.length} warning(s) · sources: ${sourceCounts.unavailable} unavailable, ${sourceCounts.partial} partial, ${sourceCounts.reference} reference.`,
    snapshot.warnings.length ? 'partial' : 'live', snapshot.generatedAt, snapshot.sources.filter((source) => source.state !== 'live').map((source) => source.id),
  )
  return {
    warningsSummary,
    stats: {
      overdueActions: evidence(snapshot.metrics.overdueActions === null
        ? 'Total unknown; attention rows are not verified overdue tasks.'
        : 'Provided count; overdue-task source details are unavailable.', 'unavailable', undefined, []),
      unreadEmails: live(snapshot.metrics.unreadEmails === null
        ? 'Total unknown; sampled mail cannot supply an inbox count.'
        : 'Inbox total; bounded mail does not establish inbox-wide composition.', 'inbox'),
      meetingsNextDay: live(meetingQualifier, 'calendar', nextIds),
      teamsUnread: live(snapshot.metrics.teamsUnread === null
        ? `Total unknown; ${chats.unreadFound} verified unread among ${chats.items.length} loaded chats.`
        : `Latest-message unread checks across ${chats.items.length} loaded chats, not message totals.`, 'chats', chats.items.map((item) => item.id)),
      projects: projectQualifier,
      oof: live(snapshot.metrics.oof === null
        ? `Total unknown; ${absences.length} loaded notices, not verified people away.`
        : 'Calendar notices; not a people count or confirmed availability.', 'calendar', absences.map((event) => event.item.id)),
    },
    attention,
    attentionCounts,
    reads: {
      attention: attentionRead,
      weekLoad: live(weekRead, 'calendar', weekIds),
      allocation: live(allocationRead, 'calendar', weekIds),
      agenda: live(agendaRead, 'calendar', nextIds),
      prep: sectionRead('prep', 'Calendar descriptions, not inferred preparation requirements.'),
      reply: sectionRead('reply', 'Heuristic candidates may already have replies.'),
      chats: sectionRead('chats', 'Latest-message checks do not count all unread messages.'),
      people: sectionRead('people', 'Follow-up and availability are unverified.'),
      projects: sectionRead('projects', 'Activity and priority are unverified.'),
      actions: sectionRead('actions', 'Task status is not independently verified.'),
      training: sectionRead('training', 'Title/category matches; completion and task status unknown.'),
      oof: sectionRead('oof', `From fetch time to ${window.end.toISODate()} (exclusive); availability unconfirmed.`),
      files: sectionRead('files', 'OneDrive root items, not all recent Microsoft 365 files.'),
    },
    ...(protectedTime ? { protectedTime } : {}),
    agendaAdvice,
    oofImpact: evidence('Meeting impact and anyone’s availability are not established by absence notices.', 'unavailable', undefined, absences.map((event) => event.item.id)),
  }
}
