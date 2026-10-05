import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Loaded-window assistant data shared from the strict Session bridge to the root rail. */
export interface AssistantSessionView {
  readonly sessionId: SessionId
  readonly latestSeq: number
  readonly unsupportedSeq: number | null
  readonly day: CalendarPanelData
  readonly memory: MemoryPanelData
}

/** Root-owned source carrying the current Session's loaded-window assistant data. */
export interface AssistantSessionViewSource {
  /** Return the currently published strict-Session view, if any. */
  getSnapshot(): AssistantSessionView | null
  /** Observe root-source changes from renderer selector hooks. */
  subscribe(listener: () => void): () => void
  /** Publish a strict-Session bridge view into the root rail source. */
  setSessionView(view: AssistantSessionView): void
  /** Clear the view only when the unmounted Session scope still owns it. */
  clearSessionView(sessionId?: SessionId): void
}

/** Calendar facts projected from a recorded `calendar_list` tool result. */
export type CalendarPanelData =
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly sourceSeq: number; readonly count: number; readonly truncated: boolean; readonly timeZone: string; readonly window: CalendarWindow; readonly events: readonly CalendarEventItem[] }
  | ProblemData

/** Memory facts projected from recorded memory tool results. */
export type MemoryPanelData =
  | { readonly status: 'empty' }
  | { readonly status: 'ready'; readonly sourceSeq: number; readonly truncated: boolean; readonly entries: readonly MemoryEntry[] }
  | ProblemData

/** Non-empty state for unsupported, malformed, or failed recorded assistant data. */
export interface ProblemData {
  readonly status: 'unsupported' | 'malformed' | 'failed'
  readonly sourceSeq: number
  readonly toolName?: string
}

/** Calendar query window recorded by the tool. */
export interface CalendarWindow {
  readonly start: string
  readonly end: string
}

/** One compact agenda row derived from a calendar event. */
export interface CalendarEventItem {
  readonly id: string
  readonly title: string
  readonly start: CalendarLocalTime
  readonly end: CalendarLocalTime
  readonly durationMinutes: number
  readonly allDay: boolean
  readonly busy: boolean
  readonly location?: string
  readonly status?: string
  readonly recurring: boolean
  readonly override: boolean
}

/** Local time representation recorded by the calendar tool. */
export interface CalendarLocalTime {
  readonly instant: string
  readonly local: string
  readonly timeZone: string
  readonly allDay: boolean
}

/** One compact memory row derived from recorded memory tool metadata. */
export interface MemoryEntry {
  readonly note: string
  readonly revision: string | null
  readonly source: 'read' | 'listed' | 'written' | 'absent'
  readonly sourceSeq: number
  readonly summary: string
  readonly contentBytes?: number
}

type WorkAssistantMeta =
  | { readonly kind: 'calendar-list'; readonly value: CalendarListValue }
  | { readonly kind: 'memory-read'; readonly value: MemoryReadValue }
  | { readonly kind: 'memory-list'; readonly value: MemoryListValue }
  | { readonly kind: 'memory-write'; readonly value: MemoryWriteValue }

type WorkAssistantKind = WorkAssistantMeta['kind']

interface ParsedMeta {
  readonly state: 'ok' | 'malformed' | 'unsupported'
  readonly target: 'calendar' | 'memory' | 'unknown'
  readonly kind?: WorkAssistantKind
  readonly meta?: WorkAssistantMeta
}

interface CalendarListValue {
  readonly timeZone: string
  readonly window: CalendarWindow
  readonly count: number
  readonly truncated: boolean
  readonly events: readonly CalendarEventItem[]
}

type MemoryReadValue =
  | { readonly note: string; readonly exists: true; readonly revision: string; readonly content: string }
  | { readonly note: string; readonly exists: false; readonly revision: null; readonly content: null }

interface MemoryListValue {
  readonly notes: readonly { readonly note: string; readonly revision: string }[]
  readonly truncated: boolean
}

interface MemoryWriteValue {
  readonly note: string
  readonly revision: string
  readonly commit: string
  readonly contentBytes: number
}

/** Create a root-scoped source shared by the rightbar and strict-Session bridge injection. */
export function createAssistantSessionViewSource(): AssistantSessionViewSource {
  let current: AssistantSessionView | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setSessionView: (view) => {
      current = view
      emit()
    },
    clearSessionView: (sessionId) => {
      if (current === null) return
      if (sessionId !== undefined && current.sessionId !== sessionId) return
      current = null
      emit()
    },
  }
}

/** Build the current Session rail model from the already-loaded Chat window. */
export function buildAssistantSessionView(sessionId: SessionId, nodes: readonly ConversationNode[] | undefined): AssistantSessionView {
  let latestSeq = 0
  let unsupportedSeq: number | null = null
  let day: CalendarPanelData = { status: 'empty' }
  let memoryProblem: ProblemData | null = null
  let memoryReadySeq = -1
  let memoryTruncated = false
  const memory = new Map<string, MemoryEntry>()

  const ordered = [...(nodes ?? [])].sort((left, right) => left.seq - right.seq)
  for (const node of ordered) {
    latestSeq = Math.max(latestSeq, node.seq)
    if (node.kind !== 'tool-result') continue
    const toolName = node.call?.name
    const parsed = parseWorkAssistantMeta(node.meta)
    const failureTarget = toolFailureTarget(toolName)
    if (node.isError && failureTarget !== null) {
      const problem = failedProblem(node.seq, toolName)
      if (failureTarget === 'calendar') day = problem
      else {
        if (toolName === 'memory_write') memory.clear()
        memoryProblem = problem
        memoryReadySeq = Math.max(memoryReadySeq, node.seq)
      }
      continue
    }
    if (parsed === null) continue
    if (parsed.state === 'unsupported') {
      const problem = { status: 'unsupported', sourceSeq: node.seq } satisfies ProblemData
      if (parsed.target === 'calendar') day = problem
      else if (parsed.target === 'memory') {
        if (parsed.kind === 'memory-write') memory.clear()
        memoryProblem = problem
        memoryReadySeq = Math.max(memoryReadySeq, node.seq)
      } else unsupportedSeq = node.seq
      continue
    }
    if (parsed.state === 'malformed') {
      const problem = { status: 'malformed', sourceSeq: node.seq } satisfies ProblemData
      if (parsed.target === 'calendar') day = problem
      else if (parsed.target === 'memory') {
        if (parsed.kind === 'memory-write') memory.clear()
        memoryProblem = problem
        memoryReadySeq = Math.max(memoryReadySeq, node.seq)
      } else unsupportedSeq = node.seq
      continue
    }
    if (parsed.meta === undefined) continue
    switch (parsed.meta.kind) {
      case 'calendar-list':
        day = {
          status: 'ready',
          sourceSeq: node.seq,
          count: parsed.meta.value.count,
          truncated: parsed.meta.value.truncated,
          timeZone: parsed.meta.value.timeZone,
          window: parsed.meta.value.window,
          events: parsed.meta.value.events,
        }
        break
      case 'memory-read':
        applyMemoryRead(memory, node.seq, parsed.meta.value)
        memoryProblem = null
        memoryReadySeq = node.seq
        break
      case 'memory-list':
        applyMemoryList(memory, node.seq, parsed.meta.value)
        memoryTruncated = parsed.meta.value.truncated
        memoryProblem = null
        memoryReadySeq = node.seq
        break
      case 'memory-write':
        applyMemoryWrite(memory, node.seq, parsed.meta.value)
        memoryProblem = null
        memoryReadySeq = node.seq
        break
    }
  }

  return {
    sessionId,
    latestSeq,
    unsupportedSeq,
    day,
    memory: memoryProblem !== null
      ? memoryProblem
      : memory.size === 0
        ? { status: 'empty' }
        : {
            status: 'ready',
            sourceSeq: memoryReadySeq,
            truncated: memoryTruncated,
            entries: [...memory.values()].sort((left, right) =>
              right.sourceSeq - left.sourceSeq
              || left.note.localeCompare(right.note)),
          },
  }
}

function parseWorkAssistantMeta(meta: unknown): ParsedMeta | null {
  const root = asRecord(meta)?.['workAssistant']
  if (root === undefined) return null
  const record = asRecord(root)
  if (record === null) return { state: 'malformed', target: 'unknown' }
  const kind = record['kind']
  if (typeof kind !== 'string') return { state: 'malformed', target: 'unknown' }
  if (record['version'] !== 1) {
    const known = knownKind(kind)
    return known === undefined
      ? { state: 'unsupported', target: targetOfKnownKind(kind) }
      : { state: 'unsupported', target: targetOfKnownKind(kind), kind: known }
  }
  const value = record['value']
  switch (kind) {
    case 'calendar-list': {
      const parsed = parseCalendarList(value)
      return parsed === null
        ? { state: 'malformed', target: 'calendar', kind }
        : { state: 'ok', target: 'calendar', kind, meta: { kind, value: parsed } }
    }
    case 'memory-read': {
      const parsed = parseMemoryRead(value)
      return parsed === null
        ? { state: 'malformed', target: 'memory', kind }
        : { state: 'ok', target: 'memory', kind, meta: { kind, value: parsed } }
    }
    case 'memory-list': {
      const parsed = parseMemoryList(value)
      return parsed === null
        ? { state: 'malformed', target: 'memory', kind }
        : { state: 'ok', target: 'memory', kind, meta: { kind, value: parsed } }
    }
    case 'memory-write': {
      const parsed = parseMemoryWrite(value)
      return parsed === null
        ? { state: 'malformed', target: 'memory', kind }
        : { state: 'ok', target: 'memory', kind, meta: { kind, value: parsed } }
    }
    default:
      return { state: 'unsupported', target: 'unknown' }
  }
}

function parseCalendarList(value: unknown): CalendarListValue | null {
  const record = asRecord(value)
  if (record === null) return null
  const timeZone = record['timeZone']
  const window = parseWindow(record['window'])
  const count = record['count']
  const truncated = record['truncated']
  const eventsValue = record['events']
  if (typeof timeZone !== 'string' || window === null || !isInteger(count) || typeof truncated !== 'boolean' || !Array.isArray(eventsValue)) return null
  const events: CalendarEventItem[] = []
  for (const item of eventsValue) {
    const event = parseCalendarEvent(item)
    if (event === null) return null
    events.push(event)
  }
  return { timeZone, window, count, truncated, events }
}

function parseWindow(value: unknown): CalendarWindow | null {
  const record = asRecord(value)
  if (record === null) return null
  const start = record['start']
  const end = record['end']
  return typeof start === 'string' && typeof end === 'string' ? { start, end } : null
}

function parseCalendarEvent(value: unknown): CalendarEventItem | null {
  const record = asRecord(value)
  if (record === null) return null
  const id = record['id']
  const title = record['title']
  const start = parseLocalTime(record['start'])
  const end = parseLocalTime(record['end'])
  const durationMinutes = record['durationMinutes']
  const allDay = record['allDay']
  const busy = record['busy']
  const recurring = record['recurring']
  const override = record['override']
  if (
    typeof id !== 'string'
    || typeof title !== 'string'
    || start === null
    || end === null
    || !isInteger(durationMinutes)
    || typeof allDay !== 'boolean'
    || typeof busy !== 'boolean'
    || typeof recurring !== 'boolean'
    || typeof override !== 'boolean'
  ) return null
  const location = optionalString(record['location'])
  const status = optionalString(record['status'])
  return {
    id,
    title,
    start,
    end,
    durationMinutes,
    allDay,
    busy,
    ...(location === undefined ? {} : { location }),
    ...(status === undefined ? {} : { status }),
    recurring,
    override,
  }
}

function parseLocalTime(value: unknown): CalendarLocalTime | null {
  const record = asRecord(value)
  if (record === null) return null
  const instant = record['instant']
  const local = record['local']
  const timeZone = record['timeZone']
  const allDay = record['allDay']
  return typeof instant === 'string' && typeof local === 'string' && typeof timeZone === 'string' && typeof allDay === 'boolean'
    ? { instant, local, timeZone, allDay }
    : null
}

function parseMemoryRead(value: unknown): MemoryReadValue | null {
  const record = asRecord(value)
  if (record === null) return null
  const note = record['note']
  const exists = record['exists']
  if (typeof note !== 'string' || typeof exists !== 'boolean') return null
  if (exists) {
    const revision = record['revision']
    const content = record['content']
    return typeof revision === 'string' && typeof content === 'string'
      ? { note, exists, revision, content }
      : null
  }
  return record['revision'] === null && record['content'] === null
    ? { note, exists, revision: null, content: null }
    : null
}

function parseMemoryList(value: unknown): MemoryListValue | null {
  const record = asRecord(value)
  if (record === null) return null
  const notesValue = record['notes']
  const truncated = record['truncated']
  if (!Array.isArray(notesValue) || typeof truncated !== 'boolean') return null
  const notes: { note: string; revision: string }[] = []
  for (const item of notesValue) {
    const note = asRecord(item)
    if (note === null || typeof note['note'] !== 'string' || typeof note['revision'] !== 'string') return null
    notes.push({ note: note['note'], revision: note['revision'] })
  }
  return { notes, truncated }
}

function parseMemoryWrite(value: unknown): MemoryWriteValue | null {
  const record = asRecord(value)
  if (record === null) return null
  const note = record['note']
  const revision = record['revision']
  const commit = record['commit']
  const contentBytes = record['contentBytes']
  return typeof note === 'string' && typeof revision === 'string' && typeof commit === 'string' && isInteger(contentBytes)
    ? { note, revision, commit, contentBytes }
    : null
}

function applyMemoryRead(memory: Map<string, MemoryEntry>, sourceSeq: number, value: MemoryReadValue): void {
  memory.set(value.note, value.exists
    ? {
        note: value.note,
        revision: value.revision,
        source: 'read',
        sourceSeq,
        summary: summarizeContent(value.content),
      }
    : {
        note: value.note,
        revision: null,
        source: 'absent',
        sourceSeq,
        summary: '',
      })
}

function applyMemoryList(memory: Map<string, MemoryEntry>, sourceSeq: number, value: MemoryListValue): void {
  const listed = new Set<string>()
  for (const item of value.notes) {
    listed.add(item.note)
    const existing = memory.get(item.note)
    if (existing?.revision === item.revision) continue
    memory.set(item.note, {
      note: item.note,
      revision: item.revision,
      source: 'listed',
      sourceSeq,
      summary: '',
    })
  }
  if (!value.truncated) {
    for (const note of [...memory.keys()]) {
      if (!listed.has(note)) memory.delete(note)
    }
  }
}

function applyMemoryWrite(memory: Map<string, MemoryEntry>, sourceSeq: number, value: MemoryWriteValue): void {
  memory.set(value.note, {
    note: value.note,
    revision: value.revision,
    source: 'written',
    sourceSeq,
    summary: '',
    contentBytes: value.contentBytes,
  })
}

function summarizeContent(content: string): string {
  const line = content.split(/\r?\n/u).map(part => part.trim()).find(Boolean) ?? ''
  return line.replace(/\s+/gu, ' ').slice(0, 180)
}

function failedProblem(sourceSeq: number, toolName: string | undefined): ProblemData {
  return toolName === undefined
    ? { status: 'failed', sourceSeq }
    : { status: 'failed', sourceSeq, toolName }
}

function toolFailureTarget(toolName: string | undefined): 'calendar' | 'memory' | null {
  switch (toolName) {
    case 'calendar_list':
      return 'calendar'
    case 'memory_read':
    case 'memory_list':
    case 'memory_write':
      return 'memory'
    default:
      return null
  }
}

function targetOfKnownKind(kind: string): ParsedMeta['target'] {
  switch (kind) {
    case 'calendar-list':
      return 'calendar'
    case 'memory-read':
    case 'memory-list':
    case 'memory-write':
      return 'memory'
    default:
      return 'unknown'
  }
}

function knownKind(kind: string): WorkAssistantKind | undefined {
  switch (kind) {
    case 'calendar-list':
    case 'memory-read':
    case 'memory-list':
    case 'memory-write':
      return kind
    default:
      return undefined
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}
