import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { calendarWindow, parseEvents } from '../src/host/personal-calendar.ts'
import { projectChats } from '../src/host/personal-chats.ts'
import { buildPersonalInsights } from '../src/host/personal-insights.ts'
import { parseReferenceHtml } from '../src/host/reference.ts'
import { calendarNextPath, loadPersonal } from '../src/host/personal.ts'
import { personalInsightsSchema } from '../src/shared/insights.ts'
import type { PersonalOptions, PersonalSnapshot, ReadOnlyMcp } from '../src/shared/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const options: PersonalOptions = {
  timeZone: 'America/Los_Angeles',
  attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 3,
  maxItems: 20,
  now: () => new Date('2026-03-06T20:00:00Z'),
}
const signal = (): AbortSignal => new AbortController().signal
const response = (data: unknown, note?: string): unknown => ({ results: [{ statusCode: 200, data }], ...(note ? { note } : {}) })
const failure = (statusCode: number): unknown => ({ results: [{ statusCode }] })
const list = (value: unknown[], next?: string): unknown => response({ value, ...(next ? { '@odata.nextLink': next } : {}) })

function event(id: string, start = '2026-03-09T09:00:00', end = '2026-03-09T10:00:00', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, subject: `Meeting ${id}`,
    start: { dateTime: start, timeZone: 'Pacific Standard Time' },
    end: { dateTime: end, timeZone: 'Pacific Standard Time' },
    responseStatus: { response: 'accepted' },
    organizer: { emailAddress: { name: 'Example Organizer', address: 'organizer@example.com' } },
    isOnlineMeeting: true, isAllDay: false, isCancelled: false, showAs: 'busy',
    webLink: `https://outlook.office.com/calendar/item/${id}`, bodyPreview: 'Calendar agenda', categories: [],
    ...overrides,
  }
}

function message(id: string, receivedDateTime: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, subject: `Message ${id}`, receivedDateTime,
    from: { emailAddress: { name: 'Example Sender', address: 'sender@example.com' } },
    isRead: false, importance: 'normal', flag: { flagStatus: 'notFlagged' },
    bodyPreview: 'Message preview', webLink: `https://outlook.office.com/mail/item/${id}`, ...overrides,
  }
}

function chat(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, topic: `Example chat ${id}`, chatType: 'group', webUrl: `https://teams.microsoft.com/l/chat/${id}`,
    viewpoint: { lastMessageReadDateTime: '2026-03-06T10:00:00Z' },
    lastMessagePreview: {
      body: { contentType: 'text', content: 'Synthetic latest message' },
      createdDateTime: '2026-03-06T11:00:00Z',
      from: { user: { id: 'other-user', displayName: 'Example Author' } },
      isDeleted: false,
      messageType: 'message',
    },
    ...overrides,
  }
}

type Reply = unknown | ((url: URL) => unknown)
function transport(overrides: Record<string, Reply> = {}): { mcp: ReadOnlyMcp; paths: string[]; signals: AbortSignal[] } {
  const paths: string[] = []
  const signals: AbortSignal[] = []
  const defaults: Record<string, Reply> = {
    '/me/messages': list([]),
    '/me': response({ id: 'current-user', displayName: 'Example User', mail: 'user@example.com' }),
    '/me/mailFolders/inbox': response({ unreadItemCount: 4, totalItemCount: 50 }),
    '/me/calendarView': list([]),
    '/me/mailFolders/inbox/messages': list([]),
    '/me/chats': list([]),
    '/me/drive/root/children': list([]),
  }
  return {
    paths, signals,
    mcp: {
      async call(operation, args, callSignal) {
        assert.equal(operation, 'fetch')
        assert.deepEqual(Object.keys(args), ['entityUrls'])
        assert.ok(Array.isArray(args.entityUrls))
        assert.equal(args.entityUrls.length, 1)
        const path = args.entityUrls[0] as string
        assert.match(path, /^\/me(?:\/|\?)/)
        paths.push(path)
        signals.push(callSignal)
        const url = new URL(path, 'https://graph.microsoft.com')
        const reply = Object.hasOwn(overrides, url.pathname) ? overrides[url.pathname] : defaults[url.pathname]
        return typeof reply === 'function' ? reply(url) : reply
      },
    },
  }
}

test('fetches selected bounded read-only resources and orders mail by newest received date', async () => {
  const { mcp, paths, signals } = transport({
    '/me/mailFolders/inbox/messages': list([
      message('older', '2026-03-05T12:00:00Z'),
      message('newer', '2026-03-06T12:00:00Z', { importance: 'high' }),
      message('read', '2026-03-06T13:00:00Z', { isRead: true }),
    ], 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=more'),
    '/me/chats': list([{ id: 'chat', topic: 'Example chat', chatType: 'group', webUrl: 'https://teams.microsoft.com/l/chat/example', lastUpdatedDateTime: '2026-03-06T15:00:00Z', unreadCount: 999 }]),
    '/me/drive/root/children': list([{ id: 'file', name: 'Example document', webUrl: 'https://example.sharepoint.com/file', lastModifiedDateTime: '2026-03-06T17:00:00Z' }]),
  })
  const controller = new AbortController()
  const result = await loadPersonal(mcp, options, controller.signal)
  assert.equal(paths.length, 10)
  assert.ok(signals.every((item) => item === controller.signal))
  for (const path of paths) {
    const url = new URL(path, 'https://graph.microsoft.com')
    assert.ok(url.searchParams.get('$select'))
    if (url.pathname === '/me/messages') assert.equal(url.searchParams.get('$top'), '50')
    else if (url.pathname !== '/me' && url.pathname !== '/me/mailFolders/inbox') assert.equal(url.searchParams.get('$top'), '20')
    assert.equal(url.searchParams.get('$expand'), url.pathname === '/me/chats' ? 'lastMessagePreview' : null)
  }
  const mailUrl = new URL(paths.find((path) => path.startsWith('/me/mailFolders/inbox/messages'))!, 'https://graph.microsoft.com')
  assert.equal(mailUrl.searchParams.get('$orderby'), 'receivedDateTime desc')
  assert.match(mailUrl.searchParams.get('$filter')!, /^receivedDateTime ge 2026-02-27T20:00:00.000Z and receivedDateTime le 2026-03-06T20:00:00.000Z.*isRead eq false.*flag\/flagStatus eq 'flagged'.*importance eq 'high'/)
  assert.equal(result.displayName, 'Example User')
  assert.equal(result.email, 'user@example.com')
  assert.equal(result.metrics.unreadEmails, 4)
  assert.equal(result.metrics.overdueActions, null)
  assert.equal(result.metrics.teamsUnread, null)
  const replies = result.sections.find((section) => section.id === 'reply')!
  assert.deepEqual(replies.items.map((item) => item.id), ['mail-newer', 'mail-older'])
  assert.ok(replies.items.every((item) => /Heuristic candidate; may already have been replied/.test(item.detail)))
  assert.equal(replies.source, 'partial')
  assert.equal(result.sections.find((section) => section.id === 'chats')!.items.length, 1)
  assert.equal(result.sections.find((section) => section.id === 'files')!.items.length, 1)
})

test('verified chat previews use the selected viewpoint and safe plain-text HTML extraction', async () => {
  const { mcp, paths } = transport({
    '/me/chats': list([chat('html', {
      lastMessagePreview: {
        body: { contentType: 'html', content: '<p>First <b>paragraph</b></p><p>Second<br>line <a href="javascript:steal()">label</a></p><script>hidden payload</script><iframe>hidden frame</iframe><img src=x onerror="steal()">' },
        createdDateTime: '2026-03-06T11:00:00Z',
        from: { user: { id: 'other-user', displayName: 'Example Author' } },
        isDeleted: false, messageType: 'message',
      },
    })]),
  })
  const result = await loadPersonal(mcp, options, signal())
  const url = new URL(paths.find((path) => path.startsWith('/me/chats'))!, 'https://graph.microsoft.com')
  assert.equal(url.searchParams.get('$select'), 'id,topic,chatType,webUrl,viewpoint')
  assert.equal(url.searchParams.get('$expand'), 'lastMessagePreview')
  assert.equal(url.searchParams.get('$top'), String(options.maxItems))
  assert.doesNotMatch(url.search, /members|messages|lastUpdatedDateTime/)
  const section = result.sections.find((entry) => entry.id === 'chats')!
  assert.equal(result.metrics.teamsUnread, 1)
  assert.match(section.items[0]!.detail, /Unread latest message.*From: Example Author.*First paragraph Second line label/)
  assert.doesNotMatch(section.items[0]!.detail, /<|steal|hidden|iframe|javascript/)
  assert.equal(section.items[0]!.url, 'https://teams.microsoft.com/l/chat/html')
  assert.equal(section.items[0]!.sourceDate, '2026-03-06T11:00:00.000Z')
  assert.match(section.note!, /1 unread chat\(s\) found among 1 loaded; all chats loaded/)
})

test('chat unread comparisons handle equality and offsets while excluding deleted, system, and self-sent latest messages', async () => {
  const preview = (createdDateTime: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    body: { contentType: 'text', content: 'Synthetic preview' }, createdDateTime,
    from: { user: { id: 'other-user', displayName: 'Example Author' } },
    isDeleted: false, messageType: 'message', ...overrides,
  })
  const { mcp } = transport({
    '/me/chats': list([
      chat('equal', { lastMessagePreview: preview('2026-03-06T10:00:00Z') }),
      chat('older', { lastMessagePreview: preview('2026-03-06T09:00:00Z') }),
      chat('unread', { lastMessagePreview: preview('2026-03-06T11:00:00Z') }),
      chat('offset-unread', { lastMessagePreview: preview('2026-03-06T04:00:00-08:00') }),
      chat('self', { lastMessagePreview: preview('2026-03-06T13:00:00Z', { from: { user: { id: 'current-user', displayName: 'Example User' } } }) }),
      chat('system', { lastMessagePreview: preview('2026-03-06T14:00:00Z', { messageType: 'systemEventMessage' }) }),
      chat('deleted', { lastMessagePreview: preview('2026-03-06T15:00:00Z', { isDeleted: true, body: { contentType: 'text', content: 'Deleted content must not be shown' } }) }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  const section = result.sections.find((entry) => entry.id === 'chats')!
  assert.equal(result.metrics.teamsUnread, null)
  assert.match(section.note!, /2 unread chat\(s\) found among 7 loaded; total unknown/)
  assert.match(result.warnings.join(' '), /unknown for 3 chat\(s\).*newer self-sent, system, or deleted/)
  assert.doesNotMatch(result.warnings.join(' '), /missing or invalid/)
  assert.deepEqual(section.items.slice(0, 2).map((item) => item.id), ['chat-offset-unread', 'chat-unread'])
  assert.ok(section.items.slice(2).every((item) => item.detail.startsWith('Recent chat')))
  assert.match(section.items.find((item) => item.id === 'chat-self')!.detail, /sent by you; not counted as unread/)
  assert.match(section.items.find((item) => item.id === 'chat-system')!.detail, /system event; not counted as unread/)
  assert.doesNotMatch(section.items.find((item) => item.id === 'chat-deleted')!.detail, /Deleted content must not be shown/)
  assert.match(section.items.find((item) => item.id === 'chat-equal')!.detail, /not newer than the read timestamp/)
})

test('excluded latest messages after the read cutoff cannot prove earlier incoming messages were read', () => {
  const exclusions = [
    { id: 'self', from: { user: { id: 'current-user', displayName: 'Example User' } } },
    { id: 'system', messageType: 'systemEventMessage' },
    { id: 'deleted', isDeleted: true },
  ]
  for (const { id, ...overrides } of exclusions) {
    for (const hour of [9, 10, 11]) {
      const result = projectChats([chat(id, {
        lastMessagePreview: {
          body: { contentType: 'text', content: 'Synthetic preview' },
          createdDateTime: `2026-03-06T${String(hour).padStart(2, '0')}:00:00Z`,
          from: { user: { id: 'other-user', displayName: 'Example Author' } },
          isDeleted: false, messageType: 'message', ...overrides,
        },
      })], 'current-user')
      assert.equal(result.unreadFound, 0)
      assert.equal(result.items.length, 1)
      assert.match(result.items[0]!.detail, /^Recent chat/)
      assert.equal(result.completeUnreadEvidence, hour <= 10)
      if (hour > 10) {
        assert.match(result.items[0]!.detail, /Earlier incoming unread messages may exist/)
        assert.match(result.warnings.join(' '), /unknown for 1 chat\(s\).*may conceal earlier incoming unread messages/)
        assert.doesNotMatch(result.warnings.join(' '), /missing or invalid/)
      } else {
        assert.deepEqual(result.warnings, [])
        assert.doesNotMatch(result.items[0]!.detail, /Earlier incoming unread messages may exist/)
      }
    }
  }
})

test('long plain-text and HTML chat previews are single-line excerpts without broken Unicode', async () => {
  const content = `${'Example text 🙂\n'.repeat(60)}Ending omitted from preview`
  const rows = ['text', 'html'].map((contentType) => chat(contentType, {
    lastMessagePreview: {
      body: { contentType, content: contentType === 'html' ? `<div>${content}</div>` : content },
      createdDateTime: '2026-03-06T11:00:00Z',
      from: { user: { id: 'other-user', displayName: 'Example Author' } },
      isDeleted: false, messageType: 'message',
    },
  }))
  const { mcp } = transport({ '/me/chats': list(rows) })
  const result = await loadPersonal(mcp, options, signal())
  for (const item of result.sections.find((section) => section.id === 'chats')!.items) {
    const preview = item.detail.slice(item.detail.lastIndexOf(' · ') + 3)
    assert.ok(Array.from(preview).length <= 280)
    assert.ok(Array.from(preview).length >= 240)
    assert.ok(preview.endsWith('…'))
    assert.doesNotMatch(preview, /\n|<|Ending omitted|[\uD800-\uDFFF]/u)
    assert.match(item.url, /^https:\/\/teams\.microsoft\.com\//)
  }
})

test('null or missing chat read evidence preserves previews without inventing an unread total', async () => {
  const { mcp } = transport({
    '/me/chats': list([
      chat('unknown', { viewpoint: null }),
      chat('no-preview', { lastMessagePreview: null }),
      chat('invalid-date', { viewpoint: { lastMessageReadDateTime: 'not-a-date' } }),
      chat('unread'),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  const section = result.sections.find((entry) => entry.id === 'chats')!
  assert.equal(result.metrics.teamsUnread, null)
  assert.equal(section.items[0]!.id, 'chat-unread')
  assert.equal(section.items.length, 4)
  assert.match(section.items.find((item) => item.id === 'chat-unknown')!.detail, /Unread state unknown.*Synthetic latest message/)
  assert.match(section.note!, /1 unread chat\(s\) found among 4 loaded; total unknown/)
  assert.equal(section.source, 'partial')
  assert.match(result.warnings.join(' '), /unread state is unknown for 3 chat/)
})

test('bounded chat pages report verified unread sample counts rather than a first-page total', async () => {
  const { mcp, paths } = transport({
    '/me/chats': list([chat('sample')], 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=next'),
  })
  const result = await loadPersonal(mcp, options, signal())
  const section = result.sections.find((entry) => entry.id === 'chats')!
  assert.equal(result.metrics.teamsUnread, null)
  assert.match(section.note!, /1 unread chat\(s\) found among 1 loaded; total unknown/)
  assert.match(section.items[0]!.detail, /Unread latest message/)
  assert.equal(section.source, 'partial')
  assert.equal(paths.filter((path) => path.startsWith('/me/chats')).length, 1)
})

test('recent-chat fallbacks stay readable and distinct when no incoming latest message is verified unread', async () => {
  const { mcp } = transport({
    '/me/chats': list([chat('read', { viewpoint: { lastMessageReadDateTime: '2026-03-06T11:00:00Z' } })]),
  })
  const result = await loadPersonal(mcp, options, signal())
  const section = result.sections.find((entry) => entry.id === 'chats')!
  assert.equal(result.metrics.teamsUnread, 0)
  assert.match(section.note!, /Showing recent-chat fallbacks, not verified unread messages/)
  assert.match(section.items[0]!.detail, /^Recent chat.*Synthetic latest message/)
  const unknownIdentity = transport({ '/me': failure(403), '/me/chats': list([chat('unknown-author')]) })
  const fallback = await loadPersonal(unknownIdentity.mcp, options, signal())
  assert.equal(fallback.metrics.teamsUnread, null)
  assert.match(fallback.sections.find((entry) => entry.id === 'chats')!.items[0]!.detail, /Unread state unknown.*Synthetic latest message/)
})

test('only the last seven days of mail are considered, including flagged messages', async () => {
  const { mcp } = transport({
    '/me/mailFolders/inbox/messages': list([
      message('old-flagged', '2026-02-01T12:00:00Z', { flag: { flagStatus: 'flagged' } }),
      message('too-old', '2026-02-27T19:59:59.999Z'),
      message('cutoff', '2026-02-27T20:00:00Z'),
      message('now', '2026-03-06T20:00:00Z'),
      message('future', '2026-03-06T20:00:00.001Z'),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.deepEqual(result.sections.find((section) => section.id === 'reply')!.items.map((item) => item.id), ['mail-now', 'mail-cutoff'])
  assert.deepEqual(result.sections.find((section) => section.id === 'urgent')!.items, [])
})

test('newsletter, no-reply, and incident automation are not presented as live reply candidates', async () => {
  const received = '2026-03-06T12:00:00Z'
  const { mcp } = transport({
    '/me/mailFolders/inbox/messages': list([
      message('newsletter', received, { subject: 'Example weekly newsletter', importance: 'high' }),
      message('digest', received, { subject: 'Weekly digest for an example project' }),
      message('no-reply', received, { from: { emailAddress: { address: 'no-reply@example.com' } } }),
      message('do-not-reply', received, { from: { emailAddress: { address: 'do_not_reply@example.com' } } }),
      message('incident', received, { from: { emailAddress: { address: 'icm@example.com' } }, importance: 'high' }),
      message('incident-marker', received, { subject: '[IcM] Example incident alert' }),
      message('subscription', received, { bodyPreview: 'Manage your email preferences or unsubscribe.' }),
      message('human-incident', received, { subject: 'IcM incident follow-up', from: { emailAddress: { address: 'riley@example.com' } } }),
      message('human-notification', received, { subject: 'Please review the notification design' }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  const reply = result.sections.find((section) => section.id === 'reply')!
  assert.deepEqual(reply.items.map((item) => item.id), ['mail-human-incident', 'mail-human-notification'])
  assert.ok(reply.items.every((item) => /Heuristic candidate; may already have been replied to/.test(item.detail)))
  assert.match(reply.note!, /Not verified obligations/)
  const attention = result.sections.find((section) => section.id === 'urgent')!
  assert.deepEqual(attention.items, [])
  assert.equal(attention.source, 'partial')
})

test('missing and failed resources remain unknown while independent sources succeed', async () => {
  const { mcp } = transport({
    '/me': response({}),
    '/me/mailFolders/inbox': response({ totalItemCount: 10 }),
    '/me/calendarView': response({}),
    '/me/chats': () => { throw new Error('simulated disconnected source') },
    '/me/drive/root/children': list([{ id: 'folder', name: 'Folder', folder: {}, webUrl: 'https://example.sharepoint.com/folder' }]),
    '/me/mailFolders/inbox/messages': failure(403),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.displayName, 'Personal work')
  assert.equal(result.email, undefined)
  assert.equal(result.metrics.unreadEmails, null)
  assert.equal(result.metrics.meetingsNextDay, null)
  assert.equal(result.metrics.oof, null)
  assert.equal(result.metrics.teamsUnread, null)
  assert.deepEqual(result.schedule, [])
  assert.deepEqual(result.allocation, [])
  assert.deepEqual(result.weekLoad, [])
  assert.equal(result.sections.find((section) => section.id === 'files')!.items[0]!.title, 'Folder')
  assert.match(result.warnings.join(' '), /HTTP 403/)
  assert.equal(result.sources.find((source) => source.id === 'calendar')!.state, 'unavailable')
  assert.equal(result.sources.find((source) => source.id === 'files')!.state, 'live')
})

test('Friday and weekend windows reach Monday using DST-aware local calendar arithmetic', () => {
  const spring = calendarWindow(options)
  assert.equal(spring.nextBusinessDay.toISO(), '2026-03-09T00:00:00.000-07:00')
  assert.equal(spring.start.toISO(), '2026-03-06T00:00:00.000-08:00')
  assert.equal(spring.end.toISO(), '2026-03-16T00:00:00.000-07:00')
  const fall = calendarWindow({ ...options, now: () => new Date('2026-10-30T20:00:00Z') })
  assert.equal(fall.nextBusinessDay.toISO(), '2026-11-02T00:00:00.000-08:00')
  const saturday = calendarWindow({ ...options, now: () => new Date('2026-03-07T20:00:00Z') })
  assert.equal(saturday.nextBusinessDay.toISODate(), '2026-03-09')
  const midweek = calendarWindow({ ...options, now: () => new Date('2026-03-11T20:00:00Z') })
  assert.equal(midweek.start.toISODate(), '2026-03-09')
  assert.equal(midweek.nextBusinessDay.toISODate(), '2026-03-12')
  assert.throws(() => calendarWindow({ ...options, timeZone: 'Invalid/Zone' }), /valid clock/)
})

test('busy conflicts and free/tentative overlaps are distinct; focus and absence notices are not meetings', async () => {
  const rows = [
    event('busy-a'),
    event('busy-b', '2026-03-09T09:30:00', '2026-03-09T10:30:00'),
    event('free', '2026-03-09T11:00:00', '2026-03-09T12:00:00', { showAs: 'free' }),
    event('busy-c', '2026-03-09T11:30:00', '2026-03-09T12:30:00'),
    event('tentative', '2026-03-09T13:00:00', '2026-03-09T14:00:00', { responseStatus: { response: 'tentativelyAccepted' }, showAs: 'tentative' }),
    event('busy-d', '2026-03-09T13:30:00', '2026-03-09T14:30:00'),
    event('focus', '2026-03-09T09:00:00', '2026-03-09T10:00:00', { subject: 'Focus time' }),
    event('absence', '2026-03-09T09:00:00', '2026-03-09T10:00:00', { subject: 'Example colleague OOF notice', showAs: 'free' }),
    event('self-oof', '2026-03-10T09:00:00', '2026-03-10T10:00:00', { subject: 'Unavailable', showAs: 'oof' }),
    event('all-day', '2026-03-09T00:00:00', '2026-03-10T00:00:00', { isAllDay: true }),
    event('declined', undefined, undefined, { responseStatus: { response: 'declined' } }),
    event('cancelled', undefined, undefined, { isCancelled: true }),
    event('training', '2026-03-09T15:00:00', '2026-03-09T16:00:00', { subject: 'Customer training workshop', categories: ['Customer', 'Training'] }),
    event('organizer-only', '2026-03-09T16:00:00', '2026-03-09T17:00:00', { organizer: { emailAddress: { name: 'OOF Example' } } }),
  ]
  const { mcp } = transport({ '/me/calendarView': list(rows) })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.nextBusinessDay, '2026-03-09')
  assert.equal(result.metrics.meetingsNextDay, 8)
  assert.equal(result.metrics.oof, 2)
  const byId = new Map(result.schedule.map((item) => [item.id, item]))
  assert.equal(byId.has('declined'), false)
  assert.equal(byId.has('cancelled'), false)
  for (const id of ['busy-a', 'busy-b']) assert.equal(byId.get(id)!.conflict, true)
  for (const id of ['free', 'busy-c', 'tentative', 'busy-d']) {
    assert.equal(byId.get(id)!.conflict, false)
    assert.equal(byId.get(id)!.optionalOverlap, true)
  }
  assert.equal(byId.get('free')!.free, true)
  assert.equal(byId.get('focus')!.conflict, false)
  assert.equal(byId.get('absence')!.conflict, false)
  assert.equal(result.sections.find((section) => section.id === 'oof')!.items.length, 2)
  assert.equal(result.sections.find((section) => section.id === 'training')!.items[0]!.title, 'Customer training workshop')
  assert.equal(result.weekLoad[0]!.minutes, 480)
  assert.equal(result.allocation.reduce((sum, item) => sum + item.minutes, 0), 480)
  assert.equal(result.allocation.find((item) => item.category === 'training')!.minutes, 60)
  assert.equal(result.allocation.find((item) => item.category === 'customer')!.minutes, 0)
  assert.equal(result.allocation.find((item) => item.category === 'focus')!.minutes, 60)
  assert.ok(Math.abs(result.allocation.reduce((sum, item) => sum + item.percent, 0) - 100) < 1e-10)
})

test('DST-crossing UTC events preserve actual duration and invalid times are not free slots', () => {
  const warnings: string[] = []
  const events = parseEvents([
    event('dst', undefined, undefined, {
      start: { dateTime: '2026-03-08T09:30:00', timeZone: 'UTC' },
      end: { dateTime: '2026-03-08T10:30:00', timeZone: 'UTC' },
    }),
    event('invalid', undefined, undefined, { start: { dateTime: 'not-a-date', timeZone: 'UTC' } }),
    event('unknown-zone', undefined, undefined, { start: { dateTime: '2026-03-09T10:00:00', timeZone: 'Unrecognized Standard Time' } }),
  ], options.timeZone, warnings)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.item.start, '2026-03-08T01:30:00.000-08:00')
  assert.equal(events[0]!.item.end, '2026-03-08T03:30:00.000-07:00')
  assert.equal(events[0]!.end.diff(events[0]!.start, 'minutes').minutes, 60)
  assert.equal(warnings.length, 2)
})

test('explicit focus and no-meeting phrases work inside titles without matching general discussion subjects', async () => {
  const { mcp } = transport({
    '/me/calendarView': list([
      event('focus', undefined, undefined, { subject: 'Example planning: focus time' }),
      event('block', undefined, undefined, { subject: 'Example initiative — focus block' }),
      event('deep', undefined, undefined, { subject: 'Example initiative — deep work' }),
      event('friday', '2026-03-13T09:00:00', '2026-03-13T17:00:00', { subject: 'No Meeting Fridays', showAs: 'free' }),
      event('category', undefined, undefined, { subject: 'Example planning', categories: ['Focus time'] }),
      event('customer', undefined, undefined, { subject: 'Customer focus group' }),
      event('review', undefined, undefined, { subject: 'Focus review' }),
      event('agenda', undefined, undefined, { subject: 'No meeting agenda review' }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.metrics.meetingsNextDay, 3)
  assert.equal(result.weekLoad[0]!.meetings, 3)
  assert.equal(result.weekLoad[4]!.meetings, 0)
  assert.equal(result.weekLoad[4]!.minutes, 0)
  assert.equal(result.allocation.find((entry) => entry.category === 'focus')!.minutes, 240)
  for (const id of ['focus', 'block', 'deep', 'category']) assert.equal(result.schedule.find((entry) => entry.id === id)!.conflict, false)
})

test('calendar continuation is same-resource only and preserves opaque query bytes', () => {
  const query = '?$select=id%2Csubject&$top=20&$skiptoken=opaque%2B%252F%3D&a=one+two'
  assert.equal(calendarNextPath(`https://graph.microsoft.com/v1.0/me/calendarView${query}`), `/me/calendarView${query}`)
  assert.equal(calendarNextPath(`/me/calendarView${query}`), `/me/calendarView${query}`)
  for (const unsafe of [
    'https://evil.example/me/calendarView?x=1',
    'https://graph.microsoft.com.evil.example/v1.0/me/calendarView?x=1',
    'https://name:pass@graph.microsoft.com/v1.0/me/calendarView?x=1',
    'http://graph.microsoft.com/v1.0/me/calendarView?x=1',
    'https://graph.microsoft.com:444/v1.0/me/calendarView?x=1',
    '//graph.microsoft.com/me/calendarView?x=1',
    '/me/messages?x=1', '/me/calendarView?x=1#fragment', '/me/calendarView/../messages?x=1',
    '/me/calendarView?x=1\n', '/me\\calendarView?x=1', 42, null, {},
  ]) assert.equal(calendarNextPath(unsafe), undefined)
})

test('calendar pages retain successes, honor bounds, and do not mutate fetched records', async () => {
  const firstRows = [event('first')]
  const cursor = 'https://graph.microsoft.com/v1.0/me/calendarView?$select=id%2Csubject&$top=20&$skiptoken=a%2B%252F%3D'
  const { mcp, paths } = transport({
    '/me/calendarView': (url: URL) => url.searchParams.has('$skiptoken')
      ? list([event('second', '2026-03-09T10:00:00', '2026-03-09T11:00:00')], '/me/calendarView?$skiptoken=third')
      : list(firstRows, cursor),
  })
  const result = await loadPersonal(mcp, { ...options, attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 2 }, signal())
  assert.equal(firstRows.length, 1)
  assert.equal(paths.filter((path) => path.startsWith('/me/calendarView')).length, 2)
  assert.ok(paths.includes('/me/calendarView?$select=id%2Csubject&$top=20&$skiptoken=a%2B%252F%3D'))
  assert.equal(result.schedule.length, 2)
  assert.equal(result.metrics.meetingsNextDay, null)
  assert.equal(result.metrics.oof, null)
  assert.equal(result.weekLoad[0]!.meetings, 2)
  assert.match(result.warnings.join(' '), /page limit/)
  assert.equal(result.sources.find((source) => source.id === 'calendar')!.state, 'partial')
})

test('a complete calendar pagination produces complete counts and local-date query bounds', async () => {
  const { mcp, paths } = transport({
    '/me/calendarView': (url: URL) => url.searchParams.has('$skiptoken')
      ? list([event('second', '2026-03-09T10:00:00', '2026-03-09T11:00:00')])
      : list([event('first')], '/me/calendarView?$top=20&$select=id&$skiptoken=second'),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.schedule.length, 2)
  assert.equal(result.metrics.meetingsNextDay, 2)
  assert.equal(result.sources.find((source) => source.id === 'calendar')!.state, 'live')
  const first = new URL(paths.find((path) => path.startsWith('/me/calendarView'))!, 'https://graph.microsoft.com')
  assert.equal(first.searchParams.get('startDateTime'), '2026-03-06T00:00:00.000-08:00')
  assert.equal(first.searchParams.get('endDateTime'), '2026-03-16T00:00:00.000-07:00')
  assert.equal(result.weekLoad.length, 5)
  assert.deepEqual(result.weekLoad.map((day) => day.date), ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'])
})

test('generic collection page-size notes do not make exhausted calendar pages incomplete', async () => {
  const note = 'Results limited to 35 items per collection. Use @odata.nextLink to fetch additional pages.'
  const { mcp } = transport({
    '/me/calendarView': (url: URL) => response(url.searchParams.has('$skiptoken')
      ? { value: [event('second', '2026-03-09T10:00:00', '2026-03-09T11:00:00')] }
      : { value: [event('first')], '@odata.nextLink': '/me/calendarView?$top=35&$select=id&$skiptoken=second' }, note),
    '/me/mailFolders/inbox': response({ unreadItemCount: 4, totalItemCount: 50 }, note),
  })
  const complete = await loadPersonal(mcp, options, signal())
  assert.equal(complete.metrics.meetingsNextDay, 2)
  assert.equal(complete.metrics.oof, 0)
  assert.equal(complete.metrics.unreadEmails, 4)
  assert.equal(complete.sources.find((source) => source.id === 'calendar')!.state, 'live')
  assert.equal(complete.sources.find((source) => source.id === 'inbox')!.state, 'live')
  assert.deepEqual(complete.warnings, [])
  const bounded = await loadPersonal(mcp, { ...options, attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 1 }, signal())
  assert.equal(bounded.metrics.meetingsNextDay, null)
  assert.equal(bounded.sources.find((source) => source.id === 'calendar')!.state, 'partial')
  assert.match(bounded.warnings.join(' '), /Calendar page limit/)
  const truncated = transport({
    '/me/calendarView': response({ value: [event('first')] }, `${note} Some results were omitted.`),
  })
  const partial = await loadPersonal(truncated.mcp, options, signal())
  assert.equal(partial.metrics.meetingsNextDay, null)
  assert.match(partial.warnings.join(' '), /Some results were omitted/)
})

test('a failed, unsafe, or repeated next page cannot hide prior calendar events', async () => {
  for (const next of ['/me/calendarView?$skiptoken=second', 'https://evil.example/calendar?token=secret']) {
    const { mcp, paths } = transport({
      '/me/calendarView': (url: URL) => url.searchParams.has('$skiptoken') ? failure(503) : list([event('first')], next),
    })
    const result = await loadPersonal(mcp, options, signal())
    assert.equal(result.schedule.length, 1)
    assert.equal(result.metrics.meetingsNextDay, null)
    assert.equal(result.metrics.unreadEmails, 4)
    assert.equal(result.sources.find((source) => source.id === 'calendar')!.state, 'partial')
    assert.equal(paths.some((path) => path.includes('evil.example')), false)
    assert.doesNotMatch(result.warnings.join(' '), /token=secret/)
  }
  const cursor = '/me/calendarView?$skiptoken=repeat'
  const { mcp, paths } = transport({ '/me/calendarView': list([event('first')], cursor) })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.schedule.length, 1)
  assert.equal(paths.filter((path) => path.startsWith('/me/calendarView')).length, 2)
  assert.match(result.warnings.join(' '), /repeated a page/)
})

test('malformed JSON, row data, and provider notes surface partial or unavailable evidence', async () => {
  const { mcp } = transport({
    '/me': null,
    '/me/mailFolders/inbox': response({ unreadItemCount: '0', totalItemCount: 0 }),
    '/me/calendarView': list([event('good'), { id: 'incomplete' }]),
    '/me/mailFolders/inbox/messages': response({ value: [message('good', '2026-03-06T12:00:00Z'), message('bad', 'yesterday')] }, 'Some results were omitted.'),
    '/me/chats': response({ value: [{ id: 'chat', chatType: 'group', webUrl: 'javascript:alert(1)' }] }),
    '/me/drive/root/children': { results: [{ statusCode: 200 }] },
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.schedule.length, 1)
  assert.equal(result.metrics.meetingsNextDay, null)
  assert.equal(result.metrics.unreadEmails, null)
  assert.equal(result.sections.find((section) => section.id === 'reply')!.items.length, 1)
  assert.equal(result.sections.find((section) => section.id === 'chats')!.items.length, 0)
  assert.equal(result.sections.find((section) => section.id === 'files')!.source, 'unavailable')
  assert.match(result.warnings.join(' '), /Some results were omitted/)
  assert.match(result.warnings.join(' '), /incomplete event/)
})

test('explicit error data and malformed envelopes are not interpreted as successful empty lists', async () => {
  for (const invalid of [
    null, { results: [] }, { results: [{ statusCode: '200', data: { value: [] } }] },
    response({ value: null }), response({ value: [], error: { message: 'Synthetic failure' } }),
    { results: [{ statusCode: 200, error: 'Synthetic failure', data: { value: [] } }] },
  ]) {
    const { mcp } = transport({ '/me/calendarView': invalid })
    const result = await loadPersonal(mcp, options, signal())
    assert.equal(result.metrics.meetingsNextDay, null)
    assert.deepEqual(result.weekLoad, [])
    assert.deepEqual(result.allocation, [])
    assert.equal(result.metrics.unreadEmails, 4)
    assert.equal(result.sources.find((source) => source.id === 'calendar')!.state, 'unavailable')
    assert.ok(result.warnings.length)
  }
})

test('observed provider error causes remain actionable while authentication values are redacted', async () => {
  const { mcp } = transport({
    '/me/mailFolders/inbox/messages': () => {
      throw new Error('WorkIQ HTTP 400 InefficientFilter: unsupported sort. Bearer synthetic-secret https://outlook.office.com/?access_token=another-secret&sig=signature-secret')
    },
    '/me/calendarView': { results: [{ statusCode: 403, data: { error: { code: 'AccessDenied', message: 'Synthetic policy denial' } } }] },
    '/me/chats': response({ error: { code: 'SyntheticFailure', message: 'No diagnostic data available' } }),
  })
  const result = await loadPersonal(mcp, options, signal())
  const warnings = result.warnings.join(' ')
  assert.match(warnings, /HTTP 400 InefficientFilter: unsupported sort/)
  assert.match(warnings, /HTTP 403.*AccessDenied: Synthetic policy denial/)
  assert.match(warnings, /SyntheticFailure: No diagnostic data available/)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|another-secret|signature-secret/)
  assert.match(warnings, /\[redacted\]/)
  assert.equal(result.metrics.unreadEmails, 4)
})

test('unsafe live links are replaced only for known Outlook ids and omitted for chats and files', async () => {
  const { mcp } = transport({
    '/me/calendarView': list([event('safe-id', undefined, undefined, { webLink: 'javascript:alert(1)' })]),
    '/me/mailFolders/inbox/messages': list([message('safe-mail', '2026-03-06T12:00:00Z', { webLink: 'https://evil.example/' })]),
    '/me/chats': list([{ id: 'unsafe-chat', chatType: 'group', webUrl: 'data:text/html,payload' }]),
    '/me/drive/root/children': list([{ id: 'unsafe-file', name: 'File', webUrl: 'file:///C:/secret' }]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.schedule[0]!.url, 'https://outlook.office.com/calendar/item/safe-id')
  assert.equal(result.sections.find((section) => section.id === 'reply')!.items[0]!.url, 'https://outlook.office.com/mail/deeplink/read/safe-mail')
  assert.deepEqual(result.sections.find((section) => section.id === 'chats')!.items, [])
  assert.deepEqual(result.sections.find((section) => section.id === 'files')!.items, [])
  assert.match(result.warnings.join(' '), /unsafe source link/)
  assert.doesNotMatch(JSON.stringify(result), /javascript:|data:text\/html|evil\.example|C:\/secret/)
})

test('saved sections stay dated but never replace a current empty attention briefing', async () => {
  const directory = await mkdtemp(join(root, '.personal-test-'))
  try {
    const path = join(directory, 'reference.html')
    const asOf = 'Last refreshed: Example saved date'
    await writeFile(path, `<div class="refresh">${asOf}</div>
      <div class="urgent-banner"><h2>Needs attention now</h2><ul>${Array.from({ length: 6 }, (_, index) => `<li><a href="https://outlook.office.com/mail/${index}">Saved ${index}</a></li>`).join('')}</ul></div>
      <div class="card"><h2>Top Projects</h2><a class="row" href="https://dev.azure.com/example/project">Saved project</a></div>
      <div class="card"><h2>OOF Radar</h2><a class="row" href="https://outlook.office.com/calendar/old">Saved absence</a></div>
      <div class="card"><h2>Training</h2><a class="row" href="https://outlook.office.com/calendar/old">Saved course</a></div>
      <div class="card"><h2>Unread Teams Chats</h2><a class="row" href="https://teams.microsoft.com/l/chat/example">27 unread from saved briefing</a></div>
      <div class="card"><h2>Recent Files</h2><a class="row" href="https://example.sharepoint.com/old">Saved file</a></div>`)
    const { mcp } = transport({ '/me/calendarView': list([event('training', undefined, undefined, { subject: 'Example training' })]) })
    const result = await loadPersonal(mcp, { ...options, referencePath: path }, signal())
    assert.equal(result.referenceAsOf, asOf)
    assert.equal(result.metrics.attentionItems, 0)
    assert.equal(result.metrics.overdueActions, null)
    assert.equal(result.metrics.projects, 1)
    assert.equal(result.metrics.teamsUnread, 0)
    assert.equal(result.sections.find((section) => section.id === 'urgent')!.source, 'partial')
    assert.deepEqual(result.sections.find((section) => section.id === 'urgent')!.items, [])
    const unavailable = await loadPersonal(transport({ '/me/messages': () => { throw new Error('Briefing offline') } }).mcp, { ...options, referencePath: path }, signal())
    assert.equal(unavailable.sections.find(section => section.id === 'urgent')!.source, 'unavailable')
    assert.deepEqual(unavailable.sections.find(section => section.id === 'urgent')!.items, [])
    assert.equal(result.sections.find((section) => section.id === 'training')!.items[0]!.title, 'Example training')
    for (const id of ['oof', 'chats', 'files']) {
      const section = result.sections.find((section) => section.id === id)!
      assert.equal(section.source, 'live')
      assert.equal(section.items.length, 0)
    }
    const failing = transport({ '/me/calendarView': failure(503) })
    const fallback = await loadPersonal(failing.mcp, { ...options, referencePath: path }, signal())
    assert.equal(fallback.metrics.oof, null)
    assert.equal(fallback.sections.find((section) => section.id === 'training')!.source, 'reference')
    assert.deepEqual(fallback.allocation, [])
    const missing = await loadPersonal(mcp, { ...options, referencePath: join(directory, 'missing.html') }, signal())
    assert.equal(missing.metrics.unreadEmails, 4)
    assert.equal(missing.schedule.length, 1)
    assert.match(missing.warnings.join(' '), /Saved briefing could not be read/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('abort is propagated to the owner rather than reported as six empty resources', async () => {
  const controller = new AbortController()
  controller.abort()
  const { mcp, paths } = transport()
  await assert.rejects(loadPersonal(mcp, options, controller.signal), { name: 'AbortError' })
  assert.deepEqual(paths, [])
})

test('every personal load supplies complete insights without deriving inbox composition from recent mail', async () => {
  const { mcp } = transport({
    '/me/mailFolders/inbox': response({ unreadItemCount: 2500, totalItemCount: 4000 }),
    '/me/mailFolders/inbox/messages': list([
      message('alert', '2026-03-06T18:00:00Z', {
        subject: 'Automated alert', importance: 'high',
        from: { emailAddress: { address: 'alerts@example.com' } },
      }),
    ], 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=more'),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(personalInsightsSchema.safeParse(result.insights).success, true)
  assert.equal(result.metrics.unreadEmails, 2500)
  assert.equal(result.metrics.overdueActions, null)
  assert.equal(result.insights!.stats.unreadEmails.source, 'live')
  assert.match(result.insights!.stats.unreadEmails.text, /bounded mail does not establish inbox-wide composition/)
  assert.equal(result.insights!.stats.overdueActions.source, 'unavailable')
  assert.match(result.insights!.stats.overdueActions.text, /unknown/)
  assert.deepEqual(result.insights!.attention, [])
  assert.equal(result.insights!.reads.reply.source, 'partial')
  assert.doesNotMatch(JSON.stringify(result.insights), /nearly all|all messages are alerts|running hot|everyone is in|no meeting impact/i)
  assert.equal(result.insights!.warningsSummary.text, '1 warning(s) · sources: 1 unavailable, 2 partial, 0 reference.')
  for (const qualifier of Object.values(result.insights!.stats)) assert.ok(qualifier.text.length <= 100, qualifier.text)
})

test('unknown and partial insights preserve measured nulls and verbatim source warnings', async () => {
  const { mcp } = transport({
    '/me/mailFolders/inbox': response({ totalItemCount: 10 }),
    '/me/calendarView': list([event('loaded')], 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=more'),
    '/me/chats': list([chat('missing-read', { viewpoint: null })], 'https://graph.microsoft.com/v1.0/me/chats?$skiptoken=more'),
    '/me/drive/root/children': list([{ id: 'unsafe', name: 'Unlinked file', webUrl: 'javascript:unsafe()' }]),
  })
  const result = await loadPersonal(mcp, { ...options, attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 1 }, signal())
  for (const metric of ['overdueActions', 'unreadEmails', 'meetingsNextDay', 'teamsUnread', 'oof'] as const) {
    assert.equal(result.metrics[metric], null)
    assert.match(result.insights!.stats[metric].text, /unknown/i)
  }
  assert.equal(result.insights!.stats.meetingsNextDay.source, 'partial')
  assert.match(result.insights!.stats.meetingsNextDay.text, /1 loaded meeting/)
  assert.equal(result.insights!.stats.teamsUnread.source, 'partial')
  assert.equal(result.insights!.reads.weekLoad.source, 'partial')
  assert.match(result.insights!.reads.weekLoad.text, /Partial calendar/)
  assert.ok(result.warnings.includes('Calendar page limit reached; calendar totals are partial.'))
  assert.ok(result.warnings.includes('chats: only the bounded first page is shown; more items are available.'))
  assert.equal(result.insights!.warningsSummary.text, '5 warning(s) · sources: 1 unavailable, 5 partial, 0 reference.')
  assert.doesNotMatch(JSON.stringify(result.insights), /unsafe\(\)|No meeting impact|all in/i)
  assert.equal(result.insights!.protectedTime, undefined)
  for (const qualifier of Object.values(result.insights!.stats)) assert.ok(qualifier.text.length <= 100, qualifier.text)
})

test('missing calendar records establish neither free time, absence impact nor meeting recommendations', async () => {
  for (const calendar of [list([]), failure(503)]) {
    const { mcp } = transport({ '/me/calendarView': calendar })
    const result = await loadPersonal(mcp, options, signal())
    assert.equal(personalInsightsSchema.safeParse(result.insights).success, true)
    assert.equal(result.insights!.protectedTime, undefined)
    assert.deepEqual(result.insights!.agendaAdvice, [])
    assert.equal(result.insights!.oofImpact!.source, 'unavailable')
    assert.match(result.insights!.oofImpact!.text, /not established/)
    assert.match(result.insights!.reads.weekLoad.text, /does not establish free time|missing events are not free time/)
    assert.doesNotMatch(JSON.stringify(result.insights), /no impact|everybody|everyone is|all in|core forum/i)
  }
})

test('only explicit free overlaps get optional advice, while accepted and tentative meetings receive no priority', async () => {
  const { mcp } = transport({
    '/me/calendarView': list([
      event('busy'),
      event('free', '2026-03-09T09:15:00', '2026-03-09T09:45:00', { showAs: 'free' }),
      event('tentative', '2026-03-09T09:00:00', '2026-03-09T10:00:00', { showAs: 'tentative' }),
      event('free-alone', '2026-03-09T11:00:00', '2026-03-09T12:00:00', { showAs: 'free' }),
      event('notice', '2026-03-09T09:00:00', '2026-03-09T10:00:00', { subject: 'Example colleague OOF notice', showAs: 'free' }),
      event('focus', '2026-03-13T13:00:00', '2026-03-13T15:00:00', { subject: 'Focus time', showAs: 'busy' }),
      event('free-focus', '2026-03-13T15:00:00', '2026-03-13T16:00:00', { subject: 'Focus time', showAs: 'free' }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.deepEqual(result.insights!.agendaAdvice.map(({ eventId, recommendation }) => ({ eventId, recommendation })), [{ eventId: 'free', recommendation: 'optional' }])
  const advice = result.insights!.agendaAdvice[0]!.reason
  assert.equal(advice.source, 'live')
  assert.match(advice.text, /Marked free/)
  assert.deepEqual(new Set(advice.evidenceIds), new Set(['calendar', 'free', 'busy', 'tentative']))
  assert.doesNotMatch(advice.text, /core|must|drop|keep/i)
  assert.match(result.insights!.protectedTime!.text, /Busy focus\/no-meeting labels: Mar 13, 2026 13:00–15:00 \(UTC-07:00\)/)
  assert.match(result.insights!.protectedTime!.text, /No uninterrupted-time guarantee/)
  assert.deepEqual(result.insights!.protectedTime!.evidenceIds, ['calendar', 'focus'])
  assert.equal(result.metrics.oof, 1)
  assert.equal(result.insights!.oofImpact!.source, 'unavailable')
  assert.match(result.insights!.stats.oof.text, /not a people count/)
  assert.match(result.insights!.reads.allocation.text, /Titles\/categories are heuristics/)
})

test('historical reference attention and captions retain their date alongside unrelated current measurements', async () => {
  const directory = await mkdtemp(join(root, '.personal-insights-test-'))
  try {
    const path = join(directory, 'reference.html')
    const asOf = 'Last refreshed 7:30 PM PT, Mar 6, 2026'
    const authoredCaption = 'Saved authored context. This full caveat describes only the records available when the briefing was authored; it must not establish current project status or the availability of other people.'
    await writeFile(path, `<div class="refresh">${asOf}</div>
      <div class="kpi"><div class="kpi-label">Unread emails</div><div class="kpi-note">All are synthetic saved alerts.</div></div>
      <div class="urgent-banner"><h2>Needs attention</h2><a class="row" href="https://outlook.office.com/mail/review"><strong>Saved review</strong><div class="m">Due tomorrow, Mar 7.</div></a></div>
      <section data-section="projects"><h2>Projects</h2><p class="card-caption">${authoredCaption}</p><a class="row" href="https://dev.azure.com/example/project">Saved project</a></section>
      <section data-section="oof"><h2>OOF</h2><div class="row"><strong>No meeting impact</strong><div class="m">Everybody is available.</div></div></section>
      <section data-section="training"><h2>Training</h2><p class="card-caption">Saved course deadline has passed.</p><a class="row" href="https://outlook.office.com/calendar/old">Saved course</a></section>`)
    const { mcp } = transport()
    const result = await loadPersonal(mcp, { ...options, referencePath: path, now: () => new Date('2030-06-10T20:00:00Z') }, signal())
    assert.deepEqual(result.insights!.attention, [])
    assert.deepEqual(result.sections.find(section => section.id === 'urgent')!.items, [])
    assert.equal(result.metrics.overdueActions, null)
    assert.equal(result.metrics.unreadEmails, 4)
    assert.equal(result.metrics.oof, 0)
    assert.equal(result.insights!.stats.projects.source, 'reference')
    assert.equal(result.insights!.stats.projects.sourceDate, asOf)
    assert.equal(result.insights!.reads.projects.source, 'reference')
    assert.equal(result.insights!.reads.projects.text, authoredCaption)
    assert.equal(result.insights!.reads.projects.sourceDate, asOf)
    assert.deepEqual(result.insights!.reads.projects.evidenceIds, ['reference-projects-0'])
    assert.match(result.sections.find((section) => section.id === 'projects')!.note!, /Not verified live or automatically recomputed/)
    assert.equal(result.insights!.reads.training.source, 'live')
    assert.doesNotMatch(result.insights!.reads.training.text, /Saved course/)
    assert.doesNotMatch(JSON.stringify(result.insights), /Everybody|All are synthetic|No meeting impact/i)
    assert.deepEqual(result.insights!.agendaAdvice, [])
    const omission = 'Saved briefing: 1 item(s) omitted because their source link is missing or unsafe.'
    assert.ok(result.warnings.includes(omission))
    assert.equal(result.insights!.warningsSummary.text, '1 warning(s) · sources: 0 unavailable, 1 partial, 1 reference.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('live mail relative dates are not recast as the fetch day without an authored timezone', async () => {
  const { mcp } = transport({
    '/me/mailFolders/inbox/messages': list([
      message('relative', '2026-03-03T01:00:00Z', { importance: 'high', bodyPreview: 'Due tomorrow.' }),
      message('absolute', '2026-03-03T01:00:00Z', { importance: 'high', bodyPreview: 'Due 2026-03-07.' }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.deepEqual(result.insights!.attention, [])
  assert.deepEqual(result.sections.find(section => section.id === 'urgent')!.items, [])
})

test('busy-day and allocation reads derive bounded durations, preserve ties and identify title-based assumptions', async () => {
  const { mcp } = transport({
    '/me/calendarView': list([
      event('short'),
      event('training', '2026-03-11T09:00:00', '2026-03-11T10:30:00', { subject: 'Example training' }),
      event('customer', '2026-03-12T09:00:00', '2026-03-12T10:30:00', { subject: 'Example customer call' }),
    ]),
  })
  const result = await loadPersonal(mcp, options, signal())
  assert.equal(result.weekLoad.reduce((sum, day) => sum + day.meetings, 0), 3)
  assert.equal(result.weekLoad.reduce((sum, day) => sum + day.minutes, 0), 240)
  assert.match(result.insights!.reads.weekLoad.text, /90 minutes on 2026-03-11, 2026-03-12/)
  assert.match(result.insights!.reads.weekLoad.text, /Excludes cancelled\/declined, all-day, focus and absence records; overlaps count separately/)
  assert.equal(result.allocation.reduce((sum, entry) => sum + entry.minutes, 0), 240)
  assert.match(result.insights!.reads.allocation.text, /customer, training \(38% each\)/)
  assert.match(result.insights!.reads.allocation.text, /Titles\/categories are heuristics/)
  assert.match(result.insights!.reads.allocation.text, /excludes free\/all-day\/absence time; overlaps count separately/)
  assert.equal(result.insights!.reads.allocation.source, 'live')
  assert.equal(result.insights!.reads.allocation.sourceDate, result.generatedAt)
  assert.deepEqual(result.insights!.reads.weekLoad.evidenceIds, ['calendar', 'short', 'training', 'customer'])
})

test('closing reads remain compact without duplicating full section caveats', async () => {
  const { mcp } = transport({
    '/me/calendarView': list([event('meeting')]),
    '/me/chats': list([chat('unread')]),
    '/me/mailFolders/inbox/messages': list([message('candidate', '2026-03-06T12:00:00Z')]),
  })
  const result = await loadPersonal(mcp, options, signal())
  for (const id of ['prep', 'reply', 'chats', 'people', 'projects', 'actions', 'training', 'oof', 'files'] as const) {
    const section = result.sections.find((entry) => entry.id === id)!
    const read = result.insights!.reads[id]
    assert.ok(read.text.length <= 110, read.text)
    assert.ok(section.note)
    assert.ok(!read.text.includes(section.note), id)
  }
  assert.match(result.sections.find((section) => section.id === 'reply')!.note!, /automated senders\/newsletters are heuristically excluded/)
  assert.match(result.sections.find((section) => section.id === 'chats')!.note!, /nondeleted incoming latest message is newer than its last-read timestamp/)
  assert.match(result.insights!.reads.chats.text, /do not count all unread messages/)
  assert.match(result.insights!.reads.oof.text, /From fetch time to 2026-03-16 \(exclusive\); availability unconfirmed/)
  assert.match(result.insights!.reads.attention.text, /seven days from fetch date/)
})

test('provided overdue counts retain their value without inventing source details or an unknown-total claim', async () => {
  const result = await loadPersonal(transport().mcp, options, signal())
  const original = structuredClone(result)
  for (const overdueActions of [0, 7]) {
    const snapshot = { ...result, metrics: { ...result.metrics, overdueActions } }
    const insights = buildPersonalInsights(snapshot, {
      events: [],
      window: calendarWindow(options),
      reference: { available: false, sections: [], warnings: [] },
      chats: { unreadFound: 0, items: [] },
    })
    assert.equal(snapshot.metrics.overdueActions, overdueActions)
    assert.equal(insights.stats.overdueActions.text, 'Provided count; overdue-task source details are unavailable.')
    assert.equal(insights.stats.overdueActions.source, 'unavailable')
    assert.equal(insights.stats.overdueActions.sourceDate, undefined)
    assert.deepEqual(insights.stats.overdueActions.evidenceIds, [])
    assert.doesNotMatch(insights.stats.overdueActions.text, /total unknown/i)
  }
  assert.deepEqual(result, original)
})

test('warning summaries count source states without copying or truncating raw diagnostics', async () => {
  const result = await loadPersonal(transport().mcp, options, signal())
  const diagnostics = [
    `source-a: original diagnostic ${'detail '.repeat(1000)}end`,
    'source-b: original diagnostic\nwith line breaks\tand preserved spacing.  ',
  ]
  for (const warnings of [diagnostics, []]) {
    const raw = [...warnings]
    Object.freeze(warnings)
    const snapshot: PersonalSnapshot = {
      ...result,
      warnings,
      sources: [
        { id: 'source-a', state: 'partial', updatedAt: result.generatedAt },
        { id: 'source-b', state: 'unavailable', updatedAt: result.generatedAt },
        { id: 'source-c', state: 'partial', updatedAt: result.generatedAt },
        { id: 'reference', state: 'reference', updatedAt: result.generatedAt },
        { id: 'source-d', state: 'live', updatedAt: result.generatedAt },
      ],
    }
    const insights = buildPersonalInsights(snapshot, {
      events: [],
      window: calendarWindow(options),
      reference: { available: false, sections: [], warnings: [] },
      chats: { unreadFound: 0, items: [] },
    })
    assert.ok(insights.warningsSummary.text.length < 100, 'Summary length must not grow with raw diagnostics.')
    assert.equal(insights.warningsSummary.text, `${warnings.length} warning(s) · sources: 1 unavailable, 2 partial, 1 reference.`)
    assert.doesNotMatch(insights.warningsSummary.text, /original diagnostic|line breaks|detail/)
    assert.equal(insights.warningsSummary.sourceDate, result.generatedAt)
    assert.deepEqual(insights.warningsSummary.evidenceIds, ['source-a', 'source-b', 'source-c', 'reference'])
    assert.strictEqual(snapshot.warnings, warnings)
    assert.deepEqual(snapshot.warnings, raw)
  }
})

test('attention counts cover all retained source rows, including unclassified and partial evidence', async () => {
  const result = await loadPersonal(transport().mcp, options, signal())
  const reference = parseReferenceHtml(`<div class="refresh">Last refreshed Mar 6, 2026</div>
    <section data-section="urgent"><h2>Needs attention</h2>${[
      'Past due review', 'Due March 7, 2026', 'Waiting for review', 'Standing task',
      'Review incident notes', 'Due to the March 5, 2026 outage, review notes',
    ].map((title, index) => `<a class="row" href="https://outlook.office.com/mail/row-${index}">${title}</a>`).join('')}</section>`)
  const snapshot: PersonalSnapshot = {
    ...result, referenceAsOf: reference.referenceAsOf,
    sections: [...result.sections.filter((section) => section.id !== 'urgent'), ...reference.sections],
  }
  const insights = buildPersonalInsights(snapshot, {
    events: [], window: calendarWindow(options), reference, chats: { unreadFound: 0, items: [] },
  })
  assert.deepEqual(insights.attentionCounts, { pastDue: 1, dueSoon: 1, waiting: 1, standing: 1, unclassified: 2 })
  assert.equal(insights.attention.length, 6)
  assert.equal(personalInsightsSchema.safeParse(insights).success, true)

  const partial = await loadPersonal(transport({
    '/me/mailFolders/inbox/messages': list([
      message('past-due', '2026-03-06T12:00:00Z', { importance: 'high', subject: 'Past due review' }),
      message('unknown', '2026-03-06T12:00:00Z', { importance: 'high' }),
    ], 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=more'),
  }).mcp, options, signal())
  assert.equal(partial.sections.find((section) => section.id === 'urgent')!.source, 'partial')
  assert.deepEqual(partial.insights!.attentionCounts, { pastDue: 0, dueSoon: 0, waiting: 0, standing: 0, unclassified: 0 })
})

test('attention counts distinguish empty loaded evidence from unavailable or absent sections', async () => {
  const empty = await loadPersonal(transport().mcp, options, signal())
  assert.deepEqual(empty.insights!.attentionCounts, { pastDue: 0, dueSoon: 0, waiting: 0, standing: 0, unclassified: 0 })
  const unavailable = await loadPersonal(transport({ '/me/messages': () => { throw new Error('Briefing unavailable') } }).mcp, options, signal())
  assert.equal(unavailable.insights!.attentionCounts, null)
  assert.match(unavailable.insights!.reads.attention.text, /totals are unknown/)
  const absent = buildPersonalInsights({ ...empty, sections: empty.sections.filter((section) => section.id !== 'urgent') }, {
    events: [], window: calendarWindow(options),
    reference: { available: false, sections: [], warnings: [] }, chats: { unreadFound: 0, items: [] },
  })
  assert.equal(absent.attentionCounts, null)
  assert.equal(absent.reads.attention.source, 'unavailable')
  assert.match(absent.reads.attention.text, /totals are unknown/)
})

test('focus interval summaries group identical daily windows without losing dates or inferring protection', async () => {
  const rows = [9, 10, 11, 12, 13].map((day) => event(
    `focus-${day}`, `2026-03-${day.toString().padStart(2, '0')}T13:00:00`, `2026-03-${day.toString().padStart(2, '0')}T15:00:00`, { subject: 'Focus time' },
  ))
  const result = await loadPersonal(transport({ '/me/calendarView': list(rows) }).mcp, options, signal())
  assert.equal(result.insights!.protectedTime!.text, 'Busy focus/no-meeting labels: Mar 9–13, 2026 13:00–15:00 (UTC-07:00). No uninterrupted-time guarantee.')
  assert.deepEqual(result.insights!.protectedTime!.evidenceIds, ['calendar', ...rows.map((row) => row.id)])
  assert.equal(result.insights!.protectedTime!.sourceDate, result.generatedAt)
})

test('focus interval summaries preserve gaps, overlapping windows, duplicate intervals and overnight endpoints', async () => {
  const result = await loadPersonal(transport({ '/me/calendarView': list([
    event('first', '2026-03-09T13:00:00', '2026-03-09T15:00:00', { subject: 'Focus time' }),
    event('duplicate', '2026-03-09T13:00:00', '2026-03-09T15:00:00', { subject: 'Focus time' }),
    event('overlap', '2026-03-09T14:00:00', '2026-03-09T16:00:00', { subject: 'Focus time' }),
    event('later', '2026-03-11T13:00:00', '2026-03-11T15:00:00', { subject: 'Focus time' }),
    event('overnight', '2026-03-12T23:00:00', '2026-03-13T01:00:00', { subject: 'Focus time' }),
    event('precision', '2026-03-13T13:00:01.125', '2026-03-13T15:00:02.500', { subject: 'Focus time' }),
  ]) }).mcp, options, signal())
  const text = result.insights!.protectedTime!.text
  assert.match(text, /Mar 9, 11, 2026 13:00–15:00 \(UTC-07:00\)/)
  assert.match(text, /Mar 9, 2026 13:00–15:00 \(UTC-07:00\)/)
  assert.match(text, /Mar 9, 2026 14:00–16:00 \(UTC-07:00\)/)
  assert.match(text, /Mar 12, 2026 23:00 \(UTC-07:00\)–Mar 13, 2026 01:00 \(UTC-07:00\)/)
  assert.match(text, /Mar 13, 2026 13:00:01\.125–15:00:02\.500 \(UTC-07:00\)/)
  assert.doesNotMatch(text, /Mar 9–11|13:00–16:00/)
  assert.equal(result.insights!.protectedTime!.evidenceIds.length, 7)
})

test('focus interval summaries retain year boundaries and distinct daylight-saving offsets', async () => {
  const yearBoundary = await loadPersonal(transport({ '/me/calendarView': list([
    event('year-end', '2026-12-31T13:00:00', '2026-12-31T15:00:00', { subject: 'Focus time' }),
    event('year-start', '2027-01-01T13:00:00', '2027-01-01T15:00:00', { subject: 'Focus time' }),
  ]) }).mcp, { ...options, now: () => new Date('2026-12-25T20:00:00Z') }, signal())
  assert.match(yearBoundary.insights!.protectedTime!.text, /\[Dec 31, 2026; Jan 1, 2027\] 13:00–15:00 \(UTC-08:00\)/)

  const timeZone = 'Asia/Jerusalem'
  const focusEvent = (id: string, start: string, end: string) => event(id, start, end, {
    subject: 'Focus time',
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
  })
  const transition = await loadPersonal(transport({ '/me/calendarView': list([
    focusEvent('before', '2026-03-26T13:00:00', '2026-03-26T15:00:00'),
    focusEvent('crossing', '2026-03-27T01:00:00', '2026-03-27T04:00:00'),
    focusEvent('after', '2026-03-27T13:00:00', '2026-03-27T15:00:00'),
  ]) }).mcp, { ...options, timeZone, now: () => new Date('2026-03-20T12:00:00Z') }, signal())
  const text = transition.insights!.protectedTime!.text
  assert.match(text, /Mar 26, 2026 13:00–15:00 \(UTC\+02:00\)/)
  assert.match(text, /Mar 27, 2026 01:00 \(UTC\+02:00\)–04:00 \(UTC\+03:00\)/)
  assert.match(text, /Mar 27, 2026 13:00–15:00 \(UTC\+03:00\)/)
  assert.doesNotMatch(text, /Mar 26–27/)
})
