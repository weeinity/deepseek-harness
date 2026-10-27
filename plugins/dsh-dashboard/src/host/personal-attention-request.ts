/** Bounded mailbox searches for current personally relevant follow-up evidence. */
export interface AttentionRequest {
  asOf: string
  timeZone: string
  lookbackDays: number
  maxItems: number
  maxMessages: number
}

/** Separate incident, customer and deployment searches keep bulk alerts from crowding out direct asks.
 * @param person Verified current mailbox email and display name, not a browser-supplied query.
 * @param request Evidence date and per-query read bounds.
 * @returns Fixed /me/messages paths selecting original message bodies and navigation links.
 */
export function attentionQueries(person: { displayName: string; email: string }, request: AttentionRequest): string[] {
  const since = new Date(Date.parse(request.asOf) - request.lookbackDays * 86400000).toISOString().slice(0, 10)
  const who = person.email.split('@')[0]!.replace(/[^a-zA-Z0-9._-]/g, '')
  const recipient = person.email.replace(/[^a-zA-Z0-9@._+-]/g, '')
  const name = person.displayName.replace(/\s*\([^)]*\)/g, '').trim().replaceAll('"', '')
  const queries = [
    who + ' AND ("Sev 0" OR "Sev 1" OR "Sev 2" OR "assigned to" OR "mentioned you in Incident")',
    '(to:' + recipient + ' OR from:' + recipient + ') AND (subject:case OR subject:GetHelp OR "guidance" OR subject:"mentioned you" OR subject:"sent a message") AND NOT subject:Lockbox AND NOT subject:"PR -"',
    '(subject:"failed to publish" OR subject:"publication failed" OR subject:"build failed")',
    '(subject:"' + name + '" OR subject:' + who + ') AND "ECS" AND received>=' + since,
  ]
  return queries.map(query => '/me/messages?' + new URLSearchParams({
    $search: JSON.stringify(query + ' AND received>=' + since),
    $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,webLink,conversationId',
    $top: String(request.maxMessages),
  }))
}
