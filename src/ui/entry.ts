import type { QuickPickItem } from 'vscode'
import type { CommitSummary } from '../git/log'
import type { ReviewTarget } from '../git/types'
import { wrap } from '@reatom/core'
import { window } from 'vscode'
import { DEFAULT_COMMIT_LIMIT, readRecentCommits } from '../git/log'
import { parseRangeInput, rangeInputError } from '../git/types'
import { gitCapability } from '../model/session'

/**
 * The two Phase 4 entry points that need to ask the user something. Both hand
 * the model a plain {@link ReviewTarget}; nothing here knows what happens next.
 */

interface CommitItem extends QuickPickItem {
  /** Absent on the "type a ref" escape hatch. */
  readonly rev?: string
}

const TYPE_A_REF = '$(edit) Enter a commit, tag, or ref…'

function toItem(commit: CommitSummary): CommitItem {
  const merge = commit.parentCount > 1 ? ' · merge' : ''
  return {
    label: commit.subject === '' ? commit.shortSha : commit.subject,
    description: commit.shortSha,
    detail: `${commit.author} · ${commit.relativeDate}${merge}`,
    rev: commit.sha,
  }
}

async function resolveRepoRoot(): Promise<string | null> {
  const capability = await wrap(gitCapability())
  return capability !== null && capability.ok ? capability.repoRoot : null
}

/**
 * Recent history as a pick list, with a free-text escape hatch for anything
 * older or for a tag. A merge commit is labelled as one, because it is
 * reviewed against its first parent and that is worth knowing before starting.
 */
export async function pickCommitEntry(): Promise<ReviewTarget | null> {
  const repoRoot = await resolveRepoRoot()
  if (repoRoot === null)
    return null

  const commits = await wrap(readRecentCommits(repoRoot, { limit: DEFAULT_COMMIT_LIMIT }))
  const items: CommitItem[] = [{ label: TYPE_A_REF, alwaysShow: true }, ...commits.map(toItem)]

  const picked = await wrap(window.showQuickPick(items, {
    title: 'Guide Reviewer: Review a Commit',
    placeHolder: commits.length === 0
      ? 'No history yet — enter a commit, tag, or ref'
      : 'Pick a commit to review against its first parent',
    matchOnDescription: true,
    matchOnDetail: true,
  }))
  if (picked === undefined)
    return null
  if (picked.rev !== undefined)
    return { kind: 'commit', rev: picked.rev }

  const typed = await wrap(window.showInputBox({
    title: 'Guide Reviewer: Review a Commit',
    prompt: 'Commit SHA, tag, or ref. A root commit is reviewed against the empty tree; a merge against its first parent.',
    placeHolder: 'HEAD~1',
    validateInput: value => (value.trim() === '' ? 'Enter a commit, tag, or ref.' : undefined),
  }))
  const rev = typed?.trim() ?? ''
  return rev === '' ? null : { kind: 'commit', rev }
}

export async function promptRangeEntry(): Promise<ReviewTarget | null> {
  const raw = await wrap(window.showInputBox({
    title: 'Guide Reviewer: Review a Commit Range',
    prompt: 'A..B and A...B both review B against merge-base(A, B), so commits only on A are excluded.',
    placeHolder: 'main..HEAD',
    validateInput: value => rangeInputError(value) ?? undefined,
  }))
  if (raw === undefined)
    return null

  const range = parseRangeInput(raw)
  return range === null ? null : { kind: 'range', from: range.from, to: range.to }
}
