/** Replace only Agency discovery and executable resolution; all ordinary subprocesses remain native. */
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import LocalSubprocessRuntime from '../../../../../packages/subprocess/subprocess-local/lib/index.js'

/** Local provider with deterministic, private external Agency observations. */
export default class TaskboardFixtureSubprocess extends LocalSubprocessRuntime {
  async resolveExecutable(command, ...args) {
    if (['agency.exe', 'wt.exe', 'copilot.exe'].includes(command)) {
      return join(process.env.DSH_TASKBOARD_FIXTURE_ROOT, command)
    }
    return super.resolveExecutable(command, ...args)
  }

  spawn(spec) {
    if (basename(spec.argv[0]) !== 'agency.exe') return super.spawn(spec)
    if (JSON.stringify(spec.argv.slice(1, 4)) !== JSON.stringify(['hub', 'list-local-sessions', '--json'])) {
      throw new Error('Taskboard fixture refuses non-discovery Agency subprocesses')
    }
    const root = process.env.DSH_TASKBOARD_FIXTURE_ROOT
    appendFileSync(join(root, 'external-calls.jsonl'), JSON.stringify({ type: 'discovery', argv: spec.argv }) + '\n')
    const stdout = readFileSync(join(root, 'agency-state.json'), 'utf8')
    return {
      stdin: undefined, stdout: undefined, stderr: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate() {},
      waitForExit: async () => true,
    }
  }
}
