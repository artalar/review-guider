import type { GitOptions } from './exec'
import { splitNul, tryGit } from './exec'
import { resolveRef } from './refs'

/**
 * Raw stash primitives. The protocol that sequences them lives in
 * `isolate.ts`; the rules it must respect are in architecture/overview.md §3.5.
 *
 * Notably absent: `git stash pop`. `pop` drops the entry on partial success,
 * which is exactly the case where we most need it to survive.
 */

export interface StashEntry {
  /** `stash@{0}` — valid only until the stash list changes. */
  readonly selector: string
  readonly sha: string
  /** Reflog subject, e.g. `On main: guide-reviewer:<id>`. */
  readonly subject: string
}

export async function listStash(repoRoot: string, options: GitOptions = {}): Promise<StashEntry[]> {
  const result = await tryGit(repoRoot, ['stash', 'list', '-z', '--format=%gd%x09%H%x09%gs'], options)
  if (result.code !== 0)
    return []
  return splitNul(result.stdout)
    .map((record) => {
      const [selector, sha, ...rest] = record.split('\t')
      return { selector: selector ?? '', sha: sha ?? '', subject: rest.join('\t') }
    })
    .filter(entry => entry.selector !== '' && entry.sha !== '')
}

/** Locates our entry by its scoped message, which no other tool writes. */
export async function findStashByMessage(
  repoRoot: string,
  message: string,
  options: GitOptions = {},
): Promise<StashEntry | null> {
  const entries = await listStash(repoRoot, options)
  return entries.find(entry => entry.subject.endsWith(`: ${message}`) || entry.subject === message) ?? null
}

export interface StashPushResult {
  /** `null` when the tree was already clean and nothing was stashed. */
  readonly sha: string | null
  readonly message: string
}

export async function stashPush(
  repoRoot: string,
  args: { readonly message: string, readonly includeUntracked: boolean },
  options: GitOptions = {},
): Promise<StashPushResult> {
  const before = await resolveRef(repoRoot, 'refs/stash', options)

  // `--include-untracked`, never `--all`: `--all` would sweep .env, node_modules
  // and build output, and a restore failure there is unrecoverable (plan R8).
  const pushArgs = ['stash', 'push', '--quiet']
  if (args.includeUntracked)
    pushArgs.push('--include-untracked')
  pushArgs.push('-m', args.message)

  const result = await tryGit(repoRoot, pushArgs, options)
  if (result.code !== 0)
    throw new Error(`git stash push failed: ${result.stderr.trim() || result.stdout.trim()}`)

  const after = await resolveRef(repoRoot, 'refs/stash', options)
  return { sha: after !== null && after !== before ? after : null, message: args.message }
}

export interface StashApplyResult {
  readonly ok: boolean
  /** True when the failure was a merge conflict rather than a bad invocation. */
  readonly conflict: boolean
  /** True when the index split was reinstated (`--index` succeeded). */
  readonly indexRestored: boolean
  readonly stderr: string
}

/**
 * `--index` first, because the staged / unstaged split is part of what the user
 * had. If git refuses to reinstate the index it applies nothing, so falling
 * back to a plain apply is safe — verification then reports the split mismatch
 * and the caller keeps every artifact.
 */
export async function stashApply(
  repoRoot: string,
  rev: string,
  options: GitOptions = {},
): Promise<StashApplyResult> {
  const withIndex = await tryGit(repoRoot, ['stash', 'apply', '--index', rev], options)
  if (withIndex.code === 0)
    return { ok: true, conflict: false, indexRestored: true, stderr: '' }

  if (isConflict(withIndex.stderr, withIndex.stdout))
    return { ok: false, conflict: true, indexRestored: false, stderr: withIndex.stderr }

  const plain = await tryGit(repoRoot, ['stash', 'apply', rev], options)
  if (plain.code === 0)
    return { ok: true, conflict: false, indexRestored: false, stderr: withIndex.stderr }

  return {
    ok: false,
    conflict: isConflict(plain.stderr, plain.stdout),
    indexRestored: false,
    stderr: plain.stderr || withIndex.stderr,
  }
}

function isConflict(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`
  return text.includes('CONFLICT') || text.includes('would be overwritten') || text.includes('Merge conflict')
}

/** Only ever called after verification succeeded. */
export async function stashDrop(repoRoot: string, selector: string, options: GitOptions = {}): Promise<boolean> {
  const result = await tryGit(repoRoot, ['stash', 'drop', '--quiet', selector], options)
  return result.code === 0
}
