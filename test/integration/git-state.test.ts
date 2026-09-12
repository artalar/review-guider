import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalizeRepoRoot } from '../../src/git/paths'
import { quoteArg } from '../../src/git/rebase'
import {
  abortRebase,
  continueRebase,
  popAutostash,
  pruneWorktrees,
  readGitState,
  removeWorktree,
  showAutostash,
} from '../../src/git/state'
import { cleanupTempRepos, makeTempDir, makeTempRepo } from '../helpers/tmp-repo'

afterAll(cleanupTempRepos)

async function writeSequenceEditor(repoRoot: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(repoRoot, 'seq.mjs'), [
    'import { readFileSync, writeFileSync } from \'node:fs\'',
    'const path = process.argv[2]',
    'writeFileSync(path, readFileSync(path, \'utf8\').replace(/^pick /gm, \'edit \'))',
    '',
  ].join('\n'))
}

function sequenceEditor(repoRoot: string): string {
  return `${quoteArg(process.execPath)} ${quoteArg(join(repoRoot, 'seq.mjs'))}`
}

describe('readGitState', () => {
  it('reports a clean repository', async () => {
    const repo = await makeTempRepo()
    const state = await readGitState(repo.root)
    expect(state.rebase).toBeNull()
    expect(state.operation).toBeNull()
    expect(state.conflicts).toEqual([])
    expect(state.staged).toBe(0)
    expect(state.unstaged).toBe(0)
    expect(state.untracked).toBe(0)
    expect(state.detached).toBe(false)
    expect(state.branch).toBe('main')
    expect(state.autostashes).toEqual([])
    expect(state.worktrees).toEqual([])
  })

  it('counts staged, unstaged and untracked files', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'staged\n')
    await repo.git('add', 'a.txt')
    await repo.write('a.txt', 'staged and edited\n')
    await repo.write('b.txt', 'untracked\n')

    const state = await readGitState(repo.root)
    expect(state.staged).toBe(1)
    expect(state.unstaged).toBe(1)
    expect(state.untracked).toBe(1)
  })

  it('reads a rebase stopped at edit', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'two\n')
    await repo.git('add', '-A')
    await repo.commit('second')
    await writeSequenceEditor(repo.root)
    await repo.git('config', 'sequence.editor', sequenceEditor(repo.root))
    await repo.git('rebase', '-i', 'HEAD~1')

    const state = await readGitState(repo.root)
    expect(state.rebase).not.toBeNull()
    expect(state.rebase?.branch).toBe('main')
    expect(state.rebase?.stoppedSha).toBe(await repo.head())
    expect(state.rebase?.total).toBeGreaterThanOrEqual(1)
    expect(state.operation).toBeNull()

    const continued = await continueRebase(repo.root)
    expect(continued.command).toBe('git rebase --continue')
    expect(continued.code).toBe(0)
    expect((await readGitState(repo.root)).rebase).toBeNull()
  })

  it('reads a rebase conflict and abort restores the branch', async () => {
    const repo = await makeTempRepo({ files: { 'conflict.txt': 'base\n' } })
    await repo.git('checkout', '-q', '-b', 'other')
    await repo.write('conflict.txt', 'other\n')
    await repo.git('add', '-A')
    await repo.commit('other side')
    await repo.git('checkout', '-q', 'main')
    await repo.write('conflict.txt', 'main\n')
    await repo.git('add', '-A')
    await repo.commit('main side')
    const rebase = await repo.tryGit('rebase', 'other')
    expect(rebase.code).not.toBe(0)

    const state = await readGitState(repo.root)
    expect(state.rebase).not.toBeNull()
    expect(state.conflicts).toEqual(['conflict.txt'])

    const aborted = await abortRebase(repo.root)
    expect(aborted.command).toBe('git rebase --abort')
    expect(aborted.code).toBe(0)
    const after = await readGitState(repo.root)
    expect(after.rebase).toBeNull()
    expect(after.branch).toBe('main')
    expect(after.conflicts).toEqual([])
  })

  it('flags merge, cherry-pick, revert and bisect', async () => {
    const mergeRepo = await makeTempRepo({ files: { 'conflict.txt': 'base\n' } })
    await mergeRepo.git('checkout', '-q', '-b', 'other')
    await mergeRepo.write('conflict.txt', 'other\n')
    await mergeRepo.git('add', '-A')
    await mergeRepo.commit('other side')
    await mergeRepo.git('checkout', '-q', 'main')
    await mergeRepo.write('conflict.txt', 'main\n')
    await mergeRepo.git('add', '-A')
    await mergeRepo.commit('main side')
    expect((await mergeRepo.tryGit('merge', 'other')).code).not.toBe(0)
    expect((await readGitState(mergeRepo.root)).operation).toBe('merge')
    await mergeRepo.git('merge', '--abort')

    const pickRepo = await makeTempRepo({ files: { 'conflict.txt': 'base\n' } })
    await pickRepo.git('checkout', '-q', '-b', 'other')
    await pickRepo.write('conflict.txt', 'other\n')
    await pickRepo.git('add', '-A')
    await pickRepo.commit('other side')
    const other = await pickRepo.head()
    await pickRepo.git('checkout', '-q', 'main')
    await pickRepo.write('conflict.txt', 'main\n')
    await pickRepo.git('add', '-A')
    await pickRepo.commit('main side')
    expect((await pickRepo.tryGit('cherry-pick', other)).code).not.toBe(0)
    expect((await readGitState(pickRepo.root)).operation).toBe('cherry-pick')
    await pickRepo.git('cherry-pick', '--abort')

    const revertRepo = await makeTempRepo({ files: { 'file.txt': 'first\n' } })
    await revertRepo.write('file.txt', 'second\n')
    await revertRepo.git('add', '-A')
    await revertRepo.commit('second')
    await revertRepo.write('file.txt', 'third\n')
    await revertRepo.git('add', '-A')
    await revertRepo.commit('third')
    expect((await revertRepo.tryGit('revert', '--no-edit', 'HEAD~1')).code).not.toBe(0)
    expect((await readGitState(revertRepo.root)).operation).toBe('revert')
    await revertRepo.git('revert', '--abort')

    const bisectRepo = await makeTempRepo()
    await bisectRepo.git('bisect', 'start')
    expect((await readGitState(bisectRepo.root)).operation).toBe('bisect')
    await bisectRepo.git('bisect', 'reset')
  })

  it('lists leftover autostash entries and can show or pop them', async () => {
    const repo = await makeTempRepo({ files: { 'wip.txt': 'clean\n' } })
    await repo.write('wip.txt', 'dirty\n')
    await repo.git('stash', 'push', '-m', 'autostash', '--', 'wip.txt')

    const state = await readGitState(repo.root)
    expect(state.autostashes.length).toBeGreaterThan(0)
    expect(state.autostashes[0]?.subject).toMatch(/autostash\)?$/)

    const shown = await showAutostash(repo.root, state.autostashes[0]?.selector ?? 'stash@{0}')
    expect(shown.command).toContain('stash show')
    expect(shown.code).toBe(0)

    const popped = await popAutostash(repo.root, state.autostashes[0]?.selector ?? 'stash@{0}')
    expect(popped.command).toContain('stash pop')
    expect((await readGitState(repo.root)).autostashes).toEqual([])
  })

  it('ignores an autostash that is not the latest stash', async () => {
    const repo = await makeTempRepo({ files: { 'wip.txt': 'clean\n', 'other.txt': 'clean\n' } })
    await repo.write('wip.txt', 'older\n')
    await repo.git('stash', 'push', '-m', 'autostash', '--', 'wip.txt')
    await repo.write('other.txt', 'newer\n')
    await repo.git('stash', 'push', '-m', 'wip', '--', 'other.txt')

    expect((await readGitState(repo.root)).autostashes).toEqual([])
  })

  it('reports a detached HEAD', async () => {
    const repo = await makeTempRepo()
    await repo.git('checkout', '-q', '--detach', 'HEAD')
    const state = await readGitState(repo.root)
    expect(state.detached).toBe(true)
    expect(state.branch).toBeNull()
  })

  it('lists only worktrees under the Tabthrough root', async () => {
    const repo = await makeTempRepo()
    const oursRoot = await makeTempDir()
    const foreignRoot = await makeTempDir()
    const ours = join(oursRoot, 'ours')
    const foreign = join(foreignRoot, 'foreign')
    await repo.git('worktree', 'add', '--detach', ours, 'HEAD')
    await repo.git('worktree', 'add', '--detach', foreign, 'HEAD')

    const state = await readGitState(repo.root, { worktreeDir: oursRoot })
    expect(state.worktrees).toHaveLength(1)
    expect(canonicalizeRepoRoot(state.worktrees[0]?.path ?? '')).toBe(canonicalizeRepoRoot(ours))
    expect(state.worktrees[0]?.dirty).toBe(false)

    await repo.write('tracked.txt', 'in main\n')
    await repo.git('add', 'tracked.txt')
    await repo.git('commit', '-m', 'keep main moving')

    const dirty = await makeTempDir()
    const dirtyPath = join(dirty, 'dirty')
    await repo.git('worktree', 'add', '--detach', dirtyPath, 'HEAD')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dirtyPath, 'extra.txt'), 'dirt\n')
    const dirtyState = await readGitState(repo.root, { worktreeDir: dirty })
    expect(dirtyState.worktrees[0]?.dirty).toBe(true)

    const refused = await removeWorktree(repo.root, dirtyPath)
    expect(refused.command).toBe(`git worktree remove ${dirtyPath}`)
    expect(refused.code).not.toBe(0)

    const cleaned = await makeTempDir()
    const cleanPath = join(cleaned, 'clean')
    await repo.git('worktree', 'add', '--detach', cleanPath, 'HEAD')
    const removed = await removeWorktree(repo.root, cleanPath)
    expect(removed.code).toBe(0)

    const staleRoot = await makeTempDir()
    const stale = join(staleRoot, 'stale')
    await repo.git('worktree', 'add', '--detach', stale, 'HEAD')
    const { rm } = await import('node:fs/promises')
    await rm(stale, { recursive: true, force: true })
    const pruned = await pruneWorktrees(repo.root)
    expect(pruned.command).toBe('git worktree prune')
    expect(pruned.code).toBe(0)
    expect((await readGitState(repo.root, { worktreeDir: staleRoot })).worktrees).toEqual([])
  })
})
