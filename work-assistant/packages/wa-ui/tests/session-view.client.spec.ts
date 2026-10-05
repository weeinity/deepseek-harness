import { describe, expect, it } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { buildAssistantSessionView } from '../src/client/sessionView.ts'

const SESSION_ID = 'current' as SessionId

function toolResult(seq: number, name: string | null, meta: unknown, isError = false): ConversationNode {
  return {
    kind: 'tool-result',
    seq,
    time: Date.UTC(2026, 8, 17, 16, seq),
    callId: `call-${seq}`,
    call: name === null ? null : { name, argsRaw: '{"note":"profile.md"}' },
    callTime: Date.UTC(2026, 8, 17, 16, seq - 1),
    content: [],
    isError,
    meta,
    subCalls: [],
  } as ConversationNode
}

function workAssistantMeta(kind: string, value: unknown, version = 1): unknown {
  return { workAssistant: { version, kind, value } }
}

function memoryRead(note: string, revision: string, content: string): unknown {
  return workAssistantMeta('memory-read', { note, exists: true, revision, content })
}

function memoryList(notes: readonly { readonly note: string; readonly revision: string }[], truncated: boolean): unknown {
  return workAssistantMeta('memory-list', { notes, truncated })
}

function calendarList(): unknown {
  return workAssistantMeta('calendar-list', {
    timeZone: 'America/Los_Angeles',
    window: { start: '2026-09-17T16:00:00.000Z', end: '2026-09-18T00:00:00.000Z' },
    count: 1,
    truncated: false,
    events: [{
      id: 'event-1',
      uid: 'uid-1',
      title: 'Design review',
      start: { instant: '2026-09-17T21:00:00.000Z', local: '2026-09-17T14:00:00', timeZone: 'America/Los_Angeles', allDay: false },
      end: { instant: '2026-09-17T22:00:00.000Z', local: '2026-09-17T15:00:00', timeZone: 'America/Los_Angeles', allDay: false },
      durationMinutes: 60,
      allDay: false,
      busy: true,
      location: 'Room 4',
      status: 'confirmed',
      recurring: false,
      override: false,
    }],
  })
}

describe('buildAssistantSessionView', () => {
  it('renders valid tagged results when the loaded window no longer has the call head', () => {
    const view = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, null, calendarList()),
      toolResult(2, null, memoryRead('profile.md', 'rev-a', 'Keep summaries concise.\nSecond line.')),
    ])

    expect(view.day.status).toBe('ready')
    if (view.day.status === 'ready') {
      expect(view.day.events.map(event => event.title)).toEqual(['Design review'])
    }
    expect(view.memory.status).toBe('ready')
    if (view.memory.status === 'ready') {
      expect(view.memory.entries).toMatchObject([
        { note: 'profile.md', revision: 'rev-a', source: 'read', summary: 'Keep summaries concise.' },
      ])
    }
  })

  it('clears older memory previews after a metadata-free failed memory write before later reads restore data', () => {
    const failed = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('old.md', 'rev-old', 'Old content')),
      toolResult(2, 'memory_write', undefined, true),
    ])
    expect(failed.memory.status).toBe('failed')

    const restored = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('old.md', 'rev-old', 'Old content')),
      toolResult(2, 'memory_write', undefined, true),
      toolResult(3, 'memory_read', memoryRead('fresh.md', 'rev-fresh', 'Fresh content')),
    ])
    expect(restored.memory.status).toBe('ready')
    if (restored.memory.status === 'ready') {
      expect(restored.memory.entries.map(entry => entry.note)).toEqual(['fresh.md'])
    }
  })

  it('clears older memory previews after a malformed memory write before later reads restore data', () => {
    const malformed = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('old.md', 'rev-old', 'Old content')),
      toolResult(2, null, workAssistantMeta('memory-write', { note: 'old.md' })),
    ])
    expect(malformed.memory.status).toBe('malformed')

    const restored = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('old.md', 'rev-old', 'Old content')),
      toolResult(2, null, workAssistantMeta('memory-write', { note: 'old.md' })),
      toolResult(3, 'memory_read', memoryRead('fresh.md', 'rev-fresh', 'Fresh content')),
    ])
    expect(restored.memory.status).toBe('ready')
    if (restored.memory.status === 'ready') {
      expect(restored.memory.entries.map(entry => entry.note)).toEqual(['fresh.md'])
    }
  })

  it('treats memory list absence as authoritative only when the list is not truncated', () => {
    const truncated = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('keep.md', 'rev-1', 'Kept content')),
      toolResult(2, 'memory_read', memoryRead('stale.md', 'rev-2', 'Stale content')),
      toolResult(3, 'memory_list', memoryList([{ note: 'keep.md', revision: 'rev-1' }], true)),
    ])
    expect(truncated.memory.status).toBe('ready')
    if (truncated.memory.status === 'ready') {
      expect(new Set(truncated.memory.entries.map(entry => entry.note))).toEqual(new Set(['keep.md', 'stale.md']))
      expect(truncated.memory.entries.find(entry => entry.note === 'keep.md')).toMatchObject({ source: 'read', summary: 'Kept content' })
    }

    const full = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('keep.md', 'rev-1', 'Kept content')),
      toolResult(2, 'memory_read', memoryRead('stale.md', 'rev-2', 'Stale content')),
      toolResult(3, 'memory_list', memoryList([{ note: 'keep.md', revision: 'rev-1' }], false)),
    ])
    expect(full.memory.status).toBe('ready')
    if (full.memory.status === 'ready') {
      expect(full.memory.entries.map(entry => entry.note)).toEqual(['keep.md'])
      expect(full.memory.entries[0]).toMatchObject({ source: 'read', summary: 'Kept content' })
    }
  })

  it('invalidates a matching memory preview when a list reports a changed revision', () => {
    const view = buildAssistantSessionView(SESSION_ID, [
      toolResult(1, 'memory_read', memoryRead('profile.md', 'rev-old', 'Old content')),
      toolResult(2, 'memory_list', memoryList([{ note: 'profile.md', revision: 'rev-new' }], true)),
    ])

    expect(view.memory.status).toBe('ready')
    if (view.memory.status === 'ready') {
      expect(view.memory.entries).toMatchObject([
        { note: 'profile.md', revision: 'rev-new', source: 'listed', summary: '' },
      ])
    }
  })
})
