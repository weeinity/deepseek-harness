import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attentionTarget, validAttentionTarget } from '../src/host/attention-identity.ts'
import type { DashboardItem } from '../src/shared/types.ts'

const row: DashboardItem = {
  id: 'reference-urgent-0', title: 'Synthetic follow-up',
  detail: 'Review the synthetic draft.', url: 'https://dev.azure.com/example/project/_workitems/edit/1',
  source: 'reference', severity: 'hot', sourceDate: 'Last refreshed yesterday',
}

test('attention identity excludes position, source date, and display initials', () => {
  const first = attentionTarget(row)
  assert.deepEqual(attentionTarget({ ...row, id: 'reference-urgent-17', sourceDate: 'Last refreshed today', initials: 'SY' }), first)
  assert.match(first.key, /^attention:[a-f0-9]{64}$/)
  assert(validAttentionTarget(first))
})

test('normalized whitespace, Unicode, and canonical URL host preserve identity', () => {
  const first = attentionTarget({ ...row, title: ' Café  review ', detail: 'Read\n the draft.' })
  const next = attentionTarget({
    ...row, title: 'Cafe\u0301 review', detail: 'Read the   draft.',
    url: 'https://DEV.AZURE.COM:443/example/project/_workitems/edit/1',
  })
  assert.deepEqual(first, next)
})

test('content and severity changes invalidate a choice without changing the exact identity', () => {
  const first = attentionTarget(row)
  for (const edited of [{ ...row, detail: 'The synthetic draft reopened.' }, { ...row, severity: 'watch' as const }]) {
    const next = attentionTarget(edited)
    assert.equal(next.key, first.key)
    assert.notEqual(next.fingerprint, first.fingerprint)
  }
})

test('title, link, source kind, case, query, and fragment changes are not fuzzy matches', () => {
  const first = attentionTarget(row)
  for (const edited of [
    { ...row, title: 'Synthetic follow-up reopened' },
    { ...row, title: 'synthetic follow-up' },
    { ...row, url: `${row.url}0` },
    { ...row, url: `${row.url}?view=detail` },
    { ...row, url: `${row.url}#thread` },
    { ...row, source: 'live' as const },
  ]) assert.notEqual(attentionTarget(edited).key, first.key)
})

test('persisted identity validation rejects a mismatched key or noncanonical target', () => {
  const first = attentionTarget(row)
  assert.equal(validAttentionTarget({ ...first, title: 'Another synthetic item' }), false)
  assert.equal(validAttentionTarget({ ...first, url: first.url.replace('dev.azure.com', 'DEV.AZURE.COM') }), false)
})
