import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { adoAnalyticsSettingsSchema } from '../src/shared/ado-analytics-schema.ts'
import { adoHistoryRange } from '../src/shared/ado-history.ts'
import type { AdoSnapshot } from '../src/shared/types.ts'

const readme = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const en = readme('README.md')
const zh = readme('README.zh.md')

function structure(line: string): string {
  if (!line) return 'blank'
  if (line.startsWith('```')) return line
  if (line.startsWith('|')) return `table:${line.split('|').length}`
  if (/^#+ /.test(line)) return line.match(/^#+/)![0]
  if (line.startsWith('- ')) return 'list'
  if (/^<(?:a|details|summary|\/details)/.test(line)) return line.replace(/>[^<]+</g, '><')
  return 'paragraph'
}

test('dashboard README translations retain physical line, Markdown, code, and link alignment', () => {
  const left = en.split('\n')
  const right = zh.split('\n')
  assert.equal(left.length, right.length)
  assert.deepEqual(left.map(structure), right.map(structure))
  const fences = (text: string) => [...text.matchAll(/```[\s\S]*?```/g)].map(match => match[0])
  assert.deepEqual(fences(en), fences(zh))
  const targets = (text: string) => [...text.matchAll(/\]\(([^)]+)\)/g)].map(match => match[1]!.replace(/\.zh\.md(?=#|$)/, '.md'))
  assert.deepEqual(targets(en), targets(zh))
  for (const target of targets(en)) {
    if (/^https?:|^#/.test(target)) continue
    assert.ok(existsSync(new URL(`../${target.split('#')[0]}`, import.meta.url)), `Missing README link: ${target}`)
  }
  for (const text of [en, zh]) {
    assert.match(text, /^---\ndescription: "[^\n]+"\nkind: "package-bundle"\n---/)
    assert.match(text, /[^\n]\n$/)
    assert.doesNotMatch(text, /\n\n$/)
  }
})

test('documented ADO analytics defaults and evidence limits match the shared settings', () => {
  const settings = adoAnalyticsSettingsSchema.parse({})
  const defaults = {
    ageBands: [7, 14, 30], historyDays: 30, maxHistoryDays: 120, maxHistoryItems: 200,
    maxRevisionsPerItem: 1000, revisionPageSize: 50, historyConcurrency: 4,
    historyTimeoutMs: 120000, maxHistoryRequests: 400,
  }
  assert.deepEqual(settings, defaults)
  for (const text of [en, zh]) {
    for (const key of Object.keys(defaults)) assert.ok(text.includes(`\`adoAnalytics.${key}\``), `Missing config ${key}`)
    for (const field of ['snapshotId', 'type', 'force', 'ado-history', 'wit_work_item/list_revisions', 'CreatedDate', 'StateChangeDate', 'ChangedDate']) {
      assert.ok(text.includes(field), `Missing evidence field ${field}`)
    }
  }
  assert.match(en, /Omitted histories are not zero observations; unavailable history produces no lines/)
  assert.match(en, /captures that report before narrowing the matching table/)
  assert.match(en, /browser-supplied export report is not trusted/)
  assert.match(en, /ADO files contain no scripts/)
  assert.doesNotMatch(en, /registers four fixed|calculate export totals from that selection/)
  assert.match(zh, /缺失历史不视为零值观察/)
  assert.match(zh, /导出先捕获报告，再缩小匹配表格/)
  assert.match(zh, /不信任浏览器提交的导出报告/)
})

test('documented recent and unavailable sprint ranges match current history selection', () => {
  const source: AdoSnapshot = {
    kind: 'ado', generatedAt: '2040-04-03T17:00:00Z', defaultType: 'Task', complete: true,
    source: { input: 'Synthetic', orgName: 'example', project: 'Synthetic', mode: 'query' },
    sourceUrl: 'https://dev.azure.com/example/Synthetic', items: [], warnings: [],
    analytics: { version: 1, timeZone: 'UTC', settings: adoAnalyticsSettingsSchema.parse({}) },
  }
  assert.equal(adoHistoryRange(source).range?.source, 'recent')
  source.source.mode = 'iteration'
  source.iteration = { name: 'Synthetic sprint', path: 'Synthetic\\Sprint', id: 'synthetic-iteration' }
  assert.equal(adoHistoryRange(source).range, null)
  source.iteration.start = '2041-01-01'
  source.iteration.finish = '2041-01-14'
  assert.equal(adoHistoryRange(source).range, null)
  assert.match(en, /missing, invalid, reversed, or not-yet-started ranges leave history unavailable rather than substituting recent dates/)
  assert.match(zh, /历史不可用，不会改用近期日期/)
})
