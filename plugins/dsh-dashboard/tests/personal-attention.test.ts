import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { attentionQueries } from '../src/host/personal-attention-request.ts'
import { projectMailboxAttention, loadAttentionBriefing } from '../src/host/personal-attention.ts'
import { assertReadOperation } from '../src/host/mcp.ts'

const request = { asOf: '2040-04-03T17:00:00.000Z', timeZone: 'America/Los_Angeles', lookbackDays: 7, maxItems: 5, maxMessages: 50 }
const person = { displayName: 'Alex Example (IP)', email: 'alex@example.invalid' }
function mail(id: string, subject: string, text: string, patch: Record<string, unknown> = {}) {
  return { id, subject, receivedDateTime: '2040-04-03T16:00:00Z', from: { emailAddress: { address: 'owner@example.invalid' } },
    toRecipients: [{ emailAddress: { address: person.email } }], body: { contentType: 'text', content: text },
    conversationId: id, isRead: true, importance: 'normal', ...patch }
}

test('focused fetch queries include read and moved mail without allowing synthesis or actions', async () => {
  const paths = attentionQueries(person, request)
  assert.equal(paths.join('\n') + '\n', await readFile(new URL('./fixtures/attention-question.txt', import.meta.url), 'utf8'))
  assert.equal(paths.length, 4)
  for (const path of paths) {
    const url = new URL(path, 'https://graph.microsoft.com')
    assert.equal(url.pathname, '/me/messages')
    assert.equal(url.searchParams.get('$top'), '50')
    assert.ok(url.searchParams.get('$select')?.includes('body'))
    assert.doesNotMatch(path, /isRead|importance|inbox/)
    assert.doesNotThrow(() => assertReadOperation('workiq', 'fetch', { entityUrls: [path] }))
  }
  for (const operation of ['ask', 'attention-briefing', 'sendMail', 'do_action']) assert.throws(() => assertReadOperation('workiq', operation, {}))
})

test('current owned incident, customer asks, publication failure and own rollouts become concrete actions', () => {
  const rows = [
    mail('incident', 'Incident 987654321 has been assigned to Alex Example', 'Incident has been assigned to you. Alex Example. Active Sev 2. Acknowledge request.'),
    mail('case', 'RE: Customer case 12345678', 'Hi Alex Example, could you confirm supported auto-apply and auto-remove sequencing? The customer proposed a workaround; design change is unconfirmed.'),
    mail('prior', 'Kendall Example sent a message', 'As discussed, please confirm the agreed deliverable and update for case 87654321.'),
    mail('build', 'Publication failed — version 1.2.3', 'Alex Example, publication failed for PR 1111111 / build 2222222. This version will not automatically publish.'),
    mail('rollout', 'PR - ECS Rollout 5555555 (Alex Example)', 'Alex Example completed the pull request. ECS Rollout 5555555.'),
    mail('noise', 'Weekly newsletter', 'Please read our weekly newsletter', { importance: 'high' }),
  ]
  const result = projectMailboxAttention(rows, person, request)
  assert.equal(result.section.items.length, 5)
  assert.match(result.section.items[0]!.detail, /Check the current incident and acknowledgement; acknowledge only if still pending/)
  assert.ok(result.section.items.some(row => /proposed workarounds and design-change plans as unconfirmed/.test(row.detail)))
  assert.ok(result.section.items.some(row => /Do not restart the engagement/.test(row.detail)))
  assert.ok(result.section.items.some(row => /failed-stage diagnosis and recovery plan/.test(row.detail)))
  assert.ok(result.section.items.some(row => /Completed approvals\/configuration operations are not proof/.test(row.detail)))
  assert.ok(result.section.items.every(row => /Why you:.*Latest evidence:/.test(row.detail)))
  assert.equal(result.section.source, 'partial')
  assert.ok(result.section.items.every(row => row.url.startsWith('https://outlook.office.com/mail/deeplink/read/')))
  assert.deepEqual(result.annotations?.map(row => row.rank), [0, 1, 2, 3, 4])
})

test('other owners, bulk recipients, stale evidence and later replies do not create personal obligations', () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ emailAddress: { address: index === 0 ? person.email : index + '@example.invalid' } }))
  const result = projectMailboxAttention([
    mail('other', 'Incident 99999999 assigned to Sam Other', 'Sam Other owns incident 99999999. Active Sev 2.'),
    mail('bulk', 'High importance notification', 'Please review this announcement.', { toRecipients: many }),
    mail('old', 'Customer case 12345678', 'Alex Example please review.', { receivedDateTime: '2039-01-01T00:00:00Z' }),
    mail('future', 'Customer case 12345678', 'Alex Example please review.', { receivedDateTime: '2041-01-01T00:00:00Z' }),
    mail('ask', 'Customer case 77777777', 'Alex Example, can you review?', { conversationId: 'done' }),
    mail('reply', 'RE: Customer case 77777777', 'I have answered.', { conversationId: 'done', receivedDateTime: request.asOf, from: { emailAddress: { address: person.email } } }),
    mail('quote', 'RE: Old request', 'No further action required.\nFrom: Someone\nAlex Example please investigate Sev 2.'),
  ], person, request)
  assert.deepEqual(result.section.items, [])
})

test('duplicate incident mail and repeated rollout notifications collapse while current evidence dates remain original', () => {
  const original = mail('i1', 'Incident 987654321 assigned to Alex Example', 'Incident assigned to you. Alex Example. Active Sev 2.')
  const next = mail('i2', 'Person mentioned you in Incident: Id 987654321', 'Please read the restricted incident.', { receivedDateTime: request.asOf })
  const rows = [original, original, next,
    mail('r1', 'ECS Rollout 5555555 (Alex Example)', 'Alex Example completed the pull request.'),
    mail('r2', 'ECS Rollout 5555555 (Alex Example)', 'Alex Example approved the changes.'),
  ]
  const result = projectMailboxAttention(rows, person, request)
  assert.equal(result.section.items.length, 2)
  assert.equal(result.section.items[0]?.sourceDate, request.asOf)
  const later = projectMailboxAttention(rows, person, { ...request, asOf: '2040-04-03T17:01:00Z' })
  assert.deepEqual(result.section.items, later.section.items)
  const closed = projectMailboxAttention([...rows, mail('closed', 'Incident 987654321 resolved', 'Incident resolved.', { receivedDateTime: '2040-04-03T17:00:00Z' })], person, request)
  assert.equal(closed.section.items.some(row => row.title.startsWith('Incident')), false)
})

test('mailbox failures stay visible without an old saved-task substitute and cancellation propagates', async () => {
  const failed = await loadAttentionBriefing({ call: async () => { throw new Error('Offline') } }, person, request, new AbortController().signal)
  assert.equal(failed.section.source, 'unavailable')
  assert.deepEqual(failed.section.items, [])
  assert.match(failed.section.note!, /Refresh to retry/)
  const unknown = await loadAttentionBriefing({ call: async () => assert.fail('No reads without verified identity') }, null, request, new AbortController().signal)
  assert.equal(unknown.section.source, 'unavailable')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(loadAttentionBriefing({ call: async () => { controller.signal.throwIfAborted() } }, person, request, controller.signal), { name: 'AbortError' })
})
