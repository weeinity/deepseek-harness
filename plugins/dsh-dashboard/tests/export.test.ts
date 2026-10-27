import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from 'cheerio'
import { renderDashboardHtml } from '../src/export/html.ts'
import type { AdoItem, AdoSnapshot, PersonalSnapshot } from '../src/shared/types.ts'

const snapshot: PersonalSnapshot = {
  kind: 'personal', generatedAt: '2026-09-12T05:00:00Z', timeZone: 'America/Los_Angeles',
  displayName: 'Sample <script>alert(1)</script>', nextBusinessDay: '2026-09-14',
  sources: [], metrics: { overdueActions: null, attentionItems: 2, unreadEmails: 22, meetingsNextDay: 6, teamsUnread: null, projects: 1, oof: 0 },
  schedule: [], todayRemaining: [], weekLoad: [{ date: '2026-09-14', meetings: 6, minutes: 60 }],
  allocation: [{ category: 'internal', minutes: 60, percent: 100 }],
  sections: [{ id: 'projects', source: 'reference', items: [{ id: '1', title: 'Plan & review', detail: 'Saved <b>text</b>', url: 'https://outlook.office.com/mail/inbox?searchquery=plan', source: 'reference' }] }],
  referenceAsOf: 'Yesterday; not verified live', warnings: [],
}

test('portable export renders final numbers, safe text, source links and CSS charts without scripts', () => {
  const html = renderDashboardHtml(snapshot)
  const $ = load(html)
  $('script').remove()
  assert.deepEqual($('.kpi-value').map((_, node) => $(node).text()).get(), ['—', '22', '6', '—', '1', '0'])
  assert.match($('.kpi').first().text(), /Overdue actions/)
  assert.equal($('h1 script').length, 0)
  assert.equal($('.row b').length, 0)
  assert.match($('.row').first().attr('href') ?? '', /^https:\/\/outlook.office.com/)
  assert.match(html, /conic-gradient/)
  assert.match(html, /#theme-toggle:checked/)
  assert.match(html, /Not configured|not configured/)
  assert.equal($('script[src],link[href],img[src],iframe,canvas').length, 0)
})

test('ADO export keeps Unknown and Removed out of people and risk totals while retaining their rows', () => {
  const item = (id: number, category: AdoItem['category']): AdoItem => ({
    id, title: `Synthetic work ${id}`, type: 'Task', state: category, category,
    assignee: `Person ${id}`, assigneeId: `person-${id}`, areaPath: 'Demo', iterationPath: 'Demo\\Sprint',
    tags: [], url: `https://dev.azure.com/example/Demo/_workitems/edit/${id}`,
    risks: category === 'Completed' ? [] : ['stale'],
  })
  const ado: AdoSnapshot = {
    kind: 'ado', generatedAt: snapshot.generatedAt,
    source: { input: 'Demo\\Sprint', path: 'Demo\\Sprint', orgName: 'example', project: 'Demo', mode: 'iteration' },
    sourceUrl: 'https://dev.azure.com/example/Demo', defaultType: 'Task',
    items: [item(1, 'Completed'), item(2, 'Unknown'), item(3, 'Removed')], complete: true, warnings: [],
  }
  const $ = load(renderDashboardHtml(ado))
  assert.deepEqual($('.kpi-value').map((_, node) => $(node).text()).get(), ['1', '0', '1', '0', '1', '1'])
  assert.equal($('tbody tr').length, 3)
})
