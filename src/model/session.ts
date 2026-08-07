import type { IsolationHandle, IsolationPlan, OrphanRef, RestoreOutcome } from '../git/isolate'
import type { SessionToken } from '../git/journal'
import type { GitCapability, RepoStatus } from '../git/probe'
import type { PreflightRequest, ReviewTarget } from '../git/types'
import type { GuideDiagnostic } from '../guide/types'
import type { Ports } from './ports'
import type { Session } from './steps'
import {
  abortVar,
  action,
  atom,
  computed,
  framePromise,
  isAbort,
  peek,
  take,
  throwAbort,
  withAbort,
  withAsync,
  withAsyncData,
  wrap,
} from '@reatom/core'
import {
  cleanupGuideRefs,
  isolate,
  IsolationBlockedError,
  listGuideRefs,
  MissingObjectsError,
  planIsolation,
  RepoLockedError,
  restoreFromToken,
} from '../git/isolate'
import { isRecoverable } from '../git/journal'
import { probeGit, readStatus } from '../git/probe'
import { readLock } from '../git/refs'
import { describeTarget } from '../git/types'
import { guideFile, heuristicOptions, stashIncludeUntracked } from './config'
import { guideSource } from './guide-source'
import { inertPorts } from './ports'
import { reatomSession } from './steps'

// Settings live in `./config` so `steps.ts` can read `revealMode` without a
// cycle; re-exported here because the bridge treats the model as one surface.
export { guideFile, heuristicOptions, revealMode, showRationale, stashIncludeUntracked } from './config'

/**
 * The single source of truth (architecture/reatom-model.md).
 *
 * No `vscode` import, no subprocess spawn: everything effectful crosses the
 * boundary through `src/git` or through the installed {@link Ports}.
 */

// ---------------------------------------------------------------------------
// Root atoms
// ---------------------------------------------------------------------------

/** Set by the bridge at activation. MVP: first workspace folder (P2: multi-root). */
export const workspaceRoot = atom<string | null>(null, 'workspaceRoot')

/** Injected VS Code capabilities. Tests substitute in-memory implementations. */
export const ports = atom<Ports>(inertPorts, 'ports')

/** Bumped by the bridge's FileSystemWatcher on `.git/**` and workspace writes. */
export const gitWatchToken = atom(0, 'git.watchToken')

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

const NO_WORKSPACE: GitCapability = {
  ok: false,
  reason: 'no-workspace',
  message: 'Open a folder to use Guide Reviewer.',
}

/**
 * Deliberately *not* a dependant of `gitWatchToken`: re-probing on every write
 * under `.git/` would spawn a probe storm during isolation, when the extension
 * is itself the one writing refs. The cost is that this value is only as fresh
 * as the last workspace change, so anything that gates a mutation probes again
 * for itself — see `startSession`.
 */
export const gitCapability = computed(async (): Promise<GitCapability | null> => {
  const root = workspaceRoot()
  if (root === null)
    return NO_WORKSPACE

  return await wrap(probeGit(root, { signal: abortVar.require().signal }))
}, 'git.capability').extend(withAsyncData({ initState: null }))

export const repoStatus = computed(async (): Promise<RepoStatus | null> => {
  // W5: hoist every reactive read above the first await, or the dependency is
  // never tracked and this computed silently stops refreshing.
  const capabilityPromise = gitCapability()
  gitWatchToken()

  const capability = await wrap(capabilityPromise)
  if (capability === null || !capability.ok)
    return null

  return await wrap(readStatus(capability.repoRoot, { signal: abortVar.require().signal }))
}, 'git.repoStatus').extend(withAsyncData({ initState: null }))

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export type SessionStatus
  /** No session; commands available. */
  = | 'idle'
  /** Summary shown, waiting for the user; nothing touched yet. */
    | 'preflight'
  /** Isolation in progress; the tree may be mid-change. */
    | 'stashing'
  /** Reviewing. */
    | 'active'
  /** Restore in flight. */
    | 'restoring'
  /** Restore could not be verified; everything preserved, the user must act. */
    | 'blocked'
  /** Start failed and was unwound. */
    | 'error'

export const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['preflight'],
  preflight: ['stashing', 'idle', 'error'],
  // `idle` is reachable because `isolate` unwinds itself on failure.
  stashing: ['active', 'restoring', 'idle', 'error'],
  active: ['restoring'],
  restoring: ['idle', 'blocked', 'error'],
  blocked: ['restoring', 'idle'],
  error: ['idle'],
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError'
  constructor(readonly from: SessionStatus, readonly to: SessionStatus) {
    super(`illegal session status transition ${from} -> ${to}`)
  }
}

export class SessionAlreadyActiveError extends Error {
  override readonly name = 'SessionAlreadyActiveError'
  constructor(readonly status: SessionStatus) {
    super(`A Guide Reviewer session is already ${status}.`)
  }
}

export class RecoveryPendingError extends Error {
  override readonly name = 'RecoveryPendingError'
  constructor() {
    super('Guide Reviewer has work to restore from a previous session. Restore it before starting a new review.')
  }
}

export class GitUnavailableError extends Error {
  override readonly name = 'GitUnavailableError'
  constructor(readonly capability: GitCapability | null) {
    super(capability !== null && !capability.ok ? capability.message : 'git is unavailable.')
  }
}

export type EmptyDiffReason = 'empty' | 'whitespace'

export class EmptyDiffError extends Error {
  override readonly name = 'EmptyDiffError'
  constructor(readonly entry: ReviewTarget, readonly reason: EmptyDiffReason = 'empty') {
    super(reason === 'whitespace'
      ? `Only whitespace changed in ${describeTarget(entry)} — there is nothing to review.`
      : `Nothing to review in ${describeTarget(entry)}.`)
  }
}

/** The only writer of session status. Illegal transitions throw, never silently apply. */
export const sessionStatus = atom<SessionStatus>('idle', 'session.status').extend(target => ({
  to: action((next: SessionStatus): SessionStatus => {
    const current = target()
    if (current === next)
      return current
    if (!LEGAL_TRANSITIONS[current].includes(next))
      throw new IllegalTransitionError(current, next)
    target.set(next)
    return next
  }, 'session.status.to'),
}))

export const isSessionActive = computed(() => sessionStatus() === 'active', 'session.isActive')

/**
 * Anything but `idle`. `isSessionActive` gates the reveal loop; this gates the
 * way *out* of a session, so Cancel stays reachable from `blocked`, `error`
 * and a pre-flight that never got answered — the states a user most needs an
 * exit from, and exactly the ones `active` excludes.
 */
export const isSessionOpen = computed(() => sessionStatus() !== 'idle', 'session.isOpen')

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export const session = atom<Session | null>(null, 'session')
/** Survives a failed start, so the unwind can still find what to undo. */
export const isolation = atom<IsolationHandle | null>(null, 'session.isolation')
export const guideDiagnostics = atom<readonly GuideDiagnostic[]>([], 'session.diagnostics')
export const restoreBlock = atom<RestoreOutcome | null>(null, 'session.restoreBlock')

export const preflightRequest = atom<PreflightRequest | null>(null, 'preflight.request')
export const preflightAnswer = action((approved: boolean) => approved, 'preflight.answer')

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export const recoveryEpoch = atom(0, 'recovery.epoch')

/**
 * Keyed on the *probed* repository root, never on the workspace folder. Open a
 * package inside a monorepo, or a path that reaches the repo through a symlink,
 * and the two differ — and a token written under one key and looked for under
 * the other means recovery silently never fires, which is the one failure this
 * whole subsystem exists to prevent.
 */
export const recoveryToken = computed(async (): Promise<SessionToken | null> => {
  const capabilityPromise = gitCapability()
  const store = ports().store
  recoveryEpoch()

  // Not gated on `capability.ok`. A repository that is mid-rebase, or whose
  // HEAD is unborn, is a repository Guide Reviewer will not *start* in — but it
  // may still be holding a stash of the user's work, and refusing to look would
  // hide exactly the thing this subsystem exists to surface.
  const root = capabilityRepoRoot(await wrap(capabilityPromise))
  if (root === null)
    return null

  return await wrap(store.readToken(root))
}, 'recovery.token').extend(withAsyncData({ initState: null }))

function capabilityRepoRoot(capability: GitCapability | null): string | null {
  if (capability === null)
    return null
  return capability.ok ? capability.repoRoot : capability.repoRoot ?? null
}

export const recoveryPending = computed(() => isRecoverable(recoveryToken.data()), 'recovery.pending')

export const orphanRefs = computed(async (): Promise<readonly OrphanRef[]> => {
  const capabilityPromise = gitCapability()
  recoveryEpoch()

  const capability = await wrap(capabilityPromise)
  if (capability === null || !capability.ok)
    return []

  return await wrap(listGuideRefs(capability.repoRoot, { signal: abortVar.require().signal }))
}, 'recovery.orphanRefs').extend(withAsyncData({ initState: [] as readonly OrphanRef[] }))

/**
 * Recovery for a session this window is not already driving: a live session
 * owns its own restore through `teardownSession`, and a restore already
 * draining must never be raced — two `git stash apply` runs against one entry
 * is the outcome the protocol cannot survive.
 */
export const recoverBackup = action(async (): Promise<RestoreOutcome | null> => {
  const entryStatus = peek(sessionStatus)
  if (entryStatus !== 'idle' && entryStatus !== 'blocked')
    return null

  const token = await wrap(recoveryToken())
  if (token === null)
    return null

  if (peek(sessionStatus) === 'blocked')
    sessionStatus.to('restoring')
  else if (peek(sessionStatus) !== 'idle')
    return null

  // No signal: an interrupted `git stash apply` is the one outcome we cannot survive.
  const outcome = await wrap(restoreFromToken({ token, store: peek(ports).store }))
  recoveryEpoch.set(value => value + 1)

  if (outcome.kind === 'restored') {
    // The machine has to come home too. Leaving it `blocked` after a restore
    // that actually worked keeps Start disabled until the window is reloaded.
    isolation.set(null)
    session.set(null)
    restoreBlock.set(null)
    if (peek(sessionStatus) !== 'idle')
      sessionStatus.to('idle')
    await wrap(peek(ports).ui.notify('info', 'Guide Reviewer restored your work from the backup.'))
  }
  else {
    restoreBlock.set(outcome)
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
    await wrap(peek(ports).ui.notify('warn', describeBlocked(outcome)))
  }
  return outcome
}, 'recovery.restore').extend(withAsync({ status: true }), withAbort('first-in-win'))

/** Forgets the reminder. Never destroys a backup — that is a separate command. */
export const discardRecovery = action(async (): Promise<boolean> => {
  const token = await wrap(recoveryToken())
  if (token === null)
    return false

  const confirmed = await wrap(peek(ports).ui.notify(
    'warn',
    'Forget the pending Guide Reviewer restore? The stash entry and backup refs stay in git.',
    ['Forget'],
  ))
  if (confirmed !== 'Forget')
    return false

  await wrap(peek(ports).store.clearToken(token.repoRoot))
  recoveryEpoch.set(value => value + 1)

  // Forgetting the reminder releases the machine as well. The stash entry and
  // the refs stay in git; this window simply stops waiting on them, which is
  // the only escape from a restore that can never be made to verify.
  if (peek(sessionStatus) === 'blocked') {
    isolation.set(null)
    session.set(null)
    restoreBlock.set(null)
    sessionStatus.to('idle')
  }
  return true
}, 'recovery.discard').extend(withAsync())

export const cleanupBackups = action(async (): Promise<readonly string[]> => {
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok)
    throw new GitUnavailableError(capability)
  if (peek(recoveryPending))
    throw new RecoveryPendingError()

  const removed = await wrap(cleanupGuideRefs(capability.repoRoot))
  recoveryEpoch.set(value => value + 1)
  return removed
}, 'recovery.cleanup').extend(withAsync({ status: true }), withAbort('first-in-win'))

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface StartRequest {
  readonly entry: ReviewTarget
}

interface StartFailure {
  readonly error: unknown
  /** Isolation that already existed when the failed start began. */
  readonly inherited: IsolationHandle | null
}

/**
 * Every failed start ends here: it unwinds whatever `isolate` managed to do and
 * puts the machine back in a state the user can act from. A failed start must
 * leave the tree exactly as it was found.
 */
const startFailed = action(async ({ error, inherited }: StartFailure): Promise<void> => {
  const handle = peek(isolation)

  // A start refused before it touched anything — a second Start while a review
  // is running, say — must leave the running session completely alone. Undoing
  // someone else's isolation would be the worst possible response to "no".
  if (handle !== null && handle === inherited) {
    if (!isAbort(error))
      await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
    return
  }

  if (error instanceof IsolationBlockedError) {
    // `isolate` already tried to undo itself and could not. Everything is kept.
    sessionStatus.to('restoring')
    restoreBlock.set(error.outcome)
    sessionStatus.to('blocked')
  }
  else if (handle !== null) {
    sessionStatus.to('restoring')
    const outcome = await wrap(restoreFromToken({ token: handle.token, store: peek(ports).store }))
    if (outcome.kind === 'restored') {
      isolation.set(null)
      restoreBlock.set(null)
      sessionStatus.to('idle')
    }
    else {
      restoreBlock.set(outcome)
      sessionStatus.to('blocked')
    }
  }
  else if (peek(sessionStatus) !== 'idle') {
    // Nothing was mutated: `isolate` unwound itself, or it never ran.
    sessionStatus.to('idle')
  }

  session.set(null)
  preflightRequest.set(null)
  recoveryEpoch.set(value => value + 1)

  // Aborts are a user choice (declined pre-flight, superseded call), not a business error.
  if (!isAbort(error))
    await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
}, 'session.failed').extend(withAsync())

export const startSession = action(async (request: StartRequest): Promise<Session> => {
  // Attach failure handling once, at the top; the happy path below stays flat.
  const inherited = peek(isolation)
  framePromise().catch(error => startFailed({ error, inherited }))

  if (peek(sessionStatus) !== 'idle')
    throw new SessionAlreadyActiveError(peek(sessionStatus))

  const signal = abortVar.require().signal

  // A fresh probe, not `gitCapability()`. The cached one is as old as the last
  // workspace change, so a rebase or merge begun after the window opened still
  // reads `ok` — and this is the last check before a `git stash push`. Nothing
  // downstream re-tests it: `planIsolation` reads the unmerged paths but does
  // not refuse them, and `isolate` would stash straight over MERGE_HEAD.
  const root = peek(workspaceRoot)
  const capability = root === null ? NO_WORKSPACE : await wrap(probeGit(root, { signal }))
  if (!capability.ok)
    throw new GitUnavailableError(capability)

  const { repoRoot } = capability

  // Read the journal itself rather than `recoveryPending`, whose cached value
  // is only as fresh as its last subscriber. A gate that stands between the
  // user and an unrestored backup cannot depend on someone being subscribed.
  if (isRecoverable(await wrap(peek(ports).store.readToken(repoRoot))))
    throw new RecoveryPendingError()

  const includeUntracked = peek(stashIncludeUntracked)

  // An early, honest refusal. The compare-and-swap in `isolate` is still the
  // real protection; checking here just means the user is never asked to
  // approve a pre-flight that cannot possibly proceed.
  const lockOwner = await wrap(readLock(repoRoot, { signal }))
  if (lockOwner !== null)
    throw new RepoLockedError(lockOwner)

  sessionStatus.to('preflight')

  // Stat-only pass: resolves base/after and counts changed lines. Touches nothing.
  const plan: IsolationPlan = await wrap(planIsolation(repoRoot, { entry: request.entry, includeUntracked }, { signal }))
  if (plan.preflight.changedLineCount === 0)
    throw new EmptyDiffError(request.entry, 'empty')
  if (plan.substantiveLineCount === 0)
    throw new EmptyDiffError(request.entry, 'whitespace')

  // Confirmation as a reactive event rather than a callback: the bridge renders
  // `preflight.request` as a modal and calls `preflight.answer`. Declining
  // aborts the whole frame, so nothing below runs and there is nothing to undo.
  //
  // The abort is thrown *after* the take, never from its selector: a selector
  // that throws an abort only means "not this value, keep waiting", which would
  // leave a declined pre-flight hanging forever.
  preflightRequest.set(plan.preflight)
  const approved = await wrap(take(preflightAnswer, 'preflightApproval'))
  preflightRequest.set(null)
  if (!approved)
    throwAbort()

  sessionStatus.to('stashing')
  const id = peek(ports).clock.sessionId()

  // From here the working tree can change. `isolate` acquires the lock ref,
  // captures before it mutates, and journals before each step.
  const handle = await wrap(isolate({
    repoRoot,
    sessionId: id,
    plan,
    store: peek(ports).store,
    includeUntracked,
    now: peek(ports).clock.now(),
    signal,
  }))
  isolation.set(handle)
  recoveryEpoch.set(value => value + 1)

  const built = await wrap(peek(guideSource).build({
    repoRoot,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    options: peek(heuristicOptions),
    guideFile: peek(guideFile),
    signal,
  }))

  const model = reatomSession({
    id,
    repoRoot,
    entry: request.entry,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    handle,
    diff: built.diff,
    guide: built.guide,
  })

  guideDiagnostics.set(built.diagnostics)
  session.set(model)
  sessionStatus.to('active')
  model.next()
  return model
}, 'session.start').extend(withAsync({ status: true }), withAbort('first-in-win'))

export type CancelReason = 'finish' | 'cancel' | 'deactivate'

const teardownSession = action(async ({ reason }: { reason: CancelReason }): Promise<void> => {
  const handle = peek(isolation)
  if (handle === null) {
    session.set(null)
    if (peek(sessionStatus) !== 'idle')
      sessionStatus.to('idle')
    return
  }

  sessionStatus.to('restoring')

  // No `signal` on purpose: `git stash apply` must never be cancelled halfway.
  const outcome = await wrap(restoreFromToken({ token: handle.token, store: peek(ports).store }))
  recoveryEpoch.set(value => value + 1)

  if (outcome.kind === 'restored') {
    isolation.set(null)
    session.set(null)
    restoreBlock.set(null)
    sessionStatus.to('idle')
    await wrap(peek(ports).ui.notify('info', describeRestored(reason)))
    return
  }

  // Conflict or verification mismatch: keep everything. Stash entry, both refs,
  // the lock and the token all stay, so the next activation can finish the job.
  // The commands are already in the message; `restoreBlock` is what carries
  // them to the output channel. An action button here would have nothing to
  // dispatch to, because the model cannot open a VS Code view.
  restoreBlock.set(outcome)
  sessionStatus.to('blocked')
  await wrap(peek(ports).ui.notify('warn', describeBlocked(outcome)))
}, 'session.teardown').extend(withAsync())

export const finishSession = action(async (): Promise<void> => {
  if (peek(sessionStatus) !== 'active')
    return
  await wrap(teardownSession({ reason: 'finish' }))
}, 'session.finish').extend(withAsync({ status: true }), withAbort('first-in-win'))

/**
 * Still works when `session()` is `null` but `isolation()` is not — that is the
 * shape of a mid-start failure and of a post-crash resume. Cancel is *not* a
 * discard: it runs exactly the same restore as Finish, only the message differs.
 */
export const cancelSession = action(async (reason: CancelReason = 'cancel'): Promise<void> => {
  const status = peek(sessionStatus)
  if (status === 'idle')
    return
  // `finish` and `cancel` are separate actions, so their `first-in-win` guards
  // cannot see each other: without this, Cancel during an in-flight Finish
  // would start a second `git stash apply` over the first one.
  if (status === 'restoring')
    return
  await wrap(teardownSession({ reason }))
}, 'session.cancel').extend(withAsync({ status: true }), withAbort('first-in-win'))

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export const gitUsable = computed(() => gitCapability.data()?.ok === true, 'ui.gitUsable')

export const canStart = computed(
  () => gitUsable() && !recoveryPending() && sessionStatus() === 'idle',
  'ui.canStart',
)

/** Why Start is disabled, so the bridge can say so instead of failing on click. */
export const startBlockedReason = computed((): string | null => {
  const capability = gitCapability.data()
  if (capability === null)
    return 'Checking the repository…'
  if (!capability.ok)
    return capability.hint === undefined ? capability.message : `${capability.message} ${capability.hint}`
  if (recoveryPending())
    return 'Guide Reviewer has work to restore from a previous session.'
  const status = sessionStatus()
  if (status !== 'idle')
    return `A Guide Reviewer session is already ${status}.`
  return null
}, 'ui.startBlockedReason')

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function describeStartFailure(error: unknown): string {
  if (error instanceof RepoLockedError)
    return 'Another window is already reviewing this repository.'
  if (error instanceof EmptyDiffError || error instanceof SessionAlreadyActiveError)
    return error.message
  // Already phrased for the user, hint included.
  if (error instanceof MissingObjectsError)
    return error.message
  if (error instanceof RecoveryPendingError || error instanceof GitUnavailableError)
    return error.message
  return `Guide Reviewer could not start: ${error instanceof Error ? error.message : String(error)}`
}

export function describeRestored(reason: CancelReason): string {
  switch (reason) {
    case 'finish':
      return 'Review finished. Your working tree is back.'
    case 'cancel':
      return 'Review cancelled. Your working tree is back.'
    case 'deactivate':
      return 'Guide Reviewer restored your working tree before shutting down.'
  }
}

export function describeBlocked(outcome: RestoreOutcome): string {
  if (outcome.kind === 'restored')
    return 'Your working tree is back.'
  return `${outcome.message} Nothing was discarded — run: ${outcome.commands.join(' && ')}`
}
