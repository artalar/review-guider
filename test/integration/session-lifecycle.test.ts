import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { afterRefName, resolveRef } from '../../src/git/refs'
import {
  advanceSession,
  cancelSession,
  canStart,
  editHere,
  EmptyDiffError,
  GitUnavailableError,
  isolation,
  ports,
  session,
  SessionAlreadyActiveError,
  sessionStatus,
  startBlockedReason,
  startSession,
} from '../../src/model/session'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempDir, makeTempRepo } from '../helpers/tmp-repo'

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

describe('session lifecycle', () => {
  it('starts a working-tree review without cleaning the disk', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)

    expect(peek(canStart)).toBe(true)
    expect(peek(startBlockedReason)).toBeNull()

    await startReview(harness, { kind: 'workingTree' })

    expect(peek(sessionStatus)).toBe('active')
    expect(peek(session)).not.toBeNull()
    expect(await repo.fingerprint()).toEqual(before)
    expect((await repo.git('stash', 'list')).trim()).toBe('')
    expect(await resolveRef(repo.root, afterRefName('entry-session'))).not.toBeNull()
    expect(harness.saveDocumentsCalls.length).toBeGreaterThan(0)

    await cancelSession('finish')
    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(isolation)).toBeNull()
    expect(await resolveRef(repo.root, afterRefName('entry-session'))).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)
    expect(harness.notifications.at(-1)?.message).toContain('finished')
    harness.dispose()
  })

  it('finishes the walk when next is requested on the last step', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrapModel(repo.root)
    const model = await startReview(harness, { kind: 'workingTree' })
    model.jumpTo(model.guide.steps.length - 1)
    expect(peek(model.isComplete)).toBe(true)
    await advanceSession()
    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.at(-1)?.message).toContain('finished')
    harness.dispose()
  })

  it('opens the workspace file for a commit review', async () => {
    const repo = await makeTempRepo({ files: { 'src/app.ts': 'export const n = 1\n' } })
    await repo.write('src/app.ts', 'export const n = 2\n')
    await repo.git('add', '-A')
    await repo.commit('change app')
    const harness = await bootstrapModel(repo.root)
    await startReview(harness, { kind: 'commit', rev: 'HEAD' })
    await editHere()
    expect(harness.openedAt.some(entry => entry.path === 'src/app.ts')).toBe(true)
    harness.dispose()
  })

  it('treats cancel like finish for the after-ref', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)

    await startReview(harness, { kind: 'workingTree' })
    await cancelSession('cancel')

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect((await repo.git('stash', 'list')).trim()).toBe('')
    expect(harness.notifications.at(-1)?.message).toContain('cancelled')
    harness.dispose()
  })

  it('does not write an after-ref for a commit review', async () => {
    const repo = await makeTempRepo({ files: { 'src/app.ts': 'export const n = 1\n' } })
    await repo.write('src/app.ts', 'export const n = 2\n')
    await repo.git('add', '-A')
    await repo.commit('bump')
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)

    await startReview(harness, { kind: 'commit', rev: 'HEAD' })
    expect(peek(isolation)?.afterRef).toBeNull()
    expect(await resolveRef(repo.root, afterRefName('entry-session'))).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)

    await cancelSession('cancel')
    expect(await repo.fingerprint()).toEqual(before)
    harness.dispose()
  })

  it('saves dirty buffers before snapshotting the working tree', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrapModel(repo.root)
    harness.saveDocumentsResult = { ok: false, path: 'a.txt' }

    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toBeDefined()
    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(entry => entry.message.includes('a.txt'))).toBe(true)
    harness.dispose()
  })

  it('cancels a start that is still saving', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)
    const current = peek(ports)
    ports.set({
      ui: {
        ...current.ui,
        saveDocuments: async () => {
          await new Promise<void>(resolve => setTimeout(resolve, 80))
          return { ok: true as const }
        },
      },
      clock: current.clock,
    })

    const running = startSession({ entry: { kind: 'workingTree' } })
    await cancelSession('cancel')
    await expect(running).rejects.toBeDefined()

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    harness.dispose()
  })

  it('refuses a second start in the same window', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrapModel(repo.root)
    await startReview(harness, { kind: 'workingTree' })
    await expect(startSession({ entry: { kind: 'workingTree' } })).rejects.toBeInstanceOf(SessionAlreadyActiveError)
    harness.dispose()
  })

  it('refuses to start outside a repository', async () => {
    const dir = await makeTempDir()
    const harness = await bootstrapModel(dir)
    expect(peek(canStart)).toBe(false)
    await expect(startSession({ entry: { kind: 'workingTree' } })).rejects.toBeInstanceOf(GitUnavailableError)
    harness.dispose()
  })

  it('refuses an empty working tree', async () => {
    const repo = await makeTempRepo()
    const harness = await bootstrapModel(repo.root)
    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toBeInstanceOf(EmptyDiffError)
    expect(peek(sessionStatus)).toBe('idle')
    harness.dispose()
  })
})
