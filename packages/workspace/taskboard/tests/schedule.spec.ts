import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTaskScheduleRun, TaskboardInputError, taskScheduleInput } from '../src/index.ts'
import { cleanup, dsh, harness, request, schedule } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})
afterEach(async () => {
  vi.useRealTimers()
  await cleanup()
})

describe('domain-owned cron configuration', () => {
  it('calculates the next occurrence strictly after the supplied instant in the chosen timezone', () => {
    const timers = vi.getTimerCount()
    expect(nextTaskScheduleRun(schedule, '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T01:00:00.000Z')
    expect(nextTaskScheduleRun({ cron: '0 9 * * *', timeZone: 'Asia/Tokyo' }, '2025-12-31T23:59:59.000Z'))
      .toBe('2026-01-01T00:00:00.000Z')
    expect(vi.getTimerCount()).toBe(timers)
  })

  it.each([
    { cron: '@hourly' },
    { cron: '* * * *' },
    { cron: '* * * * * *' },
    { cron: '* * * * * * *' },
    { cron: '0 0 * JAN MON' },
    { cron: '0 0 L * *' },
    { cron: '0 0 * * 1#2' },
    { cron: '60 * * * *' },
    { cron: '0 0 31 2 *' },
    { timeZone: 'Not/A_Time_Zone' },
    { timeZone: '+01:00' },
  ])('rejects invalid configuration through create and update: %j', async (patch) => {
    const { board, workspaceId } = await harness()
    await expect(board.create({ workspaceId, title: 'Invalid', schedule: { ...schedule, ...patch } }))
      .rejects.toBeInstanceOf(TaskboardInputError)
    const task = await board.create({ workspaceId, title: 'Valid', schedule })
    await expect(board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { schedule: { ...schedule, ...patch } },
    })).rejects.toBeInstanceOf(TaskboardInputError)
    expect(board.get(task.id)).toEqual(task)
  })

  it('rejects caller-provided occurrence metadata and invalid evaluation timestamps', () => {
    expect(taskScheduleInput.safeParse({ ...schedule, nextRunAt: '2026-01-01T01:00:00.000Z' }).success).toBe(false)
    expect(taskScheduleInput.safeParse({ ...schedule, lastTriggeredAt: '2026-01-01T00:00:00.000Z' }).success).toBe(false)
    expect(() => nextTaskScheduleRun(schedule, 'invalid')).toThrow('valid timestamp')
    expect(() => nextTaskScheduleRun({ ...schedule, timeZone: '' }, '2026-01-01T00:00:00.000Z'))
      .toThrow(TaskboardInputError)
  })

  it('preserves unchanged schedule metadata and calculates edits without accepting caller-written timestamps', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Scheduled', schedule })
    expect(task.schedule?.nextRunAt).toBe('2026-01-01T01:00:00.000Z')
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'))
    await expect(board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { schedule: { ...schedule } },
    })).resolves.toEqual(task)
    vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'))
    const run = await board.beginExecution({
      ...request(task), proposedConnection: dsh, trigger: 'schedule',
      scheduledAt: task.schedule!.nextRunAt!, nextRunAt: '2026-01-01T02:00:00.000Z', now: '2026-01-01T01:00:00.000Z',
    })
    task = await board.settleExecution({ taskId: task.id, executionId: run.executionId, status: 'succeeded' })
    task = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { schedule: { ...schedule, cron: '45 * * * *' } },
    })
    expect(task.schedule).toMatchObject({
      nextRunAt: '2026-01-01T01:45:00.000Z', lastTriggeredAt: '2026-01-01T01:00:00.000Z',
    })
    task = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { schedule: { ...schedule, enabled: false } },
    })
    expect(task.schedule).toEqual({
      ...schedule, enabled: false, lastTriggeredAt: '2026-01-01T01:00:00.000Z',
    })
    task = await board.update({
      taskId: task.id, expectedRevision: task.revision, patch: { schedule },
    })
    expect(task.schedule?.nextRunAt).toBe('2026-01-01T02:00:00.000Z')
  })

  it('restores an archived schedule disabled without retaining its next occurrence', async () => {
    const { board, workspaceId } = await harness()
    let task = await board.create({ workspaceId, title: 'Scheduled', schedule })
    task = await board.archive(task.id, task.revision)
    expect(task.schedule).toEqual({ ...schedule, enabled: false })
    task = await board.restore(task.id, task.revision)
    expect(task.schedule).toEqual({ ...schedule, enabled: false })
    expect(task.schedule).not.toHaveProperty('nextRunAt')
  })
})
