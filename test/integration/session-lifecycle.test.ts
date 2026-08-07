import type { NotifyLevel, Ports, StorePort } from '../../src/model/ports'
import type { TmpRepo } from '../helpers/tmp-repo'
import { join } from 'node:path'
import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listGuideRefs, RepoLockedError } from '../../src/git/isolate'
import { readStatus } from '../../src/git/probe'
import { backupRefName, LOCK_REF, readLock, resolveRef, writeRef } from '../../src/git/refs'
import { listStash } from '../../src/git/stash'
import { memoryStore } from '../../src/model/ports'
import {
  cancelSession,
  canStart,
  cleanupBackups,
  discardRecovery,
  EmptyDiffError,
  gitCapability,
  isolation,
  ports,
  preflightAnswer,
  preflightRequest,
  recoverBackup,
  recoveryPending,
  recoveryToken,
  restoreBlock,
  session,
  SessionAlreadyActiveError,
  sessionStatus,
  startBlockedReason,
  startSession,
  workspaceRoot,
} from '../../src/model/session'
import { isolateUpTo } from '../helpers/protocol'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

/**
 * The model driving the real protocol (plan P0-5 / P0-6 / P0-7).
 *
 * The suites above prove `src/git` restores correctly. This one proves the
 * Reatom lifecycle reaches it on every exit path, and that the gating atoms the
 * bridge renders agree with what actually happened on disk.
 */

const subscriptions: Array<() => void> = []

beforeEach(() => context.reset())

afterEach(() => {
  while (subscriptions.length > 0)
    subscriptions.pop()?.()
})

afterAll(cleanupTempRepos)

interface Notification {
  readonly level: NotifyLevel
  readonly message: string
}

interface Harness {
  readonly store: StorePort
  readonly notifications: Notification[]
  /** Answers the pre-flight the way `src/ui/prompts.ts` does. */
  approve: boolean
  /** Which action button a notification comes back with, if any. */
  answer: string | undefined
}

function install(store: StorePort = memoryStore()): Harness {
  const harness: Harness = { store, notifications: [], approve: true, answer: undefined }
  const installed: Ports = {
    store,
    ui: {
      confirm: async () => harness.approve,
      notify: async (level, message) => {
        harness.notifications.push({ level, message })
        return harness.answer
      },
      openReview: async () => {},
    },
    clock: {
      now: () => 1_000,
      sessionId: () => 'model-session',
    },
  }
  ports.set(installed)
  return harness
}

async function bootstrap(repo: TmpRepo, store?: StorePort): Promise<Harness> {
  return await bootstrapAt(repo.root, store)
}

async function bootstrapAt(root: string, store?: StorePort): Promise<Harness> {
  const harness = install(store)
  workspaceRoot.set(root)

  // The gating computeds are async and only refresh while something is
  // listening, so the harness connects them exactly as `useGuideContextKeys`
  // does. Without this the test would assert against a never-updated cache.
  subscriptions.push(canStart.subscribe(() => {}), recoveryPending.subscribe(() => {}))

  await gitCapability()
  await recoveryToken()
  return harness
}

/**
 * Starts a session and plays the bridge's part in the pre-flight handshake:
 * the model publishes a request, the bridge answers it.
 */
async function start(harness: Harness): Promise<void> {
  const running = startSession({ entry: { kind: 'workingTree' } })
  const settled = running.then(() => undefined, () => undefined)

  await Promise.race([
    settled,
    vi.waitFor(() => {
      if (peek(preflightRequest) === null)
        throw new Error('pre-flight not published yet')
    }, { timeout: 5_000, interval: 5 }),
  ])

  if (peek(preflightRequest) !== null)
    preflightAnswer(harness.approve)

  await running
}

async function dirtyRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({ files: { 'a.txt': 'one\n', 'b.txt': 'keep\n' } })
  await repo.write('a.txt', 'edited\n')
  await repo.write('new.txt', 'fresh\n')
  return repo
}

describe('session lifecycle over the real protocol', () => {
  it('isolates the tree on start and restores it on finish', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    expect(peek(canStart)).toBe(true)
    expect(peek(startBlockedReason)).toBeNull()

    await start(harness)

    expect(peek(sessionStatus)).toBe('active')
    expect(peek(preflightRequest)).toBeNull()
    expect((await readStatus(repo.root)).clean).toBe(true)
    expect(await readLock(repo.root)).not.toBeNull()
    expect(await harness.store.readToken(repo.root)).not.toBeNull()

    // One step per changed file here: an edited tracked file and an untracked one.
    const model = peek(session)
    expect(model).not.toBeNull()
    expect(peek(model!.progress)).toEqual({ index: 1, total: 2 })

    await cancelSession('finish')

    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(session)).toBeNull()
    expect(peek(isolation)).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)
    expect(await harness.store.readToken(repo.root)).toBeNull()
    expect(await listGuideRefs(repo.root)).toEqual([])
    expect(await readLock(repo.root)).toBeNull()
  })

  it('treats cancel exactly like finish', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await start(harness)
    await cancelSession('cancel')

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(await listStash(repo.root)).toEqual([])
    expect(harness.notifications.at(-1)?.message).toContain('cancelled')
  })

  it('restores on the deactivate path too', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await start(harness)
    await cancelSession('deactivate')

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('mutates nothing when the pre-flight is declined', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)
    harness.approve = false

    await expect(start(harness)).rejects.toThrow()

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(await listGuideRefs(repo.root)).toEqual([])
    expect(await readLock(repo.root)).toBeNull()
    expect(await harness.store.readToken(repo.root)).toBeNull()
    // Declining is a choice, not a failure: no error toast.
    expect(harness.notifications).toEqual([])
  })

  it('refuses to start on an empty diff', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    const harness = await bootstrap(repo)

    await expect(start(harness)).rejects.toBeInstanceOf(EmptyDiffError)

    expect(peek(sessionStatus)).toBe('idle')
    expect(await readLock(repo.root)).toBeNull()
    expect(harness.notifications.at(-1)?.level).toBe('error')
  })

  it('refuses a second start in the same window', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrap(repo)
    await start(harness)

    await expect(startSession({ entry: { kind: 'workingTree' } })).rejects.toBeInstanceOf(SessionAlreadyActiveError)

    expect(peek(sessionStatus)).toBe('active')
    await cancelSession('cancel')
  })

  it('refuses before the pre-flight when another window holds the lock', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await writeRef(repo.root, LOCK_REF, await repo.head())

    // Refused up front rather than after the user approves a stash that could
    // never have happened.
    await expect(startSession({ entry: { kind: 'workingTree' } })).rejects.toBeInstanceOf(RepoLockedError)

    expect(peek(preflightRequest)).toBeNull()
    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(harness.notifications.at(-1)?.message).toContain('Another window')
  })

})

describe('recovery', () => {
  it('blocks Start and offers a restore when a previous session left a token', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()

    const { store } = await isolateUpTo(repo, 'reviewing', { sessionId: 'ghost' })
    await bootstrap(repo, store)

    expect(peek(recoveryPending)).toBe(true)
    expect(peek(canStart)).toBe(false)
    expect(peek(startBlockedReason)).toContain('restore')

    const outcome = await recoverBackup()
    expect(outcome?.kind).toBe('restored')

    expect(await repo.fingerprint()).toEqual(before)
    await recoveryToken()
    expect(peek(recoveryPending)).toBe(false)
    expect(peek(canStart)).toBe(true)
    expect(await readLock(repo.root)).toBeNull()
  })

  it('finds the token when the workspace folder is a subdirectory of the repo', async () => {
    const repo = await makeTempRepo({ files: { 'packages/app/index.ts': 'export const app = 1\n' } })
    await repo.write('packages/app/index.ts', 'export const app = 2\n')
    const before = await repo.fingerprint()

    const { store } = await isolateUpTo(repo, 'reviewing', { sessionId: 'nested' })

    // The token is keyed on the repository root; the folder VS Code opened is
    // two levels below it.
    await bootstrapAt(join(repo.root, 'packages', 'app'), store)

    expect(peek(recoveryPending)).toBe(true)
    expect((await recoverBackup())?.kind).toBe('restored')
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('reports a blocked restore instead of pretending it worked', async () => {
    const repo = await dirtyRepo()
    const { store } = await isolateUpTo(repo, 'reviewing', { sessionId: 'stuck' })
    const harness = await bootstrap(repo, store)

    // Interference the recovery cannot reconcile.
    await repo.write('a.txt', 'someone else was here\n')

    const outcome = await recoverBackup()
    expect(outcome?.kind).toBe('blocked')
    expect(peek(restoreBlock)?.kind).toBe('blocked')
    expect(harness.notifications.at(-1)?.level).toBe('warn')
    expect(harness.notifications.at(-1)?.message).toContain('Nothing was discarded')

    // Everything is still on disk for the user to finish by hand.
    expect(await listStash(repo.root)).toHaveLength(1)
    expect(await resolveRef(repo.root, backupRefName('stuck'))).not.toBeNull()
    expect(await store.readToken(repo.root)).not.toBeNull()
  })

  /**
   * The state machine has to come home, not just the files. A restore that
   * verifies leaves `blocked` behind; if it did not, `canStart` would stay
   * false for the rest of the window and only a reload would clear it.
   */
  it('returns a blocked session to idle once the restore finally verifies', async () => {
    const repo = await dirtyRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await start(harness)

    // Interference the teardown cannot reconcile: the tree will not match the
    // capture however the stash is applied.
    await repo.write('interference.txt', 'not ours\n')
    await cancelSession('cancel')

    expect(peek(sessionStatus)).toBe('blocked')
    expect(peek(restoreBlock)?.kind).toBe('blocked')
    expect(peek(canStart)).toBe(false)
    expect(peek(isolation)).not.toBeNull()

    await repo.remove('interference.txt')
    expect((await recoverBackup())?.kind).toBe('restored')

    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(session)).toBeNull()
    expect(peek(isolation)).toBeNull()
    expect(peek(restoreBlock)).toBeNull()
    expect(await repo.fingerprint()).toEqual(before)

    await recoveryToken()
    expect(peek(canStart)).toBe(true)
  })

  /**
   * The escape hatch of last resort: a restore that can never be made to
   * verify would otherwise pin `recoveryPending` forever. Forgetting it keeps
   * every artifact in git and only stops this window waiting on them.
   */
  it('lets the user forget a restore that cannot be completed', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrap(repo)

    await start(harness)
    await repo.write('interference.txt', 'not ours\n')
    await cancelSession('cancel')
    expect(peek(sessionStatus)).toBe('blocked')

    harness.answer = 'Forget'
    expect(await discardRecovery()).toBe(true)

    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(isolation)).toBeNull()
    await recoveryToken()
    expect(peek(recoveryPending)).toBe(false)
    expect(peek(canStart)).toBe(true)

    // Nothing was destroyed — the backup is still there to recover by hand.
    expect(await listStash(repo.root)).toHaveLength(1)
    expect(await resolveRef(repo.root, backupRefName('model-session'))).not.toBeNull()
  })

  it('cleans up orphan refs but never while a restore is pending', async () => {
    const repo = await dirtyRepo()
    const harness = await bootstrap(repo)

    const head = await repo.head()
    await writeRef(repo.root, backupRefName('orphan'), head)

    const removed = await cleanupBackups()
    expect(removed).toEqual([backupRefName('orphan')])
    expect(await listGuideRefs(repo.root)).toEqual([])
    expect(harness.notifications).toEqual([])
  })

  it('refuses cleanup while a token is outstanding', async () => {
    const repo = await dirtyRepo()
    const { store, token } = await isolateUpTo(repo, 'reviewing', { sessionId: 'pending' })
    await bootstrap(repo, store)

    await expect(cleanupBackups()).rejects.toThrow(/restore/i)
    expect(await resolveRef(repo.root, token.afterRef)).not.toBeNull()
  })
})
