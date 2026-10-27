/** Current next actions from bounded mailbox evidence; saved briefings and unread flags never establish ownership. */
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import { z } from 'zod'
import type { DashboardItem, DashboardSection, ReadOnlyMcp } from '../shared/types.ts'
import type { PersonalInsights } from '../shared/insights.ts'
import { safeSourceUrl } from '../shared/urls.ts'
import { safeError } from './mcp.ts'
import { attentionQueries, type AttentionRequest } from './personal-attention-request.ts'

const address = z.object({ emailAddress: z.object({ address: z.string().nullable().optional(), name: z.string().nullable().optional() }) })
const messageSchema = z.object({
  id: z.string().min(1), subject: z.string().nullable(), receivedDateTime: z.string().datetime({ offset: true }),
  from: address.nullable().optional(), toRecipients: z.array(address).optional(),
  bodyPreview: z.string().nullable().optional(), body: z.object({ content: z.string(), contentType: z.string().optional() }).optional(),
  webLink: z.string().nullable().optional(), conversationId: z.string().optional(),
})
type Message = z.infer<typeof messageSchema>
interface Evidence extends Message { text: string; current: string; time: number }
export interface AttentionResult {
  section: DashboardSection
  warnings: string[]
  annotations?: PersonalInsights['attention']
}

function plain(message: Message): string {
  if (!message.body) return message.bodyPreview ?? ''
  if (message.body.contentType === 'text') return message.body.content
  const $ = load(message.body.content)
  $('script,style,svg,template').remove()
  $('br').replaceWith('\n')
  $('p,div,tr,li').append('\n')
  return $.root().text()
}
function compact(text: string, limit = 650): string {
  const clean = text.replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : clean
}
function latestText(text: string): string {
  return text.split(/\n(?:From:|Sent:|_{5,}|-{3,}\s*Original Message|On .+wrote:)/i)[0]!.trim()
}
function source(message: Message): string {
  return safeSourceUrl(message.webLink) ?? 'https://outlook.office.com/mail/deeplink/read/' + encodeURIComponent(message.id)
}
function names(displayName: string, email: string): string[] {
  const name = displayName.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase()
  return [...new Set([email.toLowerCase(), email.split('@')[0]!.toLowerCase(), name].filter(Boolean))]
}
function personallyNamed(text: string, identities: string[]): boolean {
  const lower = text.toLowerCase()
  return identities.some(name => new RegExp('(^|[^a-z0-9])' + name.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(lower))
}
function identifiers(text: string): string[] { return [...new Set(text.match(/\b\d{7,16}\b/g) ?? [])] }
function incidentId(text: string): string | undefined { return /\b(?:incident(?:\s*:\s*id)?|ID)\s*[:#]?\s*(\d{7,16})\b/i.exec(text)?.[1] }

/** Project explicit personal assignments, customer asks, publication blockers and owned rollout verification.
 * @param records Recent messages across focused searches, including read and archived mail.
 * @param person Verified current mailbox identity; distribution-list membership alone is not ownership.
 * @param request Evidence and output bounds.
 * @returns Existing Dashboard rows and recommendation ranks, with original source dates and links.
 */
export function projectMailboxAttention(records: unknown[], person: { displayName: string; email: string }, request: AttentionRequest): AttentionResult {
  const identities = names(person.displayName, person.email)
  const since = Date.parse(request.asOf) - request.lookbackDays * 86400000
  const warnings: string[] = []
  const byId = new Map<string, Evidence>()
  for (const raw of records) {
    const parsed = messageSchema.safeParse(raw)
    if (!parsed.success) { warnings.push('attention: an incomplete message was omitted.'); continue }
    const time = Date.parse(parsed.data.receivedDateTime)
    if (time < since || time > Date.parse(request.asOf)) continue
    const text = plain(parsed.data)
    byId.set(parsed.data.id, { ...parsed.data, text, current: latestText(text), time })
  }
  const messages = [...byId.values()].sort((a, b) => b.time - a.time)
  const candidates: { key: string; priority: number; item: DashboardItem }[] = []
  const add = (message: Evidence, key: string, title: string, next: string, why: string, priority: number) => {
    if (candidates.some(row => row.key === key)) return
    candidates.push({ key, priority, item: {
      id: 'attention-mail-' + createHash('sha256').update(key).digest('hex'), title,
      detail: next + ' · Why you: ' + why + ' · Latest evidence: ' + compact(message.current, 350),
      url: source(message), source: 'live', sourceDate: new Date(message.time).toISOString(),
      severity: priority === 0 ? 'hot' : priority === 1 ? 'watch' : 'active',
    } })
  }
  const incidentGroups = new Map<string, Evidence[]>()
  for (const message of messages) {
    const id = incidentId((message.subject ?? '') + '\n' + message.current)
    if (!id) continue
    const group = incidentGroups.get(id) ?? []
    group.push(message); incidentGroups.set(id, group)
  }
  for (const [id, group] of incidentGroups) {
    const newest = group[0]!
    if (group.some(message => message.time === newest.time && /\b(?:resolved|mitigated|closed)\b/i.test((message.subject ?? '') + '\n' + message.current))) continue
    const ownershipEvidence = group.find(message => /assigned to|owner\s*:/i.test(message.current + ' ' + message.subject))
    const ownerClause = ownershipEvidence
      ? /(?:assigned to|owner\s*:)([^\n]{0,180})/i.exec(ownershipEvidence.current + '\n' + ownershipEvidence.subject)?.[1] : undefined
    const owned = ownerClause && personallyNamed(ownerClause, identities)
    if (ownerClause && !owned && !/mentioned you/i.test(newest.subject ?? '')) continue
    const mention = group.find(message => /mentioned you/i.test(message.subject ?? ''))
    if (!owned && !mention) continue
    const latest = (newest.subject ?? '') + '\n' + newest.current
    if (/\b(?:resolved|mitigated|closed|reassigned to)\b/i.test(latest) && !/\b(?:reopened|reactivated)\b/i.test(latest)) continue
    if (!group.some(message => /\bsev(?:erity)?\s*[:=-]?\s*[012]\b/i.test((message.subject ?? '') + '\n' + message.current))) continue
    const related = messages.filter(message => !group.includes(message) && (message.subject ?? '').toLowerCase().includes('sent a message')
      && identifiers(message.text).includes(id)).slice(0, 1)
    const context = related.length ? ' Review the related message: ' + compact(related[0]!.current, 250) : ''
    add(newest, 'incident:' + id, 'Incident ' + id + ' — personal follow-up',
      'Immediate — Check the current incident and acknowledgement; acknowledge only if still pending. Read the latest restricted mention, confirm the next investigation step and next update time.' + context,
      owned ? 'A recent incident notification assigns you; later mail does not establish current live state.' : 'The incident explicitly mentions you; ownership and live state still need confirmation.', 0)
  }
  const rollouts: { message: Evidence; id: string }[] = []
  for (const message of messages) {
    const subject = message.subject ?? ''
    const text = subject + '\n' + message.current
    const fromSelf = message.from?.emailAddress.address?.toLowerCase() === person.email.toLowerCase()
    if (fromSelf || !subject.trim() || incidentId(subject)) continue
    const rollout = /\bECS\s+Rollout\s+(\d+)\b/i.exec(text)?.[1]
    if (rollout && personallyNamed(text, identities) && /completed the pull request|approved the changes|executed successfully|approval.+(?:granted|completed)/i.test(text)) {
      if (!rollouts.some(row => row.id === rollout)) rollouts.push({ message, id: rollout })
      continue
    }
    if (/\b(?:newsletter|digest|news feed|unsubscribe|job at|discount|conference|invite you|sign up)\b/i.test(text)) continue
    const direct = (message.toRecipients?.length ?? 0) <= 5 && message.toRecipients?.some(recipient => recipient.emailAddress.address?.toLowerCase() === person.email.toLowerCase())
    const named = personallyNamed(message.current, identities)
    const teams = /\bsent a message\b|mentioned you in your chat/i.test(subject)
    const automation = /icm|lockbox|no.?reply|notifications?|alerts?|devops|viva/i.test(message.from?.emailAddress.address ?? '')
    const publication = /publish|publication|release|build/i.test(subject)
    const smallPublicationNotice = publication && (message.toRecipients?.length ?? 99) <= 5
    if (!named && !(direct && (!automation || teams)) && !smallPublicationNotice) continue
    const caseIds = /case\s*\d|GetHelp\s*\d|GH#|INT#/i.test(subject + ' ' + message.current)
      ? identifiers(subject + ' ' + message.current).sort((a, b) => b.length - a.length) : []
    const key = caseIds[0] ? 'case:' + caseIds[0] : message.conversationId ? 'thread:' + message.conversationId : 'message:' + message.id
    if (messages.some(later => later.time > message.time && later.conversationId && later.conversationId === message.conversationId
      && (later.from?.emailAddress.address?.toLowerCase() === person.email.toLowerCase()
        || /\b(?:no further action|issue (?:is )?resolved|request (?:is )?closed|already (?:answered|resolved))\b/i.test(later.current)))) continue
    if (/\b(?:no further action|issue (?:is )?resolved|request (?:is )?closed)\b/i.test(message.current)) continue
    if (/publish|publication|release|build/i.test(subject) && /failed|cannot|can't|will not|won't|not automatically|blocked|failure/i.test(message.current + ' ' + subject)) {
      const packageName = /package\s+([a-z0-9_.-]+?)\.\d+(?:\.\d+){1,}/i.exec(subject)?.[1]
      const publicationKey = packageName ? 'publication:' + packageName.toLowerCase() : key
      const failedPr = /Pull Request:\s*(\d+)/i.exec(message.current)?.[1]
      const failedBuild = /Build job:\s*(\d+)/i.exec(message.current)?.[1]
      add(message, publicationKey, subject, 'Today — Ask the release/build owner for the failed-stage diagnosis and recovery plan. Confirm the published version; a PR/build success does not prove publication.'
        + (failedPr ? ' Latest failed PR: ' + failedPr + (failedBuild ? ' / build ' + failedBuild : '') + '.' : ''),
        named ? 'The publication evidence names you.' : direct ? 'The release blocker was sent directly to you.' : 'A small-recipient publication failure reached your mailbox; confirm the responsible release owner.', 1)
      continue
    }
    const asks = message.current.split(/\n|(?<=[.!?])\s+/).map(line => compact(line, 400)).filter(line =>
      /\b(?:please|could you|can you|would you|need (?:your|you)|following up|follow.up|confirm|guidance|questions?|next step|did we|\?)\b/i.test(line))
    if (!asks.length && !/\bcase\s*\d|GetHelp\s*\d/i.test(subject) && !/mentioned you in your chat/i.test(subject)) continue
    if (/Incident Access Request|Action required: Approve or deny request|lockbox/i.test(subject)) continue
    const prior = /discussed|as discussed|already (?:spoke|talked)|(?:thanks|thank you).{0,80}(?:discussion|call)|following our/i.test(message.current)
    const ids = identifiers(subject + ' ' + message.current).slice(0, 4)
    const context = compact([...new Set(asks)].join(' '), 400)
    const next = prior ? 'Today — Follow up on the existing discussion; confirm the agreed deliverable, owner and next update. Do not restart the engagement.'
      : /guidance|supported|workaround|sequenc|auto.apply|auto.remove/i.test(message.current)
        ? 'Today — Coordinate with the case owner to answer the requested supported behavior and sequencing. Treat proposed workarounds and design-change plans as unconfirmed until engineering validates them.'
        : teams ? 'Today — Read the full Teams message and confirm the requested deliverable, owner and next update; notification previews may be incomplete.'
          : 'Today — Review the latest request and confirm the next deliverable, responsible owner and update time; a reply may already exist outside the loaded evidence.'
    add(message, key, subject + (teams && ids.length ? ' — ' + ids.join(' / ') : ''),
      next + (context ? ' Request: ' + context : ''), named ? 'The latest message explicitly addresses you.' : 'A small-recipient message or Teams notification was sent directly to you.',
      caseIds.length ? 1 : 3)
  }
  if (rollouts.length) {
    const latest = rollouts[0]!
    add(latest.message, 'owned-rollout-verification', 'Verify your ECS changes — ' + rollouts.map(row => row.id).slice(0, 10).join(', '),
      'Today — Confirm propagation and runtime health within each approved scope. Completed approvals/configuration operations are not proof that the intended behavior is effective everywhere.',
      'Recent rollout completion/approval notifications explicitly name you as the change owner.', 2)
  }
  candidates.sort((a, b) => a.priority - b.priority)
  const items = candidates.slice(0, request.maxItems).map(row => row.item)
  const annotations: PersonalInsights['attention'] = candidates.slice(0, request.maxItems).map(({ item, priority }, rank) => ({
    itemId: item.id, rank, category: 'unclassified', thisWeekend: false,
    tone: priority === 0 ? 'critical' : priority === 1 ? 'warning' : 'accent',
    consequence: { text: priority === 0 ? 'Personally relevant incident; verify live state before acting.' : 'Concrete personal follow-up; no deadline is inferred.',
      source: 'partial', sourceDate: item.sourceDate, evidenceIds: [item.id] },
  }))
  return { section: { id: 'urgent', source: 'partial', items,
    note: 'Current mailbox follow-ups from focused recent-message searches, including read and moved mail. Ranked by explicit personal involvement and consequence. This is a bounded evidence list, not verified live incident/deployment status; open the source before acting.' }, annotations, warnings }
}

/** Load a bounded current mailbox shortlist without model calls or stale saved-task fallback.
 * @param mcp Fetch-only source connector.
 * @param person Verified current mailbox identity; no identity means unavailable, not guessed ownership.
 * @param request Evidence and per-query read bounds.
 * @param signal Host-owned cancellation.
 * @returns Current action rows or a visibly unavailable section; independent resources remain usable.
 */
export async function loadAttentionBriefing(mcp: ReadOnlyMcp, person: { displayName: string; email: string } | null,
  request: AttentionRequest, signal: AbortSignal): Promise<AttentionResult> {
  try {
    if (!person) throw new Error('Current mailbox identity is unavailable.')
    const results = await Promise.allSettled(attentionQueries(person, request).map(async path => {
      const raw = await mcp.call('fetch', { entityUrls: [path] }, signal)
      signal.throwIfAborted()
      const envelope = z.object({ results: z.array(z.object({ statusCode: z.number(), data: z.object({ value: z.array(z.unknown()), '@odata.nextLink': z.string().optional() }).optional() })).length(1) }).parse(raw)
      const result = envelope.results[0]!
      if (result.statusCode !== 200 || !result.data) throw new Error('A focused mailbox query was unavailable.')
      return result.data.value.slice(0, request.maxMessages)
    }))
    const loaded = results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    if (!results.some(result => result.status === 'fulfilled')) throw new Error('All focused mailbox queries failed.')
    const result = projectMailboxAttention(loaded, person, request)
    if (results.some(result => result.status === 'rejected')) result.warnings.push('attention: some focused mailbox searches failed; the displayed shortlist is incomplete.')
    return result
  } catch (error) {
    signal.throwIfAborted()
    return { section: { id: 'urgent', source: 'unavailable', items: [],
      note: 'Could not load current mailbox priorities. Refresh to retry; an old saved briefing is not used as today’s attention list.' },
      warnings: ['Mailbox attention unavailable: ' + safeError(error)] }
  }
}
