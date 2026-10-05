/** Installed-profile checks use a test-only trigger; production GET/POST never starts a model. */
import { strict as assert } from 'node:assert'

export const PROACTIVE_TEXT = 'Synthetic scheduled briefing: your calendar is ready to review. Would you like to plan the day?'
export const FIRST_BRIEFING_AT = '2026-01-02T16:00:00.000Z'

/** Verify fresh generation, disconnected replay, user gestures, and cancellation over real HTTP. */
export async function smokeProactiveInbox(h) {
  let firstItem
  await h.scenario(async page => {
    await h.startNewSession(page, 'proactive draft')
    const draft = await h.seedDraft(page, 'Keep this draft while the assistant speaks.', 'proactive draft')
    assert.equal(draft, 'Keep this draft while the assistant speaks.', 'proactive test requires an editable, nonempty draft')
    const selectedUrl = page.url()
    const before = await snapshot(page)
    assert.equal(before.enabled, true)
    assert.deepEqual(before.items, [])
    assert.equal((await trigger(page, h.token, FIRST_BRIEFING_AT)).status, 'completed')
    const ready = await snapshot(page)
    assert.equal(ready.items.length, 1)
    firstItem = ready.items[0]
    assert.equal(firstItem.text, PROACTIVE_TEXT)
    assert.equal(firstItem.read, false)
    assert.equal(page.url(), selectedUrl)
    await h.assertDraft(page, draft, 'proactive delivery preserves draft')
    const panel = await h.panel(page)
    await panel.getByRole('tab', { name: /^Inbox/u }).click()
    await panel.getByRole('tabpanel').getByText(PROACTIVE_TEXT, { exact: true }).waitFor({ state: 'visible' })
    await h.assertDraft(page, draft, 'Inbox preview preserves draft')
    await h.screenshot(page, 'proactive-inbox-unread')
    await panel.getByRole('button', { name: 'Hide assistant panel', exact: true }).click()
    const collapsed = page.getByRole('button', { name: 'Show assistant panel · Inbox: 1 unread', exact: true })
    await collapsed.waitFor({ state: 'visible' })
    await h.screenshot(page, 'proactive-inbox-collapsed-badge')
    await collapsed.click()
    const requests = (await h.providerLog()).filter(entry => entry.type === 'briefing-request')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].source.kind, 'plugin')
    assert.equal(requests[0].source.plugin, 'wa-briefing')
    assert.deepEqual(requests[0].tools.sort(), ['calendar_find_conflicts', 'calendar_list', 'memory_list', 'memory_read'])
    const sessions = await h.sessions()
    const session = sessions.find(entry => entry.header.id === firstItem.sessionId)
    assert.ok(session)
    assert.equal(session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin' && event.data.source.plugin === 'wa-briefing').length, 1)
    assert.ok(session.events.filter(event => event.type === 'user/message').every(event => event.data.source.kind === 'plugin'))
    const calendarCall = session.events.find(event => event.type === 'tool/call' && event.data.name === 'calendar_list')
    assert.ok(calendarCall)
    assert.ok(session.events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && block.toolCallId === calendarCall.data.callId && !block.isError)))
    assert.ok(session.events.some(event => event.type === 'assistant/message' && event.data.message.id === firstItem.messageId))
    await h.saveSession(session, new URL(page.url()).origin)
  }, 'proactive fresh message')

  await h.scenario(async page => {
    const restored = await snapshot(page)
    assert.deepEqual(restored.items, [firstItem])
    const before = (await h.providerLog()).filter(entry => entry.type === 'briefing-request').length
    assert.deepEqual(await trigger(page, h.token, FIRST_BRIEFING_AT), { status: 'skipped', reason: 'duplicate' })
    assert.equal((await h.providerLog()).filter(entry => entry.type === 'briefing-request').length, before)
    let panel = await h.panel(page)
    await panel.getByRole('tab', { name: /^Inbox/u }).click()
    await panel.getByRole('tabpanel').getByText(PROACTIVE_TEXT, { exact: true }).waitFor({ state: 'visible' })
    await panel.getByRole('button', { name: 'Open and reply' }).click()
    await h.conversationText(page, PROACTIVE_TEXT, 'proactive open conversation')
    assert.equal((await snapshot(page)).items[0].read, true)
    panel = await h.panel(page)
    await panel.getByRole('tab', { name: /^Inbox/u }).click()
    await panel.getByRole('button', { name: /^Dismiss/u }).click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="wa-assistant-panel"]')?.textContent?.includes('Synthetic scheduled briefing:'))
    assert.deepEqual((await snapshot(page)).items, [])
    await page.reload({ waitUntil: 'load' })
    await h.dialogs(page)
    assert.deepEqual((await snapshot(page)).items, [])

    await h.control({ briefingHoldOnce: true })
    const pending = trigger(page, h.token, '2026-01-02T16:01:00.000Z').catch(error => error)
    await h.waitProvider(entry => entry.type === 'briefing-hold-start', 'proactive pause barrier')
    panel = await h.panel(page)
    await panel.getByRole('tab', { name: /^Inbox/u }).click()
    await panel.getByRole('button', { name: /Pause/u }).click()
    await panel.getByRole('button', { name: /Resume/u }).waitFor({ state: 'visible' })
    assert.ok(await pending instanceof Error)
    assert.deepEqual((await snapshot(page)).items, [])
    assert.equal((await snapshot(page)).paused, true)
    assert.deepEqual(await trigger(page, h.token, '2026-01-02T16:02:00.000Z'), { status: 'skipped', reason: 'paused' })
  }, 'proactive restart and pause')

  await h.scenario(async page => {
    assert.equal((await snapshot(page)).paused, true)
    const panel = await h.panel(page)
    await panel.getByRole('tab', { name: /^Inbox/u }).click()
    await panel.getByRole('button', { name: /Resume/u }).click()
    await panel.getByRole('button', { name: /Pause/u }).waitFor({ state: 'visible' })
    assert.equal((await snapshot(page)).paused, false)
    assert.deepEqual((await snapshot(page)).items, [])
    assert.deepEqual(await trigger(page, h.token, '2026-01-02T16:01:00.000Z'), { status: 'skipped', reason: 'duplicate' })
  }, 'proactive pause persisted')
}

async function snapshot(page) {
  const response = await page.request.get(new URL('/api/work-assistant/briefing', page.url()).href, { headers: { 'x-dsh-assistant': '1' } })
  assert.equal(response.status(), 200)
  return response.json()
}

async function trigger(page, token, at) {
  const url = new URL('/__wa-test/briefing', page.url())
  url.searchParams.set('at', at)
  const response = await page.request.post(url.href, { headers: { 'x-wa-test-token': token }, timeout: 30_000 })
  const result = await response.json()
  if (!response.ok()) throw new Error('Scheduled fixture failed: ' + JSON.stringify(result))
  return result
}
