import { context, peek } from '@reatom/core'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isolate, planIsolation } from '../../src/git/isolate'
import { readLock } from '../../src/git/refs'
import { memoryStore } from '../../src/model/ports'
import { cancelSession, finishSession, ports, sessionStatus, startSession } from '../../src/model/session'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

beforeEach(() => context.reset())
afterAll(cleanupTempRepos)

describe('release lifecycle regressions', () => {
  it('releases the repository lock when the first journal write fails', async () => {
    const repo = await makeTempRepo({ files: { 'a.ts': 'old\n' } })
    await repo.write('a.ts', 'new\n')
    const before = await repo.fingerprint()
    const plan = await planIsolation(repo.root, { entry: { kind: 'workingTree' }, includeUntracked: true, sessionMode: 'readonly' })
    const store = { ...memoryStore(), writeToken: async () => {
      throw new Error('storage unavailable')
    } }
    await expect(isolate({ repoRoot: repo.root, sessionId: 'failed-journal', plan, store, includeUntracked: true, sessionMode: 'readonly' })).rejects.toThrow('storage unavailable')
    expect(await readLock(repo.root)).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('cancels during preparation before the preflight listener exists', async () => {
    const repo = await makeTempRepo({ files: { 'a.ts': 'old\n' } })
    await repo.write('a.ts', 'new\n')
    const before = await repo.fingerprint()
    const harness = await bootstrapModel(repo.root)
    const running = startSession({ entry: { kind: 'workingTree' } })
    const rejected = running.then(() => false, () => true)
    expect(peek(sessionStatus)).toBe('preflight')
    await cancelSession()
    expect(await rejected).toBe(true)
    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    harness.dispose()
  })

  it('counts editor changes saved before the preflight plan', async () => {
    const repo = await makeTempRepo({ files: { 'a.ts': 'old\n' } })
    const harness = await bootstrapModel(repo.root)
    const installed = peek(ports)
    let saved = false
    ports.set({ ...installed, ui: { ...installed.ui, saveDocuments: async () => {
      if (!saved) {
        saved = true
        await repo.write('a.ts', 'new from buffer\n')
      }
      return { ok: true as const }
    } } })
    await startReview(harness, { kind: 'workingTree' })
    await finishSession()
    expect(await repo.read('a.ts')).toBe('new from buffer\n')
    harness.dispose()
  })

  it('reserves apply Finish while document saving is pending', async () => {
    const repo = await makeTempRepo({ files: { 'a.ts': 'old\n', 'b.ts': 'old\n' } })
    await repo.write('a.ts', 'new\n')
    await repo.write('b.ts', 'new\n')
    const harness = await bootstrapModel(repo.root)
    const model = await startReview(harness, { entry: { kind: 'workingTree' }, sessionMode: 'apply' })
    const installed = peek(ports)
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    ports.set({ ...installed, ui: { ...installed.ui, saveDocuments: async () => {
      await waiting
      return { ok: true as const }
    } } })
    const finishing = finishSession()
    await vi.waitFor(() => expect(peek(sessionStatus)).toBe('applying'))
    const cursor = model.cursor()
    expect(await model.next()).toBe(false)
    await cancelSession()
    expect(model.cursor()).toBe(cursor)
    release()
    await finishing
    expect(peek(sessionStatus)).toBe('idle')
    harness.dispose()
  })

  it('refuses an obsolete plan when a buffer becomes dirty during confirmation', async () => {
    const repo = await makeTempRepo({ files: { 'a.ts': 'old\n' } })
    await repo.write('a.ts', 'committed\n')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'change')
    const harness = await bootstrapModel(repo.root)
    const installed = peek(ports)
    let saves = 0
    ports.set({ ...installed, ui: { ...installed.ui, saveDocuments: async () => {
      saves += 1
      if (saves === 2)
        await repo.write('a.ts', 'new buffer during confirmation\n')
      return { ok: true as const }
    } } })
    await expect(startReview(harness, { kind: 'commit', rev: 'HEAD' })).rejects.toThrow('repository changed')
    await vi.waitFor(() => expect(peek(sessionStatus)).toBe('idle'))
    expect(await repo.read('a.ts')).toBe('new buffer during confirmation\n')
    expect(await readLock(repo.root)).toBeNull()
    expect(await harness.store.readToken(repo.root)).toBeNull()
    harness.dispose()
  })
})
