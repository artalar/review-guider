import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../../src/git/exec'
import {
  AFTER_REF_MAX_AGE_MS,
  beginReview,
  planIsolation,
  releaseReview,
  sweepStaleAfterRefs,
} from '../../src/git/isolate'
import { afterRefName, listAfterRefs, listRefs, resolveRef, writeRef } from '../../src/git/refs'
import { captureWorkingState, writeWorkingTree } from '../../src/git/snapshot'
import { cancelSession, isolation, sessionStatus } from '../../src/model/session'
import { isForbiddenIsolationGit, isMutatingGit, recordGitExec } from '../helpers/git-spy'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

beforeEach(() => context.reset())

afterEach(async () => {
  if (peek(sessionStatus) !== 'idle')
    await cancelSession('cancel')
})

afterAll(cleanupTempRepos)

async function dirtyRepo() {
  const repo = await makeTempRepo({ files: { 'a.txt': 'one\n', 'b.txt': 'keep\n' } })
  await repo.write('a.txt', 'edited\n')
  await repo.write('new.txt', 'fresh\n')
  return repo
}

describe('snapshot ref lifecycle', () => {
  it('pins a working-tree after-ref without touching the tree or the stash', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const head = await repo.head()
    const plan = await planIsolation(repo.root, { entry: { kind: 'workingTree' } })
    const handle = await beginReview({ repoRoot: repo.root, sessionId: 'snap-1', plan })

    expect(handle.afterRef).toBe(afterRefName('snap-1'))
    expect(await resolveRef(repo.root, handle.afterRef ?? '')).toBe(handle.afterRev)
    expect((await repo.git('rev-parse', `${handle.afterRev}^`)).trim()).toBe(head)
    expect((await repo.git('rev-parse', `${handle.afterRev}^{tree}`)).trim()).toBe(await writeWorkingTree(repo.root))
    expect(await repo.fingerprint()).toEqual(before)
    expect((await repo.git('stash', 'list')).trim()).toBe('')
    expect(await resolveRef(repo.root, 'refs/tabthrough/lock')).toBeNull()

    await releaseReview(handle)
    expect(await resolveRef(repo.root, afterRefName('snap-1'))).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('writes nothing for a commit or range review', async () => {
    const repo = await makeTempRepo({ files: { 'src/app.ts': 'export const n = 1\n' } })
    await repo.write('src/app.ts', 'export const n = 2\n')
    await repo.git('add', '-A')
    await repo.commit('bump')
    const before = await repo.fingerprint()

    const spy = recordGitExec()
    try {
      const commitPlan = await planIsolation(repo.root, { entry: { kind: 'commit', rev: 'HEAD' } })
      const commitHandle = await beginReview({ repoRoot: repo.root, sessionId: 'c1', plan: commitPlan })
      expect(commitHandle.afterRef).toBeNull()
      expect(commitHandle.afterRev).toBe(await repo.head())

      const rangePlan = await planIsolation(repo.root, { entry: { kind: 'range', from: 'HEAD~1', to: 'HEAD' } })
      const rangeHandle = await beginReview({ repoRoot: repo.root, sessionId: 'r1', plan: rangePlan })
      expect(rangeHandle.afterRef).toBeNull()

      expect(spy.calls.filter(isMutatingGit)).toEqual([])
    }
    finally {
      spy.restore()
    }

    expect(await listAfterRefs(repo.root)).toEqual([])
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('sweeps after-refs older than 24 hours and leaves the rest alone', async () => {
    const repo = await makeTempRepo()
    const tree = (await repo.git('write-tree')).trim()
    const oldCommit = (await runGit(repo.root, ['commit-tree', tree, '-p', 'HEAD', '-m', 'old after'], {
      env: {
        GIT_AUTHOR_NAME: 'Tabthrough',
        GIT_AUTHOR_EMAIL: 'tabthrough@localhost',
        GIT_COMMITTER_NAME: 'Tabthrough',
        GIT_COMMITTER_EMAIL: 'tabthrough@localhost',
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00 +0000',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00 +0000',
      },
    })).trim()
    await writeRef(repo.root, afterRefName('old'), oldCommit)

    const fresh = await captureWorkingState(repo.root, 'fresh')
    await writeRef(repo.root, afterRefName('fresh'), fresh.commit)
    await writeRef(repo.root, 'refs/tabthrough/other/keep', await repo.head())

    const removed = await sweepStaleAfterRefs(repo.root, Date.parse('2000-01-02T00:00:00Z') + AFTER_REF_MAX_AGE_MS)
    expect(removed).toEqual([afterRefName('old')])
    expect(await resolveRef(repo.root, afterRefName('old'))).toBeNull()
    expect(await resolveRef(repo.root, afterRefName('fresh'))).toBe(fresh.commit)
    expect(await resolveRef(repo.root, 'refs/tabthrough/other/keep')).toBe(await repo.head())
    expect((await listRefs(repo.root, 'refs/tabthrough/other')).map(ref => ref.name)).toEqual(['refs/tabthrough/other/keep'])
  })

  it('lets two reviews pin independent after-refs on one repository', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const plan = await planIsolation(repo.root, { entry: { kind: 'workingTree' } })
    const first = await beginReview({ repoRoot: repo.root, sessionId: 'window-a', plan })
    const second = await beginReview({ repoRoot: repo.root, sessionId: 'window-b', plan })

    expect(first.afterRev).not.toBe('')
    expect(second.afterRev).not.toBe('')
    expect(await resolveRef(repo.root, afterRefName('window-a'))).toBe(first.afterRev)
    expect(await resolveRef(repo.root, afterRefName('window-b'))).toBe(second.afterRev)
    expect(await repo.fingerprint()).toEqual(before)

    await releaseReview(first)
    expect(await resolveRef(repo.root, afterRefName('window-a'))).toBeNull()
    expect(await resolveRef(repo.root, afterRefName('window-b'))).toBe(second.afterRev)
    await releaseReview(second)
  })
})

describe('model start uses the snapshot and never isolates', () => {
  it('leaves git status identical and deletes the after-ref on finish', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)
    const spy = recordGitExec()

    try {
      await startReview(harness, { kind: 'workingTree' })
      expect(peek(sessionStatus)).toBe('active')
      expect(peek(isolation)?.afterRef).toBe(afterRefName('entry-session'))
      expect(await resolveRef(repo.root, afterRefName('entry-session'))).not.toBeNull()
      expect(await repo.fingerprint()).toEqual(before)
      expect((await repo.git('stash', 'list')).trim()).toBe('')
      expect(spy.calls.filter(isForbiddenIsolationGit)).toEqual([])

      await cancelSession('finish')
      expect(peek(sessionStatus)).toBe('idle')
      expect(await resolveRef(repo.root, afterRefName('entry-session'))).toBeNull()
      expect(await repo.fingerprint()).toEqual(before)
    }
    finally {
      spy.restore()
      harness.dispose()
    }
  })
})
