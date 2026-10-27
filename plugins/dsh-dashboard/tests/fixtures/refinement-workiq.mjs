/** Rich synthetic Graph records, anchored to requested dates rather than the subprocess clock. */
import { DateTime } from 'luxon'

const zone = 'America/Los_Angeles'
const person = { emailAddress: { name: 'Alex Example', address: 'alex@example.invalid' } }

function calendar(url) {
  const start = DateTime.fromISO(url.searchParams.get('startDateTime')).setZone(zone).startOf('day')
  const end = DateTime.fromISO(url.searchParams.get('endDateTime')).setZone(zone)
  if (!start.isValid || !end.isValid || end <= start) throw new Error('Synthetic calendar requires a valid requested window')
  const values = []
  const make = (day, index, title, hour, minute, duration, extra = {}) => ({
    id: `${day.toISODate()}-${index}`, subject: title,
    start: { dateTime: day.set({ hour, minute }).toUTC().toISO(), timeZone: 'UTC' },
    end: { dateTime: day.set({ hour, minute }).plus({ minutes: duration }).toUTC().toISO(), timeZone: 'UTC' },
    webLink: `https://outlook.office.com/calendar/item/${day.toISODate()}-${index}`,
    organizer: person, responseStatus: { response: 'accepted' }, isOnlineMeeting: true,
    isAllDay: false, isCancelled: false, showAs: 'busy', bodyPreview: 'Synthetic preparation context.',
    categories: [], ...extra,
  })
  for (let day = start; day < end; day = day.plus({ days: 1 })) {
    if (day.weekday > 5) continue
    const count = [0, 6, 5, 9, 10, 2][day.weekday]
    for (let index = 0; index < count; index += 1) {
      const title = index === 0 ? 'Atlas feature review' : index === 1 ? 'Optional office hours'
        : index === 2 ? 'Customer planning' : index === 3 ? 'Training workshop' : `Engineering sync ${index}`
      values.push(make(day, index, title, index < 2 ? 9 : 8 + index, index === 1 ? 15 : 0, 45, {
        showAs: index === 1 ? 'free' : 'busy',
        responseStatus: { response: index === 2 ? 'tentativelyAccepted' : 'accepted' },
      }))
    }
    values.push(make(day, 'focus', 'Focus time', 18, 0, 60))
    if (day.weekday === 3) values.push(make(day, 'absence', 'Example absence notice', 0, 0, 1440, {
      showAs: 'oof', isAllDay: true,
    }))
  }
  values.sort((left, right) => left.start.dateTime.localeCompare(right.start.dateTime) || left.id.localeCompare(right.id))
  const skip = Number(url.searchParams.get('$skip') ?? 0)
  const top = Number(url.searchParams.get('$top') ?? 35)
  if (!Number.isInteger(skip) || skip < 0 || !Number.isInteger(top) || top < 1) throw new Error('Invalid synthetic page')
  const result = { value: values.slice(skip, skip + top) }
  if (skip + top < values.length) {
    url.searchParams.set('$skip', String(skip + top))
    result['@odata.nextLink'] = `https://graph.microsoft.com/v1.0${url.pathname}${url.search}`
  }
  return result
}

/** Return synthetic data only; source URLs are inert until a human opens them. */
export function fetch(entityUrl) {
  const url = new URL(entityUrl, 'https://graph.microsoft.com')
  switch (url.pathname) {
    case '/me':
      return { id: 'synthetic-profile', displayName: 'Synthetic Dashboard Account', mail: 'dashboard@example.invalid' }
    case '/me/mailFolders/inbox':
      return { id: 'inbox', unreadItemCount: 424242, totalItemCount: 500000 }
    case '/me/calendarView':
      return calendar(url)
    case '/me/messages': {
      return { value: [{ id: 'synthetic-current-case', subject: 'Customer case 12345678',
        receivedDateTime: new Date(Date.parse(/received>=([0-9-]+)/.exec(url.searchParams.get('$search'))[1]) + 86400000).toISOString(), from: { emailAddress: { address: 'owner@example.invalid' } },
        toRecipients: [{ emailAddress: { address: 'dashboard@example.invalid' } }],
        body: { contentType: 'text', content: 'Synthetic Dashboard Account, please confirm supported sequencing for this customer. The workaround is unvalidated.' },
        conversationId: 'synthetic-current-case', webLink: 'https://outlook.office.com/mail/deeplink/read/synthetic-current-case',
      }] }
    }
    case '/me/mailFolders/inbox/messages': {
      const upper = /receivedDateTime le (\S+)/.exec(url.searchParams.get('$filter') ?? '')?.[1]
      const asOf = DateTime.fromISO(upper ?? '')
      if (!asOf.isValid) throw new Error('Synthetic mail requires an explicit upper date')
      return { value: Array.from({ length: 8 }, (_, index) => ({
        id: `mail-${index}`, subject: `Example review request ${index + 1}`, from: person,
        receivedDateTime: asOf.minus({ hours: index + 1 }).toISO(), isRead: false,
        importance: index === 0 ? 'high' : 'normal',
        flag: { flagStatus: index === 0 ? 'flagged' : 'notFlagged' },
        bodyPreview: `Could you review the synthetic proposal and reply with your decision? Item ${index + 1}.`,
        webLink: `https://outlook.office.com/mail/inbox?itemid=synthetic-${index}`,
      })) }
    }
    case '/me/chats':
      return { value: Array.from({ length: 5 }, (_, index) => ({
        id: `chat-${index}`, topic: `Example working group ${index + 1}`, chatType: 'group',
        webUrl: `https://teams.microsoft.com/l/chat/0/0?users=example${index}%40example.invalid`,
        viewpoint: { lastMessageReadDateTime: '2026-01-01T08:00:00Z' },
        lastMessagePreview: {
          createdDateTime: '2026-01-01T09:00:00Z',
          body: { contentType: 'text', content: `Synthetic follow-up ${index + 1}: review requested.` },
          from: { user: { displayName: 'Blair Example' } },
        },
      })) }
    case '/me/drive/root/children':
      return { value: Array.from({ length: 5 }, (_, index) => ({
        id: `folder-${index}`, name: `Example project folder ${index + 1}`, folder: { childCount: 3 },
        lastModifiedDateTime: `2026-01-0${5 - index}T12:00:00Z`,
        webUrl: `https://example.sharepoint.com/sites/synthetic/Documents/folder-${index}`,
      })) }
    default:
      throw new Error(`Unsupported rich synthetic resource: ${url.pathname}`)
  }
}
