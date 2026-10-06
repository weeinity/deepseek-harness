/** Client read ownership over a programmable Remote, without Host header/address eligibility checks. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions, SessionLease } from '../src/client/index.ts'
import { ClientSessions } from '../src/client/sessions/service.ts'
import type { SessionFollowFrame, SessionPage } from '../src/types.ts'
import { entries, ev, historyValue as page } from './event-script.client.ts'
import { deferred, err, FakeApiClient, fakeRemote, ok, type RuntimeRemotes } from './fake-api.client.ts'

const roots: Context[] = []
const unblock: Array<() => void> = []
const a = SessionId('lease-a')
const b = SessionId('lease-b')

afterEach(async () => {
  for (const release of unblock.splice(0)) release()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(configure?: (remote: RuntimeRemotes) => RuntimeRemotes) {
  const ctx = new Context()
  roots.push(ctx)
  const api = new FakeApiClient()
  const remote = fakeRemote(api)
  const sessions = new ClientSessions(ctx, configure?.(remote) ?? remote)
  await ctx.plugin(() => undefined)
  return { ctx, api, sessions }
}

async function listed(sessions: ClientSessions, ...ids: SessionId[]): Promise<void> {
  for (const sessionId of ids) {
    sessions.handleSessionAdded({ sessionId, running: false, blank: false, updatedAt: 0 })
  }
  await Promise.resolve()
}

function openingGate(api: FakeApiClient) {
  const started = deferred<undefined>()
  const response = deferred<RemoteResult<SessionPage>>()
  unblock.push(() => { response.resolve(ok({ records: [], hasMore: false })) })
  api.onHistory = () => {
    started.resolve(undefined)
    return response.promise
  }
  return { started: started.promise, response }
}

function snapshot(sessionId: SessionId): SessionFollowFrame {
  return {
    type: 'snapshot',
    header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
    cursor: -1,
    records: [],
    hasMore: false,
    projections: { asOfSeq: -1, values: {} },
    assistantStream: { revision: 0 },
  }
}

describe('Session history leases', () => {
  it('exports only a binding and asynchronous release through the public service', () => {
    expectTypeOf<ISessions['retain']>().parameters
      .toEqualTypeOf<[sessionId: SessionId, signal?: AbortSignal | undefined]>()
    expectTypeOf<ISessions['retain']>().returns.toEqualTypeOf<Promise<SessionLease>>()
    expectTypeOf<SessionLease['dispose']>().returns.toEqualTypeOf<Promise<void>>()
  })

  it('reads two unlisted roots independently without changing current or list membership', async () => {
    const { api, sessions } = await setup()
    await sessions.refresh()
    const list = sessions.list.getSnapshot()
    api.onHistory = ({ sessionId }) => Promise.resolve(ok(page([ev.user(SessionSeq(0), sessionId)])))
    const [first, second] = await Promise.all([sessions.retain(a), sessions.retain(b)])
    expect(sessions.list.getSnapshot()).toBe(list)
    expect(first.binding).toBe(sessions.binding(a))
    expect(first.binding.session.getSnapshot().openState).toBe('open')
    expect(first.binding.eventSource.getSnapshot().entries[0]?.event.data).toMatchObject({
      content: [{ type: 'text', text: a }],
    })
    expect(second.binding.eventSource.getSnapshot().entries[0]?.event.data).toMatchObject({
      content: [{ type: 'text', text: b }],
    })
    expect(api.callsOf('session.follow')).toEqual([
      { address: { kind: 'session', sessionId: a }, assistantStream: true, maxMessages: 50 },
      { address: { kind: 'session', sessionId: b }, assistantStream: true, maxMessages: 50 },
    ])
    await api.pushFollow(a, entries([ev.turnStart(SessionSeq(1), 1)])[0]!)
    expect(first.binding.eventSource.getSnapshot().entries).toHaveLength(2)
    expect(second.binding.eventSource.getSnapshot().entries).toHaveLength(1)
    await first.dispose()
    expect(api.activeFollows(a)).toBe(0)
    expect(api.activeFollows(b)).toBe(1)
    expect(api.callsOf('session.cancel')).toEqual([])
    await second.dispose()
    expect(api.activeFollows(b)).toBe(0)
  })

  it('shares a pending opening and lets one caller abort without interrupting another lease', async () => {
    const { api, sessions } = await setup()
    const gate = openingGate(api)
    const abort = new AbortController()
    const reason = new Error('reader unmounted')
    const cancelled = expect(sessions.retain(a, abort.signal)).rejects.toBe(reason)
    const pending = sessions.retain(a)
    await gate.started
    expect(api.followStarts).toEqual([a])
    abort.abort(reason)
    await cancelled
    expect(api.activeFollows(a)).toBe(1)
    gate.response.resolve(ok(page([ev.user(SessionSeq(0), 'ready')])))
    const lease = await pending
    const other = await sessions.retain(a)
    expect(other.binding).toBe(lease.binding)
    await lease.dispose()
    expect(api.activeFollows(a)).toBe(1)
    await other.dispose()
    expect(api.activeFollows(a)).toBe(0)
  })

  it.each(['navigation-first', 'lease-first'] as const)(
    'shares navigation ownership and preserves off-screen warm history: %s',
    async (order) => {
      const { api, sessions } = await setup()
      await listed(sessions, a, b)
      const binding = sessions.binding(a)
      expect(binding?.session.getSnapshot().openState).toBe('cold')
      if (order === 'navigation-first') sessions.open(a)
      const lease = await sessions.retain(a)
      if (order === 'lease-first') sessions.open(a)
      expect(lease.binding).toBe(binding)
      sessions.open(b)
      await lease.dispose()
      expect(sessions.list.getSnapshot().current).toBe(b)
      expect(api.followStarts.filter(id => id === a)).toHaveLength(1)
      expect(api.activeFollows(a)).toBe(1)
      await api.pushFollow(a, entries([ev.turnStart(SessionSeq(0), 1)])[0]!)
      expect(binding?.eventSource.getSnapshot().entries).toHaveLength(1)
    },
  )

  it('releases only reads, preserving a listed binding, pending submission, and running state', async () => {
    const { api, sessions } = await setup()
    await listed(sessions, a)
    const lease = await sessions.retain(a)
    const retired = vi.fn()
    const submission = lease.binding.session.beginSubmission({
      text: 'pending', mode: 'queue', attachments: [], onRetire: retired,
    })
    sessions.handleSessionStatus(a, true)
    await lease.dispose()
    expect(lease.binding.session.getSnapshot()).toMatchObject({
      openState: 'cold', running: true, pendingSubmissions: [{ requestId: submission.requestId }],
    })
    expect(retired).not.toHaveBeenCalled()
    expect(sessions.binding(a)).toBe(lease.binding)
    expect(api.activeFollows(a)).toBe(0)
    const reopened = await sessions.retain(a)
    expect(reopened.binding).toBe(lease.binding)
    expect(api.followStarts).toEqual([a, a])
    expect(api.callsOf('session.cancel')).toEqual([])
    submission.abandon()
  })

  it('rejects a pre-aborted retain without materializing a binding or starting follow', async () => {
    const { api, sessions } = await setup()
    const reason = new Error('already cancelled')
    await expect(sessions.retain(a, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(sessions.binding(a)).toBeUndefined()
    expect(api.followStarts).toEqual([])
  })

  it.each(['missing', 'malformed'] as const)('rejects %s history and permits a fresh acquisition', async (failure) => {
    const { api, sessions } = await setup()
    const error = new RemoteError('session/not-found', 'missing', { sessionId: a })
    api.onHistory = () => Promise.resolve(failure === 'missing'
      ? err(error)
      : ok({ records: [{ type: 'event', event: {} }], hasMore: false } as unknown as SessionPage))
    if (failure === 'missing') await expect(sessions.retain(a)).rejects.toBe(error)
    else await expect(sessions.retain(a)).rejects.toMatchObject({ code: 'gateway/internal' })
    expect(api.activeFollows(a)).toBe(0)
    expect(sessions.binding(a)).toBeUndefined()
    api.onHistory = () => Promise.resolve(ok(page([])))
    const lease = await sessions.retain(a)
    expect(lease.binding.session.getSnapshot().openState).toBe('open')
  })

  it('uses cancellation for the entire lease lifetime and joins repeated dispose calls', async () => {
    const { api, sessions } = await setup()
    const abort = new AbortController()
    const lease = await sessions.retain(a, abort.signal)
    abort.abort()
    const closing = lease.dispose()
    expect(lease.dispose()).toBe(closing)
    await closing
    expect(api.activeFollows(a)).toBe(0)
    expect(sessions.binding(a)).toBeUndefined()
  })

  it('waits for an aborted opening to stop and rejects without publishing its late baseline', async () => {
    const { api, sessions } = await setup()
    const gate = openingGate(api)
    const abort = new AbortController()
    const reason = new Error('cancel opening')
    const settled = vi.fn()
    const result = sessions.retain(a, abort.signal).catch((error: unknown) => { settled(); return error })
    await gate.started
    const binding = sessions.binding(a)!
    const published = vi.fn()
    const off = binding.eventSource.subscribe(() => { published(binding.eventSource.getSnapshot().entries) })
    abort.abort(reason)
    published.mockClear()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    gate.response.resolve(ok(page([ev.user(SessionSeq(0), 'late')])))
    expect(await result).toBe(reason)
    expect(api.activeFollows(a)).toBe(0)
    expect(published.mock.calls).toEqual([[[]]])
    off()
  })

  it('keeps leased histories across list absence, then drops the unlisted scope on release', async () => {
    const { api, sessions } = await setup()
    await listed(sessions, a)
    const lease = await sessions.retain(a)
    await sessions.refresh()
    expect(sessions.list.getSnapshot().ids).toEqual([])
    expect(sessions.binding(a)).toBe(lease.binding)
    expect(api.activeFollows(a)).toBe(1)
    await lease.dispose()
    expect(sessions.binding(a)).toBeUndefined()
  })

  it('does not select an independent reader over the current Session', async () => {
    const { sessions } = await setup()
    await listed(sessions, b)
    sessions.open(b)
    const lease = await sessions.retain(a)
    expect(sessions.list.getSnapshot().current).toBe(b)
    expect(sessions.list.getSnapshot().ids).not.toContain(a)
    await lease.dispose()
    expect(sessions.list.getSnapshot().current).toBe(b)
  })

  it('drops absent navigation history when its final lease leaves after the stage moves', async () => {
    const { api, sessions } = await setup()
    await listed(sessions, a)
    sessions.open(a)
    const lease = await sessions.retain(a)
    await sessions.refresh()
    await listed(sessions, b)
    sessions.open(b)
    expect(sessions.binding(a)).toBe(lease.binding)
    expect(api.activeFollows(a)).toBe(1)
    await lease.dispose()
    expect(api.activeFollows(a)).toBe(0)
    expect(sessions.binding(a)).toBeUndefined()
  })

  it('preserves a replacement lease acquired by the old scope cleanup', async () => {
    const { api, sessions } = await setup()
    const first = await sessions.retain(a)
    await first.binding.ctx.fiber.await()
    const replacement = deferred<SessionLease>()
    first.binding.ctx.effect(() => () => {
      void sessions.retain(a).then(
        (value) => { replacement.resolve(value) },
        (error: unknown) => { replacement.reject(error) },
      )
    }, 'replacement reader')
    await first.dispose()
    const second = await replacement.promise
    expect(second.binding).not.toBe(first.binding)
    expect(sessions.binding(a)).toBe(second.binding)
    expect(api.activeFollows(a)).toBe(1)
  })

  it('makes disposal reentrant during history-window release', async () => {
    const { api, sessions } = await setup()
    const lease = await sessions.retain(a)
    const repeated: Promise<void>[] = []
    const off = lease.binding.eventSource.subscribe(() => { repeated.push(lease.dispose()) })
    const closing = lease.dispose()
    await closing
    expect(repeated).toEqual([closing])
    expect(api.activeFollows(a)).toBe(0)
    off()
  })

  it('joins an older-page read without allowing its late completion to overwrite a new owner', async () => {
    const { api, sessions } = await setup()
    await listed(sessions, a)
    const started = deferred<undefined>()
    const older = deferred<RemoteResult<SessionPage>>()
    unblock.push(() => { older.resolve(ok(page([]))) })
    api.onHistory = ({ beforeSeq }) => {
      if (beforeSeq !== undefined) {
        started.resolve(undefined)
        return older.promise
      }
      return Promise.resolve(ok(page([ev.user(SessionSeq(1), 'current')], true)))
    }
    const first = await sessions.retain(a)
    const paging = first.binding.session.loadOlder()
    await started.promise
    const released = vi.fn()
    const closing = first.dispose().then(released)
    await vi.waitFor(() => { expect(first.binding.session.getSnapshot().openState).toBe('cold') })
    const second = await sessions.retain(a)
    expect(second.binding).toBe(first.binding)
    const current = second.binding.eventSource.getSnapshot()
    expect(released).not.toHaveBeenCalled()
    older.resolve(ok(page([ev.turnStart(SessionSeq(0), 1)])))
    await Promise.all([closing, paging])
    expect(second.binding.eventSource.getSnapshot()).toBe(current)
    expect(second.binding.session.getSnapshot()).toMatchObject({ openState: 'open', loadingOlder: false })
    expect(api.activeFollows(a)).toBe(1)
  })

  it('rejects a shared opening failure for every owner and releases the source once', async () => {
    const { api, sessions } = await setup()
    const gate = openingGate(api)
    const failure = new RemoteError('session/not-found', 'missing', { sessionId: a })
    const results = Promise.allSettled([sessions.retain(a), sessions.retain(a)])
    await gate.started
    gate.response.resolve(err(failure))
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])
    expect(api.followStarts).toEqual([a])
    expect(api.activeFollows(a)).toBe(0)
  })

  it('rejects a removed staged binding without replacing navigation ownership', async () => {
    const { api, sessions } = await setup()
    await listed(sessions, a)
    sessions.open(a)
    const lease = await sessions.retain(a)
    sessions.handleSessionRemoved(a)
    await lease.dispose()
    await expect(sessions.retain(a)).rejects.toThrow(`Session removed: ${a}`)
    expect(sessions.binding(a)).toBe(lease.binding)
    expect(api.callsOf('session.cancel')).toEqual([])
  })

  it('releases every lease on explicit removal without ending a different Session follow', async () => {
    const { api, sessions } = await setup()
    const first = await sessions.retain(a)
    const shared = await sessions.retain(a)
    const other = await sessions.retain(b)
    sessions.handleSessionRemoved(a)
    await Promise.all([first.dispose(), shared.dispose()])
    expect(first.binding.session.getSnapshot().removed).toBe(true)
    expect(api.activeFollows(a)).toBe(0)
    expect(api.activeFollows(b)).toBe(1)
    expect(other.binding.session.getSnapshot().removed).toBe(false)
  })

  it.each(['remove', 'dispose'] as const)('rejects pending readiness on %s', async (end) => {
    const { ctx, api, sessions } = await setup()
    const gate = openingGate(api)
    const result = sessions.retain(a).catch((error: unknown) => error)
    await gate.started
    let closing: Promise<void> | undefined
    if (end === 'remove') sessions.handleSessionRemoved(a)
    else closing = ctx.fiber.dispose()
    gate.response.resolve(ok(page([])))
    expect(await result).toMatchObject({
      message: end === 'remove' ? `Session removed: ${a}` : 'Session controller disposed',
    })
    await closing
    expect(api.activeFollows(a)).toBe(0)
    if (end === 'dispose') {
      await expect(sessions.retain(b)).rejects.toThrow('Session controller disposed')
    }
  })

  it('joins slow iterator teardown on final release and controller disposal', async () => {
    const entered = deferred<undefined>()
    const aborted = deferred<undefined>()
    const close = deferred<undefined>()
    unblock.push(() => { close.resolve(undefined) })
    const { ctx, sessions } = await setup(remote => ({
      ...remote,
      session: {
        ...remote.session,
        follow: async function* (_request, signal) {
          if (signal === undefined) throw new Error('follow needs cancellation')
          yield snapshot(a)
          entered.resolve(undefined)
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
          })
          await close.promise
        },
      },
    }))
    const lease = await sessions.retain(a)
    await entered.promise
    const released = vi.fn()
    const release = lease.dispose().then(released)
    await aborted.promise
    const disposed = vi.fn()
    const disposal = ctx.fiber.dispose().then(disposed)
    await Promise.resolve()
    expect(released).not.toHaveBeenCalled()
    expect(disposed).not.toHaveBeenCalled()
    close.resolve(undefined)
    await Promise.all([release, disposal])
    expect(released).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
  })

  it('retains native transient Assistant ownership until the final reader releases', async () => {
    const { api, sessions } = await setup()
    const first = await sessions.retain(a)
    const second = await sessions.retain(a)
    const attemptId = LlmAttemptId('leased-attempt')
    await api.pushFollow(a, {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: -1, turn: 1, step: 1 },
    })
    await api.pushFollow(a, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0, time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'streaming' },
      },
    })
    await first.dispose()
    expect(second.binding.eventSource.getSnapshot().entries[0]?.event).toMatchObject({
      type: 'assistant/live-chunk', data: { chunk: { text: 'streaming' } },
    })
    const failure = new RemoteError('session/not-found', 'gone', { sessionId: a })
    api.failStreams(failure)
    await vi.waitFor(() => {
      expect(second.binding.session.getSnapshot()).toMatchObject({ openState: 'error', openError: failure })
    })
    await second.dispose()
    expect(api.activeFollows(a)).toBe(0)
    expect(api.callsOf('session.cancel')).toEqual([])
  })
})
