/** The client reconciles verified snapshots and never starts model work. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBriefingSource, type BriefingSource, type BriefingView } from '../src/client/briefing.ts'

const sources: BriefingSource[] = []
const empty = { version: 1, enabled: true, paused: false, running: false, items: [] }
const item = { id: 'one', sessionId: 'one', messageId: 'reply', createdAt: '2026-03-01T08:00:00.000Z', text: 'Meeting in one hour.', read: false, dismissed: false }

function deferred<T>() { return Promise.withResolvers<T>() }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }) }
function create() { const source = createBriefingSource(1000, 100); sources.push(source); return source }
function until(source: BriefingSource, predicate: (view: BriefingView) => boolean): Promise<void> {
  if (predicate(source.getSnapshot())) return Promise.resolve()
  return new Promise(resolve => {
    const dispose = source.subscribe(() => { if (predicate(source.getSnapshot())) { dispose(); resolve() } })
  })
}

afterEach(() => {
  for (const source of sources.splice(0)) source.dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('briefing snapshot source', () => {
  it('loads one same-origin GET, publishes snapshots, polls, and unsubscribes', async () => {
    vi.useFakeTimers()
    const first = deferred<Response>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(response({ ...empty, items: [item] }))
    vi.stubGlobal('fetch', fetch)
    const source = create()
    const initial = source.getSnapshot()
    expect(source.getSnapshot()).toBe(initial)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await source.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    first.resolve(response(empty))
    await until(source, view => view.status === 'ready')
    expect(listener).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]).toEqual(['/api/work-assistant/briefing', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { 'x-dsh-assistant': '1' } })])
    unsubscribe()
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.getSnapshot().data?.items).toEqual([item])
    expect(listener).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
  })

  it('persists explicit actions and does not duplicate a busy request', async () => {
    const action = deferred<Response>()
    const fetch = vi.fn().mockResolvedValueOnce(response(empty)).mockReturnValueOnce(action.promise)
    vi.stubGlobal('fetch', fetch)
    const source = create()
    await until(source, view => view.status === 'ready')
    const pending = source.act({ action: 'pause' })
    expect(source.getSnapshot()).toMatchObject({ busy: true, data: { paused: false } })
    await source.act({ action: 'resume' })
    await source.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
    action.resolve(response({ ...empty, paused: true }))
    await pending
    expect(source.getSnapshot()).toMatchObject({ busy: false, data: { paused: true } })
    expect(fetch.mock.calls[1]).toEqual(['/api/work-assistant/briefing', expect.objectContaining({ method: 'POST', body: '{"action":"pause"}', headers: { 'x-dsh-assistant': '1', 'Content-Type': 'application/json' } })])
  })

  it.each(['resolve', 'reject'])('does not let a stale GET %s overwrite a newer pause response', async mode => {
    const get = deferred<Response>()
    const fetch = vi.fn().mockReturnValueOnce(get.promise).mockResolvedValueOnce(response({ ...empty, paused: true }))
    vi.stubGlobal('fetch', fetch)
    const source = create()
    await source.act({ action: 'pause' })
    if (mode === 'resolve') get.resolve(response(empty))
    else get.reject(new Error('disconnected'))
    await get.promise.catch(() => {})
    await Promise.resolve()
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: { paused: true } })
  })

  it('retains verified data on failure, rejects mutation failure, and recovers after reconnect', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...empty, items: [item] }))
      .mockResolvedValueOnce(response({}, 503)).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response(empty))
    vi.stubGlobal('fetch', fetch)
    const source = create()
    await until(source, view => view.status === 'ready')
    await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'error', data: { items: [item] } })
    await expect(source.act({ action: 'pause' })).rejects.toThrow('offline')
    expect(source.getSnapshot()).toMatchObject({ status: 'error', busy: false, data: { paused: false } })
    await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', data: { items: [] } })
  })

  it.each([null, 1, {}, { ...empty, version: 2 }, { ...empty, enabled: 'true' }, { ...empty, paused: 0 }, { ...empty, running: null }, { ...empty, items: {} }, { ...empty, items: Array(201).fill(item) }, { ...empty, items: [null] }, { ...empty, items: [{ ...item, text: '' }] }, { ...empty, items: [{ ...item, id: 42 }] }, { ...empty, items: [{ ...item, read: 'false' }] }, { ...empty, items: [{ ...item, dismissed: 0 }] }])('rejects malformed wire snapshot without making up empty data', async value => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(value)))
    const source = create()
    await until(source, view => view.status === 'error')
    expect(source.getSnapshot().data).toBeNull()
  })

  it.each(['GET', 'POST'])('recovers after a hung %s reaches its request deadline', async method => {
    vi.useFakeTimers()
    const hung = (_url: string, options: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      const signal = options.signal!
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const fetch = vi.fn()
    if (method === 'POST') fetch.mockResolvedValueOnce(response(empty))
    fetch.mockImplementationOnce(hung).mockResolvedValue(response({ ...empty, paused: false }))
    vi.stubGlobal('fetch', fetch)
    const source = create()
    let action: Promise<unknown> | undefined
    if (method === 'POST') {
      await until(source, view => view.status === 'ready')
      action = source.act({ action: 'pause' }).catch(error => error)
      expect(source.getSnapshot().busy).toBe(true)
    }
    await vi.advanceTimersByTimeAsync(100)
    if (action !== undefined) expect(await action).toBeDefined()
    expect(source.getSnapshot()).toMatchObject({ status: 'error', busy: false })
    await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'ready', busy: false, data: { paused: false } })
  })

  it('aborts outstanding work, removes timers, and suppresses late data on disposal', async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    const fetch = vi.fn().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetch)
    const source = create()
    const listener = vi.fn()
    source.subscribe(listener)
    const before = source.getSnapshot()
    source.dispose()
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    pending.resolve(response(empty))
    await pending.promise
    await vi.advanceTimersByTimeAsync(10_000)
    await source.refresh()
    await source.act({ action: 'pause' })
    expect(source.getSnapshot()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })
})
