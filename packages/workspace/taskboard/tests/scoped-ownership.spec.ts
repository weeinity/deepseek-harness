import type { Context } from '@deepseek-ai/cordis'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { afterEach, expect, it } from 'vitest'
import TaskboardService, { createTaskboardOwnershipCapability } from '../src/index.ts'
import type { TaskboardOwnershipCapability } from '../src/index.ts'
import { cleanup, dsh, harness } from './harness.ts'

afterEach(cleanup)

async function mountConsumer(root: Context) {
  let capability!: TaskboardOwnershipCapability
  let board!: TaskboardService
  const lifetime = new AbortController()
  const fiber = await root.plugin({
    inject: ['taskboard'],
    apply(ctx: Context) {
      expect(() => ctx.storageDomain).toThrow('without inject')
      expect(() => ctx.workspaceRegistry).toThrow('without inject')
      board = ctx.taskboard
      capability = createTaskboardOwnershipCapability(board, async () => { lifetime.signal.throwIfAborted() })
      ctx.effect(() => async () => {
        lifetime.abort(new Error('consumer stopped'))
        await capability.drain()
      }, 'scoped taskboard owner')
    },
  })
  return { fiber, capability, board }
}

it('refreshes from a taskboard-only consumer and replaces owners and storage dependencies through Cordis fibers', async () => {
  const { ctx, workspaceId, facility, domainProvider, taskboardProvider } = await harness({ scoped: true })
  const first = await mountConsumer(ctx)
  await first.capability.refresh()
  const task = await first.board.create({ workspaceId, title: 'Persist across scoped callers', connection: dsh })
  await first.fiber.dispose()
  expect(facility.get('taskboard')).toBeDefined()
  const second = await mountConsumer(ctx)
  await second.capability.refresh()
  expect(second.board.get(task.id)).toEqual(task)
  await domainProvider!.dispose()
  expect(facility.get('taskboard')).toBeUndefined()
  await expect(second.capability.refresh()).rejects.toThrow('closing')
  await taskboardProvider.dispose()
  await ctx.plugin(StorageDomain, { backend: 'fixture', routes: {} })
  await ctx.plugin(TaskboardService)
  const third = await mountConsumer(ctx)
  await third.capability.refresh()
  expect(ctx.storageDomain).not.toBe(facility)
  expect(third.board.get(task.id)).toEqual(task)
  await ctx.fiber.dispose()
  expect(ctx.storageDomain).toBeUndefined()
})
