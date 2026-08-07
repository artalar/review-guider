import type { GitOptions } from './exec'
import type { RepoStatus } from './probe'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from './exec'
import { readStatus } from './probe'

/**
 * Capture-before-mutate (architecture/overview.md §3.5.1).
 *
 * A temp-index snapshot writes the entire working state — tracked edits *and*
 * untracked files — into one immutable commit without touching the real index
 * or the working tree. `git add -A` honours `.gitignore`, so ignored files are
 * never swept (plan R8).
 */

const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Guide Reviewer',
  GIT_AUTHOR_EMAIL: 'guide-reviewer@localhost',
  GIT_COMMITTER_NAME: 'Guide Reviewer',
  GIT_COMMITTER_EMAIL: 'guide-reviewer@localhost',
}

export interface WorkingStateCapture {
  readonly tree: string
  readonly commit: string
}

/**
 * Writes the working tree into a tree object using a throwaway index.
 *
 * Deterministic: the resulting tree is a function of the working tree content
 * alone, which is what makes it usable both as the capture and as the restore
 * verification.
 */
export async function writeWorkingTree(repoRoot: string, options: GitOptions = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guide-reviewer-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    await runGit(repoRoot, ['read-tree', 'HEAD'], { ...options, env })
    await runGit(repoRoot, ['add', '-A'], { ...options, env })
    return (await runGit(repoRoot, ['write-tree'], { ...options, env })).trim()
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The after-commit: the working state anchored to a real commit parented at HEAD. */
export async function captureWorkingState(
  repoRoot: string,
  sessionId: string,
  options: GitOptions = {},
): Promise<WorkingStateCapture> {
  const tree = await writeWorkingTree(repoRoot, options)
  const commit = (await runGit(
    repoRoot,
    ['commit-tree', tree, '-p', 'HEAD', '-m', `guide-reviewer after ${sessionId}`],
    { ...options, env: IDENTITY },
  )).trim()
  return { tree, commit }
}

/**
 * Canonical form of the porcelain status: the staged / unstaged / untracked
 * split, with the branch headers dropped so the digest survives a detached
 * HEAD in between. Sorted, so it does not depend on git's traversal order.
 */
export function canonicalStatus(status: RepoStatus): string {
  return status.entries
    .filter(entry => entry.kind !== 'ignored')
    .map(entry => `${entry.kind}\t${entry.indexStatus}${entry.worktreeStatus}\t${entry.path}\t${entry.oldPath ?? ''}`)
    .sort()
    .join('\n')
}

export function digestStatus(status: RepoStatus): string {
  return `sha256:${createHash('sha256').update(canonicalStatus(status)).digest('hex')}`
}

export async function readStatusDigest(repoRoot: string, options: GitOptions = {}): Promise<string> {
  return digestStatus(await readStatus(repoRoot, options))
}

export interface VerificationResult {
  readonly ok: boolean
  readonly treeMatches: boolean
  readonly statusMatches: boolean
  readonly actualTree: string
  readonly actualStatusDigest: string
}

/**
 * Restore verification: the recomputed working tree must equal the captured
 * after-tree byte for byte, *and* the staged / unstaged / untracked split must
 * match what was recorded before the stash. Only both together permit a drop.
 */
export async function verifyRestored(
  repoRoot: string,
  expected: { readonly tree: string | null, readonly statusDigest: string | null },
  options: GitOptions = {},
): Promise<VerificationResult> {
  const actualTree = await writeWorkingTree(repoRoot, options)
  const actualStatusDigest = await readStatusDigest(repoRoot, options)
  const treeMatches = expected.tree !== null && expected.tree === actualTree
  const statusMatches = expected.statusDigest !== null && expected.statusDigest === actualStatusDigest
  return {
    ok: treeMatches && statusMatches,
    treeMatches,
    statusMatches,
    actualTree,
    actualStatusDigest,
  }
}
