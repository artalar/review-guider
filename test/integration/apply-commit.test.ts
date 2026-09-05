import { context, peek } from '@reatom/core'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isRecoverable } from '../../src/git/journal'
import { afterRefName, appliedRefName, backupRefName, resolveRef } from '../../src/git/refs'
import {
  cancelSession,
  canStart,
  cleanupBackups,
  finishSession,
  isolation,
  recoveryPending,
  recoveryToken,
  session,
  sessionStatus,
} from '../../src/model/session'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

beforeEach(() => context.reset())

afterAll(cleanupTempRepos)

describe('commit apply lifecycle', () => {
  it('checks out base, applies a step, and Cancel restores byte-identical WIP', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')
      await repo.write('wip.txt', 'keep me\n')
      const before = await repo.fingerprint()

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })

      expect(model.mode).toBe('apply')
      expect(peek(sessionStatus)).toBe('active')
      // startSession already advanced the first step.
      expect(model.appliedIndex()).toBeGreaterThanOrEqual(0)
      expect(await resolveRef(repo.root, appliedRefName(model.id))).not.toBeNull()
      expect(await repo.read('src/hello.ts')).toContain('world')

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')

      expect(peek(sessionStatus)).toBe('idle')
      expect(peek(session)).toBeNull()
      expect(peek(isolation)).toBeNull()
      expect(await repo.fingerprint()).toEqual(before)

      harness.dispose()
    })
  })

  it('keeps the applied tree on finish, journals done-kept, and does not stash-restore', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')
      await repo.write('wip.txt', 'pre-session orphan\n')
      const before = await repo.fingerprint()

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true
      harness.answer = 'Open Source Control'

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })
      const sessionId = model.id

      while (!model.isComplete()) {
        const moved = await model.next()
        if (!moved)
          break
      }

      expect(await repo.read('src/hello.ts')).toContain('world')
      expect(await repo.exists('wip.txt')).toBe(false)

      await finishSession()
      await recoveryToken()

      expect(peek(sessionStatus)).toBe('idle')
      expect(peek(session)).toBeNull()
      expect(peek(isolation)).toBeNull()
      expect(peek(recoveryPending)).toBe(false)
      expect(peek(canStart)).toBe(true)
      expect(harness.scmOpened).toBe(1)

      expect(await repo.read('src/hello.ts')).toContain('world')
      expect(await repo.exists('wip.txt')).toBe(false)
      expect(await repo.fingerprint()).not.toEqual(before)
      expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')

      const token = await harness.store.readToken(repo.root)
      expect(token?.stage).toBe('done-kept')
      expect(isRecoverable(token)).toBe(false)
      expect(await resolveRef(repo.root, afterRefName(sessionId))).not.toBeNull()
      expect(await resolveRef(repo.root, backupRefName(sessionId))).not.toBeNull()
      expect(await resolveRef(repo.root, appliedRefName(sessionId))).not.toBeNull()
      expect(await resolveRef(repo.root, 'refs/tabthrough/lock')).toBeNull()

      const keptMessage = harness.notifications.find(entry =>
        entry.message.includes('kept in the working tree'))
      expect(keptMessage).toBeDefined()
      expect(keptMessage?.message).not.toMatch(/working tree is back/i)
      expect(keptMessage?.message).toMatch(/git stash apply/)
      expect(keptMessage?.level).toBe('info')

      harness.answer = 'Remove backups'
      const removed = await cleanupBackups()
      expect(removed.length).toBeGreaterThan(0)
      expect(await harness.store.readToken(repo.root)).toBeNull()
      expect(await resolveRef(repo.root, afterRefName(sessionId))).toBeNull()
      expect(await resolveRef(repo.root, backupRefName(sessionId))).toBeNull()
      expect(await resolveRef(repo.root, appliedRefName(sessionId))).toBeNull()

      harness.dispose()
    })
  })

  it('stays detached on finish when carry checkout cannot return to the branch', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })
      expect(await repo.read('src/hello.ts')).toContain('world')

      // Detached review: renaming the branch makes carry-checkout fail without `-f`.
      await repo.git('branch', '-m', 'main', 'elsewhere')

      await finishSession()

      expect(peek(sessionStatus)).toBe('idle')
      expect(await repo.read('src/hello.ts')).toContain('world')
      expect((await repo.tryGit('symbolic-ref', '--quiet', 'HEAD')).code).not.toBe(0)
      expect((await harness.store.readToken(repo.root))?.stage).toBe('done-kept')
      expect(await resolveRef(repo.root, afterRefName(model.id))).not.toBeNull()
      expect(await resolveRef(repo.root, appliedRefName(model.id))).not.toBeNull()

      const warn = harness.notifications.find(entry =>
        entry.level === 'warn' && entry.message.includes('keeping your changes'))
      expect(warn).toBeDefined()

      harness.dispose()
    })
  })

  it('keeps Cancel reachable after an apply throw wedges status at applying (B2)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')
      await repo.write('scratch.txt', 'pre-session\n')
      const before = await repo.fingerprint()

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })

      // Simulate an exception path that left status at `applying` without
      // `applyPending` — Cancel must still restore (review 002 B2).
      sessionStatus.to('applying')
      expect(peek(sessionStatus)).toBe('applying')
      expect(model.applyPending()).toBe(false)

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')

      expect(peek(sessionStatus)).toBe('idle')
      expect(await repo.fingerprint()).toEqual(before)
      harness.dispose()
    })
  })

  it('stays active on conflict so Tab can retry after markers are cleared (B3)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: {
          'src/types.ts': 'export type Id = string\n',
          'src/service.ts': 'export const n = 1\n',
        },
      })
      await repo.write('src/types.ts', 'export type Id = string\nexport type Name = string\n')
      await repo.write('src/service.ts', 'export const n = 1\nexport const m = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('two files')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })

      expect(model.appliedIndex()).toBeGreaterThanOrEqual(0)
      const nextPath = model.nextStep()?.path
      expect(nextPath).toBeDefined()
      await repo.write(nextPath!, 'export const BOOM = true\n')

      const moved = await model.next()
      expect(moved).toBe(false)
      expect(peek(sessionStatus)).toBe('active')

      const note = harness.notifications.find(entry =>
        /conflict/i.test(entry.message))
      expect(note).toBeDefined()
      expect(note?.message).toMatch(/press Tab|Resolve conflict markers/i)

      const again = await model.next()
      expect(again).toBe(false)
      expect(peek(sessionStatus)).toBe('active')
      expect(harness.notifications.some(entry =>
        entry.message.includes('Resolve conflict markers'))).toBe(true)

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')
      expect(peek(sessionStatus)).toBe('idle')
      harness.dispose()
    })
  })

  it('deletes appliedRef on verified Cancel (M4)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true
      harness.answer = 'Cancel and restore'

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })
      const sessionId = model.id
      expect(await resolveRef(repo.root, appliedRefName(sessionId))).not.toBeNull()

      await cancelSession('cancel')

      expect(await resolveRef(repo.root, appliedRefName(sessionId))).toBeNull()
      expect(await resolveRef(repo.root, afterRefName(sessionId))).toBeNull()
      const leftover = (await repo.git('for-each-ref', 'refs/tabthrough')).trim()
      expect(leftover).toBe('')
      expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')
      harness.dispose()
    })
  })

  it('refuses Finish while conflict markers remain (review 003 B1)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: {
          'src/types.ts': 'export type Id = string\n',
          'src/service.ts': 'export const n = 1\n',
        },
      })
      await repo.write('src/types.ts', 'export type Id = string\nexport type Name = string\n')
      await repo.write('src/service.ts', 'export const n = 1\nexport const m = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('two files')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })

      const nextPath = model.nextStep()?.path
      expect(nextPath).toBeDefined()
      await repo.write(nextPath!, 'export const BOOM = true\n')
      expect(await model.next()).toBe(false)
      expect(model.canAdvance()).toBe(true)
      expect(await repo.read(nextPath!)).toContain('<<<<<<<')

      await finishSession()

      expect(peek(sessionStatus)).toBe('active')
      expect(peek(session)).not.toBeNull()
      expect(harness.notifications.some(entry =>
        /Resolve conflict markers.*before finishing/i.test(entry.message))).toBe(true)
      expect((await harness.store.readToken(repo.root))?.stage).toBe('reviewing')

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')
      harness.dispose()
    })
  })

  it('does not restore apply mode on deactivate (review 003 B2)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      const model = await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })
      await repo.write('MY-NOTES.md', 'keep me across reload\n')

      await cancelSession('deactivate')

      expect(peek(sessionStatus)).toBe('active')
      expect(peek(session)).not.toBeNull()
      expect(await repo.exists('MY-NOTES.md')).toBe(true)
      expect(await repo.read('MY-NOTES.md')).toBe('keep me across reload\n')
      expect((await harness.store.readToken(repo.root))?.stage).toBe('reviewing')
      expect(await resolveRef(repo.root, appliedRefName(model.id))).not.toBeNull()
      expect(harness.notifications.some(entry =>
        entry.message.includes('shutting down'))).toBe(false)

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')
      harness.dispose()
    })
  })

  it('keeps mid-walk user files on Cancel (review 003 M1 / 004)', async () => {
    await context.start(async () => {
      const repo = await makeTempRepo({
        files: { 'src/hello.ts': 'export const hello = 1\n' },
      })
      await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
      await repo.git('add', '-A')
      const commit = await repo.commit('add world')
      await repo.write('scratch.txt', 'pre-session\n')
      const beforeHello = await repo.read('src/hello.ts')

      const harness = await bootstrapModel(repo.root, { withReview: true })
      harness.approve = true

      await startReview(harness, {
        entry: { kind: 'commit', rev: commit },
        sessionMode: 'apply',
      })
      await repo.write('MY-NOTES.md', 'authored during the walk\n')

      harness.answer = 'Cancel and restore'
      await cancelSession('cancel')

      // Never classified as mid-walk junk. Extra files may leave restore
      // `blocked` after verify — stop-and-explain beats delete (003 M1).
      expect(await repo.exists('MY-NOTES.md')).toBe(true)
      expect(await repo.read('MY-NOTES.md')).toBe('authored during the walk\n')
      expect(await repo.read('scratch.txt')).toBe('pre-session\n')
      expect(await repo.read('src/hello.ts')).toBe(beforeHello)
      expect((await repo.git('rev-parse', '--abbrev-ref', 'HEAD')).trim()).toBe('main')
      expect(['idle', 'blocked']).toContain(peek(sessionStatus))

      harness.dispose()
    })
  })
})
