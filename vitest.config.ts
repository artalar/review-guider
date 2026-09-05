import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration suites share the global Reatom context and call
    // `context.reset()` in beforeEach. Parallel file runs abort in-flight
    // `take()`/`wrap()` work mid-flight and surface as
    // `TypeError: un is not a function` (review 002 M8). Serialise files.
    fileParallelism: false,
    // The integration suites drive real `git` subprocesses against temp repos,
    // which is well past vitest's 5s default on a cold Windows runner.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
