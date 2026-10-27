import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshDelay } from '../src/client/owner.ts'
import { settingsSchema } from '../src/client/validation.ts'
import { refreshClockSlots } from '../src/shared/schedule.ts'
import type { DashboardSettings } from '../src/shared/types.ts'

const settings: DashboardSettings = {
  timeZone: 'America/Los_Angeles', refreshMinutes: 60, refreshMinute: 55,
  workdayStart: 6, workdayEnd: 18, cacheSeconds: 600, hasReference: false, maxChatQuestionChars: 4000,
}

function next(now: string, schedule = settings): string {
  const instant = Date.parse(now)
  return new Date(instant + refreshDelay(schedule, instant)).toISOString()
}

test('hourly refresh uses the twelve weekday :55 slots, not elapsed time since fetching', () => {
  assert.deepEqual(refreshClockSlots(settings), { first: 415, last: 1075 })
  assert.equal(next('2026-09-14T13:54:59Z'), '2026-09-14T13:55:00.000Z')
  assert.equal(next('2026-09-14T13:55:00Z'), '2026-09-14T14:55:00.000Z')
  assert.equal(next('2026-09-14T17:07:43Z'), '2026-09-14T17:55:00.000Z')
  assert.equal(next('2026-09-15T00:54:30Z'), '2026-09-15T00:55:00.000Z')
  assert.equal(next('2026-09-15T00:55:00Z'), '2026-09-15T13:55:00.000Z')
})

test('the last Friday slot advances past the weekend', () => {
  assert.equal(next('2026-09-12T00:55:00Z'), '2026-09-14T13:55:00.000Z')
  assert.equal(next('2026-09-12T19:00:00Z'), '2026-09-14T13:55:00.000Z')
})

test('weekday refresh times retain local clock hours across both Pacific DST transitions', () => {
  assert.equal(next('2026-03-07T01:55:00Z'), '2026-03-09T13:55:00.000Z')
  assert.equal(next('2026-10-31T00:55:00Z'), '2026-11-02T14:55:00.000Z')
})

test('custom minute and interval remain anchored to the configured workday', () => {
  const custom = { ...settings, timeZone: 'UTC', refreshMinutes: 15, refreshMinute: 5, workdayStart: 9, workdayEnd: 10 }
  assert.deepEqual(refreshClockSlots(custom), { first: 545, last: 590 })
  assert.equal(next('2026-09-14T09:21:10Z', custom), '2026-09-14T09:35:00.000Z')
  assert.equal(next('2026-09-14T09:50:00Z', custom), '2026-09-15T09:05:00.000Z')
})

test('a weekday clock gap skips the nonexistent wall-clock slot', () => {
  const jerusalem = { ...settings, timeZone: 'Asia/Jerusalem', workdayStart: 2, workdayEnd: 5 }
  assert.equal(next('2026-03-26T23:59:00Z', jerusalem), '2026-03-27T00:55:00.000Z')
  assert.equal(next('2026-03-26T23:59:00Z', { ...jerusalem, workdayEnd: 3 }), '2026-03-29T23:55:00.000Z')
})

test('a repeated weekday clock slot schedules each real occurrence once', () => {
  const cairo = { ...settings, timeZone: 'Africa/Cairo', workdayStart: 23, workdayEnd: 24 }
  assert.equal(next('2026-10-29T20:54:00Z', cairo), '2026-10-29T20:55:00.000Z')
  assert.equal(next('2026-10-29T20:56:00Z', cairo), '2026-10-29T21:55:00.000Z')
  assert.equal(next('2026-10-29T21:55:00Z', cairo), '2026-10-30T21:55:00.000Z')
})

test('invalid clock settings are refused at the response boundary', () => {
  assert.equal(settingsSchema.safeParse(settings).success, true)
  for (const refreshMinute of [-1, 60, 0.5]) {
    assert.equal(settingsSchema.safeParse({ ...settings, refreshMinute }).success, false)
  }
  assert.equal(settingsSchema.safeParse({ ...settings, refreshMinutes: 1.5 }).success, false)
  assert.equal(settingsSchema.safeParse({ ...settings, workdayEnd: settings.workdayStart }).success, false)
})
