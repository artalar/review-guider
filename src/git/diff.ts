import type { NameStatusEntry } from '../guide/types'
import type { GitOptions } from './exec'
import { parseNameStatusZ } from '../guide/parse-diff'
import { runGit, splitLines, tryGit } from './exec'

/**
 * Frozen read invocations. The guide digest depends on these staying stable —
 * see architecture/overview.md §3.4.
 */
const PATCH_ARGS = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U3', '--patch'] as const
const NAME_STATUS_ARGS = ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '--name-status', '-z'] as const

export interface RawDiff {
  readonly patch: string
  readonly nameStatus: readonly NameStatusEntry[]
}

export async function readPatch(repoRoot: string, base: string, after: string, options: GitOptions = {}): Promise<string> {
  return await runGit(repoRoot, [...PATCH_ARGS, base, after], options)
}

export async function readNameStatus(
  repoRoot: string,
  base: string,
  after: string,
  options: GitOptions = {},
): Promise<NameStatusEntry[]> {
  return parseNameStatusZ(await runGit(repoRoot, [...NAME_STATUS_ARGS, base, after], options))
}

export async function readDiff(repoRoot: string, base: string, after: string, options: GitOptions = {}): Promise<RawDiff> {
  return {
    patch: await readPatch(repoRoot, base, after, options),
    nameStatus: await readNameStatus(repoRoot, base, after, options),
  }
}

/** Reads a file's content at a revision. Returns `null` when the path is absent there. */
export async function showBlob(
  repoRoot: string,
  rev: string,
  path: string,
  options: GitOptions = {},
): Promise<string | null> {
  const result = await tryGit(repoRoot, ['cat-file', 'blob', `${rev}:${path}`], options)
  return result.code === 0 ? result.stdout : null
}

/** Resolves a revision to a commit sha, or `null` when it does not exist. */
export async function resolveCommit(repoRoot: string, rev: string, options: GitOptions = {}): Promise<string | null> {
  const result = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], options)
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : null
}

/**
 * The parents recorded in the commit object itself.
 *
 * `rev-parse <sha>^1` and `log --format=%P` both honour the shallow graft, so a
 * boundary commit in a shallow clone reports as parentless — indistinguishable
 * from a genuine root commit, and diffing it against the empty tree would show
 * the whole repository as added. The raw object still carries its `parent`
 * lines, which is what separates "has no parent" from "the parent was never
 * fetched".
 */
export async function readRecordedParents(
  repoRoot: string,
  rev: string,
  options: GitOptions = {},
): Promise<string[]> {
  const result = await tryGit(repoRoot, ['cat-file', 'commit', rev], options)
  if (result.code !== 0)
    return []

  const parents: string[] = []
  for (const line of result.stdout.split('\n')) {
    // The header ends at the first blank line; the message may say anything.
    if (line === '')
      break
    if (line.startsWith('parent '))
      parents.push(line.slice('parent '.length).trim())
  }
  return parents
}

export async function isShallowRepository(repoRoot: string, options: GitOptions = {}): Promise<boolean> {
  const result = await tryGit(repoRoot, ['rev-parse', '--is-shallow-repository'], options)
  return result.code === 0 && result.stdout.trim() === 'true'
}

export async function mergeBase(repoRoot: string, a: string, b: string, options: GitOptions = {}): Promise<string | null> {
  const result = await tryGit(repoRoot, ['merge-base', a, b], options)
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : null
}

export interface CountOptions extends GitOptions {
  /**
   * Adds `-w`. A count of zero under this flag is the plan's definition of a
   * whitespace-only diff, which blocks the start rather than opening a review
   * with nothing in it.
   */
  readonly ignoreWhitespace?: boolean
}

function numstatArgs(options: CountOptions): string[] {
  return [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '-M',
    '--numstat',
    ...(options.ignoreWhitespace === true ? ['-w'] : []),
  ]
}

/**
 * Total added + deleted lines between two revisions. Binary files contribute
 * `-`/`-` in numstat and are counted as one changed line each so they stay
 * visible in the pre-flight summary.
 */
export async function countChangedLines(
  repoRoot: string,
  base: string,
  after: string,
  options: CountOptions = {},
): Promise<number> {
  return sumNumstat(await runGit(repoRoot, [...numstatArgs(options), base, after], options))
}

/** Same count, but for the tracked part of the working tree against a revision. */
export async function countWorkingTreeChangedLines(
  repoRoot: string,
  base: string,
  options: CountOptions = {},
): Promise<number> {
  return sumNumstat(await runGit(repoRoot, [...numstatArgs(options), base], options))
}

export function sumNumstat(raw: string): number {
  let total = 0
  for (const line of splitLines(raw)) {
    const [added, deleted] = line.split('\t')
    if (added === '-' || deleted === '-') {
      total += 1
      continue
    }
    total += Number(added ?? 0) + Number(deleted ?? 0)
  }
  return total
}
