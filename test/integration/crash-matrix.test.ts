import type { IsolationStage } from '../../src/git/journal'
import type { TmpRepo } from '../helpers/tmp-repo'
import { afterAll, describe, expect, it } from 'vitest'
import { listGuideRefs, restoreFromToken } from '../../src/git/isolate'
import { readStatus } from '../../src/git/probe'
import { readLock } from '../../src/git/refs'
import { listStash } from '../../src/git/stash'
import { isolateUpTo } from '../helpers/protocol'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

/**
 * The crash matrix (plan Phase 2 exit criteria, product edge rows "VS Code
 * closed mid-session" and "extension crash").
 *
 * A crash is indistinguishable from a token that stopped advancing, so every
 * reachable journal state is built directly and handed to the recovery path.
 * The bar is the same as the round-trip suite: byte-identical, no leftovers.
 */

afterAll(cleanupTempRepos)

/** A tree dirty in every way the stash has to carry. */
async function dirtyRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({
    files: { 'a.txt': 'one\ntwo\n', 'staged.txt': 'before\n', 'gone.txt': 'bye\n' },
  })
  await repo.write('a.txt', 'one\ntwo\nthree\n')
  await repo.write('staged.txt', 'after\n')
  await repo.git('add', 'staged.txt')
  await repo.remove('gone.txt')
  await repo.write('untracked.txt', 'fresh\n')
  return repo
}

async function expectNoLeftovers(repo: TmpRepo): Promise<void> {
  expect(await listGuideRefs(repo.root)).toEqual([])
  expect(await readLock(repo.root)).toBeNull()
  expect(await listStash(repo.root)).toEqual([])
}

const STAGES: readonly IsolationStage[] = ['planned', 'captured', 'stashed', 'checkedout', 'reviewing']

describe('recovery from every journal stage', () => {
  for (const stage of STAGES) {
    it(`restores a working-tree session that stopped at "${stage}"`, async () => {
      const repo = await dirtyRepo()
      const before = await repo.fingerprint()

      const { token, store } = await isolateUpTo(repo, stage)
      expect(token.stage).toBe(stage)

      const outcome = await restoreFromToken({ token, store })
      expect(outcome.kind).toBe('restored')
      expect(await repo.fingerprint()).toEqual(before)
      expect(await store.readToken(repo.root)).toBeNull()
      await expectNoLeftovers(repo)
    })
  }
})

describe('recovery from a crash inside a stage', () => {
  it('restores when the journal announced the stash but the push never ran', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()

    const { token, store } = await isolateUpTo(repo, 'stashed', { skip: ['stash-push'] })
    expect(token.stashMessage).not.toBeNull()
    expect(token.backupCommit).toBeNull()
    // The work never left the tree, so recovery only has to verify and tidy up.
    expect((await readStatus(repo.root)).clean).toBe(false)

    const outcome = await restoreFromToken({ token, store })
    expect(outcome).toMatchObject({ kind: 'restored', stashApplied: false })
    expect(await repo.fingerprint()).toEqual(before)
    await expectNoLeftovers(repo)
  })

  it('restores from the stash entry when the backup ref was never written', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()

    const { token, store } = await isolateUpTo(repo, 'reviewing', { skip: ['backup-ref'] })
    expect(token.backupRef).toBeNull()
    expect(await listStash(repo.root)).toHaveLength(1)

    // The scoped stash message is the only handle left, and it is enough.
    const outcome = await restoreFromToken({ token, store })
    expect(outcome).toMatchObject({ kind: 'restored', stashApplied: true, stashDropped: true })
    expect(await repo.fingerprint()).toEqual(before)
    await expectNoLeftovers(repo)
  })

  it('restores when the journal announced a checkout that never happened', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.git('checkout', '--quiet', '-b', 'feature')
    await repo.write('feature.txt', 'new\n')
    await repo.git('add', '-A')
    const target = await repo.commit('feature work')
    await repo.git('checkout', '--quiet', 'main')
    await repo.write('a.txt', 'work in progress\n')
    const before = await repo.fingerprint()

    const { token, store } = await isolateUpTo(repo, 'reviewing', { checkout: target, skip: ['checkout'] })
    expect(token.checkedOut).toBe(target)
    expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')

    const outcome = await restoreFromToken({ token, store })
    expect(outcome.kind).toBe('restored')
    expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')
    expect(await repo.fingerprint()).toEqual(before)
    await expectNoLeftovers(repo)
  })

  it('brings HEAD home from a detached review that crashed', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'two\n')
    await repo.git('add', '-A')
    const target = await repo.commit('second')
    await repo.git('checkout', '--quiet', '-B', 'work', 'HEAD~1')
    await repo.write('a.txt', 'work in progress\n')
    const before = await repo.fingerprint()

    const { token, store } = await isolateUpTo(repo, 'reviewing', { checkout: target })
    expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(target)

    const outcome = await restoreFromToken({ token, store })
    expect(outcome.kind).toBe('restored')
    expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('work')
    expect(await repo.fingerprint()).toEqual(before)
    await expectNoLeftovers(repo)
  })
})

describe('recovery is repeatable', () => {
  it('survives being interrupted and retried at every stage', async () => {
    for (const stage of STAGES) {
      const repo = await dirtyRepo()
      const before = await repo.fingerprint()
      const { token, store } = await isolateUpTo(repo, stage)

      // Recovery is itself interruptible, so it must tolerate being run twice.
      expect((await restoreFromToken({ token, store })).kind).toBe('restored')
      expect((await restoreFromToken({ token, store })).kind).toBe('restored')

      expect(await repo.fingerprint()).toEqual(before)
      await expectNoLeftovers(repo)
    }
  })

  it('refuses to drop the stash when the capture cannot be reproduced', async () => {
    const repo = await dirtyRepo()
    const { token, store } = await isolateUpTo(repo, 'reviewing')

    // Something outside Tabthrough changed the tree while the session was
    // dead. Verification fails, so nothing is dropped and nothing is deleted.
    await repo.write('interference.txt', 'not ours\n')

    const outcome = await restoreFromToken({ token, store })
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked')
      throw new Error('unreachable')
    expect(outcome.reason).toBe('verification-failed')

    expect(await listStash(repo.root)).toHaveLength(1)
    expect(await store.readToken(repo.root)).not.toBeNull()
    expect(await readLock(repo.root)).not.toBeNull()

    // Remove the interference and the same token restores cleanly.
    await repo.remove('interference.txt')
    expect((await restoreFromToken({ token, store })).kind).toBe('restored')
    await expectNoLeftovers(repo)
  })
})
