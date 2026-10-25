/** Durable JSON publication under Windows file-handle contention. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi, type TestContext } from 'vitest'
import { writeAtomic } from '../src/atomic.ts'

const state = vi.hoisted(() => ({ attempts: 0, failures: [] as string[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      state.attempts += 1
      const code = state.failures.shift()
      if (code !== undefined) throw Object.assign(new Error('Injected rename interference'), { code })
      return actual.rename(...args)
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  state.attempts = 0
  state.failures.length = 0
})

async function target(test: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-json-atomic-'))
  test.onTestFinished(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))
  const path = join(directory, 'value.json')
  await writeFile(path, 'old')
  return { directory, path }
}

it('publishes the complete JSON file after transient Windows replacement interference', async (test) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { directory, path } = await target(test)
  state.failures.push('EACCES', 'EBUSY', 'EPERM')

  await writeAtomic(path, 'new')

  expect(state.attempts).toBe(4)
  expect(await readFile(path, 'utf8')).toBe('new')
  expect(await readdir(directory)).toEqual(['value.json'])
})

it('rejects persistent Windows interference without replacing the target or leaving temporary files', async (test) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { directory, path } = await target(test)
  state.failures.push(...Array.from({ length: 9 }, () => 'EPERM'))

  await expect(writeAtomic(path, 'new')).rejects.toMatchObject({ code: 'EPERM' })

  expect(state.attempts).toBe(9)
  expect(await readFile(path, 'utf8')).toBe('old')
  expect(await readdir(directory)).toEqual(['value.json'])
})
