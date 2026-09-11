import type { GitOptions } from './exec'
import type { GitCommandResult, RebaseState } from './state'
import type { ReviewTarget } from './types'
import { resolveCommit } from './diff'
import { tryGit } from './exec'
import { readStatus } from './probe'
import { shaMatches } from './sequence-todo'
import { formatGitCommand, readGitState, runNamedGit } from './state'

export interface FinishPolicy {
  readonly hooks: boolean
  readonly sign: boolean
}

export interface RebaseOwnership {
  readonly ours: boolean
  readonly rebase: RebaseState | null
}

export interface StartRebaseArgs {
  readonly repoRoot: string
  readonly base: string
  readonly after: string
  readonly hooks: boolean
  readonly sign: boolean
  readonly execPath: string
  readonly sequenceEditor: string
  readonly sequenceEditorArgs?: readonly string[]
  readonly options?: GitOptions
}

export interface FinishRebaseArgs {
  readonly repoRoot: string
  readonly hooks: boolean
  readonly sign: boolean
  readonly stageUntracked: readonly string[]
  readonly options?: GitOptions
  readonly from?: 'add' | 'amend'
}

export type RebaseRefuseReason = 'not-ancestor' | 'merge-after' | 'merge-above' | 'in-progress'

export type FinishRebaseFailureKind = 'hooks-or-sign' | 'conflict' | 'git'

export type FinishRebaseResult
  = | { readonly ok: true, readonly results: readonly GitCommandResult[] }
    | {
      readonly ok: false
      readonly failed: GitCommandResult
      readonly kind: FinishRebaseFailureKind
      readonly results: readonly GitCommandResult[]
    }

const REBASE_TIMEOUT_MS = 120_000

export function rebaseBypassFlags(hooks: boolean, sign: boolean): readonly string[] {
  const flags: string[] = []
  if (!hooks)
    flags.push('--no-verify')
  if (!sign)
    flags.push('--no-gpg-sign')
  return flags
}

export function rebaseStartArgs(base: string, hooks: boolean, sign: boolean): readonly string[] {
  return ['rebase', '-i', '--autostash', '--no-autosquash', ...rebaseBypassFlags(hooks, sign), base]
}

export function formatRebaseCommand(base: string, hooks: boolean, sign: boolean): string {
  return formatGitCommand(rebaseStartArgs(base, hooks, sign))
}

export function formatSequenceEditor(
  execPath: string,
  script: string,
  afterSha: string,
  extraArgs: readonly string[] = [],
): string {
  return [quoteArg(execPath), ...extraArgs.map(quoteArg), quoteArg(script), afterSha].join(' ')
}

export async function isAncestor(
  repoRoot: string,
  after: string,
  head = 'HEAD',
  options: GitOptions = {},
): Promise<boolean> {
  const result = await tryGit(repoRoot, ['merge-base', '--is-ancestor', after, head], options)
  return result.code === 0
}

export async function countCommitsAfter(
  repoRoot: string,
  after: string,
  options: GitOptions = {},
): Promise<number> {
  const result = await tryGit(repoRoot, ['rev-list', '--count', `${after}..HEAD`], options)
  if (result.code !== 0)
    return 0
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

export async function isMergeCommit(
  repoRoot: string,
  rev: string,
  options: GitOptions = {},
): Promise<boolean> {
  const result = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^2`], options)
  return result.code === 0
}

export async function countMergesInRange(
  repoRoot: string,
  base: string,
  head = 'HEAD',
  options: GitOptions = {},
): Promise<number> {
  const result = await tryGit(repoRoot, ['rev-list', '--merges', '--count', `${base}..${head}`], options)
  if (result.code !== 0)
    return 0
  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

export async function rebaseRefuseReason(
  repoRoot: string,
  after: string,
  base: string,
  options: GitOptions = {},
): Promise<RebaseRefuseReason | null> {
  const state = await readGitState(repoRoot, options)
  if (state.rebase !== null || state.operation !== null)
    return 'in-progress'
  if (!await isAncestor(repoRoot, after, 'HEAD', options))
    return 'not-ancestor'
  if (await isMergeCommit(repoRoot, after, options))
    return 'merge-after'
  if (await countMergesInRange(repoRoot, base, 'HEAD', options) > 0)
    return 'merge-above'
  return null
}

export async function readCommitGpgSign(repoRoot: string, options: GitOptions = {}): Promise<boolean> {
  const result = await tryGit(repoRoot, ['config', '--get', '--type=bool', 'commit.gpgsign'], options)
  return result.stdout.trim() === 'true'
}

export async function resolveReviewAfter(
  repoRoot: string,
  entry: ReviewTarget,
  options: GitOptions = {},
): Promise<string | null> {
  if (entry.kind === 'workingTree')
    return await resolveCommit(repoRoot, 'HEAD', options)
  if (entry.kind === 'commit')
    return await resolveCommit(repoRoot, entry.rev, options)
  return await resolveCommit(repoRoot, entry.to, options)
}

export async function startRebase(args: StartRebaseArgs): Promise<GitCommandResult> {
  const editor = formatSequenceEditor(
    args.execPath,
    args.sequenceEditor,
    args.after,
    args.sequenceEditorArgs ?? [],
  )
  return await runNamedGit(args.repoRoot, rebaseStartArgs(args.base, args.hooks, args.sign), {
    ...args.options,
    timeoutMs: args.options?.timeoutMs ?? REBASE_TIMEOUT_MS,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      GIT_SEQUENCE_EDITOR: editor,
      GIT_EDITOR: 'true',
    },
  })
}

export async function finishRebase(args: FinishRebaseArgs): Promise<FinishRebaseResult> {
  const options = { ...args.options, timeoutMs: args.options?.timeoutMs ?? REBASE_TIMEOUT_MS }
  const results: GitCommandResult[] = []
  const fromAmend = args.from === 'amend'

  if (!fromAmend) {
    const addTracked = await runNamedGit(args.repoRoot, ['add', '-u'], options)
    results.push(addTracked)
    if (addTracked.code !== 0)
      return fail(results, addTracked, classifyFinishFailure(addTracked, args, false))

    if (args.stageUntracked.length > 0) {
      const addUntracked = await runNamedGit(args.repoRoot, ['add', '--', ...args.stageUntracked], options)
      results.push(addUntracked)
      if (addUntracked.code !== 0)
        return fail(results, addUntracked, classifyFinishFailure(addUntracked, args, false))
    }
  }

  if (fromAmend || await hasStagedChanges(args.repoRoot, options)) {
    const amend = await runNamedGit(
      args.repoRoot,
      ['commit', '--amend', '--no-edit', ...rebaseBypassFlags(args.hooks, args.sign)],
      options,
    )
    results.push(amend)
    if (amend.code !== 0)
      return fail(results, amend, classifyFinishFailure(amend, args, false))
  }

  const continued = await runNamedGit(
    args.repoRoot,
    ['rebase', '--continue'],
    { ...options, env: { GIT_EDITOR: 'true' } },
  )
  results.push(continued)
  if (continued.code !== 0) {
    const conflicted = await hasConflicts(args.repoRoot, options)
    return fail(results, continued, classifyFinishFailure(continued, args, conflicted))
  }

  return { ok: true, results }
}

export async function abortRebase(repoRoot: string, options: GitOptions = {}): Promise<GitCommandResult> {
  return await runNamedGit(repoRoot, ['rebase', '--abort'], {
    ...options,
    timeoutMs: options.timeoutMs ?? REBASE_TIMEOUT_MS,
  })
}

export async function readOwnership(
  repoRoot: string,
  after: string,
  origHead: string,
  options: GitOptions = {},
): Promise<RebaseOwnership> {
  const state = await readGitState(repoRoot, options)
  return {
    rebase: state.rebase,
    ours: ownsRebase(state.rebase, after, origHead),
  }
}

export function ownsRebase(rebase: RebaseState | null, after: string, origHead: string): boolean {
  if (rebase === null)
    return false
  if (rebase.stoppedSha === null || !shaMatches(rebase.stoppedSha, after))
    return false
  if (rebase.origHead === null || !shaMatches(rebase.origHead, origHead))
    return false
  return true
}

export function stripGitProgress(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const segments = line.split('\r')
      return (segments.at(-1) ?? '').trimEnd()
    })
    .join('\n')
    .trim()
}

export function gitOutput(result: GitCommandResult): string {
  const body = [stripGitProgress(result.stdout), stripGitProgress(result.stderr)]
    .filter(part => part !== '')
    .join('\n')
  return body === '' ? `${result.command} exited ${result.code}` : body
}

function fail(
  results: readonly GitCommandResult[],
  failed: GitCommandResult,
  kind: FinishRebaseFailureKind,
): FinishRebaseResult {
  return { ok: false, failed, kind, results }
}

function classifyFinishFailure(
  result: GitCommandResult,
  policy: FinishPolicy,
  conflicted: boolean,
): FinishRebaseFailureKind {
  if (conflicted || /conflict/i.test(`${result.stdout}\n${result.stderr}`))
    return 'conflict'
  if ((policy.hooks || policy.sign) && /\bcommit\b/.test(result.command))
    return 'hooks-or-sign'
  return 'git'
}

async function hasStagedChanges(repoRoot: string, options: GitOptions): Promise<boolean> {
  const result = await tryGit(repoRoot, ['diff', '--cached', '--quiet'], options)
  return result.code === 1
}

async function hasConflicts(repoRoot: string, options: GitOptions): Promise<boolean> {
  const status = await readStatus(repoRoot, options)
  return status.unmerged.length > 0
}

export function quoteArg(value: string): string {
  if (value === '' || /[\s"$`\\]/.test(value))
    return `"${value.replace(/["$`\\]/g, '\\$&')}"`
  return value
}
