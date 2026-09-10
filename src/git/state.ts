import type { GitExecResult, GitOptions } from './exec'
import { access, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { splitLines, splitNul, tryGit } from './exec'
import { defaultWorktreeRoot, isUnderRoot, resolveWorktreeRoot } from './paths'
import { readStatus } from './probe'
import { listAfterRefs } from './refs'

/**
 * Git state the sidebar displays (ADR 0005 D5). Buttons run the named command
 * and forward stdout / stderr. Nothing here mutates on its own.
 */

export interface RebaseState {
  readonly branch: string | null
  readonly onto: string | null
  readonly stoppedSha: string | null
  readonly origHead: string | null
  readonly done: number
  readonly total: number
  readonly autostashSha: string | null
}

export type InProgressOperation = 'merge' | 'cherry-pick' | 'revert' | 'bisect'

export interface AutostashEntry {
  readonly selector: string
  readonly subject: string
}

export interface TabthroughWorktree {
  readonly path: string
  readonly head: string
  readonly dirty: boolean
}

export interface GitState {
  readonly rebase: RebaseState | null
  readonly operation: InProgressOperation | null
  readonly conflicts: readonly string[]
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly detached: boolean
  readonly branch: string | null
  readonly headSha: string | null
  readonly autostashes: readonly AutostashEntry[]
  readonly worktrees: readonly TabthroughWorktree[]
  readonly snapshotRefCount: number
}

export interface ReadGitStateOptions extends GitOptions {
  readonly worktreeDir?: string
}

export async function readGitState(repoRoot: string, options: ReadGitStateOptions = {}): Promise<GitState> {
  const status = await readStatus(repoRoot, options)
  const rebase = await readRebaseState(repoRoot, options)
  const operation = rebase === null ? await readOperation(repoRoot, options) : null
  const autostashes = await readAutostashes(repoRoot, options)
  const worktrees = await readTabthroughWorktrees(
    repoRoot,
    resolveWorktreeRoot(options.worktreeDir ?? ''),
    options,
  )
  const afterRefs = await listAfterRefs(repoRoot, options)

  return {
    rebase,
    operation,
    conflicts: status.unmerged,
    staged: status.staged.length,
    unstaged: status.unstaged.length,
    untracked: status.untracked.length,
    detached: status.detached,
    branch: status.branch,
    headSha: status.headSha,
    autostashes,
    worktrees,
    snapshotRefCount: afterRefs.length,
  }
}

export interface GitCommandResult extends GitExecResult {
  readonly command: string
}

export function formatGitCommand(args: readonly string[]): string {
  return `git ${args.join(' ')}`
}

export async function runNamedGit(
  repoRoot: string,
  args: readonly string[],
  options: GitOptions & { env?: Readonly<Record<string, string>> } = {},
): Promise<GitCommandResult> {
  const result = await tryGit(repoRoot, args, options)
  return { command: formatGitCommand(args), ...result }
}

export async function continueRebase(repoRoot: string, options: GitOptions = {}): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['rebase', '--continue'], {
    ...options,
    env: { GIT_EDITOR: 'true' },
  })
}

export async function abortRebase(repoRoot: string, options: GitOptions = {}): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['rebase', '--abort'], options)
}

export async function popAutostash(
  repoRoot: string,
  selector: string,
  options: GitOptions = {},
): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['stash', 'pop', selector], options)
}

export async function showAutostash(
  repoRoot: string,
  selector: string,
  options: GitOptions = {},
): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['stash', 'show', '-p', selector], options)
}

export async function removeWorktree(
  repoRoot: string,
  dir: string,
  options: GitOptions = {},
): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['worktree', 'remove', dir], options)
}

export async function pruneWorktrees(repoRoot: string, options: GitOptions = {}): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['worktree', 'prune'], options)
}

export { defaultWorktreeRoot, resolveWorktreeRoot }

async function readRebaseState(repoRoot: string, options: GitOptions): Promise<RebaseState | null> {
  const mergeDir = await gitPathIfExists(repoRoot, 'rebase-merge', options)
  const applyDir = mergeDir === null ? await gitPathIfExists(repoRoot, 'rebase-apply', options) : null
  const dir = mergeDir ?? applyDir
  if (dir === null)
    return null

  const headName = await readOptionalFile(joinPath(dir, 'head-name'))
  const onto = await readOptionalFile(joinPath(dir, 'onto'))
  const stoppedFile = await readOptionalFile(joinPath(dir, 'stopped-sha'))
  const rebaseHead = (await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'], options)).stdout.trim()
  const stopped = stoppedFile ?? (rebaseHead === '' ? null : rebaseHead)
  const origHead = await readOptionalFile(joinPath(dir, 'orig-head'))
  const autostashSha = await readOptionalFile(joinPath(dir, 'autostash'))
  const msgnum = parseCount(await readOptionalFile(joinPath(dir, 'msgnum')))
  const end = parseCount(await readOptionalFile(joinPath(dir, 'end')))
  const doneLines = countTodoLines(await readOptionalFile(joinPath(dir, 'done')))
  const todoLines = countTodoLines(await readOptionalFile(joinPath(dir, 'git-rebase-todo')))
  const done = msgnum ?? doneLines
  const total = end ?? (doneLines + todoLines)

  return {
    branch: displayHeadName(headName),
    onto,
    stoppedSha: stopped === '' ? null : stopped,
    origHead,
    done,
    total: total === 0 ? Math.max(done, 1) : total,
    autostashSha,
  }
}

async function readOperation(repoRoot: string, options: GitOptions): Promise<InProgressOperation | null> {
  if (await gitPathIfExists(repoRoot, 'MERGE_HEAD', options) !== null)
    return 'merge'
  if (await gitPathIfExists(repoRoot, 'CHERRY_PICK_HEAD', options) !== null)
    return 'cherry-pick'
  if (await gitPathIfExists(repoRoot, 'REVERT_HEAD', options) !== null)
    return 'revert'
  if (await gitPathIfExists(repoRoot, 'BISECT_LOG', options) !== null)
    return 'bisect'
  return null
}

async function readAutostashes(repoRoot: string, options: GitOptions): Promise<readonly AutostashEntry[]> {
  const result = await tryGit(repoRoot, ['stash', 'list', '--format=%gd%x09%s'], options)
  if (result.code !== 0)
    return []
  const entries: AutostashEntry[] = []
  for (const line of splitLines(result.stdout)) {
    const tab = line.indexOf('\t')
    const selector = tab === -1 ? line : line.slice(0, tab)
    const subject = tab === -1 ? '' : line.slice(tab + 1)
    if (subject.endsWith('autostash') || subject.endsWith('autostash)'))
      entries.push({ selector, subject })
  }
  return entries
}

async function readTabthroughWorktrees(
  repoRoot: string,
  worktreeRoot: string,
  options: GitOptions,
): Promise<readonly TabthroughWorktree[]> {
  const result = await tryGit(repoRoot, ['worktree', 'list', '--porcelain'], options)
  if (result.code !== 0)
    return []

  const blocks = result.stdout.split('\n\n')
  const out: TabthroughWorktree[] = []
  for (const block of blocks) {
    const lines = splitLines(block)
    let path: string | null = null
    let head = ''
    for (const line of lines) {
      if (line.startsWith('worktree '))
        path = line.slice('worktree '.length)
      if (line.startsWith('HEAD '))
        head = line.slice('HEAD '.length)
    }
    if (path === null || !isUnderRoot(worktreeRoot, path))
      continue
    const dirty = await worktreeIsDirty(path, options)
    out.push({ path, head, dirty })
  }
  return out
}

async function worktreeIsDirty(path: string, options: GitOptions): Promise<boolean> {
  const result = await tryGit(path, ['status', '--porcelain=v2', '--untracked-files=all', '-z'], options)
  if (result.code !== 0)
    return false
  return splitNul(result.stdout).some(field => field !== '' && !field.startsWith('# '))
}

async function gitPathIfExists(
  repoRoot: string,
  name: string,
  options: GitOptions,
): Promise<string | null> {
  const result = await tryGit(repoRoot, ['rev-parse', '--git-path', name], options)
  if (result.code !== 0)
    return null
  const relative = result.stdout.trim()
  if (relative === '')
    return null
  const absolute = isAbsolute(relative) ? relative : resolve(repoRoot, relative)
  try {
    await access(absolute)
    return absolute
  }
  catch {
    return null
  }
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, 'utf8')).trim()
    return text === '' ? null : text
  }
  catch {
    return null
  }
}

function joinPath(dir: string, name: string): string {
  return resolve(dir, name)
}

function parseCount(raw: string | null): number | null {
  if (raw === null)
    return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function countTodoLines(raw: string | null): number {
  if (raw === null)
    return 0
  return raw.split('\n').filter((line) => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  }).length
}

function displayHeadName(raw: string | null): string | null {
  if (raw === null)
    return null
  if (raw.startsWith('refs/heads/'))
    return raw.slice('refs/heads/'.length)
  return raw
}
