import type { GitOptions } from './exec'
import type { HeadPosition, ReviewTarget } from './types'
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
import { tryGit } from './exec'
import { readStatus } from './probe'
import { afterRefName, deleteRef, listAfterRefs, writeRef } from './refs'
import { captureWorkingState } from './snapshot'

/**
 * Resolve a review target to `(base, after)` and, for working changes, pin a
 * snapshot commit at `refs/tabthrough/after/<id>` (ADR 0005 D1).
 */

export const AFTER_REF_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const READONLY_WILL_RUN = 'nothing'

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

export interface IsolationPlan {
  readonly entry: ReviewTarget
  readonly repoRoot: string
  readonly baseRev: string
  /** `null` means "capture the working tree into the after-commit". */
  readonly afterRev: string | null
  readonly headBefore: HeadPosition
  /**
   * The same count under `git diff -w`. Zero here with a non-zero
   * `changedLineCount` is a whitespace-only diff, which is refused.
   */
  readonly substantiveLineCount: number
  readonly changedLineCount: number
  readonly changedFileCount: number
  readonly willRun: string
}

export interface PlanRequest {
  readonly entry: ReviewTarget
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
 * Stat-only pass. Resolves the immutable `(base, after)` pair and counts
 * changed lines. Touches nothing — not the index, not the working tree, not a
 * single ref.
 */
export async function planIsolation(
  repoRoot: string,
  request: PlanRequest,
  options: GitOptions = {},
): Promise<IsolationPlan> {
  const status = await readStatus(repoRoot, options)
  const headBefore = await readHeadPosition(repoRoot, options)
  const { entry } = request

  if (entry.kind === 'workingTree') {
    const baseRev = await requireCommit(repoRoot, 'HEAD', options)
    const untrackedLineCount = await countUntrackedLines(repoRoot, status.untracked)
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
      headBefore,
      substantiveLineCount,
      changedLineCount,
      changedFileCount: new Set([...status.staged, ...status.unstaged, ...status.untracked]).size,
      willRun: READONLY_WILL_RUN,
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
    headBefore,
    substantiveLineCount,
    changedLineCount,
    changedFileCount: (await tryGit(repoRoot, ['diff', '--name-only', '-z', baseRev, afterRev], options))
      .stdout
      .split('\0')
      .filter(Boolean)
      .length,
    willRun: READONLY_WILL_RUN,
  }
}

/** Root commit → the empty tree; merge commit → first parent. */
async function resolveCommitEntry(
  repoRoot: string,
  rev: string,
  options: GitOptions,
): Promise<{ baseRev: string, afterRev: string }> {
  const afterRev = await requireCommit(repoRoot, rev, options)
  const parent = await resolveCommit(repoRoot, `${afterRev}^1`, options)
  if (parent !== null)
    return { baseRev: parent, afterRev }

  const recorded = await readRecordedParents(repoRoot, afterRev, options)
  if (recorded[0] !== undefined)
    throw new MissingObjectsError(afterRev, recorded[0])

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
  readonly afterRef: string | null
}

export interface BeginReviewArgs {
  readonly repoRoot: string
  readonly sessionId: string
  readonly plan: IsolationPlan
  readonly signal?: AbortSignal
  readonly exec?: GitOptions['exec']
}

/**
 * Working-tree entry: snapshot + after-ref. Commit / range: no write.
 */
export async function beginReview(args: BeginReviewArgs): Promise<IsolationHandle> {
  const options: GitOptions = { signal: args.signal, exec: args.exec }
  const { repoRoot, sessionId, plan } = args

  if (plan.afterRev !== null) {
    return {
      sessionId,
      repoRoot,
      baseRev: plan.baseRev,
      afterRev: plan.afterRev,
      afterRef: null,
    }
  }

  const capture = await captureWorkingState(repoRoot, sessionId, options)
  const afterRef = afterRefName(sessionId)
  await writeRef(repoRoot, afterRef, capture.commit, options)
  return {
    sessionId,
    repoRoot,
    baseRev: plan.baseRev,
    afterRev: capture.commit,
    afterRef,
  }
}

export async function releaseReview(handle: IsolationHandle, options: GitOptions = {}): Promise<void> {
  if (handle.afterRef === null)
    return
  await deleteRef(handle.repoRoot, handle.afterRef, undefined, options)
}

export async function sweepStaleAfterRefs(
  repoRoot: string,
  nowMs: number = Date.now(),
  options: GitOptions = {},
): Promise<readonly string[]> {
  const cutoff = Math.floor(nowMs / 1000) - Math.floor(AFTER_REF_MAX_AGE_MS / 1000)
  const removed: string[] = []
  for (const ref of await listAfterRefs(repoRoot, options)) {
    if (ref.committerUnix === null || ref.committerUnix >= cutoff)
      continue
    if (await deleteRef(repoRoot, ref.name, ref.objectName, options))
      removed.push(ref.name)
  }
  return removed
}
