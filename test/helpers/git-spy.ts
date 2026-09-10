import type { GitExecRequest } from '../../src/git/exec'
import { vi } from 'vitest'
import * as gitExec from '../../src/git/exec'

export function isMutatingGit(args: readonly string[]): boolean {
  const head = args[0]
  if (head === 'stash')
    return args[1] !== 'list'
  if (head === 'worktree')
    return args[1] !== 'list'
  if (head === 'checkout' || head === 'commit-tree' || head === 'read-tree' || head === 'write-tree')
    return true
  if (head === 'add' || head === 'reset' || head === 'clean' || head === 'rebase')
    return true
  if (head === 'update-ref')
    return true
  return false
}

export function isForbiddenIsolationGit(args: readonly string[]): boolean {
  if (args[0] === 'stash' && args[1] !== 'list')
    return true
  if (args[0] === 'checkout')
    return true
  if (args[0] === 'update-ref' && args.some(arg => arg.includes('/lock')))
    return true
  return false
}

export function recordGitExec(): { readonly calls: string[][], restore: () => void } {
  const calls: string[][] = []
  const original = gitExec.execGit
  const spy = vi.spyOn(gitExec, 'execGit').mockImplementation(async (request: GitExecRequest) => {
    calls.push([...request.args])
    return original(request)
  })
  return {
    calls,
    restore: () => spy.mockRestore(),
  }
}
