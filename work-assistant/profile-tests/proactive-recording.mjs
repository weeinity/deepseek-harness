/** Canonical V3 evidence uses the repository's existing pure normalizers. */
import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeSessionSnapshot } from '../../packages/test-support/session-snapshot/src/normalize.ts'
import { redactSessionSnapshotIds } from '../../packages/test-support/session-snapshot/src/identity.ts'

export const proactiveFixtureRoot = resolve(fileURLToPath(new URL('../../snapshots/web/work-assistant-proactive/', import.meta.url)))
export const proactiveFixturePath = join(proactiveFixtureRoot, 'session.v3.jsonl')

/** Compare the whole persisted result; record only in explicit fixture mode. */
export async function checkProactiveRecording(session, workspace, runtime) {
  const raw = [{ type: 'session', ...session.header }, ...session.events].map(row => JSON.stringify(row)).join('\n') + '\n'
  const redacted = redactSessionSnapshotIds([raw])[0]
  const normalized = normalizeSessionSnapshot(redacted, { sessionIds: [], cwd: workspace, cwdAliases: [JSON.stringify(workspace).slice(1, -1)] }, { identityMode: 'preserve' })
  const prompts = session.events.filter(event => event.type === 'system/message').map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    .map(text => text.split(runtime.sourceRoot).join('{{sourceRoot}}').split(runtime.webUrl).join('{{webUrl}}'))
  const schemas = session.events.filter(event => event.type === 'request/header').map(event => event.data.header.tools)
  const files = {
    'session.v3.jsonl': normalized,
    'system-prompt.expected.md': prompts.join('\n\n<!-- system/message change -->\n\n') + '\n',
    'tool-schemas.expected.json': JSON.stringify(schemas, null, 2) + '\n',
  }
  if (process.env.WA_PROACTIVE_RECORD === '1') {
    await mkdir(proactiveFixtureRoot, { recursive: true })
    for (const [name, content] of Object.entries(files)) await writeFile(join(proactiveFixtureRoot, name), content, 'utf8')
    await writeFile(join(proactiveFixtureRoot, 'snapshot.yml'), 'version: 1\nscenario: work-assistant-proactive\nprofile: web\ncomposition: work-assistant-proactive\nrecording: authored\nheader:\n  class: work-assistant-proactive\n  pin: true\n', 'utf8')
    return
  }
  for (const [name, actual] of Object.entries(files)) assert.equal(actual, await readFile(join(proactiveFixtureRoot, name), 'utf8'), 'proactive recording differs: ' + name)
}
