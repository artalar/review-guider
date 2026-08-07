import type { GitOptions } from './exec'
import type { SessionToken, TokenStore } from './journal'
import type { HeadPosition, PreflightRequest, ReviewTarget } from './types'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
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
  if (entry.kind === 'workingTree') {
    const baseRev = await requireCommit(repoRoot, 'HEAD', options)
    const untrackedLineCount = await countUntrackedLines(repoRoot, untracked)
    const changedLineCount
      = await countWorkingTreeChangedLines(repoRoot, baseRev, options)
        + untrackedLineCount
    const substantiveLineCount
      = await countWorkingTreeChangedLines(repoRoot, baseRev, { ...options, ignoreWhitespace: true })
        + untrackedLineCount

    return {
      entry,
      repoRoot,
      baseRev,
      afterRev: null,
      checkout: null,
      needsStash,
      headBefore,
      substantiveLineCount,
      preflight: {
        entry,
        repoRoot,
        changedFileCount: new Set([...status.staged, ...status.unstaged, ...untracked]).size,
        changedLineCount,
        willStash: needsStash,
        willCheckout: null,
        files,
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

  return {
    entry,
    repoRoot,
    baseRev,
    afterRev,
    checkout: afterRev,
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
      willCheckout: afterRev,
      files,
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
  readonly token: SessionToken
}

export interface IsolateArgs {
  readonly repoRoot: string
  readonly sessionId: string
  readonly plan: IsolationPlan
  readonly store: TokenStore
  readonly includeUntracked: boolean
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
  }
  await store.writeToken(token)

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

    // 3. Checkout. Skipped for the working-tree entry, whose content already
    //    lives in the after-commit.
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

  // 1. Put HEAD back where it was, if the session moved it.
  if (token.checkedOut !== null) {
    const head = await readHeadPosition(repoRoot, options)
    if (!sameHead(head, token.headBefore)) {
      const target = token.headBefore.kind === 'branch'
        ? ['checkout', token.headBefore.name]
        : ['checkout', '--detach', token.headBefore.sha]
      const result = await tryGit(repoRoot, target, options)
      if (result.code !== 0) {
        return blocked(token, 'checkout-failed', `Could not return HEAD to ${describeHead(token.headBefore)}.`, result.stderr)
      }
    }
  }

  // 2. Re-apply the stashed work, unless it is already back.
  let stashApplied = false
  let indexRestored = true
  const expected = { tree: token.afterTree, statusDigest: token.statusDigest }
  let verification = await verifyRestored(repoRoot, expected, options)
  const entry = token.stashMessage === null
    ? null
    : await findStashByMessage(repoRoot, token.stashMessage, options)

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

  // 3. Verify, and only then drop.
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

/** Untracked files git reports, used by the pre-flight summary. */
export async function listUntracked(repoRoot: string, options: GitOptions = {}): Promise<string[]> {
  const result = await tryGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'], options)
  return result.code === 0 ? splitNul(result.stdout) : []
}
