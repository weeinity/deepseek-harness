/** Readiness-only subprocess fixture: echoes the owned input and exits on EOF. */
process.stdin.pipe(process.stdout)
