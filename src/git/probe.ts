import type { GitOptions } from './exec'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { GitMissingError, splitLines, splitNul, tryGit } from './exec'

/**
 * The capability probe (plan P0-1). Returns a discriminated result — never a
 * thrown string — so the bridge can disable Start *with a reason*.
 */

/**
 * `--porcelain=v2`, `stash push`, `--is-shallow-repository` and ref
 * transactions are all present from 2.20, which every supported platform ships.
 */
export const MIN_GIT_VERSION: readonly [number, number, number] = [2, 20, 0]

export type GitCapabilityReason
  = | 'no-workspace'
    | 'git-missing'
    | 'git-too-old'
    | 'not-a-repo'
    | 'bare-repo'
    | 'unborn-head'
    | 'rebase-or-merge-in-progress'
    | 'shallow-missing-objects'

export interface GitCapabilityOk {
  readonly ok: true
  readonly repoRoot: string
  readonly gitDir: string
  readonly headSha: string
  readonly headRef: string | null
  readonly detached: boolean
  readonly shallow: boolean
  readonly dirty: boolean
  readonly gitVersion: string
}

export interface GitCapabilityFail {
  readonly ok: false
  readonly reason: GitCapabilityReason
  readonly message: string
  readonly hint?: string
}

export type GitCapability = GitCapabilityOk | GitCapabilityFail

export interface ProbeOptions extends GitOptions {
  /** Injectable for tests; defaults to `node:fs/promises` access. */
  readonly exists?: (path: string) => Promise<boolean>
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  }
  catch {
    return false
  }
}

/** `git version 2.43.0` → `[2, 43, 0]`. Extra suffixes (`.windows.1`) are ignored. */
export function parseGitVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
  if (!match)
    return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function isAtLeast(actual: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (actual[index] > min[index])
      return true
    if (actual[index] < min[index])
      return false
  }
  return true
}

const BARE_REPO: GitCapabilityFail = {
  ok: false,
  reason: 'bare-repo',
  message: 'Guide Reviewer needs a repository with a working tree.',
  hint: 'Bare repositories have nothing to isolate or restore.',
}

const IN_PROGRESS_PATHS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const

const IN_PROGRESS_LABEL: Readonly<Record<string, string>> = {
  'rebase-merge': 'a rebase',
  'rebase-apply': 'a rebase',
  'MERGE_HEAD': 'a merge',
  'CHERRY_PICK_HEAD': 'a cherry-pick',
  'REVERT_HEAD': 'a revert',
}

export async function probeGit(root: string, options: ProbeOptions = {}): Promise<GitCapability> {
  const exists = options.exists ?? defaultExists

  let version: string
  try {
    const versionResult = await tryGit(root, ['version'], options)
    if (versionResult.code !== 0) {
      return {
        ok: false,
        reason: 'git-missing',
        message: 'Could not run `git`.',
        hint: versionResult.stderr.trim() || undefined,
      }
    }
    version = versionResult.stdout.trim()
  }
  catch (error) {
    if (error instanceof GitMissingError) {
      return {
        ok: false,
        reason: 'git-missing',
        message: 'Guide Reviewer needs `git` on your PATH.',
        hint: 'Install git, or set `git.path` in your VS Code settings.',
      }
    }
    throw error
  }

  const parsed = parseGitVersion(version)
  if (parsed && !isAtLeast(parsed, MIN_GIT_VERSION)) {
    return {
      ok: false,
      reason: 'git-too-old',
      message: `Guide Reviewer needs git ${MIN_GIT_VERSION.join('.')} or newer, found ${parsed.join('.')}.`,
      hint: 'Upgrade git and reload the window.',
    }
  }

  const layout = await tryGit(root, [
    'rev-parse',
    '--show-toplevel',
    '--is-bare-repository',
    '--is-inside-work-tree',
    '--is-shallow-repository',
    '--absolute-git-dir',
  ], options)

  if (layout.code !== 0) {
    // `--show-toplevel` fails inside a bare repository, so the distinction
    // between "no repo here" and "a repo with no working tree" needs a second look.
    const bare = await tryGit(root, ['rev-parse', '--is-bare-repository'], options)
    if (bare.code === 0 && bare.stdout.trim() === 'true')
      return BARE_REPO

    return {
      ok: false,
      reason: 'not-a-repo',
      message: 'This folder is not inside a git repository.',
      hint: 'Run `git init`, or open a folder that is part of a repository.',
    }
  }

  const [topLevel, isBare, insideWorkTree, isShallow, gitDir] = splitLines(layout.stdout)
  if (isBare === 'true' || insideWorkTree !== 'true')
    return BARE_REPO

  const repoRoot = topLevel ?? root

  const inProgress = await findOperationInProgress(repoRoot, exists, options)
  if (inProgress) {
    return {
      ok: false,
      reason: 'rebase-or-merge-in-progress',
      message: `Finish or abort ${IN_PROGRESS_LABEL[inProgress] ?? 'the operation'} in progress first.`,
      hint: 'Guide Reviewer refuses to stash on top of an unfinished git operation.',
    }
  }

  const head = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options)
  const headSha = head.stdout.trim()
  if (head.code !== 0 || headSha === '') {
    return {
      ok: false,
      reason: 'unborn-head',
      message: 'This repository has no commits yet.',
      hint: 'Make a first commit — Guide Reviewer anchors every backup to HEAD.',
    }
  }

  const symbolic = await tryGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)
  const headRef = symbolic.code === 0 ? symbolic.stdout.trim() || null : null

  const status = await readStatus(repoRoot, options)

  return {
    ok: true,
    repoRoot,
    gitDir: gitDir ?? repoRoot,
    headSha,
    headRef,
    detached: headRef === null,
    shallow: isShallow === 'true',
    dirty: !status.clean,
    gitVersion: version,
  }
}

async function findOperationInProgress(
  repoRoot: string,
  exists: (path: string) => Promise<boolean>,
  options: GitOptions,
): Promise<string | null> {
  const args = ['rev-parse', ...IN_PROGRESS_PATHS.flatMap(name => ['--git-path', name])]
  const result = await tryGit(repoRoot, args, options)
  if (result.code !== 0)
    return null

  const paths = splitLines(result.stdout)
  for (let index = 0; index < IN_PROGRESS_PATHS.length; index++) {
    const candidate = paths[index]
    if (candidate === undefined)
      continue
    const absolute = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate)
    if (await exists(absolute))
      return IN_PROGRESS_PATHS[index]
  }
  return null
}

export interface RepoStatusEntry {
  readonly path: string
  readonly oldPath?: string
  /** Porcelain v2 `XY`: index status then worktree status; `.` means unmodified. */
  readonly indexStatus: string
  readonly worktreeStatus: string
  readonly kind: 'tracked' | 'untracked' | 'ignored' | 'unmerged'
}

export interface RepoStatus {
  readonly branch: string | null
  readonly headSha: string | null
  readonly detached: boolean
  readonly entries: readonly RepoStatusEntry[]
  readonly staged: readonly string[]
  readonly unstaged: readonly string[]
  readonly untracked: readonly string[]
  readonly unmerged: readonly string[]
  readonly clean: boolean
}

const STATUS_ARGS = ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z'] as const

export async function readStatus(repoRoot: string, options: GitOptions = {}): Promise<RepoStatus> {
  const result = await tryGit(repoRoot, STATUS_ARGS, options)
  if (result.code !== 0)
    return parseStatus('')
  return parseStatus(result.stdout)
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * Records are NUL-terminated. A `2` (rename/copy) record spans two fields: the
 * record itself, then the pre-image path.
 */
export function parseStatus(raw: string): RepoStatus {
  const fields = splitNul(raw)

  let branch: string | null = null
  let headSha: string | null = null
  let detached = false
  const entries: RepoStatusEntry[] = []

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (field === undefined || field === '')
      continue

    if (field.startsWith('# ')) {
      const [, key, ...rest] = field.split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid')
        headSha = value === '(initial)' ? null : value
      if (key === 'branch.head') {
        detached = value === '(detached)'
        branch = detached ? null : value
      }
      continue
    }

    const marker = field[0]
    if (marker === '1') {
      const parts = field.split(' ')
      const xy = parts[1] ?? '..'
      entries.push({
        path: parts.slice(8).join(' '),
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        kind: 'tracked',
      })
    }
    else if (marker === '2') {
      const parts = field.split(' ')
      const xy = parts[1] ?? '..'
      const oldPath = fields[++index] ?? ''
      entries.push({
        path: parts.slice(9).join(' '),
        oldPath,
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        kind: 'tracked',
      })
    }
    else if (marker === 'u') {
      const parts = field.split(' ')
      const xy = parts[1] ?? '..'
      entries.push({
        path: parts.slice(10).join(' '),
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        kind: 'unmerged',
      })
    }
    else if (marker === '?') {
      entries.push({ path: field.slice(2), indexStatus: '?', worktreeStatus: '?', kind: 'untracked' })
    }
    else if (marker === '!') {
      entries.push({ path: field.slice(2), indexStatus: '!', worktreeStatus: '!', kind: 'ignored' })
    }
  }

  const staged: string[] = []
  const unstaged: string[] = []
  const untracked: string[] = []
  const unmerged: string[] = []

  for (const entry of entries) {
    if (entry.kind === 'untracked') {
      untracked.push(entry.path)
    }
    else if (entry.kind === 'unmerged') {
      unmerged.push(entry.path)
    }
    else if (entry.kind === 'tracked') {
      if (entry.indexStatus !== '.')
        staged.push(entry.path)
      if (entry.worktreeStatus !== '.')
        unstaged.push(entry.path)
    }
  }

  return {
    branch,
    headSha,
    detached,
    entries,
    staged,
    unstaged,
    untracked,
    unmerged,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && unmerged.length === 0,
  }
}
