import type { GitOptions } from './exec'
import { splitNul, tryGit } from './exec'
import { commitRevError } from './types'

/** Recent history, for the commit picker. Read-only, and never fails a start. */

export interface CommitSummary {
  readonly sha: string
  readonly shortSha: string
  readonly subject: string
  readonly author: string
  /** Git's own `%ar`, e.g. "3 days ago". */
  readonly relativeDate: string
  readonly parentCount: number
}

const UNIT = '\u001F'
const FORMAT = ['%H', '%h', '%s', '%an', '%ar', '%P'].join(UNIT)

export const DEFAULT_COMMIT_LIMIT = 50

export interface LogOptions extends GitOptions {
  readonly limit?: number
  readonly rev?: string
}

/**
 * `-z` makes git terminate each entry with NUL, so a subject containing a
 * newline cannot be mistaken for the next commit.
 */
export async function readRecentCommits(repoRoot: string, options: LogOptions = {}): Promise<CommitSummary[]> {
  const limit = options.limit ?? DEFAULT_COMMIT_LIMIT
  const rev = options.rev
  if (rev !== undefined && commitRevError(rev) !== null)
    return []

  const args = ['log', '--no-color', '-z', `--max-count=${limit}`, `--format=${FORMAT}`]
  if (rev !== undefined)
    args.push(rev)

  const result = await tryGit(
    repoRoot,
    args,
    options,
  )
  // An unborn branch has no history to offer; that is not an error here.
  if (result.code !== 0)
    return []

  const commits: CommitSummary[] = []
  for (const record of splitNul(result.stdout)) {
    const [sha, shortSha, subject, author, relativeDate, parents] = record.split(UNIT)
    if (sha === undefined || sha === '' || shortSha === undefined)
      continue
    commits.push({
      sha,
      shortSha,
      subject: subject ?? '',
      author: author ?? '',
      relativeDate: relativeDate ?? '',
      parentCount: (parents ?? '').trim() === '' ? 0 : (parents ?? '').trim().split(/\s+/).length,
    })
  }
  return commits
}
