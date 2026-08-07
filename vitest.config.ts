import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The integration suites drive real `git` subprocesses against temp repos,
    // which is well past vitest's 5s default on a cold Windows runner.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
