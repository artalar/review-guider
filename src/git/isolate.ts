import type { GitOptions } from './exec'
import type { SessionMode, SessionToken, TokenStore } from './journal'
import type { HeadPosition, PreflightRequest, ReviewTarget } from './types'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAppliedCheckpoint } from './apply'
import {
  countChangedLines,
  countWorkingTreeChangedLines,
  isShallowRepository,
  mergeBase,
  readRecordedParents,
  resolveCommit,
} from './diff'
import { splitNul, tryGit } from './exec'
import { advanceStage, persistToken, stashMessageFor, withStage } from './journal'
import { readStatus } from './probe'
import { acquireLock, afterRefName, backupRefName, deleteRef, listRefs, LOCK_REF, readLock, releaseLock, resolveRef, writeRef } from './refs'
import { captureWorkingState, readStatusDigest, verifyRestored } from './snapshot'
import { findStashByMessage, stashApply, stashDrop, stashPush } from './stash'

/**
 * The safety protocol: capture before mutate, journal before act, and restore
 * by apply → verify → drop. See architecture/overview.md §3.5.
 *
 * A restore that cannot complete cleanly leaves *more* state behind, never
 * less: the stash entry, both refs, the lock and the token all survive so the
 * user — or the next activation — can finish the job.
 */

export class RepoLockedError extends Error {
  override readonly name = 'RepoLockedError'
  /** The `sessionId` holding the lock, or a raw ref value for a foreign lock. */
  constructor(readonly owner: string) {
    super('Another Tabthrough session already owns this repository.')
  }
}

export class EntryNotSupportedError extends Error {
  override readonly name = 'EntryNotSupportedError'
  constructor(readonly entry: ReviewTarget) {
    super(`Cannot resolve review entry: ${entry.kind}`)
  }
}

export class ApplyModeUnsupportedError extends Error {
  override readonly name = 'ApplyModeUnsupportedError'
  constructor(readonly entry: ReviewTarget) {
    super(
      entry.kind === 'range'
        ? 'Apply mode does not support commit ranges yet. Start a read-only review, or apply a single commit.'
        : `Apply mode cannot start for ${entry.kind}.`,
    )
  }
}

/**
 * Apply mode currently writes text files only; refusing early preserves the
 * walk's promise that every visible step is reflected on disk.
 */
export class ApplyTargetUnsupportedError extends Error {
  override readonly name = 'ApplyTargetUnsupportedError'
  constructor(readonly path: string, readonly status: string) {
    super(`Apply mode cannot safely write ${status} change ${path} yet. Start a read-only review for this target.`)
  }
}

/**
 * The P0 edge row "shallow clone missing objects": detect early, fail with a
 * fetch hint. Raised from the stat-only plan, so nothing has been touched.
 */
export class MissingObjectsError extends Error {
  override readonly name = 'MissingObjectsError'
  constructor(readonly rev: string, readonly missing: string) {
    super(
      `Tabthrough cannot read the history before ${rev.slice(0, 8)}: this clone is shallow and commit `
      + `${missing.slice(0, 8)} was never fetched. Run \`git fetch --unshallow\` (or \`git fetch --deepen 1\`) and try again.`,
    )
  }
}

export class IsolationBlockedError extends Error {
  override readonly name = 'IsolationBlockedError'
  constructor(readonly outcome: RestoreOutcome, override readonly cause: unknown) {
    super('Tabthrough could not undo a failed start. Your work is preserved.')
  }
}

export interface IsolationPlan {
  readonly entry: ReviewTarget
  readonly repoRoot: string
  readonly baseRev: string
  /** `null` means "capture the working tree into the after-commit". */
  readonly afterRev: string | null
  /** Revision to detach at; `null` for the working-tree entry. */
  readonly checkout: string | null
  readonly needsStash: boolean
  readonly headBefore: HeadPosition
  /**
   * The same count under `git diff -w`. Zero here with a non-zero
   * `preflight.changedLineCount` is a whitespace-only diff, which the P0 edge
   * table refuses to start on.
   */
  readonly substantiveLineCount: number
  readonly preflight: PreflightRequest
}

export interface PlanRequest {
  readonly entry: ReviewTarget
  readonly includeUntracked: boolean
  readonly sessionMode: SessionMode
}

export async function readHeadPosition(repoRoot: string, options: GitOptions = {}): Promise<HeadPosition> {
  const symbolic = await tryGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)
  const name = symbolic.code === 0 ? symbolic.stdout.trim() : ''
  if (name !== '')
    return { kind: 'branch', name }
  const sha = await resolveCommit(repoRoot, 'HEAD', options)
  return { kind: 'detached', sha: sha ?? '' }
}

/**
 * Stat-only pass. Resolves the immutable `(base, after)` pair (ADR 0002 D4) and
 * counts changed lines so the pre-flight can state what is at stake. Touches
 * nothing — not the index, not the working tree, not a single ref.
 */
export async function planIsolation(
  repoRoot: string,
  request: PlanRequest,
  options: GitOptions = {},
): Promise<IsolationPlan> {
  const status = await readStatus(repoRoot, options)
  const headBefore = await readHeadPosition(repoRoot, options)
  const untracked = request.includeUntracked ? status.untracked : []

  const files = {
    staged: status.staged,
    unstaged: status.unstaged,
    untracked,
  }
  const needsStash = status.staged.length > 0 || status.unstaged.length > 0 || untracked.length > 0

  const { entry } = request
  if (request.sessionMode === 'apply' && entry.kind === 'range')
    throw new ApplyModeUnsupportedError(entry)

  if (entry.kind === 'workingTree') {
    const baseRev = await requireCommit(repoRoot, 'HEAD', options)
    const untrackedLineCount = await countUntrackedLines(repoRoot, untracked)
    const changedLineCount
      = await countWorkingTreeChangedLines(repoRoot, baseRev, options)
        + untrackedLineCount
    const substantiveLineCount
      = await countWorkingTreeChangedLines(repoRoot, baseRev, { ...options, ignoreWhitespace: true })
        + untrackedLineCount

    // Apply always detaches at base (HEAD after stash) so the walk starts at
    // pedagogical zero even when base === HEAD (ADR 0004 D3).
    const checkout = request.sessionMode === 'apply' ? baseRev : null

    return {
      entry,
      repoRoot,
      baseRev,
      afterRev: null,
      checkout,
      needsStash,
      headBefore,
      substantiveLineCount,
      preflight: {
        entry,
        repoRoot,
        changedFileCount: new Set([...status.staged, ...status.unstaged, ...untracked]).size,
        changedLineCount,
        willStash: needsStash,
        willCheckout: checkout,
        files,
        sessionMode: request.sessionMode,
      },
    }
  }

  const { baseRev, afterRev } = entry.kind === 'commit'
    ? await resolveCommitEntry(repoRoot, entry.rev, options)
    : await resolveRangeEntry(repoRoot, entry.from, entry.to, options)

  const changedLineCount = await countChangedLines(repoRoot, baseRev, afterRev, options)
  const substantiveLineCount = await countChangedLines(repoRoot, baseRev, afterRev, {
    ...options,
    ignoreWhitespace: true,
  })

  const checkout = request.sessionMode === 'apply' ? baseRev : afterRev

  return {
    entry,
    repoRoot,
    baseRev,
    afterRev,
    checkout,
    needsStash,
    headBefore,
    substantiveLineCount,
    preflight: {
      entry,
      repoRoot,
      changedFileCount: (await tryGit(repoRoot, ['diff', '--name-only', '-z', baseRev, afterRev], options))
        .stdout
        .split('\0')
        .filter(Boolean)
        .length,
      changedLineCount,
      willStash: needsStash,
      willCheckout: checkout,
      files,
      sessionMode: request.sessionMode,
    },
  }
}

/** Root commit → the empty tree; merge commit → first parent (documented in the pre-flight). */
async function resolveCommitEntry(
  repoRoot: string,
  rev: string,
  options: GitOptions,
): Promise<{ baseRev: string, afterRev: string }> {
  const afterRev = await requireCommit(repoRoot, rev, options)
  const parent = await resolveCommit(repoRoot, `${afterRev}^1`, options)
  if (parent !== null)
    return { baseRev: parent, afterRev }

  // Unresolvable parent, but the object claims one: a shallow boundary. Falling
  // through would review the whole repository as an addition.
  const recorded = await readRecordedParents(repoRoot, afterRev, options)
  if (recorded[0] !== undefined)
    throw new MissingObjectsError(afterRev, recorded[0])

  // A root commit diffs against the empty tree. Hashing empty stdin gets it
  // portably and, unlike the well-known SHA-1 constant, is also right in a
  // SHA-256 repository.
  const empty = await tryGit(repoRoot, ['hash-object', '-t', 'tree', '--stdin'], { ...options, stdin: '' })
  return { baseRev: empty.stdout.trim(), afterRev }
}

async function resolveRangeEntry(
  repoRoot: string,
  from: string,
  to: string,
  options: GitOptions,
): Promise<{ baseRev: string, afterRev: string }> {
  const afterRev = await requireCommit(repoRoot, to, options)
  const base = await mergeBase(repoRoot, from, afterRev, options)
  if (base === null) {
    // Two branches with no common ancestor *in this clone* is the same problem
    // as above, and has the same fix, so it gets the same hint.
    if (await isShallowRepository(repoRoot, options))
      throw new MissingObjectsError(afterRev, from)
    throw new EntryNotSupportedError({ kind: 'range', from, to })
  }
  return { baseRev: base, afterRev }
}

async function requireCommit(repoRoot: string, rev: string, options: GitOptions): Promise<string> {
  const sha = await resolveCommit(repoRoot, rev, options)
  if (sha === null)
    throw new EntryNotSupportedError({ kind: 'commit', rev })
  return sha
}

const UNTRACKED_LINE_BUDGET = 1_000_000

async function countUntrackedLines(repoRoot: string, paths: readonly string[]): Promise<number> {
  let total = 0
  for (const path of paths) {
    const absolute = join(repoRoot, path)
    try {
      const info = await stat(absolute)
      if (!info.isFile())
        continue
      if (info.size > UNTRACKED_LINE_BUDGET) {
        total += 1
        continue
      }
      const text = await readFile(absolute, 'utf8')
      total += text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    }
    catch {
      // A file that disappeared between status and read simply does not count.
    }
  }
  return total
}

export interface IsolationHandle {
  readonly sessionId: string
  readonly repoRoot: string
  readonly baseRev: string
  readonly afterRev: string
  /** Updated after each successful apply/revert checkpoint. */
  token: SessionToken
}

export interface IsolateArgs {
  readonly repoRoot: string
  readonly sessionId: string
  readonly plan: IsolationPlan
  readonly store: TokenStore
  readonly includeUntracked: boolean
  readonly sessionMode: SessionMode
  /** Read again for the heartbeat, so a slow isolation is not born stale. */
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly exec?: GitOptions['exec']
}

export async function isolate(args: IsolateArgs): Promise<IsolationHandle> {
  const { repoRoot, sessionId, plan, store } = args
  const options: GitOptions = { signal: args.signal, exec: args.exec }
  // Unwinding must never be interrupted, so it runs without the caller's signal.
  const writeOptions: GitOptions = { exec: args.exec }
  const now = args.now ?? Date.now

  // The lock value is the session id, not the HEAD sha: two windows at the
  // same HEAD would compute the same one, and the compare-and-swap release
  // would then be unable to tell them apart.
  if (!await acquireLock(repoRoot, sessionId, options)) {
    const owner = await readLock(repoRoot, options)
    throw new RepoLockedError(owner ?? 'unknown')
  }

  let token: SessionToken = {
    v: 1,
    sessionId,
    createdAt: now(),
    heartbeatAt: now(),
    repoRoot,
    stage: 'planned',
    entry: plan.entry,
    headBefore: plan.headBefore,
    lockValue: sessionId,
    afterRef: afterRefName(sessionId),
    afterCommit: null,
    afterTree: null,
    statusDigest: null,
    backupRef: null,
    backupCommit: null,
    stashMessage: null,
    checkedOut: null,
    mode: args.sessionMode,
    appliedIndex: -1,
    appliedRef: null,
  }
  try {
    await store.writeToken(token)
  }
  catch (error) {
    // No workspace mutation has started; a unavailable journal must not strand
    // the repository behind the lock acquired above.
    await releaseLock(repoRoot, sessionId, writeOptions)
    throw error
  }

  try {
    // 1. Capture. Nothing is mutated yet, so a crash here loses nothing.
    const statusDigest = await readStatusDigest(repoRoot, options)
    const capture = await captureWorkingState(repoRoot, sessionId, options)
    await writeRef(repoRoot, token.afterRef, capture.commit, options)
    token = await advanceStage(store, {
      ...token,
      afterCommit: capture.commit,
      afterTree: capture.tree,
      statusDigest,
    }, 'captured')

    // 2. Stash. The message goes into the journal *before* the push, so a crash
    //    mid-push still leaves recovery able to find the entry.
    if (plan.needsStash) {
      token = await advanceStage(store, { ...token, stashMessage: stashMessageFor(sessionId) }, 'stashed')
      const push = await stashPush(
        repoRoot,
        { message: token.stashMessage ?? stashMessageFor(sessionId), includeUntracked: args.includeUntracked },
        options,
      )
      if (push.sha !== null) {
        const backupRef = backupRefName(sessionId)
        await writeRef(repoRoot, backupRef, push.sha, options)
        token = await persistToken(store, { ...token, backupRef, backupCommit: push.sha })
      }

      const afterStash = await readStatus(repoRoot, options)
      if (!afterStash.clean)
        throw new Error('The working tree is still dirty after stashing; refusing to continue.')
    }

    // 3. Checkout. Read-only working-tree skips (already at HEAD after stash).
    //    Apply always checks out base, including working-tree (ADR 0004 D3).
    token = await advanceStage(store, { ...token, checkedOut: plan.checkout }, 'checkedout')
    if (plan.checkout !== null) {
      const checkout = await tryGit(repoRoot, ['checkout', '--detach', plan.checkout], options)
      if (checkout.code !== 0)
        throw new Error(`git checkout failed: ${checkout.stderr.trim()}`)
    }

    // Stamped again here rather than only at creation: on a large repository
    // the stash and the checkout can take longer than a heartbeat stays fresh,
    // and a session that goes live already stale is one a second window would
    // offer to "recover" out from under it.
    token = await advanceStage(store, { ...token, heartbeatAt: now() }, 'reviewing')

    return {
      sessionId,
      repoRoot,
      baseRev: plan.baseRev,
      afterRev: plan.afterRev ?? capture.commit,
      token,
    }
  }
  catch (error) {
    const outcome = await restoreFromToken({ token, store, exec: args.exec })
    if (outcome.kind === 'blocked')
      throw new IsolationBlockedError(outcome, error)
    // Best effort: the lock must not outlive a refused start.
    await releaseLock(repoRoot, sessionId, writeOptions)
    throw error
  }
}

export type RestoreBlockReason
  = | 'checkout-failed'
    | 'apply-conflict'
    | 'backup-missing'
    | 'verification-failed'
    | 'index-split-mismatch'

export type RestoreOutcome
  = | {
    readonly kind: 'restored'
    readonly stashApplied: boolean
    readonly stashDropped: boolean
    readonly indexRestored: boolean
  }
  | {
    readonly kind: 'blocked'
    readonly reason: RestoreBlockReason
    readonly message: string
    readonly commands: readonly string[]
    readonly token: SessionToken
  }

export interface RestoreArgs {
  readonly token: SessionToken
  readonly store: TokenStore
  /** Deliberately no `signal`: an interrupted `git stash apply` is unsurvivable. */
  readonly exec?: GitOptions['exec']
}

/**
 * List paths in a tree (commit or tree-ish). Empty on missing/unreadable refs.
 */
async function listTreePaths(
  repoRoot: string,
  treeish: string,
  options: GitOptions,
): Promise<ReadonlySet<string>> {
  const result = await tryGit(repoRoot, ['ls-tree', '-r', '--name-only', '-z', treeish], options)
  if (result.code !== 0)
    return new Set()
  return new Set(splitNul(result.stdout).filter(path => path !== ''))
}

/**
 * Discard apply-mode writes so Cancel can restore pre-session state.
 *
 * Never runs a bare `git clean -fd` (plan P0-6 / review 002 B1). After
 * `reset --hard` to base, only remove untracked paths this session is
 * responsible for: files that were tracked at `headBefore` and that apply
 * left untracked after the reset. Pre-session untracked the stash left on
 * disk, and files the user authored mid-walk, stay — a restore that stops
 * and explains beats one that deletes (review 003 M1 / 002 B1).
 */
async function discardApplyWrites(
  token: SessionToken,
  options: GitOptions,
): Promise<RestoreOutcome | null> {
  const repoRoot = token.repoRoot
  const resetTarget = token.checkedOut ?? 'HEAD'
  const reset = await tryGit(repoRoot, ['reset', '--hard', resetTarget], options)
  if (reset.code !== 0) {
    return blocked(
      token,
      'checkout-failed',
      'Could not discard apply-mode writes before restore.',
      reset.stderr,
    )
  }

  const status = await readStatus(repoRoot, options)
  if (status.untracked.length === 0)
    return null

  const headTreeish = token.headBefore.kind === 'branch'
    ? token.headBefore.name
    : token.headBefore.sha
  const headPaths = await listTreePaths(repoRoot, headTreeish, options)
  // Working-change walkthroughs can re-create files that were untracked
  // before isolation. Their original bytes live in the stash's third parent;
  // remove those copies before stash apply tries to restore them again.
  const stashedUntracked = token.backupCommit === null
    ? new Set<string>()
    : await listTreePaths(repoRoot, `${token.backupCommit}^3`, options)

  const toRemove = status.untracked.filter(path => headPaths.has(path) || stashedUntracked.has(path))
  if (toRemove.length === 0)
    return null

  const clean = await tryGit(repoRoot, ['clean', '-fd', '--', ...toRemove], options)
  if (clean.code !== 0) {
    return blocked(
      token,
      'checkout-failed',
      'Could not remove apply-mode untracked files before restore.',
      clean.stderr,
    )
  }
  return null
}

/**
 * Idempotent, resumable restore. Verification runs *before* the apply too, so
 * re-running after a partial failure never double-applies.
 */
export async function restoreFromToken(args: RestoreArgs): Promise<RestoreOutcome> {
  const { store } = args
  const options: GitOptions = { exec: args.exec }
  const repoRoot = args.token.repoRoot

  let token = await advanceStage(store, args.token, 'restoring')

  // Nothing was ever captured, so there is nothing to put back. Keyed on the
  // payload rather than on the stage, because a restore interrupted after it
  // journalled `restoring` must take this same branch when it is retried.
  if (token.afterCommit === null) {
    await finalize(token, store, options, { dropSelector: null })
    return { kind: 'restored', stashApplied: false, stashDropped: false, indexRestored: true }
  }

  // 1. Already restored? Tree *and* HEAD must both match — verifyRestored ignores
  //    HEAD, so a clean read-only review of HEAD used to finalize while still
  //    detached (review 004 B1). Check before discard so a retried restore
  //    cannot wipe a tree a previous partial restore already put back.
  let stashApplied = false
  let indexRestored = true
  const expected = { tree: token.afterTree, statusDigest: token.statusDigest }
  let verification = await verifyRestored(repoRoot, expected, options)
  const entry = token.stashMessage === null
    ? null
    : await findStashByMessage(repoRoot, token.stashMessage, options)
  const headSettled = token.checkedOut === null
    || sameHead(await readHeadPosition(repoRoot, options), token.headBefore)

  if (verification.ok && headSettled) {
    token = await persistToken(store, token)
    const dropped = await finalize(token, store, options, { dropSelector: entry?.selector ?? null })
    return { kind: 'restored', stashApplied: false, stashDropped: dropped, indexRestored: true }
  }

  // 2. Apply mode left real-file writes on `base`. Only when the tree is not
  //    already back — never with a bare `clean -fd`, and never when we only
  //    need to reattach HEAD (review 004 B1 fall-through).
  if (token.mode === 'apply' && !verification.ok) {
    const discardFailure = await discardApplyWrites(token, options)
    if (discardFailure !== null)
      return discardFailure
  }

  // 3. Put HEAD back where it was, if the session moved it.
  if (token.checkedOut !== null && !headSettled) {
    const target = token.headBefore.kind === 'branch'
      ? ['checkout', token.headBefore.name]
      : ['checkout', '--detach', token.headBefore.sha]
    const result = await tryGit(repoRoot, target, options)
    if (result.code !== 0) {
      return blocked(token, 'checkout-failed', `Could not return HEAD to ${describeHead(token.headBefore)}.`, result.stderr)
    }
  }

  // 4. Re-apply the stashed work, unless it is already back.
  verification = await verifyRestored(repoRoot, expected, options)

  if (!verification.ok) {
    const backupExists = token.backupRef !== null && await resolveRef(repoRoot, token.backupRef, options) !== null
    const applyRev = entry?.selector ?? (backupExists && token.backupRef !== null ? token.backupRef : null)

    if (applyRev === null) {
      if (token.backupCommit === null) {
        return blocked(token, 'verification-failed', 'The working tree does not match what Tabthrough captured, and no stash was ever created.', '')
      }
      return blocked(token, 'backup-missing', 'The stash entry and the backup ref are both gone.', '')
    }

    const apply = await stashApply(repoRoot, applyRev, options)
    if (!apply.ok) {
      return blocked(
        token,
        apply.conflict ? 'apply-conflict' : 'verification-failed',
        apply.conflict
          ? 'Restoring your work hit a merge conflict. Nothing was discarded.'
          : 'Restoring your work failed.',
        apply.stderr,
      )
    }

    stashApplied = true
    indexRestored = apply.indexRestored
    verification = await verifyRestored(repoRoot, expected, options)
  }

  // 5. Verify, and only then drop.
  if (!verification.ok) {
    return blocked(
      token,
      verification.treeMatches ? 'index-split-mismatch' : 'verification-failed',
      verification.treeMatches
        ? 'Your files are back, but the staged / unstaged split could not be reproduced.'
        : 'The restored working tree does not match what Tabthrough captured.',
      '',
    )
  }

  token = await persistToken(store, token)
  const dropped = await finalize(token, store, options, { dropSelector: entry?.selector ?? null })

  return { kind: 'restored', stashApplied, stashDropped: dropped, indexRestored }
}

export type FinishKeepOutcome
  = | {
    readonly kind: 'kept'
    readonly carried: boolean
    readonly message: string
    readonly token: SessionToken
  }
  | {
    readonly kind: 'blocked'
    readonly message: string
    readonly commands: readonly string[]
    readonly token: SessionToken
  }

export interface FinishKeepArgs {
  readonly token: SessionToken
  readonly store: TokenStore
  /** Deliberately no `signal`: Finish must not abort mid-carry. */
  readonly exec?: GitOptions['exec']
}

/**
 * Apply-mode Finish (ADR 0004 D6): keep the working tree, carry HEAD back to
 * `headBefore` without `-f`, journal `done-kept`, release the lock. Never
 * stash-applies the pre-session backup. Refs stay until explicit cleanup.
 */
export async function finishKeepFromToken(args: FinishKeepArgs): Promise<FinishKeepOutcome> {
  const { store } = args
  const options: GitOptions = { exec: args.exec }
  const writeOptions: GitOptions = { exec: args.exec }
  const repoRoot = args.token.repoRoot
  let token = args.token

  try {
    const checkpoint = await writeAppliedCheckpoint(repoRoot, token.sessionId, writeOptions)
    token = await persistToken(store, { ...token, appliedRef: checkpoint.ref })
  }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      kind: 'blocked',
      message: `Could not checkpoint the applied tree before Finish. ${detail}`.trim(),
      commands: recoveryCommands(token),
      token,
    }
  }

  token = await advanceStage(store, token, 'finishing-keep')

  let carried = true
  let carryDetail = ''
  if (token.checkedOut !== null) {
    const head = await readHeadPosition(repoRoot, options)
    if (!sameHead(head, token.headBefore)) {
      // Stage first so `checkout` can carry WT changes. Plain dirty worktrees
      // are refused even when the bytes already match the branch tip (R-apply-2).
      // Never `-f`.
      const staged = await tryGit(repoRoot, ['add', '-A'], options)
      if (staged.code !== 0) {
        carried = false
        carryDetail = staged.stderr.trim() === ''
          ? 'Could not stage applied changes before returning to the previous branch.'
          : `Could not stage applied changes before returning to the previous branch. ${staged.stderr.trim()}`
      }
      else {
        const target = token.headBefore.kind === 'branch'
          ? ['checkout', token.headBefore.name]
          : ['checkout', '--detach', token.headBefore.sha]
        const result = await tryGit(repoRoot, target, options)
        if (result.code !== 0) {
          carried = false
          carryDetail = result.stderr.trim() === ''
            ? `Could not return HEAD to ${describeHead(token.headBefore)} while keeping your changes.`
            : `Could not return HEAD to ${describeHead(token.headBefore)} while keeping your changes. ${result.stderr.trim()}`
        }
      }
    }
  }

  if (token.lockValue !== null) {
    await releaseLock(repoRoot, token.lockValue, writeOptions)
    token = await persistToken(store, { ...token, lockValue: null })
  }

  token = await advanceStage(store, token, 'done-kept')

  const backupNote = describeKeptBackupNote(token)

  if (carried) {
    return {
      kind: 'kept',
      carried: true,
      message: `Walkthrough finished. Your applied changes are kept in the working tree. ${backupNote}`,
      token,
    }
  }

  return {
    kind: 'kept',
    carried: false,
    message: [
      carryDetail,
      'Your applied changes are still in the working tree (kept). Stay detached and commit from here, or resolve the checkout and switch branches manually.',
      backupNote,
    ].filter(part => part !== '').join(' '),
    token,
  }
}

/** R-apply-3: name the stash restore route, not only Clean Up Backups. */
function describeKeptBackupNote(token: SessionToken): string {
  if (token.backupRef === null)
    return 'Commit when ready.'

  const stashHint = token.stashMessage === null
    ? `git stash apply ${token.backupRef}`
    : `git stash apply ${token.backupRef} (stash message "${token.stashMessage}")`

  return [
    `Pre-session WIP remains in the backup stash — restore it over the kept tree with: ${stashHint}.`,
    'Cancel is no longer the restore path.',
    'Clean Up Backups removes Tabthrough refs only after you confirm.',
  ].join(' ')
}

async function finalize(
  token: SessionToken,
  store: TokenStore,
  options: GitOptions,
  args: { readonly dropSelector: string | null },
): Promise<boolean> {
  const dropped = args.dropSelector === null ? false : await stashDrop(token.repoRoot, args.dropSelector, options)

  // Unconditional, because the after-ref is written before the journal records
  // its commit: a crash in that window leaves a ref the token cannot name.
  await deleteRef(token.repoRoot, token.afterRef, token.afterCommit ?? undefined, options)
  if (token.backupRef !== null && token.backupCommit !== null)
    await deleteRef(token.repoRoot, token.backupRef, token.backupCommit, options)
  if (token.appliedRef !== null) {
    const appliedSha = await resolveRef(token.repoRoot, token.appliedRef, options)
    if (appliedSha !== null)
      await deleteRef(token.repoRoot, token.appliedRef, appliedSha, options)
  }
  if (token.lockValue !== null)
    await releaseLock(token.repoRoot, token.lockValue, options)

  await store.writeToken(withStage(token, 'done'))
  await store.clearToken(token.repoRoot)
  return dropped
}

function blocked(
  token: SessionToken,
  reason: RestoreBlockReason,
  message: string,
  detail: string,
): RestoreOutcome {
  return {
    kind: 'blocked',
    reason,
    message: detail.trim() === '' ? message : `${message} ${detail.trim()}`,
    commands: recoveryCommands(token),
    token,
  }
}

/** The literal git the user can run to finish the job by hand (invariant W5). */
export function recoveryCommands(token: SessionToken): readonly string[] {
  const commands: string[] = []
  if (token.headBefore.kind === 'branch')
    commands.push(`git checkout ${token.headBefore.name}`)
  else
    commands.push(`git checkout --detach ${token.headBefore.sha}`)
  if (token.stashMessage !== null)
    commands.push('git stash list')
  if (token.backupRef !== null)
    commands.push(`git stash apply --index ${token.backupRef}`)
  commands.push(`git for-each-ref ${token.afterRef.split('/').slice(0, 2).join('/')}`)
  return commands
}

function sameHead(a: HeadPosition, b: HeadPosition): boolean {
  if (a.kind === 'branch' && b.kind === 'branch')
    return a.name === b.name
  if (a.kind === 'detached' && b.kind === 'detached')
    return a.sha === b.sha
  return false
}

function describeHead(head: HeadPosition): string {
  return head.kind === 'branch' ? head.name : head.sha.slice(0, 8)
}

export interface OrphanRef {
  readonly name: string
  readonly objectName: string
}

/** Refs left behind by a conflicted restore. Never collected automatically. */
export async function listGuideRefs(repoRoot: string, options: GitOptions = {}): Promise<OrphanRef[]> {
  return (await listRefs(repoRoot, undefined, options)).filter(ref => ref.name !== LOCK_REF)
}

export async function cleanupGuideRefs(repoRoot: string, options: GitOptions = {}): Promise<string[]> {
  const removed: string[] = []
  for (const ref of await listGuideRefs(repoRoot, options)) {
    if (await deleteRef(repoRoot, ref.name, ref.objectName, options))
      removed.push(ref.name)
  }
  return removed
}

/**
 * CAS-only lock release for a captured owner. A failed compare-and-swap means
 * the lock changed; this never deletes another session's lock or leftover refs.
 */
export async function clearAbandonedLock(
  repoRoot: string,
  owner: string,
  options: GitOptions = {},
): Promise<readonly string[]> {
  if (await releaseLock(repoRoot, owner, options))
    return [LOCK_REF]
  return []
}

/** Untracked files git reports, used by the pre-flight summary. */
export async function listUntracked(repoRoot: string, options: GitOptions = {}): Promise<string[]> {
  const result = await tryGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], options)
  return result.code === 0 ? splitNul(result.stdout) : []
}
