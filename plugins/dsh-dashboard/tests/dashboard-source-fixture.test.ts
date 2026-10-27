import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DashboardMcp } from '../src/host/mcp.ts'
import { loadPersonal } from '../src/host/personal.ts'
import { loadAdo } from '../src/host/ado.ts'
import { summarize } from '../src/shared/selection.ts'
import { adoSchema, personalSchema } from '../src/client/validation.ts'
import { loadAdoHistory } from '../src/host/ado-history.ts'
import { adoAnalyticsSettingsSchema } from '../src/shared/ado-analytics-schema.ts'
import { buildAdoAnalytics } from '../src/shared/ado-analytics.ts'
import { emptyFilters } from '../src/shared/selection.ts'
import { selectAttention } from '../src/shared/personal-selection.ts'
import { SnapshotContexts } from '../src/host/snapshot-context.ts'

test('native MCP fixtures provide only synthetic Personal and distinct ADO source evidence', async t => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const options = { command: process.execPath, args: [join(fixtures, 'dashboard-sources.mjs')], timeoutMs: 30_000 }
  const workiq = new DashboardMcp('workiq', options)
  const ado = new DashboardMcp('ado', options)
  t.after(async () => { await Promise.all([workiq.dispose(), ado.dispose()]) })
  const signal = new AbortController().signal
  const now = () => new Date('2026-09-14T16:00:00.000Z')
  const adoOptions = { maxItems: 100, pageSize: 100, staleDays: 7, blockedTags: ['blocked'], now }
  const source = {
    input: 'Example\\Sprint A', orgName: 'example', project: 'Example',
    mode: 'iteration' as const, team: 'Team',
  }
  const [personal, sprintA] = await Promise.all([
    loadPersonal(workiq, {
      timeZone: 'America/Los_Angeles', attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 5, maxItems: 35, now,
      referencePath: join(fixtures, 'synthetic-briefing.html'),
    }, signal),
    loadAdo(ado, source, adoOptions, signal),
  ])
  const sprintB = await loadAdo(ado, { ...source, input: 'Example\\Sprint B' }, adoOptions, signal)
  assert.equal(personal.displayName, 'Synthetic Dashboard Account')
  assert.equal(personal.metrics.unreadEmails, 17)
  assert.equal(personal.sources.find(item => item.id === 'inbox')?.state, 'live')
  assert.equal(sprintA.items.length, 5)
  assert.equal(summarize(sprintA.items).completed, 2)
  assert.equal(summarize(sprintA.items).remaining, 3)
  assert.equal(sprintB.items.length, 8)
  assert.equal(summarize(sprintB.items).completed, 3)
  assert.equal(summarize(sprintB.items).remaining, 5)
  assert.equal(sprintA.complete, true)
  assert.equal(sprintB.complete, true)
  assert.notEqual(sprintA.iteration?.id, sprintB.iteration?.id)
  assert.equal(personal.sections.flatMap(section => section.items).length, 0)
})

test('rich synthetic MCP evidence exercises calendar paging, refined readings, and bounded context', async t => {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const workiq = new DashboardMcp('workiq', {
    command: process.execPath,
    args: [join(fixtures, 'dashboard-sources.mjs'), join(fixtures, 'refinement-workiq.mjs')],
    timeoutMs: 30_000,
  })
  t.after(() => workiq.dispose())
  const instant = '2026-09-13T16:00:00.000Z'
  const snapshot = await loadPersonal(workiq, {
    timeZone: 'America/Los_Angeles', attention: { lookbackDays: 7, maxItems: 5, maxMessages: 50 }, maxCalendarPages: 5, maxItems: 35,
    now: () => new Date(instant), referencePath: join(fixtures, 'refinement-briefing.html'),
  }, new AbortController().signal)
  assert.equal(personalSchema.safeParse(snapshot).success, true)
  assert.equal(snapshot.metrics.unreadEmails, 424242)
  assert.equal(snapshot.metrics.meetingsNextDay, 6)
  assert.equal(snapshot.metrics.attentionItems, 1)
  assert.equal(snapshot.sources.find(source => source.id === 'calendar')?.state, 'live')
  assert.equal(selectAttention(snapshot, 'pastDue').length, 0)
  assert.equal(selectAttention(snapshot, 'thisWeekend').length, 0)
  assert.match(selectAttention(snapshot, 'all')[0]!.detail, /supported behavior and sequencing.*unconfirmed/)
  assert.equal(snapshot.insights?.agendaAdvice.length, 1)
  assert.equal(snapshot.sections.find(section => section.id === 'projects')?.items.length, 6)
  assert.ok(snapshot.weekLoad.some(day => day.meetings >= 7))
  const contexts = new SnapshotContexts({
    maxEntries: 1, maxContextBytes: 128_000, retentionMilliseconds: 60_000, now: () => Date.parse(instant),
  })
  const receipt = contexts.retain(snapshot)
  assert.doesNotThrow(() => contexts.compile(receipt.id, receipt.scope.id, {
    view: 'personal', stale: false, attentionFilter: 'all',
  }))
})

test('native MCP revision fixture supplies actual chart partitions and reopening evidence', async t => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
    const ado = new DashboardMcp('ado', {
      command: process.execPath, timeoutMs: 30_000,
      args: [join(fixtures, 'dashboard-sources.mjs'), join(fixtures, 'refinement-workiq.mjs'), join(fixtures, 'ado-analytics.mjs')],
    })
    t.after(() => ado.dispose())
    const signal = new AbortController().signal
    const snapshot = await loadAdo(ado, {
      input: 'https://dev.azure.com/example/Example/_sprints/taskboard/Team/Example/Sprint%20A',
      orgName: '', project: '', mode: 'iteration',
    }, { maxItems: 100, pageSize: 100, staleDays: 7, blockedTags: ['blocked'], now: () => new Date() }, signal)
    snapshot.analytics = { version: 1, timeZone: 'UTC', settings: adoAnalyticsSettingsSchema.parse({}) }
    snapshot.analytics.history = await loadAdoHistory(ado, snapshot, 'Task', signal)
    assert.equal(adoSchema.safeParse(snapshot).success, true)
    assert.equal(snapshot.items.length, 20)
    assert.equal(snapshot.analytics.history.items.length, 18)
    assert.notEqual(snapshot.analytics.history.status, 'unavailable')
    const report = buildAdoAnalytics(snapshot, { ...emptyFilters(), type: 'Task' })
    assert.ok(report)
    assert.equal(report.totals.completed, 6)
    assert.equal(report.totals.remaining, 10)
    assert.equal(report.totals.eligible, 16)
    assert.equal(report.closure.reduce((sum, group) => sum + group.count, 0), 10)
    assert.equal(report.age.reduce((sum, group) => sum + group.count, 0), 10)
    assert.equal(report.dependencies.groups.find(group => group.key === 'open')?.count, 2)
    assert.equal(report.dependencies.groups.find(group => group.key === 'unavailable')?.count, 1)
    assert.ok(report.history)
    assert.equal(report.history.points.at(-1)?.counts.Completed, 6)
    assert.ok(report.history.points.some(point => point.reopenedItemIds.includes(1)))
    const contexts = new SnapshotContexts({
      maxEntries: 2, maxContextBytes: 128_000, retentionMilliseconds: 60_000, now: () => Date.now(),
    })
    const receipt = contexts.retain(snapshot)
    assert.doesNotThrow(() => contexts.compile(receipt.id, receipt.scope.id, {
      view: 'ado', analyticsVersion: 1, filters: { ...emptyFilters(), type: 'Task' },
      selectedItem: null, sort: 'id', direction: 'asc', page: 0, pageSize: 20, stale: false,
    }))
})
