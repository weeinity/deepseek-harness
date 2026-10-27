import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertReadOperation, decodeMcpResult, safeError } from '../src/host/mcp.ts'
import { snapshotRequestSchema } from '../src/shared/requests.ts'
import { safeSourceUrl } from '../src/shared/urls.ts'

test('MCP reads reject mutation operations and arbitrary Graph routes', () => {
  assert.doesNotThrow(() => assertReadOperation('workiq', 'fetch', { entityUrls: ['/me?$select=displayName'] }))
  assert.throws(() => assertReadOperation('workiq', 'do_action', { actionUrl: '/me/sendMail' }))
  assert.throws(() => assertReadOperation('workiq', 'fetch', { entityUrls: ['https://example.com/me'] }))
  assert.throws(() => assertReadOperation('ado', 'wit_work_item', { action: 'update', orgName: 'test', project: 'Demo' }))
  assert.throws(() => assertReadOperation('ado', 'wit_work_item_write', { action: 'get', orgName: 'test', project: 'Demo' }))
  assert.throws(() => assertReadOperation('ado', 'work', { action: 'get_team_settings', project: 'Demo' }))
  assert.doesNotThrow(() => assertReadOperation('ado', 'wit_query', { action: 'wiql', orgName: 'test', project: 'Demo' }))
})

test('MCP decoding preserves structured data and rejects failures', () => {
  assert.deepEqual(decodeMcpResult({ content: [{ type: 'text', text: '{"value":[1]}' }] }), { value: [1] })
  assert.deepEqual(decodeMcpResult({ structuredContent: { value: [2] } }), { value: [2] })
  assert.throws(() => decodeMcpResult({ isError: true, content: [{ type: 'text', text: 'denied' }] }), /refused/)
  assert.throws(() => decodeMcpResult({ content: [{ type: 'text', text: 'unavailable' }] }), /non-JSON/)
  assert.throws(() => decodeMcpResult({ content: [] }), /no structured data/)
})

test('RPC selectors cannot carry arbitrary tool names or extra arguments', () => {
  assert.equal(snapshotRequestSchema.parse({ view: 'personal' }).view, 'personal')
  assert.throws(() => snapshotRequestSchema.parse({ view: 'personal', command: 'anything' }))
  assert.throws(() => snapshotRequestSchema.parse({ view: 'ado', source: { input: 'x', orgName: 'o', project: 'p', mode: 'iteration', wiql: 'arbitrary' } }))
})

test('source links reject scripts, local files, embedded passwords and hostile domains', () => {
  assert.equal(safeSourceUrl('javascript:alert(1)'), undefined)
  assert.equal(safeSourceUrl('file:///C:/example'), undefined)
  assert.equal(safeSourceUrl('https://teams.microsoft.com.evil.example/'), undefined)
  assert.equal(safeSourceUrl('https://secret@teams.microsoft.com/'), undefined)
  assert.equal(safeSourceUrl('https://teams.microsoft.com/l/chat/test/0'), 'https://teams.microsoft.com/l/chat/test/0')
  assert.equal(safeSourceUrl('mailto:person@example.com'), 'mailto:person@example.com')
  assert.equal(safeSourceUrl('mailto:person@example.com?bcc=someone@example.com'), undefined)
})

test('diagnostics redact bearer values and token query parameters', () => {
  assert.equal(safeError('Bearer secret'), 'Bearer [redacted]')
  assert.equal(safeError('https://example.com/?token=private&x=1'), 'https://example.com/?token=[redacted]&x=1')
})
