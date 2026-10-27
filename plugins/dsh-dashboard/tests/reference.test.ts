import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadReference, parseReferenceHtml } from '../src/host/reference.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const asOf = 'Last refreshed: Friday, Mar 6, 2026 at 09:15 PST'
const outlook = 'https://outlook.office.com/mail/example'

test('reference parsing retains dated safe text, sections, people, and semantic headings', () => {
  const result = parseReferenceHtml(`
    <div class="refresh"><span class="dot"></span>${asOf}</div>
    <div class="urgent-banner"><h2>Needs attention now</h2><ul>
      <li><a href="${outlook}"><strong>Saved review</strong> — check the draft</a></li>
    </ul></div>
    <div class="card"><h2>Prep Notes</h2><a class="row" href="${outlook}">
      <span class="t">Agenda</span><div class="m">Read &amp; compare</div>
    </a></div>
    <section class="card"><h2>Top Projects</h2><a class="row" href="https://dev.azure.com/example/project">
      <span class="t">Example project</span><div class="m">Recorded update</div>
    </a></section>
    <div class="card"><h2>Emails Needing a Reply</h2><a class="row" href="${outlook}"><span class="t">Saved reply candidate</span></a></div>
    <div class="card"><h2>Long-Term Action Items</h2><a class="row" href="${outlook}">Saved action</a></div>
    <div class="card"><h2>Training &amp; Learning</h2><a class="row" href="${outlook}">Example course</a></div>
    <div class="card"><h2>OOF Radar</h2><a class="row" href="${outlook}">Recorded absence</a></div>
    <div class="card"><h2>People to Follow Up With</h2><a class="person" href="mailto:person@example.com">
      <span class="av">EP</span><span><span class="t">Example Person</span><div class="m">Saved follow-up</div></span>
    </a></div>
    <div class="card"><h2>Unread Teams Chats</h2><a class="row" href="https://teams.microsoft.com/l/chat/example">42 unread in saved briefing</a></div>
    <div class="card"><h2>Recent Files in Flight</h2><a class="row" href="https://example.sharepoint.com/file">Saved file</a></div>
  `)
  assert.equal(result.available, true)
  assert.equal(result.referenceAsOf, asOf)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.sections.map((section) => section.id), ['urgent', 'prep', 'projects', 'reply', 'actions', 'training', 'oof', 'people', 'chats', 'files'])
  for (const section of result.sections) {
    assert.equal(section.source, 'reference')
    assert.match(section.note!, /Not verified live or automatically recomputed/)
    assert.equal(section.items.length, 1)
    assert.equal(section.items[0]!.source, 'reference')
    assert.equal(section.items[0]!.sourceDate, asOf)
  }
  assert.equal(result.sections[0]!.items[0]!.severity, 'hot')
  assert.equal(result.sections[1]!.items[0]!.detail, 'Read & compare')
  assert.equal(result.sections.find((section) => section.id === 'people')!.items[0]!.initials, 'EP')
})

test('malicious markup and unsafe or absent links cannot become reference items', () => {
  const unsafe = [
    'javascript:alert(1)', 'data:text/html,payload', 'file:///C:/secret', '//evil.example/path',
    'https://evil.example/path', 'https://outlook.office.com@evil.example/', 'https://user:password@outlook.office.com/',
    'mailto:person@example.com?subject=Send', 'http://outlook.office.com/',
  ]
  const result = parseReferenceHtml(`
    <p>${asOf}</p>
    <script>globalThis.compromised = true</script><iframe src="https://evil.example/">frame text</iframe>
    <div class="card" data-section="projects"><h2>Projects</h2>
      <a class="row" href="${outlook}" onclick="steal()"><span class="t">Safe <b>title</b></span><div class="m">Visible<script>hidden payload</script><img src=x onerror="steal()"> text</div></a>
      ${unsafe.map((url) => `<a class="row" href="${url}">Unsafe</a>`).join('')}
      <div class="row">No source link</div>
      <object><a class="row" href="${outlook}">Embedded content</a></object>
    </div>
  `)
  assert.equal(result.referenceAsOf, asOf)
  assert.equal(result.sections[0]!.items.length, 1)
  assert.equal(result.sections[0]!.items[0]!.title, 'Safe title')
  assert.equal(result.sections[0]!.items[0]!.detail, 'Visible text')
  assert.match(result.warnings.join(' '), /10 item\(s\) omitted/)
  assert.doesNotMatch(JSON.stringify(result.sections), /<|onclick|steal|payload|iframe|compromised|password/)
})

test('missing reference dates stay unknown and nested cards are not duplicated', () => {
  const result = parseReferenceHtml(`<section><h2>Projects</h2>
    <div class="card"><h2>Projects</h2>
      <a class="row" href="${outlook}">One</a><a class="row" href="${outlook}">One</a>
      <a class="row" href="${outlook}/two">Two</a>
    </div></section>`, 1)
  assert.equal(result.referenceAsOf, undefined)
  assert.equal(result.sections.length, 1)
  assert.equal(result.sections[0]!.items.length, 1)
  assert.equal(result.sections[0]!.items[0]!.sourceDate, undefined)
  assert.match(result.warnings.join(' '), /no identifiable.*limited/)
  assert.equal(parseReferenceHtml('<p>Not a briefing</p>').sections.length, 0)
})

test('reference reads use isolated local roots and failures do not throw', async () => {
  const directory = await mkdtemp(join(root, '.reference-test-'))
  try {
    const path = join(directory, 'briefing.html')
    await writeFile(path, `<div class="refresh">${asOf}</div><section data-section="urgent"><h2>Urgent</h2><a href="${outlook}">Saved</a></section>`)
    const result = await loadReference(path, 10, new AbortController().signal)
    assert.equal(result.available, true)
    assert.equal(result.sections[0]!.source, 'reference')
    const missing = await loadReference(join(directory, 'missing.html'), 10, new AbortController().signal)
    assert.equal(missing.available, false)
    assert.match(missing.warnings[0]!, /could not be read/)
    assert.match(missing.warnings[0]!, /ENOENT/)
    assert.match(missing.warnings[0]!, /missing\.html/)
    assert.deepEqual(await loadReference(undefined, 10, new AbortController().signal), { available: false, sections: [], warnings: [] })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(loadReference(path, 10, controller.signal), { name: 'AbortError' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function attentionHtml(rows: [string, string][], refresh = asOf): string {
  return `<div class="refresh">${refresh}</div><section data-section="urgent"><h2>Needs attention</h2>${rows.map(([title, detail], index) => (
    `<a class="row" href="${outlook}/${index}"><strong>${title}</strong><span class="m">${detail}</span></a>`
  )).join('')}</section>`
}

test('attention dates belong to the saved refresh, with explicit severity ranked without an invented deadline', () => {
  const parsed = parseReferenceHtml(attentionHtml([
    ['Unexplained action', 'A retained record without timing evidence'],
    ['Review', 'Due tomorrow, Mar 7. Sent earlier in the month.'],
    ['Ongoing task', 'An ongoing quality KPI'],
    ['Response', 'Waiting for your approval'],
    ['Permission review — past due', 'The review window has already lapsed.'],
    ['Sev 2 incident', 'An explicit source severity, without a date'],
  ]))
  const byId = new Map(parsed.attention!.map((entry) => [entry.itemId, entry]))
  assert.equal(byId.get('reference-urgent-1')!.category, 'dueSoon')
  assert.equal(byId.get('reference-urgent-1')!.thisWeekend, true)
  assert.match(byId.get('reference-urgent-1')!.consequence.text, /2026-03-07/)
  assert.equal(byId.get('reference-urgent-4')!.category, 'pastDue')
  assert.equal(byId.get('reference-urgent-3')!.category, 'waiting')
  assert.equal(byId.get('reference-urgent-2')!.category, 'standing')
  assert.equal(byId.get('reference-urgent-5')!.category, 'unclassified')
  assert.equal(byId.get('reference-urgent-5')!.thisWeekend, false)
  assert.match(byId.get('reference-urgent-5')!.consequence.text, /no deadline/)
  assert.deepEqual(parsed.attention!.map((entry) => entry.itemId), [
    'reference-urgent-4', 'reference-urgent-5', 'reference-urgent-1', 'reference-urgent-3', 'reference-urgent-2', 'reference-urgent-0',
  ])
  assert.deepEqual(parsed.attention!.map((entry) => entry.rank), [0, 1, 2, 3, 4, 5])
  for (const entry of parsed.attention!) {
    assert.equal(entry.consequence.source, 'reference')
    assert.equal(entry.consequence.sourceDate, asOf)
    assert.deepEqual(entry.consequence.evidenceIds, [entry.itemId])
  }
})

test('ambiguous, contradictory, negated and undated deadline language is not classified as due', () => {
  for (const detail of [
    'Due tomorrow, Mar 8.', 'Due tomorrow or Monday.', 'Due sometime next week.',
    'Due 2026-02-30.', 'Due 2026-03-07 or 2026-03-08.', 'Due Mar 7. Deadline is Mar 8.',
    'Not overdue; no deadline.', 'No longer waiting for your approval.', 'Due next Monday.',
    'Due Mar 7, 2027.', 'Due Jan 2.', 'Due Sunday, Mar 7.', 'Due Mar 7–8.',
    'Due before Mar 7.', 'Past-due review completed.', 'An ongoing quality KPI was cancelled.',
  ]) {
    const result = parseReferenceHtml(attentionHtml([['Example row', detail]]))
    assert.equal(result.attention![0]!.category, 'unclassified', detail)
    assert.equal(result.attention![0]!.thisWeekend, false, detail)
  }
  for (const refresh of ['', 'Last refreshed: date unknown', 'Last refreshed Thursday, Mar 6, 2026']) {
    const result = parseReferenceHtml(attentionHtml([['Example row', 'Due tomorrow, Mar 7.']], refresh))
    assert.equal(result.attention![0]!.category, 'unclassified')
    assert.equal(result.attention![0]!.thisWeekend, false)
  }
})

test('deadline comparison supports explicit historical dates without converting bare weekdays into weekend deadlines', () => {
  const result = parseReferenceHtml(attentionHtml([
    ['Past deadline', 'Due Mar 5, 2026.'],
    ['Weekend deadline', 'Due 2026-03-08.'],
    ['Weekday deadline', 'Due Mar 9, 2026.'],
    ['Unanchored priority', 'Before Monday; do a standing sweep.'],
  ]))
  const byId = new Map(result.attention!.map((entry) => [entry.itemId, entry]))
  assert.equal(byId.get('reference-urgent-0')!.category, 'pastDue')
  assert.equal(byId.get('reference-urgent-1')!.thisWeekend, true)
  assert.equal(byId.get('reference-urgent-2')!.category, 'dueSoon')
  assert.equal(byId.get('reference-urgent-2')!.thisWeekend, false)
  assert.equal(byId.get('reference-urgent-3')!.category, 'standing')
  assert.equal(byId.get('reference-urgent-3')!.thisWeekend, false)
})

test('reference insight extraction excludes dropped rows and never imports KPI claims or unsafe conclusions', () => {
  const result = parseReferenceHtml(`${attentionHtml([['Safe row', 'Standing task']])}
    <section data-section="projects"><h2>Projects</h2>
      <p class="card-caption">Authored context &amp; caution.</p>
      <a class="row" href="${outlook}/project">Saved project</a>
    </section>
    <section data-section="oof"><h2>OOF</h2>
      <div class="row"><span class="t">No meeting impact</span><span class="read">Everybody is available.</span></div>
      <a class="row" href="javascript:unsafe()"><span class="read">Unsafe authored conclusion</span></a>
    </section>
    <div class="kpi"><div class="kpi-label">Unread emails</div><div class="kpi-note">All messages are alerts.</div></div>`)
  assert.equal(result.captions!.projects, 'Authored context & caution.')
  assert.equal(result.captions!.oof, undefined)
  assert.deepEqual(result.sections.find((section) => section.id === 'oof')!.items, [])
  assert.equal(result.attention!.length, 1)
  assert.match(result.warnings.join(' '), /2 item\(s\) omitted/)
  assert.doesNotMatch(JSON.stringify({ attention: result.attention, captions: result.captions }), /Everybody|Unsafe|All messages/)
})

test('attention enrichment follows per-section retention limits without dropping unclassified rows', () => {
  const result = parseReferenceHtml(attentionHtml([
    ['Unclassified first row', 'Recorded context only'],
    ['Omitted priority', 'Past due'],
  ]), 1)
  assert.equal(result.sections[0]!.items.length, 1)
  assert.equal(result.attention!.length, 1)
  assert.equal(result.attention![0]!.itemId, 'reference-urgent-0')
  assert.equal(result.attention![0]!.category, 'unclassified')
  assert.match(result.warnings.join(' '), /limited to the configured item count/)
})

test('causal due-to clauses never turn incident dates into action deadlines', () => {
  for (const detail of [
    'Due to the March 5, 2026 outage, review incident notes.',
    'Review incident notes due to the 2026-03-05 outage.',
    'Due to the March 7, 2026 maintenance window, review incident notes.',
    'Due to tomorrow’s maintenance, review incident notes.',
    'The deadline changed due to the March 5, 2026 outage.',
  ]) {
    const result = parseReferenceHtml(attentionHtml([['Review incident notes', detail]]))
    assert.equal(result.attention![0]!.category, 'unclassified', detail)
    assert.equal(result.attention![0]!.thisWeekend, false, detail)
    assert.doesNotMatch(result.attention![0]!.consequence.text, /Source deadline|precedes|Due 2026/)
  }
  const explicit = parseReferenceHtml(attentionHtml([['Review', 'Due to the March 5, 2026 outage, review incident notes. Review due March 7, 2026.']]))
  assert.equal(explicit.attention![0]!.category, 'dueSoon')
  assert.equal(explicit.attention![0]!.thisWeekend, true)
  assert.match(explicit.attention![0]!.consequence.text, /2026-03-07/)
})
