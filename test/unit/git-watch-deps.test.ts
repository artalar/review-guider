import { context, peek, sleep, wrap } from '@reatom/core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sidebarViewModel } from '../../src/model/view'
import {
  bumpGitWatch,
  gitCapability,
  gitRepoToken,
  gitSurfaceLive,
  gitWatchToken,
  idleStartPreview,
  pendingEntry,
  rebaseInProgress,
  sidebarLive,
  startPreview,
  workspaceRoot,
} from '../../src/model/session'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

beforeEach(() => context.reset())
afterAll(cleanupTempRepos)

describe('idle git probes stay off the index watcher', () => {
  it('does not refetch startPreview on a git tick while no entry is pending', async () => {
    await context.start(async () => {
      const unsubscribe = startPreview.data.subscribe(() => {})
      expect(await startPreview()).toBe(idleStartPreview)
      gitWatchToken.set(value => value + 1)
      expect(await startPreview()).toBe(idleStartPreview)
      unsubscribe()
    })
  })

  it('keeps gitState-backed context keys cold until the sidebar is open', () => {
    context.start(() => {
      expect(gitSurfaceLive()).toBe(false)
      expect(rebaseInProgress()).toBe(false)
      expect(peek(sidebarViewModel).gitState).toBeNull()

      sidebarLive.set(true)
      expect(gitSurfaceLive()).toBe(true)
    })
  })

  it('does not start preview work for a pending pick while the sidebar is hidden', () => {
    context.start(() => {
      pendingEntry.set({ kind: 'commit', rev: 'abc' })
      expect(peek(sidebarViewModel).willRun).toBe('nothing')
      expect(peek(sidebarViewModel).willRunNotes).toBe(idleStartPreview.notes)
    })
  })

  it('promotes a repo bump that is followed by a worktree bump', async () => {
    await context.start(async () => {
      const repoBefore = peek(gitRepoToken)
      const watchBefore = peek(gitWatchToken)
      bumpGitWatch('repo')
      bumpGitWatch('worktree')
      await wrap(sleep(250))
      expect(peek(gitRepoToken)).toBe(repoBefore + 1)
      expect(peek(gitWatchToken)).toBe(watchBefore + 1)
    })
  })

  it('does not refetch capability when only the worktree token moves', async () => {
    const repo = await makeTempRepo()
    workspaceRoot.set(repo.root)
    const unsubscribe = gitCapability.data.subscribe(() => {})
    const first = await gitCapability()
    expect(first?.ok).toBe(true)
    gitWatchToken.set(value => value + 1)
    expect(await gitCapability()).toBe(first)
    gitRepoToken.set(value => value + 1)
    const second = await gitCapability()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    unsubscribe()
  })
})
