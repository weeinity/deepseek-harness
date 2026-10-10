/** Independent OS-process lock participant; paths arrive only from the owning test. */
import { acquireTaskboardOwnership } from '../src/runtime/ownership.ts'

const lockDirectory = process.argv[2]!
try {
  const owner = await acquireTaskboardOwnership({
    lockDirectory, updateMs: 1_000, maxAcquireAttempts: 3,
    onCompromised: (error) => { process.stderr.write(error.message); process.exitCode = 1 },
    onCallbackError: (error) => { process.stderr.write(String(error)); process.exitCode = 1 },
  })
  process.stdout.write('OWNED\n')
  process.stdin.resume()
  await new Promise<void>((resolve) => { process.stdin.once('end', resolve) })
  await owner.dispose()
  process.stdout.write('RELEASED\n')
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'ELOCKED') {
    process.stdout.write('LOCKED\n')
  } else {
    throw error
  }
}
