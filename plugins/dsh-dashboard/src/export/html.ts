/** Portable snapshots contain rendered values and safe links, not live credentials or requests. */
import type { AdoSnapshot, DashboardItem, PersonalSnapshot, SectionId } from '../shared/types.ts'
import type { DashboardExportSnapshot } from '../shared/export-types.ts'
import { attentionCategorySchema, type AttentionCategory, type EvidenceText, type PersonalInsights } from '../shared/insights.ts'
import { safeSourceUrl } from '../shared/urls.ts'
import { buildAdoAnalytics } from '../shared/ado-analytics.ts'
import { emptyFilters, groupCounts, summarize } from '../shared/selection.ts'
import { adoAnalyticsCss, renderAdoAnalytics } from './ado-analytics.ts'
import { projectAttention } from '../shared/personal-selection.ts'

const names: Record<SectionId, string> = {
  urgent: 'Needs attention', prep: 'Prep notes', projects: 'Top projects', reply: 'Emails and follow-ups',
  actions: 'Long-term actions', training: 'Training and learning', oof: 'OOF radar', people: 'People to follow up with',
  chats: 'Teams chats', files: 'Files in flight',
}
const categoryNames: Record<string, string> = { customer: 'Customer-facing', training: 'Training', internal: 'Internal', focus: 'Focus', admin: 'Admin' }
const colors = ['#0078d4', '#5e60ce', '#00a2bc', '#16a34a', '#d97706']
const attentionNames: Record<AttentionCategory, string> = {
  pastDue: 'Past due', dueSoon: 'Due soon', waiting: 'Waiting', standing: 'Standing sweep', unclassified: 'Unclassified',
}
const attentionColors = ['#e05050', '#d99b22', '#0078d4', '#596779', '#596779']

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
}

function link(url: string, body: string, className = 'row'): string {
  const safe = safeSourceUrl(url)
  return safe ? `<a class="${className}" href="${escape(safe)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<div class="${className}">${body}<small>Source link unavailable</small></div>`
}

function reading(value: EvidenceText | undefined): string {
  if (!value) return ''
  return `<p class="reading">${escape(value.text)}<small>${escape(value.source)}${value.sourceDate ? ` · ${escape(value.sourceDate)}` : ''}</small></p>`
}

function item(value: DashboardItem, index: number, attention?: PersonalInsights['attention'][number]): string {
  const badge = value.source === 'reference' ? '<span class="badge warning">Saved briefing</span>' : '<span class="badge">Source data</span>'
  const avatar = value.initials ? `<span class="avatar avatar-${index % 5 + 1}" aria-hidden="true">${escape(value.initials)}</span>` : ''
  return link(value.url, `${avatar}<strong>${value.severity ? `<span class="health ${escape(value.severity)}"></span>` : ''}${escape(value.title)}</strong>${badge}<p>${escape(value.detail)}</p>${value.sourceDate ? `<small>${escape(value.sourceDate)}</small>` : ''}${reading(attention?.consequence)}`)
}

function card(title: string, body: string, note = '', extraClass = ''): string {
  return `<section class="card ${extraClass}"><h2>${escape(title)}</h2>${note ? `<p class="note">${escape(note)}</p>` : ''}${body || '<p class="note">No confirmed items in this snapshot.</p>'}</section>`
}

function metric(label: string, value: number | null, href: string, tone = '', qualifier?: EvidenceText): string {
  return `<a href="${escape(href)}" class="kpi ${tone}"><div class="kpi-value">${value === null ? '—' : escape(value.toLocaleString('en-US'))}</div><div>${escape(label)}</div>${value === null ? '<small>Unavailable; not zero</small>' : ''}${reading(qualifier)}</a>`
}

function attentionGraph(insights: PersonalInsights | undefined): string {
  const counts = insights?.attentionCounts
  if (counts == null) return '<p class="note">Attention classifications unavailable; missing evidence does not mean zero.</p>'
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
  const max = Math.max(1, ...Object.values(counts))
  return `<p class="note">${total} source-wide attention items; this chart is not narrowed by the attention filter.</p><div class="attention-counts">${attentionCategorySchema.options.map((category, index) => `<a href="#urgent" class="attention-count"><span>${attentionNames[category]}</span><span class="count-track" aria-hidden="true"><span style="width:${counts[category] / max * 100}%;background:${attentionColors[index]}"></span></span><strong data-category="${category}">${counts[category]}</strong></a>`).join('')}</div>`
}

function personal(snapshot: PersonalSnapshot): string {
  if (snapshot.attention !== undefined) snapshot = projectAttention(snapshot, 'all')
  const zone = snapshot.timeZone
  const insights = snapshot.insights
  const attention = new Map(insights?.attention.map(entry => [entry.itemId, entry]))
  const advice = new Map(insights?.agendaAdvice.map(entry => [entry.eventId, entry]))
  const view = snapshot.attention
  const localSummary = view === undefined ? '' : `<p class="notice">${snapshot.sections.find(section => section.id === 'urgent')?.items.length ?? 0} displayed in this selection · ${view.visibleCount} visible in personal attention · ${view.hiddenCount} hidden · ${view.handledCount} handled locally · ${view.snoozedCount} snoozed · ${view.sourceCount === null ? 'Unknown' : view.sourceCount} in source. Local decisions do not change or verify source records. Stat tiles and the consequence chart retain source-wide totals.</p>`
  const date = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  const metrics = [
    metric('Overdue actions', snapshot.metrics.overdueActions, '#urgent', 'hot', insights?.stats.overdueActions),
    metric('Unread inbox emails', snapshot.metrics.unreadEmails, '#reply', 'watch', insights?.stats.unreadEmails),
    metric(`Meetings · ${snapshot.nextBusinessDay}`, snapshot.metrics.meetingsNextDay, '#schedule', '', insights?.stats.meetingsNextDay),
    metric('Unread Teams chats', snapshot.metrics.teamsUnread, '#chats', 'watch', insights?.stats.teamsUnread),
    metric('Tracked projects', snapshot.metrics.projects, '#projects', '', insights?.stats.projects),
    metric('OOF notices', snapshot.metrics.oof, '#oof', '', insights?.stats.oof),
  ].join('')
  const calendar = (events: PersonalSnapshot['schedule'], includeAdvice: boolean) => events.map(event => {
    const recommendation = includeAdvice ? advice.get(event.id) : undefined
    return link(event.url, `<span class="time">${event.allDay ? 'All day' : `${escape(date(event.start))} – ${escape(date(event.end))}`}</span><strong>${escape(event.title)}</strong><span class="badge ${event.response === 'accepted' ? 'accepted' : event.response === 'organizer' ? 'organizer' : event.response === 'notResponded' ? 'needs-response' : 'warning'}">${escape(event.response)}</span><p>${escape(event.organizer)} · ${event.online ? 'Online' : 'In person / location in source'}${event.free ? ' · Free-time event' : ''}${event.conflict ? ' · Busy conflict' : ''}${event.optionalOverlap ? ' · Tentative/free overlap' : ''}</p>${recommendation ? `<small>Suggestion: ${escape(recommendation.recommendation)}; no calendar changes made.</small>${reading(recommendation.reason)}` : ''}`)
  }).join('')
  const schedule = calendar(snapshot.schedule, true)
  const max = Math.max(1, ...snapshot.weekLoad.map(day => day.meetings))
  const bars = snapshot.weekLoad.map(day => `<a href="#schedule" class="barcol"><span>${escape(day.meetings)}</span><div class="bartrack"><div class="bar ${day.meetings >= 7 ? 'heavy' : day.meetings === 2 ? 'light' : ''}" style="height:${day.meetings / max * 100}%"></div></div><small>${escape(new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`)))}</small></a>`).join('')
  let angle = 0
  const segments = snapshot.allocation.map((allocation, index) => {
    const start = angle
    angle += Math.max(0, Math.min(100, allocation.percent)) * 3.6
    return `${colors[index % colors.length]} ${start}deg ${angle}deg`
  })
  const legend = snapshot.allocation.map((allocation, index) => `<li><span class="swatch" style="background:${colors[index % colors.length]}"></span>${escape(categoryNames[allocation.category] ?? allocation.category)} <strong>${Math.round(allocation.percent)}%</strong></li>`).join('')
  const donut = segments.length ? `<div class="donut-layout"><div class="donut" role="img" aria-label="Time allocation; percentages in adjacent legend" style="background:conic-gradient(${segments.join(',')})"></div><ul class="legend">${legend}</ul></div>` : '<p class="note">No complete time-allocation data.</p>'
  const section = (id: SectionId) => {
    const value = snapshot.sections.find(entry => entry.id === id)
    if (!value) return ''
    const rows = value.items.length ? `<ul class="item-list">${value.items.map((entry, index) => `<li>${item(entry, index, id === 'urgent' ? attention.get(entry.id) : undefined)}</li>`).join('')}</ul>` : '<p class="note">No confirmed items in this selection.</p>'
    const read = id === 'urgent' ? undefined : insights?.reads[id]
    return `<div id="${id}">${card(names[id], (id === 'urgent' ? localSummary : '') + rows + reading(read) + (id === 'oof' ? reading(insights?.oofImpact) : ''), value.note ?? value.source, id === 'urgent' ? 'urgent-banner' : '')}</div>`
  }
  const sources = snapshot.sources.map(source => `<span class="badge ${source.state === 'live' ? 'accepted' : 'warning'}">${escape(source.id)}: ${escape(source.state)}</span>`).join(' ')
  return `<div class="kpis">${metrics}</div><p class="sources">${sources}</p>${reading(insights?.warningsSummary)}${snapshot.referenceAsOf ? `<p class="notice">Saved briefing: ${escape(snapshot.referenceAsOf)}. Its claims are not verified by a structured refresh.</p>` : ''}${section('urgent')}<div class="grid"><div id="schedule">${card(`Next business day · ${snapshot.nextBusinessDay}`, (schedule || '<p class="note">No confirmed events in this snapshot.</p>') + reading(insights?.reads.agenda))}</div>${section('prep')}</div>${card("Today's remaining calendar", calendar(snapshot.todayRemaining, false))}${section('projects')}<div class="grid grid-graphs">${card('Attention by consequence', attentionGraph(insights) + reading(insights?.reads.attention))}${card('Week calendar load', `<div class="bars">${bars}</div>${reading(insights?.reads.weekLoad)}${reading(insights?.protectedTime)}`, 'Counts reflect loaded calendar data. Focus and absence notices are excluded.')}${card('Time allocation', donut + reading(insights?.reads.allocation), 'Title/category-based classification; overlapping booked events count separately.')}</div><div class="grid grid-small">${(['reply', 'actions', 'training', 'oof', 'people', 'chats'] as const).map(section).join('')}</div>${section('files')}`
}

function ado(snapshot: AdoSnapshot): string {
  const selected = snapshot.items.filter(work => work.type === snapshot.defaultType)
  const completed = selected.filter(work => work.category === 'Completed').length
  const open = selected.filter(work => ['Proposed', 'InProgress', 'Resolved'].includes(work.category)).length
  const unknown = selected.filter(work => work.category === 'Unknown').length
  const removed = selected.filter(work => work.category === 'Removed').length
  const population = selected.filter(work => work.category !== 'Unknown' && work.category !== 'Removed')
  const people = new Set(population.map(work => work.assigneeId).filter(Boolean)).size
  const risk = population.filter(work => work.risks.length)
  const metrics = metric('Completed', completed, '#work') + metric('Remaining', open, '#work', 'watch') + metric('Assigned people', people, '#work') + metric('Items with risk flags', risk.length, '#risks', 'hot') + metric('Unknown state category', unknown, '#work') + metric('Removed', removed, '#work')
  const rows = selected.map(work => `<tr><td>${link(work.url, `#${work.id}`, 'inline')}</td><td>${link(work.url, escape(work.title), 'inline')}</td><td>${escape(work.state)}<small>${escape(work.category)}</small></td><td>${escape(work.assignee || 'Unassigned')}</td><td>${work.estimate === undefined ? '—' : `${escape(work.estimate)}<small>${escape(work.estimateField)}</small>`}</td><td>${escape(work.risks.join(', ') || '—')}</td></tr>`).join('')
  const warnings = [...snapshot.warnings, ...(!snapshot.complete ? ['This result is partial. Counts cover loaded items only.'] : [])]
  return `<div class="kpis">${metrics}</div><p class="notice">${escape(snapshot.source.orgName)} / ${escape(snapshot.source.project)} / ${escape(snapshot.source.team ?? '')}<br>${escape(snapshot.iteration?.path ?? snapshot.source.path ?? snapshot.source.input)}<br>Displayed type: ${escape(snapshot.defaultType)}. Parent and task counts are not combined.${snapshot.iteration ? `<br>${escape(snapshot.iteration.start ?? '')} — ${escape(snapshot.iteration.finish ?? '')}` : ''}</p>${link(snapshot.sourceUrl, 'Open source in Azure DevOps', 'source-button')}<div id="risks">${card('Evidence-based risk flags', risk.map(work => link(work.url, `<strong>#${work.id} · ${escape(work.title)}</strong><p>${escape(work.risks.map(flag => flag === 'stale' ? 'No recent update' : flag).join(' · '))}</p>`)).join(''))}</div><div id="work">${card('Work items', `<div class="table-scroll"><table><thead><tr><th>ID</th><th>Work item</th><th>State</th><th>Assigned to</th><th>Estimate / field</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table></div>`, 'Current state only. Estimate fields retain their own units; unknown categories and Removed are outside completion percentages.')}</div>${warnings.length ? card('Data notes', `<ul>${warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul>`) : ''}`
}

/** Produce a self-contained snapshot that remains readable when scripts are disabled.
 * @param snapshot Validated dashboard data; captured ADO reports retain their scopes without recalculation.
 * @returns Complete HTML with final values and no external assets or refresh requests.
 */
export function renderDashboardHtml(snapshot: DashboardExportSnapshot): string {
  const title = snapshot.kind === 'personal' ? `${snapshot.displayName} · Personal Work` : 'Azure DevOps · Delivery dashboard'
  let content: string
  if (snapshot.kind === 'personal') content = personal(snapshot)
  else {
    const report = snapshot.adoReport ?? buildAdoAnalytics(snapshot, { ...emptyFilters(), type: snapshot.defaultType })
    const typedItems = snapshot.adoReport ? undefined : snapshot.items.filter(item => item.type === snapshot.defaultType)
    const selection = snapshot.adoExportSelection ?? (typedItems ? {
      summary: summarize(typedItems), states: groupCounts(typedItems, 'state'),
    } : undefined)
    content = report ? renderAdoAnalytics(snapshot, report, selection, { escape, link, card, metric }) : ado(snapshot)
  }
  const refreshed = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: snapshot.kind === 'personal' ? snapshot.timeZone : 'UTC' }).format(new Date(snapshot.generatedAt))
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src '${snapshot.kind === 'personal' ? 'unsafe-inline' : 'none'}'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>
:root{--bg1:#f5f7fa;--bg2:#e8edf3;--card:#fff;--text:#1f2937;--muted:#596779;--line:#dbe3ed;--hover:#f1f6fc;--urgent-bg:linear-gradient(135deg,#fee2e2,#fecaca);--urgent-heading:#991b1b;--urgent-item-bg:#fff;--urgent-item-hover:#fff5f5;--urgent-watermark:#991b1b}
[data-theme="dark"],#theme-toggle:checked~main{--bg1:#0f172a;--bg2:#131c30;--card:#1e293b;--text:#e2e8f0;--muted:#b0bfd0;--line:#394b60;--hover:#28384e;--urgent-bg:linear-gradient(135deg,#3f1d1d,#4c1d1d);--urgent-heading:#fca5a5;--urgent-item-bg:#1e293b;--urgent-item-hover:#2b3a4f;--urgent-watermark:#fca5a5}
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,sans-serif}main{min-height:100vh;background:linear-gradient(160deg,var(--bg1),var(--bg2));color:var(--text);padding-bottom:35px}.wrap{max-width:1440px;margin:auto;padding:24px}header{background:radial-gradient(circle at 10% 20%,#ffffff35,transparent 40%),radial-gradient(circle at 90% 80%,#ffffff25,transparent 45%),linear-gradient(110deg,#0078d4,#00bcf2,#5e60ce);color:#fff;padding:16px 0}header .wrap{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}h1{font-size:28px;margin:0 0 10px}h2{font-size:18px;margin:0 0 15px}.subtitle{margin:8px 0;font-size:13px}.refresh{display:flex;gap:8px;align-items:center;font-size:13px}.dot{width:8px;height:8px;border-radius:50%;background:#a2ffd4;animation:pulse 2s infinite}.theme{cursor:pointer;border:1px solid #ffffff80;border-radius:30px;padding:10px 16px;white-space:nowrap}#theme-toggle{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}#theme-toggle:focus-visible~main .theme{outline:3px solid #fff;outline-offset:4px}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid #0078d4;outline-offset:3px}.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:14px;margin-bottom:20px}.kpi,.card{background:var(--card);border:1px solid var(--line);border-radius:17px;box-shadow:0 6px 24px #10284c08;animation:up .4s both}.kpi{padding:18px;border-top:4px solid #0078d4;font-size:12px}.kpi-value{font-size:30px;font-weight:700;margin-bottom:5px}.kpi.hot{border-top-color:#e05050}.kpi.watch{border-top-color:#d99b22}.kpi:nth-child(2){animation-delay:.05s}.kpi:nth-child(3){animation-delay:.1s}.kpi:nth-child(4){animation-delay:.15s}.kpi:nth-child(5){animation-delay:.2s}.kpi:nth-child(6){animation-delay:.25s}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.grid>div{min-width:0}.card{padding:22px;margin-bottom:18px;overflow:hidden}.row{display:block;padding:12px;border-radius:10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.row:hover{background:var(--hover)}.row strong{display:inline;font-size:14px}.row p{margin:6px 0;font-size:13px;line-height:1.6}.note,small,.notice{color:var(--muted);font-size:12px;line-height:1.6}small{display:block}.notice{background:var(--card);border-left:3px solid #0078d4;padding:14px}.badge{font-size:10px;display:inline-block;border-radius:20px;background:#e0edff;color:#174f93;padding:3px 8px;margin:4px 5px}.accepted{background:#dcfce7;color:#166534}.warning{background:#fef3c7;color:#92400e}.organizer{background:#ede9fe;color:#5b21b6}.time{display:block;color:var(--muted);font-size:12px;font-weight:600;margin-bottom:4px}.urgent-banner{position:relative;background:var(--urgent-bg);border:2px solid #dc5757}.urgent-banner::before{content:"⚠";position:absolute;right:12px;top:0;font-size:90px;opacity:.12;color:var(--urgent-watermark);pointer-events:none}.urgent-banner h2,.urgent-banner .row strong{color:var(--urgent-heading)}.urgent-banner .row{position:relative;background:var(--urgent-item-bg);margin-bottom:8px}.urgent-banner .row:hover{background:var(--urgent-item-hover)}.health{display:inline-block;width:8px;height:8px;border-radius:50%;background:#18a866;margin-right:7px;box-shadow:0 0 8px currentColor}.health.hot{background:#e05050}.health.watch{background:#e9a221}.bars{height:205px;display:flex;align-items:flex-end;gap:14px;padding-top:20px}.barcol{height:100%;flex:1;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}.bartrack{display:flex;align-items:flex-end;flex:1;width:100%;background:var(--hover);border-radius:8px;overflow:hidden}.bar{width:100%;min-height:0;background:linear-gradient(0deg,#0078d4,#42c5f5);border-radius:7px 7px 0 0}.bar.heavy{background:linear-gradient(0deg,#c73535,#f89b9b)}.bar.light{background:linear-gradient(0deg,#718196,#b6c1ce)}.donut-layout{display:flex;align-items:center;gap:28px;flex-wrap:wrap}.donut{height:155px;width:155px;flex-shrink:0;border-radius:50%;position:relative}.donut::after{content:"";position:absolute;inset:28px;background:var(--card);border-radius:50%}.legend{list-style:none;padding:0;font-size:13px;flex:1;min-width:180px}.legend li{padding:8px 0;display:flex;gap:8px}.legend strong{margin-left:auto}.swatch{display:inline-block;width:12px;height:12px;border-radius:3px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}.inline{text-decoration:underline}.source-button{display:inline-block;background:var(--card);border:1px solid var(--line);padding:12px 18px;border-radius:12px;margin:0 0 18px}footer{text-align:center;padding:25px;color:var(--muted);font-size:12px}@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@keyframes pulse{50%{box-shadow:0 0 0 5px #9effc52a}}@media(max-width:1024px){.grid{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(3,1fr)}}@media(max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}.wrap{padding:14px}header .wrap{flex-direction:column}.card{padding:16px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;scroll-behavior:auto!important}}@media print{.theme{display:none}.card,.kpi{animation:none;box-shadow:none}.card{break-inside:avoid}}
.reading{border-top:1px solid var(--line);padding-top:8px;margin:10px 0 0;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.item-list{list-style:none;padding:0;margin:0}.needs-response{background:#fee2e2;color:#991b1b}.grid-small,.grid-graphs{grid-template-columns:repeat(3,minmax(0,1fr))}.attention-count{display:grid;grid-template-columns:minmax(0,1fr) 60px 24px;align-items:center;gap:10px;margin:12px 0;font-size:12px}.attention-count strong{text-align:right}.count-track,.count-track>span{display:block;height:6px;border-radius:3px}.count-track{background:var(--hover)}.avatar{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;margin-right:10px;border-radius:50%;color:#fff;font-size:12px;font-weight:700;vertical-align:middle}.avatar-1{background:linear-gradient(135deg,#0078d4,#5e60ce)}.avatar-2{background:linear-gradient(135deg,#0e7490,#10a7a0)}.avatar-3{background:linear-gradient(135deg,#7c3aed,#c026d3)}.avatar-4{background:linear-gradient(135deg,#c2410c,#d97706)}.avatar-5{background:linear-gradient(135deg,#15803d,#0d9488)}@media(max-width:1024px){.grid-small,.grid-graphs{grid-template-columns:1fr}}
${snapshot.kind === 'ado' ? adoAnalyticsCss : ''}</style></head><body><input type="checkbox" id="theme-toggle" aria-label="Dark mode"><main><header><div class="wrap"><div><h1>${escape(title)}</h1><div class="refresh"><span class="dot"></span>Last refreshed: ${escape(refreshed)}${snapshot.kind === 'personal' ? ` · ${escape(snapshot.timeZone)}` : ' · UTC'}</div><p class="subtitle">Source items open in Outlook, Teams, OneDrive, or Azure DevOps.</p></div><label class="theme" for="theme-toggle">☀ / ☾ · Dark mode</label></div></header><div class="wrap">${content}${snapshot.kind === 'personal' && snapshot.warnings.length ? card('Data notes', `<ul>${snapshot.warnings.map(warning => `<li>${escape(warning)}</li>`).join('')}</ul>`) : ''}</div><footer>Downloaded snapshot. This file makes no refresh requests. Automatic email delivery is not configured. Refresh live data in DSH and export again.</footer></main>${snapshot.kind === 'personal' ? `<script>
(()=>{const toggle=document.getElementById('theme-toggle');let saved;try{saved=localStorage.getItem('dsh-dashboard-theme')}catch(storageUnavailable){}if(saved==='dark'){toggle.checked=true;document.documentElement.dataset.theme='dark'}toggle.addEventListener('change',()=>{const theme=toggle.checked?'dark':'light';document.documentElement.dataset.theme=theme;try{localStorage.setItem('dsh-dashboard-theme',theme)}catch(storageUnavailableOrFull){}})})();
</script>` : ''}</body></html>
`
}
