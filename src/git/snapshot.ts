import type { RawDiff } from './diff'
import type { GitOptions } from './exec'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDiff } from './diff'
import { runGit } from './exec'

/**
 * Temp-index snapshot (ADR 0005 D1): writes tracked edits and untracked files
 * into one immutable commit without touching the real index or the working
 * tree. `git add -A` honours `.gitignore`.
 */

const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Tabthrough',
  GIT_AUTHOR_EMAIL: 'tabthrough@localhost',
  GIT_COMMITTER_NAME: 'Tabthrough',
  GIT_COMMITTER_EMAIL: 'tabthrough@localhost',
}

export interface WorkingStateCapture {
  readonly tree: string
  readonly commit: string
}

export async function writeWorkingTree(repoRoot: string, options: GitOptions = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tabthrough-'))
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

/**
 * The working-tree patch Start will see: tracked edits plus untracked files
 * (`add -A` on a throwaway index), without writing a commit or a ref.
 */
export async function readWorkingTreeCaptureDiff(
  repoRoot: string,
  base: string,
  options: GitOptions = {},
): Promise<RawDiff> {
  const tree = await writeWorkingTree(repoRoot, options)
  return readDiff(repoRoot, base, tree, options)
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
    ['commit-tree', tree, '-p', 'HEAD', '-m', `tabthrough after ${sessionId}`],
    { ...options, env: IDENTITY },
  )).trim()
  return { tree, commit }
}
