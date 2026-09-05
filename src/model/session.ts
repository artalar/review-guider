import type { IsolationHandle, IsolationPlan, OrphanRef, RestoreOutcome } from '../git/isolate'
import type { SessionToken } from '../git/journal'
import type { GitCapability, RepoStatus } from '../git/probe'
import type { PreflightRequest, ReviewTarget, SessionMode } from '../git/types'
import type { SidecarSource } from '../guide/sidecar'
import type { GuideDiagnostic } from '../guide/types'
import type { Ports } from './ports'
import type { Session, SessionRuntime } from './steps'
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
import { findConflictMarkedPath } from '../git/apply'
import {
  ApplyModeUnsupportedError,
  ApplyTargetUnsupportedError,
  cleanupGuideRefs,
  finishKeepFromToken,
  isolate,
  IsolationBlockedError,
  listGuideRefs,
  MissingObjectsError,
  planIsolation,
  RepoLockedError,
  restoreFromToken,
} from '../git/isolate'
import { isRecoverable, isSessionLive } from '../git/journal'
import { probeGit, readStatus } from '../git/probe'
import { readLock } from '../git/refs'
import { describeTarget } from '../git/types'
import { guideFile, heuristicOptions, sessionModeSetting, stashIncludeUntracked } from './config'
import { guideSource } from './guide-source'
import { inertPorts } from './ports'
import { reatomSession } from './steps'

// Settings live in `./config` so `steps.ts` can read `revealMode` without a
// cycle; re-exported here because the bridge treats the model as one surface.
export {
  guideFile,
  heuristicOptions,
  revealMode,
  sessionModeSetting,
  showRationale,
  stashIncludeUntracked,
} from './config'

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
// The state machine
// ---------------------------------------------------------------------------

export type SessionStatus
  /** No session; commands available. */
  = | 'idle'
  /** Summary shown, waiting for the user; nothing touched yet. */
    | 'preflight'
  /** Isolation in progress; the tree may be mid-change. */
    | 'stashing'
  /** Reviewing (read-only) or apply walk idle between Tabs. */
    | 'active'
  /** Apply mode: Tab/Previous write in flight. */
    | 'applying'
  /** Restore in flight. */
    | 'restoring'
  /** Restore could not be verified, or apply conflict left the tree needing attention. */
    | 'blocked'
  /** Start failed and was unwound. */
    | 'error'

export const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  // Recovery reserves this state before its first await, closing the same
  // start/recover race as the repository lock closes cross-window races.
  idle: ['preflight', 'restoring'],
  preflight: ['stashing', 'idle', 'error'],
  // `idle` is reachable because `isolate` unwinds itself on failure.
  stashing: ['active', 'restoring', 'idle', 'error'],
  active: ['applying', 'restoring'],
  // `restoring` is reachable so Cancel can unwind a stuck apply (review 002 B2)
  // when `applyPending` is false; in-flight writes still refuse Cancel.
  applying: ['active', 'blocked', 'error', 'restoring'],
  // No `→ active`: abandoning an in-flight restore / blocked Finish is not a
  // legal walk resume (review 003 m1). Cancel / recover go through restoring.
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
    super(`A Tabthrough session is already ${status}.`)
  }
}

export class RecoveryPendingError extends Error {
  override readonly name = 'RecoveryPendingError'
  constructor() {
    super('Tabthrough has work to restore from a previous session. Restore it before starting a new review.')
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
// Probes
// ---------------------------------------------------------------------------
//
// Below the machine rather than above it because `gitCapability` reads
// `sessionStatus` — the probe's refresh policy depends on what the session is
// doing, which is the whole point of the condition inside it.

const NO_WORKSPACE: GitCapability = {
  ok: false,
  reason: 'no-workspace',
  message: 'Open a folder to use Tabthrough.',
}

/**
 * A dependant of `gitWatchToken` *only while idle*, and the condition is the
 * point. During a session the extension is itself writing refs under `.git/`,
 * so an unconditional dependency would re-probe (six subprocesses) on top of
 * every write it makes. `idle` is both the only state where a stale answer
 * misleads anyone — Start looking available over a rebase that began after the
 * window opened — and the state where nothing of ours is writing.
 *
 * Reading `sessionStatus` reactively is what lets the dependency come back:
 * the computed re-runs on each transition, so the probe is refreshed when a
 * session ends and the watch token is picked up again from there.
 */
export const gitCapability = computed(async (): Promise<GitCapability | null> => {
  // W5: both reactive reads are hoisted above the first await.
  const root = workspaceRoot()
  if (sessionStatus() === 'idle')
    gitWatchToken()

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
  // HEAD is unborn, is a repository Tabthrough will not *start* in — but it
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

/**
 * Someone else's *running* session, not a crashed one. The journal lives in
 * `globalState` so a second window can see it (ADR 0002 D3) — which also means
 * a second window sees the first window's live token and, before the
 * heartbeat, offered to "restore" it out from under a review in progress.
 *
 * `sessionStatus() !== 'idle'` is this window's own session: it is the one
 * doing the beating, and it must never diagnose itself as somebody else.
 */
export const sessionLiveElsewhere = computed(() => {
  if (sessionStatus() !== 'idle')
    return false
  return isSessionLive(recoveryToken.data(), ports().clock.now())
}, 'recovery.liveElsewhere')

export const LIVE_ELSEWHERE_MESSAGE = 'A Tabthrough session is active in another window.'

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

  // Reserve recovery synchronously before reading the token. Otherwise Start
  // can pass its idle gate during this await and isolate the same tree.
  const reservedIdle = entryStatus === 'idle'
  let restoreStarted = false
  sessionStatus.to('restoring')
  framePromise().catch(wrap(() => {
    // A token read failure must not strand the machine in restoring. There is
    // no restore outcome to show yet, so idle can retry; a blocked session
    // keeps its blocked escape hatch.
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to(entryStatus === 'idle' && !restoreStarted ? 'idle' : 'blocked')
  }))

  const token = await wrap(recoveryToken())
  if (token === null) {
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('idle')
    return null
  }

  // Apply Finish left the tree kept on purpose. Overwriting it with the
  // pre-session stash needs an explicit dangerous confirm (ADR 0004 D6 /
  // Phase 10). Refuse with the restore recipe instead of throwing (review 003 M2).
  if (token.stage === 'done-kept') {
    const recipe = token.backupRef === null
      ? 'the backup stash listed by `git stash list`'
      : `git stash apply ${token.backupRef}`
    await wrap(peek(ports).ui.notify(
      'warn',
      `This session was finished with Keep. Restoring the pre-session backup would overwrite your kept tree. If you intentionally want the pre-session WIP back, run: ${recipe}.`,
    ))
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to(entryStatus)
    return null
  }

  // A live token belongs to a window that is still reviewing. Applying its
  // stash would end that review's isolation underneath it, so this stays a
  // notice rather than a restore until the heartbeat goes stale.
  if (reservedIdle && isSessionLive(token, peek(ports).clock.now())) {
    await wrap(peek(ports).ui.notify('info', LIVE_ELSEWHERE_MESSAGE))
    if (reservedIdle && peek(sessionStatus) === 'restoring')
      sessionStatus.to('idle')
    return null
  }

  if (peek(sessionStatus) !== 'restoring')
    return null

  if (token.mode === 'apply') {
    const answer = await wrap(peek(ports).ui.notify('warn', 'Restore the pre-session workspace? This discards applied steps and edits made during the walkthrough.', ['Restore and discard walkthrough edits', 'Keep current files']))
    if (answer !== 'Restore and discard walkthrough edits') {
      sessionStatus.to(entryStatus)
      return null
    }
  }

  // No signal: an interrupted `git stash apply` is the one outcome we cannot survive.
  restoreStarted = true
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
    await wrap(peek(ports).ui.notify('info', 'Tabthrough restored your work from the backup.'))
  }
  else {
    restoreBlock.set(outcome)
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
    await wrap(peek(ports).ui.notify('warn', describeBlocked(outcome)))
  }
  return outcome
}, 'recovery.restore').extend(withAsync({ status: true }), withAbort('first-in-win'))

/**
 * Clears the durable reminder without destroying stash/refs. Used by the
 * activation modal's "Dismiss reminder" (already confirmed there) and by
 * `discardRecovery` after its own confirm.
 */
export const forgetPendingRestore = action(async (): Promise<boolean> => {
  if (peek(sessionStatus) !== 'idle' && peek(sessionStatus) !== 'blocked')
    return false
  const token = await wrap(recoveryToken())
  if (token === null)
    return false

  if (peek(sessionStatus) !== 'idle' && peek(sessionStatus) !== 'blocked')
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
}, 'recovery.forget').extend(withAsync())

/** Forgets the reminder. Never destroys a backup — that is a separate command. */
export const discardRecovery = action(async (): Promise<boolean> => {
  const token = await wrap(recoveryToken())
  if (token === null)
    return false

  const confirmed = await wrap(peek(ports).ui.notify(
    'warn',
    'Dismiss the pending Tabthrough restore reminder? The stash entry and backup refs stay in git until you clean them up.',
    ['Forget'],
  ))
  if (confirmed !== 'Forget')
    return false

  return await wrap(forgetPendingRestore())
}, 'recovery.discard').extend(withAsync())

export const cleanupBackups = action(async (): Promise<readonly string[]> => {
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok)
    throw new GitUnavailableError(capability)
  if (peek(recoveryPending))
    throw new RecoveryPendingError()

  const leftover = await wrap(peek(ports).store.readToken(capability.repoRoot))
  const stashHint = leftover?.stage === 'done-kept' && leftover.stashMessage !== null
    ? ` A pre-session stash entry (message "${leftover.stashMessage}") may still appear in \`git stash list\` after the refs are gone.`
    : leftover?.backupRef !== null && leftover?.backupRef !== undefined
      ? ` Pre-session backup ref ${leftover.backupRef} will be deleted.`
      : ''

  const answer = await wrap(peek(ports).ui.notify(
    'warn',
    `Clean Up Backups permanently removes Tabthrough refs under refs/tabthrough, including any Finish-kept session pointer.${stashHint} This does not drop stash entries by itself, but clears the product's pointer to them.`,
    ['Remove backups', 'Keep backups'],
  ))
  if (answer !== 'Remove backups')
    return []

  const removed = await wrap(cleanupGuideRefs(capability.repoRoot))
  const after = await wrap(peek(ports).store.readToken(capability.repoRoot))
  if (after?.stage === 'done-kept')
    await wrap(peek(ports).store.clearToken(capability.repoRoot))
  recoveryEpoch.set(value => value + 1)
  return removed
}, 'recovery.cleanup').extend(withAsync({ status: true }), withAbort('first-in-win'))

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface StartRequest {
  readonly entry: ReviewTarget
  /** Repo-relative sidecar path; defaults to `tabthrough.guideFile`. */
  readonly guideFile?: string
  /**
   * When set, the guide engine uses this text instead of reading the sidecar
   * from git — the path for starting from an open `*.guide.json` editor.
   */
  readonly sidecar?: SidecarSource
  /** Overrides the setting / chooser when tests pin a mode. */
  readonly sessionMode?: SessionMode
}

/** Start attempts are cancellable while waiting for pre-flight or isolation. */
const startAttempt = atom(0, 'session.startAttempt')
const cancelledStartAttempt = atom<number | null>(null, 'session.cancelledStartAttempt')
const startSettled = action((attempt: number) => attempt, 'session.startSettled')
const finishPending = atom(false, 'session.finishPending')

function sessionRuntime(): SessionRuntime {
  return {
    ports: () => peek(ports),
    beginApply: () => {
      if (peek(sessionStatus) !== 'active')
        return false
      sessionStatus.to('applying')
      return true
    },
    endApply: (next) => {
      if (peek(sessionStatus) === 'applying')
        sessionStatus.to(next)
    },
  }
}

async function resolveSessionMode(request: StartRequest): Promise<SessionMode> {
  if (request.sessionMode !== undefined)
    return request.sessionMode
  const setting = peek(sessionModeSetting)
  if (setting !== 'ask')
    return setting
  const chosen = await wrap(peek(ports).ui.chooseSessionMode())
  if (chosen === null)
    throwAbort()
  return chosen
}

interface StartFailure {
  readonly error: unknown
  /** Isolation that already existed when the failed start began. */
  readonly inherited: IsolationHandle | null
  readonly attempt: number
}

/**
 * Every failed start ends here: it unwinds whatever `isolate` managed to do and
 * puts the machine back in a state the user can act from. A failed start must
 * leave the tree exactly as it was found.
 */
const startFailed = action(async ({ error, inherited, attempt }: StartFailure): Promise<void> => {
  const handle = peek(isolation)
  try {
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
  }
  catch (failure) {
    preflightRequest.set(null)
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
    await wrap(peek(ports).ui.notify('error', `Workspace recovery needs attention: ${failure instanceof Error ? failure.message : String(failure)}`))
  }
  finally {
    startSettled(attempt)
  }
}, 'session.failed').extend(withAsync())

export const startSession = action(async (request: StartRequest): Promise<Session> => {
  if (peek(sessionStatus) !== 'idle')
    throw new SessionAlreadyActiveError(peek(sessionStatus))

  // Attach failure handling once, at the top; the happy path below stays flat.
  // The attempt id lets Cancel wait for the unwind belonging to this start,
  // even if another rejected click arrives while the first one is suspended.
  const inherited = peek(isolation)
  const attempt = startAttempt.set(value => value + 1)
  cancelledStartAttempt.set(null)
  framePromise().catch(error => startFailed({ error, inherited, attempt }))
  // Reserve before the first probe/read await. This closes same-window
  // start/start and start/recovery races during the pre-flight preparation.
  sessionStatus.to('preflight')

  const signal = abortVar.require().signal

  // A fresh probe, not `gitCapability()`. The cached one now refreshes while
  // idle, but a watcher event is not instantaneous and this is the last check
  // before a `git stash push`. Nothing downstream re-tests it: `planIsolation`
  // reads the unmerged paths but does not refuse them, and `isolate` would
  // stash straight over MERGE_HEAD.
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

  const resolvedMode = await wrap(resolveSessionMode(request))

  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()
  // Count the same saved content that isolation will capture, including edits
  // that previously existed only in a VS Code buffer.
  const savedBeforePlan = await wrap(peek(ports).ui.saveDocuments(repoRoot, []))
  if (!savedBeforePlan.ok) {
    await wrap(peek(ports).ui.notify('warn', `Save ${savedBeforePlan.path} before starting Tabthrough.`))
    throwAbort()
  }

  // Stat-only pass: resolves base/after and counts changed lines. Touches nothing.
  const plan: IsolationPlan = await wrap(planIsolation(
    repoRoot,
    { entry: request.entry, includeUntracked, sessionMode: resolvedMode },
    { signal },
  ))
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()
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
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()
  const approved = await wrap(take(preflightAnswer, 'preflightApproval'))
  preflightRequest.set(null)
  if (!approved)
    throwAbort()

  // VS Code buffers are not part of Git's view of the working tree. Persist
  // every dirty editor in this repository before the first stash, or a later
  // editor save could overwrite the isolated tree with content that was never
  // captured by the journal.
  const saved = await wrap(peek(ports).ui.saveDocuments(repoRoot, []))
  if (!saved.ok) {
    await wrap(peek(ports).ui.notify('warn', `Save ${saved.path} before starting Tabthrough.`))
    throwAbort()
  }

  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  // The confirmation can stay open while files, HEAD, or merge state change.
  // Never execute an obsolete checkout/stash plan after saving those edits.
  const currentCapability = await wrap(probeGit(repoRoot, { signal }))
  if (!currentCapability.ok)
    throw new GitUnavailableError(currentCapability)
  const currentPlan = await wrap(planIsolation(
    repoRoot,
    { entry: request.entry, includeUntracked, sessionMode: resolvedMode },
    { signal },
  ))
  if (JSON.stringify(currentPlan) !== JSON.stringify(plan))
    throw new Error('The repository changed while the start confirmation was open. Start the review again to confirm the updated changes.')

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
    sessionMode: resolvedMode,
    now: peek(ports).clock.now,
    signal,
  }))
  isolation.set(handle)
  recoveryEpoch.set(value => value + 1)

  // Cancellation during the non-abortable isolation window is handled after
  // isolate has returned, so its own restore path can see the complete handle.
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  const built = await wrap(peek(guideSource).build({
    repoRoot,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    options: peek(heuristicOptions),
    guideFile: request.guideFile ?? peek(guideFile),
    ...(request.sidecar === undefined ? {} : { sidecar: request.sidecar }),
    signal,
  }))
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  if (resolvedMode === 'apply') {
    const unsupported = built.diff.files.find(file =>
      file.isBinary || file.status === 'mode-only' || file.status === 'renamed'
      || file.oldMode === '120000' || file.newMode === '120000'
      || file.oldMode === '160000' || file.newMode === '160000'
      || (file.oldMode !== undefined && file.newMode !== undefined && file.oldMode !== file.newMode)
      || (file.status === 'added' && file.newMode === '100755')
      || built.guide.steps.some(step => step.path === file.path && step.kind === 'stub'))
    if (unsupported !== undefined)
      throw new ApplyTargetUnsupportedError(unsupported.path, unsupported.isBinary ? 'binary' : unsupported.status)
  }

  const model = reatomSession({
    id,
    repoRoot,
    entry: request.entry,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    handle,
    diff: built.diff,
    guide: built.guide,
    mode: resolvedMode,
    runtime: sessionRuntime(),
  })

  guideDiagnostics.set(built.diagnostics)
  session.set(model)
  sessionStatus.to('active')
  await wrap(Promise.resolve(model.next()))
  cancelledStartAttempt.set(null)
  startSettled(attempt)
  return model
}, 'session.start').extend(withAsync({ status: true }), withAbort('first-in-win'))

export type CancelReason = 'finish' | 'cancel' | 'deactivate'

const teardownSession = action(async ({ reason }: { reason: CancelReason }): Promise<void> => {
  framePromise().catch(wrap(() => {
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
  }))
  const handle = peek(isolation)
  if (handle === null) {
    session.set(null)
    if (peek(sessionStatus) !== 'idle')
      sessionStatus.to('idle')
    return
  }

  sessionStatus.to('restoring')
  framePromise().catch(wrap(() => {
    if (peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
  }))

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

/**
 * Apply Finish: keep the tree, journal `done-kept`, offer SCM. Does not restore
 * the pre-session stash (ADR 0004 D6 / R-apply-9).
 */
const finishApplyKeep = action(async (): Promise<void> => {
  const handle = peek(isolation)
  const model = peek(session)
  if (handle === null || model === null)
    return

  // Reserve before saving documents or scanning git. Cancel observes this
  // synchronously and cannot start a competing restore over Finish.
  sessionStatus.to('applying')
  finishPending.set(true)
  // Keep an unexpected read/checkpoint failure from wedging the reservation.
  framePromise().catch(wrap(() => {
    finishPending.set(false)
    if (peek(sessionStatus) === 'applying' || peek(sessionStatus) === 'restoring')
      sessionStatus.to('blocked')
  }))

  const paths = [...new Set(model.guide.steps.map(step => step.path))]
  const saved = await wrap(peek(ports).ui.saveDocuments(model.repoRoot, paths))
  if (!saved.ok) {
    await wrap(peek(ports).ui.notify('warn', `Save ${saved.path} before finishing.`))
    finishPending.set(false)
    if (peek(sessionStatus) === 'applying')
      sessionStatus.to('active')
    return
  }

  // Same refusals Tab enforces — never keep conflict markers (review 003 B1 / M6).
  const status = await wrap(readStatus(model.repoRoot))
  if (status.unmerged.length > 0) {
    await wrap(peek(ports).ui.notify(
      'warn',
      `Resolve unmerged paths before finishing: ${status.unmerged.slice(0, 3).join(', ')}${status.unmerged.length > 3 ? '…' : ''}`,
    ))
    finishPending.set(false)
    if (peek(sessionStatus) === 'applying')
      sessionStatus.to('active')
    return
  }

  const conflictPath = await wrap(findConflictMarkedPath(model.repoRoot, paths))
  if (conflictPath !== null) {
    await wrap(peek(ports).ui.notify(
      'warn',
      `Resolve conflict markers in ${conflictPath} before finishing. Finish keeps the working tree as-is — markers must not be committed as the walk outcome.`,
    ))
    await wrap(peek(ports).ui.openWorkspaceFile(model.repoRoot, conflictPath))
    finishPending.set(false)
    if (peek(sessionStatus) === 'applying')
      sessionStatus.to('active')
    return
  }

  sessionStatus.to('restoring')

  const outcome = await wrap(finishKeepFromToken({
    token: handle.token,
    store: peek(ports).store,
  }))
  handle.token = outcome.token

  if (outcome.kind === 'blocked') {
    // Checkpoint failure: stay reachable via Cancel (review 002 M7). `blocked`
    // keeps Cancel enabled; do not resume the walk without a checkpoint.
    sessionStatus.to('blocked')
    recoveryEpoch.set(value => value + 1)
    await wrap(peek(ports).ui.notify('warn', outcome.message))
    finishPending.set(false)
    return
  }

  isolation.set(null)
  session.set(null)
  restoreBlock.set(null)
  sessionStatus.to('idle')
  recoveryEpoch.set(value => value + 1)

  const answer = await wrap(peek(ports).ui.notify(
    outcome.carried ? 'info' : 'warn',
    outcome.message,
    ['Open Source Control'],
  ))
  if (answer === 'Open Source Control')
    await wrap(peek(ports).ui.openSourceControl())
  finishPending.set(false)
}, 'session.finishApplyKeep').extend(withAsync())

export const finishSession = action(async (): Promise<void> => {
  if (peek(sessionStatus) !== 'active')
    return
  const model = peek(session)
  if (model?.mode === 'apply') {
    await wrap(finishApplyKeep())
    return
  }
  await wrap(teardownSession({ reason: 'finish' }))
}, 'session.finish').extend(withAsync({ status: true }), withAbort('first-in-win'))

/**
 * Focus Source Control so the user can commit. Never runs `git commit`.
 */
export const commitHandoff = action(async (): Promise<void> => {
  await wrap(peek(ports).ui.openSourceControl())
}, 'session.commitHandoff').extend(withAsync())

/**
 * Still works when `session()` is `null` but `isolation()` is not — that is the
 * shape of a mid-start failure and of a post-crash resume. Cancel is *not* a
 * discard in read-only mode: it runs exactly the same restore as Finish, only
 * the message differs. In apply mode Cancel restores pre-session and discards
 * mid-walk edits (ADR 0004 D6).
 */
export const cancelSession = action(async (reason: CancelReason = 'cancel'): Promise<void> => {
  const status = peek(sessionStatus)
  if (status === 'idle')
    return

  // A start has no isolation handle until the journal has been captured. Feed
  // a decline through the pre-flight event so the suspended start frame exits;
  // merely changing status would leave it waiting and a later approval could
  // still mutate the repository.
  if (status === 'preflight') {
    const attempt = peek(startAttempt)
    cancelledStartAttempt.set(attempt)
    const settled = take(startSettled, value => value === attempt, 'startCancelled')
    startSession.abort()
    await wrap(settled)
    return
  }

  // Isolation deliberately remains non-abortable here. Mark the attempt and
  // let `startSession` wait for isolate to return its complete handle, then its
  // normal failure path restores the tree and releases the lock.
  if (status === 'stashing') {
    const attempt = peek(startAttempt)
    cancelledStartAttempt.set(attempt)
    await wrap(take(startSettled, value => value === attempt, 'startCancelled'))
    return
  }
  // `finish` and `cancel` are separate actions, so their `first-in-win` guards
  // cannot see each other: without this, Cancel during an in-flight Finish
  // would start a second `git stash apply` over the first one.
  if (status === 'restoring')
    return
  // Refuse only while a write is actually in flight — a stuck `applying`
  // status (exception before endApply) must not hide Cancel (review 002 B2).
  const model = peek(session)
  if (status === 'applying' && (model?.applyPending() === true || peek(finishPending)))
    return

  // Window close / reload must not run destructive apply Cancel without D6
  // consent. Leave the tree and `reviewing` journal for Phase 10 recovery
  // (review 003 B2). Read-only deactivate still restores.
  const handle = peek(isolation)
  const applyMode = model?.mode === 'apply' || handle?.token.mode === 'apply'
  if (reason === 'deactivate' && applyMode)
    return

  if (reason === 'cancel' && applyMode) {
    const answer = await wrap(peek(ports).ui.notify(
      'warn',
      'Cancel restores your pre-session working tree and discards applied steps and mid-walk edits.',
      ['Cancel and restore', 'Keep reviewing'],
    ))
    if (answer !== 'Cancel and restore')
      return
    // The confirmation awaited user input. Finish or Next may have acquired
    // the session meanwhile, so never restore using a stale confirmation.
    if (peek(session) !== model || peek(sessionStatus) !== status)
      return
  }

  await wrap(teardownSession({ reason }))
}, 'session.cancel').extend(withAsync({ status: true }), withAbort('first-in-win'))

// ---------------------------------------------------------------------------
// Liveness
// ---------------------------------------------------------------------------

/** Comfortably inside `HEARTBEAT_STALE_MS`, so one missed tick proves nothing. */
export const HEARTBEAT_INTERVAL_MS = 7_000

/**
 * Says "this window is still here" on the token it owns, so a second window
 * can tell a crashed session from a live one (review 001 M2). The bridge ticks
 * it; see `bindSessionHeartbeat` in `src/index.ts`.
 *
 * Beats while the session is open except during `restoring` / `stashing`, where
 * the journal belongs to isolate/restore and a read-modify-write could race.
 * Apply mode's `applying` and `blocked` must keep beating — otherwise a second
 * window offers to restore a live apply session (review 002 M5).
 */
export const refreshHeartbeat = action(async (): Promise<boolean> => {
  const handle = peek(isolation)
  const status = peek(sessionStatus)
  if (handle === null || status === 'idle' || status === 'restoring' || status === 'stashing')
    return false

  const store = peek(ports).store
  const stored = await wrap(store.readToken(handle.repoRoot))

  // Re-checked after the await: the session may have started tearing down
  // while the read was in flight, and this must not write over that.
  const statusAfter = peek(sessionStatus)
  if (statusAfter === 'idle' || statusAfter === 'restoring' || statusAfter === 'stashing')
    return false
  if (stored === null || stored.sessionId !== handle.sessionId)
    return false
  if (stored.stage !== 'reviewing' && stored.stage !== 'applying')
    return false

  await wrap(store.writeToken({ ...stored, heartbeatAt: peek(ports).clock.now() }))
  return true
}, 'session.heartbeat').extend(withAsync())

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
  // Before `recoveryPending`, which is also true for a live token: "restore
  // your work" would be a false alarm about a review that is going fine.
  if (sessionLiveElsewhere())
    return LIVE_ELSEWHERE_MESSAGE
  if (recoveryPending())
    return 'Tabthrough has work to restore from a previous session.'
  const status = sessionStatus()
  if (status !== 'idle')
    return `A Tabthrough session is already ${status}.`
  return null
}, 'ui.startBlockedReason')

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function describeStartFailure(error: unknown): string {
  if (error instanceof RepoLockedError)
    return 'Another window is already reviewing this repository.'
  if (error instanceof ApplyModeUnsupportedError)
    return error.message
  if (error instanceof ApplyTargetUnsupportedError)
    return error.message
  if (error instanceof EmptyDiffError || error instanceof SessionAlreadyActiveError)
    return error.message
  // Already phrased for the user, hint included.
  if (error instanceof MissingObjectsError)
    return error.message
  if (error instanceof RecoveryPendingError || error instanceof GitUnavailableError)
    return error.message
  return `Tabthrough could not start: ${error instanceof Error ? error.message : String(error)}`
}

export function describeRestored(reason: CancelReason): string {
  switch (reason) {
    case 'finish':
      return 'Review finished. Your working tree is back.'
    case 'cancel':
      return 'Review cancelled. Your working tree is back.'
    case 'deactivate':
      return 'Tabthrough restored your working tree before shutting down.'
  }
}

export function describeBlocked(outcome: RestoreOutcome): string {
  if (outcome.kind === 'restored')
    return 'Your working tree is back.'
  return `${outcome.message} Nothing was discarded — run: ${outcome.commands.join(' && ')}`
}
