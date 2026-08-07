import type { IsolationHandle } from '../../src/git/isolate'
import type { ReviewTarget } from '../../src/git/types'
import type { StorePort } from '../../src/model/ports'
import type { RepoFingerprint, TmpRepo } from '../helpers/tmp-repo'
import { afterAll, describe, expect, it } from 'vitest'
import { isolate, listGuideRefs, planIsolation, RepoLockedError, restoreFromToken } from '../../src/git/isolate'
import { stashMessageFor } from '../../src/git/journal'
import { readStatus } from '../../src/git/probe'
import { backupRefName, readLock, resolveRef } from '../../src/git/refs'
import { findStashByMessage, listStash } from '../../src/git/stash'
import { memoryStore } from '../../src/model/ports'
import { cleanupTempRepos, isWindows, makeTempRepo } from '../helpers/tmp-repo'

/**
 * The sacred suite (plan Phase 2 test gate).
 *
 * Every case takes a fingerprint — `git status --porcelain=v2 -z` plus a
 * SHA-256 of every tracked and untracked file — isolates the repository for
 * real, and asserts the fingerprint after the restore is identical. A failure
 * here is a data-loss bug and blocks every later phase.
 */

afterAll(cleanupTempRepos)

interface Trip {
  readonly before: RepoFingerprint
  readonly handle: IsolationHandle
  readonly store: StorePort
  readonly needsStash: boolean
}

interface TripOptions {
  readonly sessionId?: string
  readonly includeUntracked?: boolean
  readonly entry?: ReviewTarget
}

/** Fingerprints, then runs the real isolation pipeline. */
async function beginTrip(repo: TmpRepo, options: TripOptions = {}): Promise<Trip> {
  const sessionId = options.sessionId ?? 'roundtrip'
  const includeUntracked = options.includeUntracked ?? true
  const entry: ReviewTarget = options.entry ?? { kind: 'workingTree' }

  const before = await repo.fingerprint()
  const store = memoryStore()
  const plan = await planIsolation(repo.root, { entry, includeUntracked })
  const handle = await isolate({ repoRoot: repo.root, sessionId, plan, store, includeUntracked, now: 0 })

  return { before, handle, store, needsStash: plan.needsStash }
}

/** Restores, then asserts the round trip was byte-identical and left nothing behind. */
async function endTrip(repo: TmpRepo, trip: Trip): Promise<void> {
  const outcome = await restoreFromToken({ token: trip.handle.token, store: trip.store })
  expect(outcome.kind).toBe('restored')

  expect(await repo.fingerprint()).toEqual(trip.before)
  expect(await listGuideRefs(repo.root)).toEqual([])
  expect(await readLock(repo.root)).toBeNull()
  expect(await listStash(repo.root)).toEqual([])
  expect(await trip.store.readToken(repo.root)).toBeNull()
}

async function roundTrip(repo: TmpRepo, options: TripOptions = {}): Promise<Trip> {
  const trip = await beginTrip(repo, options)
  await endTrip(repo, trip)
  return trip
}

describe('stash round trip — the fixture matrix', () => {
  it('touches nothing when the tree is already clean', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    const trip = await beginTrip(repo, { sessionId: 'clean' })

    expect(trip.needsStash).toBe(false)
    // No stash entry is the assertion: a clean tree must not be pushed at all.
    expect(await listStash(repo.root)).toEqual([])
    expect(trip.handle.token.backupCommit).toBeNull()

    await endTrip(repo, trip)
  })

  it('restores unstaged edits byte-identically', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\ntwo\n', 'b.txt': 'keep\n' } })
    await repo.write('a.txt', 'one\ntwo\nthree\n')

    const trip = await beginTrip(repo, { sessionId: 'unstaged' })
    expect(trip.needsStash).toBe(true)
    expect((await readStatus(repo.root)).clean).toBe(true)

    await endTrip(repo, trip)
    expect(await repo.read('a.txt')).toBe('one\ntwo\nthree\n')
  })

  it('restores both hunks and the index split for a staged + unstaged file', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\ntwo\nthree\n' } })
    await repo.write('a.txt', 'STAGED\ntwo\nthree\n')
    await repo.git('add', 'a.txt')
    await repo.write('a.txt', 'STAGED\ntwo\nUNSTAGED\n')

    const status = await readStatus(repo.root)
    expect(status.staged).toEqual(['a.txt'])
    expect(status.unstaged).toEqual(['a.txt'])

    const trip = await roundTrip(repo, { sessionId: 'split' })

    // The fingerprint covers content; this covers the staged/unstaged split
    // specifically, which is the part `stash apply --index` exists for.
    const after = await readStatus(repo.root)
    expect(after.staged).toEqual(['a.txt'])
    expect(after.unstaged).toEqual(['a.txt'])
    expect(await repo.read('a.txt')).toBe('STAGED\ntwo\nUNSTAGED\n')
    expect(await repo.git('show', ':a.txt')).toBe('STAGED\ntwo\nthree\n')
    expect(trip.handle.token.backupCommit).not.toBeNull()
  })

  it('restores untracked files as untracked', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('new/note.md', 'scratch\n')

    const trip = await beginTrip(repo, { sessionId: 'untracked' })
    expect(trip.needsStash).toBe(true)
    expect(await repo.exists('new/note.md')).toBe(false)

    await endTrip(repo, trip)
    expect((await readStatus(repo.root)).untracked).toEqual(['new/note.md'])
  })

  it('leaves untracked files in place when the setting is off', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('scratch.txt', 'not mine to move\n')

    const trip = await beginTrip(repo, { sessionId: 'keepuntracked', includeUntracked: false })

    // Nothing tracked changed, so the pipeline has nothing to stash and the
    // untracked file simply stays where the user left it.
    expect(trip.needsStash).toBe(false)
    expect(await repo.read('scratch.txt')).toBe('not mine to move\n')

    await endTrip(repo, trip)
  })

  it.skipIf(isWindows)('preserves a file mode change', async () => {
    const repo = await makeTempRepo({ files: { 'run.sh': '#!/bin/sh\necho hi\n' } })
    await repo.setExecutable('run.sh')

    expect(trackedMode(await repo.git('ls-files', '-s', 'run.sh'))).toBe('100644')
    await roundTrip(repo, { sessionId: 'mode' })
    expect((await repo.fingerprint()).files['run.sh']?.executable).toBe(true)
  })

  it('does not normalise CRLF or mixed line endings', async () => {
    const mixed = 'crlf\r\nlf\ncrlf again\r\n'
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('mixed.txt', mixed)
    await repo.git('add', 'mixed.txt')
    await repo.commit('add mixed endings')
    await repo.write('mixed.txt', `${mixed}trailing\r\n`)

    await roundTrip(repo, { sessionId: 'crlf' })
    expect(await repo.read('mixed.txt')).toBe(`${mixed}trailing\r\n`)
  })

  it('keeps a deleted-but-not-staged file deleted', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n', 'gone.txt': 'bye\n' } })
    await repo.remove('gone.txt')

    const trip = await beginTrip(repo, { sessionId: 'deleted' })
    // The stash put the file back for the duration of the session…
    expect(await repo.exists('gone.txt')).toBe(true)

    await endTrip(repo, trip)
    // …and the restore took it away again.
    expect(await repo.exists('gone.txt')).toBe(false)
    expect((await readStatus(repo.root)).unstaged).toEqual(['gone.txt'])
  })

  it('never sweeps ignored files', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n', '.gitignore': '.env\n' } })
    await repo.write('.env', 'SECRET=1\n')
    await repo.write('a.txt', 'edited\n')

    const trip = await beginTrip(repo, { sessionId: 'ignored' })
    // R8: `--include-untracked`, never `--all`. The secret stays on disk for
    // the whole session, so a restore failure can never lose it.
    expect(await repo.read('.env')).toBe('SECRET=1\n')

    await endTrip(repo, trip)
    expect(await repo.read('.env')).toBe('SECRET=1\n')
  })

  it('restores a rename that is only staged', async () => {
    const repo = await makeTempRepo({ files: { 'old.txt': 'content\n' } })
    await repo.git('mv', 'old.txt', 'new.txt')

    await roundTrip(repo, { sessionId: 'rename' })
    expect(await repo.exists('new.txt')).toBe(true)
    expect(await repo.exists('old.txt')).toBe(false)
  })

  it('restores a subdirectory of edits and additions at once', async () => {
    const repo = await makeTempRepo({
      files: { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 2\n' },
    })
    await repo.write('src/a.ts', 'export const a = 11\n')
    await repo.remove('src/b.ts')
    await repo.write('src/c.ts', 'export const c = 3\n')
    await repo.git('add', 'src/c.ts')
    await repo.write('src/d.ts', 'export const d = 4\n')

    await roundTrip(repo, { sessionId: 'mixed' })
    expect(await repo.read('src/a.ts')).toBe('export const a = 11\n')
    expect(await repo.exists('src/b.ts')).toBe(false)
    expect((await readStatus(repo.root)).staged).toEqual(['src/c.ts'])
    expect((await readStatus(repo.root)).untracked).toEqual(['src/d.ts'])
  })
})

describe('stash round trip — head movement', () => {
  it('returns HEAD to its branch after a commit review', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'two\n')
    await repo.git('add', '-A')
    const target = await repo.commit('second')
    await repo.write('a.txt', 'work in progress\n')

    const trip = await beginTrip(repo, { sessionId: 'commit', entry: { kind: 'commit', rev: target } })

    expect(trip.handle.afterRev).toBe(target)
    expect((await repo.tryGit('symbolic-ref', '--quiet', 'HEAD')).code).not.toBe(0)

    await endTrip(repo, trip)
    expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')
    expect(await repo.read('a.txt')).toBe('work in progress\n')
  })

  it('reviews a root commit against the empty tree', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    const root = await repo.head()
    await repo.write('a.txt', 'wip\n')

    const trip = await beginTrip(repo, { sessionId: 'root', entry: { kind: 'commit', rev: root } })
    expect(trip.handle.afterRev).toBe(root)
    // Everything in a root commit is an addition, so the base is the empty tree.
    expect((await repo.git('cat-file', '-t', trip.handle.baseRev)).trim()).toBe('tree')
    expect((await repo.git('ls-tree', trip.handle.baseRev)).trim()).toBe('')

    await endTrip(repo, trip)
  })

  it('returns HEAD to a detached position it started from', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    const first = await repo.head()
    await repo.write('a.txt', 'two\n')
    await repo.git('add', '-A')
    const target = await repo.commit('second')
    await repo.git('checkout', '--detach', first)
    await repo.write('a.txt', 'detached wip\n')

    const trip = await beginTrip(repo, { sessionId: 'detached', entry: { kind: 'commit', rev: target } })
    await endTrip(repo, trip)

    expect((await repo.git('rev-parse', 'HEAD')).trim()).toBe(first)
    expect((await repo.tryGit('symbolic-ref', '--quiet', 'HEAD')).code).not.toBe(0)
  })
})

describe('stash round trip — failure is not loss', () => {
  it('blocks the restore and keeps every artifact when apply would overwrite', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\ntwo\nthree\n' } })
    await repo.write('a.txt', 'one\nMY WORK\nthree\n')

    const trip = await beginTrip(repo, { sessionId: 'conflict' })

    // Something edits the same file mid-session, so `git stash apply` refuses.
    await repo.write('a.txt', 'one\nSOMETHING ELSE\nthree\n')

    const blocked = await restoreFromToken({ token: trip.handle.token, store: trip.store })
    expect(blocked.kind).toBe('blocked')
    if (blocked.kind !== 'blocked')
      throw new Error('unreachable')
    expect(blocked.reason).toBe('apply-conflict')
    expect(blocked.commands.length).toBeGreaterThan(0)

    // Nothing discarded: the stash entry, the backup ref and the token all live.
    expect(await findStashByMessage(repo.root, stashMessageFor('conflict'))).not.toBeNull()
    expect(await resolveRef(repo.root, backupRefName('conflict'))).toBe(trip.handle.token.backupCommit)
    expect(await trip.store.readToken(repo.root)).not.toBeNull()
    expect(await readLock(repo.root)).not.toBeNull()
    // And the user's work is readable straight out of the backup ref.
    expect(await repo.git('show', `${backupRefName('conflict')}:a.txt`)).toBe('one\nMY WORK\nthree\n')

    // Undo the interference and the very same restore now completes.
    await repo.write('a.txt', 'one\ntwo\nthree\n')
    const retry = await restoreFromToken({ token: blocked.token, store: trip.store })
    expect(retry.kind).toBe('restored')
    expect(await repo.fingerprint()).toEqual(trip.before)
    expect(await listStash(repo.root)).toEqual([])
    expect(await listGuideRefs(repo.root)).toEqual([])
  })

  it('is idempotent: a second restore is a no-op', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'two\n')

    const trip = await beginTrip(repo, { sessionId: 'twice' })
    await endTrip(repo, trip)

    const again = await restoreFromToken({ token: trip.handle.token, store: trip.store })
    expect(again).toEqual({ kind: 'restored', stashApplied: false, stashDropped: false, indexRestored: true })
    expect(await repo.fingerprint()).toEqual(trip.before)
  })

  it('unwinds a failed start and leaves the tree exactly as it was', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'precious\n')
    await repo.write('scratch.txt', 'also precious\n')
    const before = await repo.fingerprint()

    // The journal write after the capture fails; everything before it must unwind.
    const store = failOnWrite(2)
    const plan = await planIsolation(repo.root, { entry: { kind: 'workingTree' }, includeUntracked: true })

    await expect(isolate({
      repoRoot: repo.root,
      sessionId: 'unwind',
      plan,
      store,
      includeUntracked: true,
      now: 0,
    })).rejects.toThrow('journal is full')

    expect(await repo.fingerprint()).toEqual(before)
    expect(await listStash(repo.root)).toEqual([])
    expect(await listGuideRefs(repo.root)).toEqual([])
    expect(await readLock(repo.root)).toBeNull()
  })
})

describe('repository lock', () => {
  it('refuses a second session and releases on restore', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'two\n')

    const first = await beginTrip(repo, { sessionId: 'window-a' })
    expect(await readLock(repo.root)).not.toBeNull()

    const plan = await planIsolation(repo.root, { entry: { kind: 'workingTree' }, includeUntracked: true })
    await expect(isolate({
      repoRoot: repo.root,
      sessionId: 'window-b',
      plan,
      store: memoryStore(),
      includeUntracked: true,
      now: 0,
    })).rejects.toBeInstanceOf(RepoLockedError)

    // The refused start wrote no token and left the first session untouched.
    expect(await resolveRef(repo.root, backupRefName('window-b'))).toBeNull()

    await endTrip(repo, first)

    // With the lock released the second window can start for real.
    await repo.write('a.txt', 'three\n')
    await roundTrip(repo, { sessionId: 'window-b2' })
  })
})

/** `100644 <sha> 0\tpath` → the mode column. */
function trackedMode(raw: string): string {
  return raw.split(' ')[0] ?? ''
}

/** A `StorePort` that throws on the nth write, to exercise the unwind path. */
function failOnWrite(nth: number): StorePort {
  const inner = memoryStore()
  let writes = 0
  return {
    readToken: inner.readToken,
    clearToken: inner.clearToken,
    writeToken: async (token) => {
      writes += 1
      if (writes === nth)
        throw new Error('journal is full')
      await inner.writeToken(token)
    },
  }
}
