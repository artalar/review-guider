import type { ReviewViewModel } from '../../src/model/view'
import type { TmpRepo } from '../helpers/tmp-repo'
import { Buffer } from 'node:buffer'
import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listGuideRefs, MissingObjectsError, planIsolation } from '../../src/git/isolate'
import { probeGit } from '../../src/git/probe'
import {
  cancelSession,
  canStart,
  describeStartFailure,
  GitUnavailableError,
  session,
  sessionStatus,
  startBlockedReason,
} from '../../src/model/session'
import { reviewViewModel } from '../../src/model/view'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeShallowClone, makeTempDir, makeTempRepo } from '../helpers/tmp-repo'

/**
 * Phase 6 (plan P0-16): the P0 edge rows of `specs/product.md` that the earlier
 * phases left to a fixture rather than an assertion. The other seven rows are
 * covered by the sacred suite, the crash matrix and the reveal loop; the status
 * table lives in `progress/test-matrix.md` §2.
 */

let harnessDispose: (() => void) | null = null

beforeEach(() => context.reset())

afterEach(async () => {
  if (peek(sessionStatus) !== 'idle')
    await cancelSession('cancel')
  harnessDispose?.()
  harnessDispose = null
})

afterAll(cleanupTempRepos)

async function bootstrap(root: string, withReview = false) {
  const harness = await bootstrapModel(root, { withReview })
  harnessDispose = harness.dispose
  return harness
}

// ---------------------------------------------------------------------------
// Binary and generated files in the diff
// ---------------------------------------------------------------------------

/**
 * A PNG signature plus noise. The NUL bytes are the load-bearing part: git
 * calls a file binary when it finds one in the first 8000 bytes.
 */
function pngBytes(seed: number): Uint8Array {
  const header = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]
  const body = Array.from({ length: 64 }, (_, index) => (index * seed) % 251)
  return Buffer.from([...header, ...body])
}

const LOCKFILE_BEFORE = `lockfileVersion: '9.0'\n\npackages:\n  acorn@8.0.0:\n    resolution: {integrity: sha512-aaa}\n`
const LOCKFILE_AFTER = `lockfileVersion: '9.0'\n\npackages:\n  acorn@8.1.0:\n    resolution: {integrity: sha512-bbb}\n`

async function mixedMediaRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({
    files: {
      'src/types.ts': 'export interface User { id: string }\n',
      'pnpm-lock.yaml': LOCKFILE_BEFORE,
    },
  })
  await repo.writeBytes('res/icon.png', pngBytes(3))
  await repo.git('add', '-A')
  await repo.commit('add the icon')

  await repo.write('src/types.ts', 'export interface User { id: string, name: string }\n')
  await repo.write('pnpm-lock.yaml', LOCKFILE_AFTER)
  await repo.writeBytes('res/icon.png', pngBytes(11))
  return repo
}

describe('binary and generated files in the diff', () => {
  it('gives a binary file a visible skipped stub instead of dropping it', async () => {
    const repo = await mixedMediaRepo()
    const harness = await bootstrap(repo.root)
    const model = await startReview(harness, { kind: 'workingTree' })

    const icon = model.diff.files.find(file => file.path === 'res/icon.png')
    expect(icon?.isBinary).toBe(true)
    expect(icon?.groups).toEqual([])

    const stub = model.guide.steps.find(step => step.path === 'res/icon.png')
    expect(stub?.kind).toBe('stub')
    expect(stub?.rationale).toBe('Skipped: binary file')

    // Honest `k/n`: the stub is counted, so the reader is never told there are
    // eight steps and shown seven.
    expect(peek(model.progress).total).toBe(model.guide.steps.length)
    expect(model.guide.steps.filter(step => step.kind === 'stub')).toHaveLength(1)
  })

  it('keeps the ordering intact around it — foundation first, generated last', async () => {
    const repo = await mixedMediaRepo()
    const harness = await bootstrap(repo.root)
    const model = await startReview(harness, { kind: 'workingTree' })

    const order = model.guide.steps.map(step => step.path)
    expect(order[0]).toBe('src/types.ts')
    expect(order.indexOf('src/types.ts')).toBeLessThan(order.indexOf('pnpm-lock.yaml'))
    expect(order.indexOf('src/types.ts')).toBeLessThan(order.indexOf('res/icon.png'))

    // A lockfile is generated but not empty, so it keeps real steps — demoted,
    // not skipped. Only the binary file has nothing to reveal.
    expect(model.guide.steps.filter(step => step.path === 'pnpm-lock.yaml').every(step => step.kind === 'reveal')).toBe(true)

    // Invariant I1 still holds with a stub in the list.
    const inDiff = model.diff.files.flatMap(file => file.groups.map(group => group.id)).sort()
    const inSteps = model.guide.steps.flatMap(step => step.groups.map(group => group.id)).sort()
    expect(inSteps).toEqual(inDiff)
  })

  it('renders the stub as its own document rather than a blank editor', async () => {
    const repo = await mixedMediaRepo()
    const harness = await bootstrap(repo.root, true)
    const model = await startReview(harness, { kind: 'workingTree' })

    const index = model.guide.steps.findIndex(step => step.path === 'res/icon.png')
    expect(index).toBeGreaterThanOrEqual(0)
    model.jumpTo(index)

    const view: ReviewViewModel = await vi.waitFor(() => {
      const current = peek(reviewViewModel)
      if (current === null || current.step?.path !== 'res/icon.png')
        throw new Error('the stub step is not projected yet')
      return current
    }, { timeout: 10_000, interval: 5 })

    expect(view.revealText).toBe('res/icon.png\n\nSkipped: binary file\n')
    expect(view.baseText).toBe('')
    expect(view.ranges).toEqual([])
    expect(view.pendingRanges).toEqual([])
  })

  it('walks the whole change end to end, stub included, and restores', async () => {
    const repo = await mixedMediaRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo.root, true)
    const model = await startReview(harness, { kind: 'workingTree' })

    let presses = 0
    while (model.next()) presses++
    expect(presses).toBe(model.guide.steps.length - 1)
    expect(peek(model.isComplete)).toBe(true)
    expect(model.next()).toBe(false)

    await cancelSession('finish')

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(await listGuideRefs(repo.root)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Shallow clone with missing objects
// ---------------------------------------------------------------------------

async function deepRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({ files: { 'src/app.ts': 'export const version = 1\n' } })
  for (const version of [2, 3]) {
    await repo.write('src/app.ts', `export const version = ${version}\n`)
    await repo.git('add', '-A')
    await repo.commit(`bump to ${version}`)
  }
  return repo
}

describe('shallow clone with missing objects', () => {
  it('is usable, and says so — the probe reports shallow rather than failing', async () => {
    const clone = await makeShallowClone(await deepRepo())

    expect(await probeGit(clone.root)).toMatchObject({ ok: true, shallow: true })
    expect(await clone.git('rev-list', '--count', 'HEAD')).toContain('1')
  })

  it('refuses a commit review whose parent was never fetched, with a fetch hint', async () => {
    const clone = await makeShallowClone(await deepRepo())

    // The plan is the stat-only pass, so the refusal happens before the
    // pre-flight is even shown.
    const failure = await planIsolation(clone.root, { entry: { kind: 'commit', rev: 'HEAD' }, includeUntracked: true })
      .then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(MissingObjectsError)
    expect(describeStartFailure(failure)).toContain('git fetch --unshallow')
  })

  // The bug this fixture exists to prevent: `rev-parse HEAD^1` fails at a
  // shallow boundary exactly as it does on a root commit, so the empty-tree
  // fallback would have shown the entire repository as freshly added.
  it('does not mistake the boundary commit for a root commit', async () => {
    const clone = await makeShallowClone(await deepRepo())
    const harness = await bootstrap(clone.root)
    const before = await clone.fingerprint()

    await expect(startReview(harness, { kind: 'commit', rev: 'HEAD' })).rejects.toBeInstanceOf(MissingObjectsError)

    expect(peek(session)).toBeNull()
    expect(peek(sessionStatus)).toBe('idle')
    expect(await clone.fingerprint()).toEqual(before)
    expect(await listGuideRefs(clone.root)).toEqual([])
    expect(harness.notifications.at(-1)?.message).toContain('shallow')
  })

  it('still reviews the working tree, which needs no history at all', async () => {
    const clone = await makeShallowClone(await deepRepo())
    await clone.write('src/app.ts', 'export const version = 4\n')

    const harness = await bootstrap(clone.root)
    const model = await startReview(harness, { kind: 'workingTree' })

    expect(model.diff.files.map(file => file.path)).toEqual(['src/app.ts'])
    expect(model.guide.steps.length).toBeGreaterThan(0)
  })

  it('refuses a range whose merge base is outside the clone', async () => {
    // `feature` branches off before the tip of `main`, so their common ancestor
    // is in neither depth-1 fetch and `git merge-base` has nothing to answer.
    const source = await deepRepo()
    await source.git('checkout', '-q', '-b', 'feature', 'main~1')
    await source.write('src/feature.ts', 'export const feature = 1\n')
    await source.git('add', '-A')
    await source.commit('feature work')
    await source.git('checkout', '-q', 'main')
    await source.write('src/app.ts', 'export const version = 4\n')
    await source.git('add', '-A')
    await source.commit('bump to 4')

    const clone = await makeShallowClone(source)
    await clone.git('fetch', '--quiet', '--depth', '1', 'origin', 'feature')

    await expect(
      planIsolation(clone.root, { entry: { kind: 'range', from: 'FETCH_HEAD', to: 'HEAD' }, includeUntracked: true }),
    ).rejects.toBeInstanceOf(MissingObjectsError)
  })
})

// ---------------------------------------------------------------------------
// No repository, no git
// ---------------------------------------------------------------------------

describe('git unusable', () => {
  it('disables Start with the reason, on a folder that is not a repository', async () => {
    const plain = await makeTempDir()
    const harness = await bootstrap(plain)

    expect(peek(canStart)).toBe(false)
    expect(peek(startBlockedReason)).toContain('not inside a git repository')
    // The hint is part of the reason, so the palette tooltip says what to do.
    expect(peek(startBlockedReason)).toContain('git init')

    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toBeInstanceOf(GitUnavailableError)
    expect(peek(sessionStatus)).toBe('idle')
  })

  it('says "open a folder" rather than "not a repository" with no workspace', async () => {
    const harness = await bootstrap(await makeTempDir())
    const { workspaceRoot } = await import('../../src/model/session')
    workspaceRoot.set(null)

    await vi.waitFor(() => {
      expect(peek(startBlockedReason)).toContain('Open a folder')
    }, { timeout: 5_000, interval: 5 })
    expect(peek(canStart)).toBe(false)
    expect(harness.notifications).toEqual([])
  })

  it('refuses a repository with no commits, before anything is asked of the user', async () => {
    const unborn = await makeTempRepo({ files: {}, initialCommit: false })
    const harness = await bootstrap(unborn.root)

    expect(peek(canStart)).toBe(false)
    expect(peek(startBlockedReason)).toContain('no commits yet')
    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toBeInstanceOf(GitUnavailableError)
  })
})
