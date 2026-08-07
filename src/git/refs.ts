import type { GitOptions } from './exec'
import { splitLines, tryGit } from './exec'

/**
 * Every artifact the safety protocol leaves behind is an ordinary git ref, so a
 * user can always inspect it with `git for-each-ref refs/guide-reviewer` and
 * recover by hand. See architecture/overview.md §3.5 and ADR 0002 D3/D5.
 */

export const REF_NAMESPACE = 'refs/guide-reviewer'
export const LOCK_REF = `${REF_NAMESPACE}/lock`
export const ZERO_OID = '0000000000000000000000000000000000000000'

export function afterRefName(sessionId: string): string {
  return `${REF_NAMESPACE}/after/${sessionId}`
}

export function backupRefName(sessionId: string): string {
  return `${REF_NAMESPACE}/backup/${sessionId}`
}

export interface GuideRef {
  readonly name: string
  readonly objectName: string
}

export async function resolveRef(repoRoot: string, ref: string, options: GitOptions = {}): Promise<string | null> {
  const result = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', ref], options)
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : null
}

export async function writeRef(
  repoRoot: string,
  ref: string,
  value: string,
  options: GitOptions = {},
): Promise<void> {
  const result = await tryGit(repoRoot, ['update-ref', ref, value], options)
  if (result.code !== 0)
    throw new Error(`failed to write ${ref}: ${result.stderr.trim()}`)
}

/**
 * Atomic create-if-absent inside git's own ref transaction: passing the zero
 * oid as the expected old value makes the update fail when the ref exists.
 */
export async function createRefIfAbsent(
  repoRoot: string,
  ref: string,
  value: string,
  options: GitOptions = {},
): Promise<boolean> {
  const result = await tryGit(repoRoot, ['update-ref', ref, value, ZERO_OID], options)
  return result.code === 0
}

/** Deletes a ref, refusing when its current value is not `expected`. */
export async function deleteRef(
  repoRoot: string,
  ref: string,
  expected?: string,
  options: GitOptions = {},
): Promise<boolean> {
  const args = expected === undefined ? ['update-ref', '-d', ref] : ['update-ref', '-d', ref, expected]
  const result = await tryGit(repoRoot, args, options)
  return result.code === 0
}

export async function listRefs(
  repoRoot: string,
  prefix: string = REF_NAMESPACE,
  options: GitOptions = {},
): Promise<GuideRef[]> {
  const result = await tryGit(repoRoot, ['for-each-ref', '--format=%(refname)%09%(objectname)', prefix], options)
  if (result.code !== 0)
    return []
  return splitLines(result.stdout).map((line) => {
    const [name, objectName] = line.split('\t')
    return { name: name ?? '', objectName: objectName ?? '' }
  }).filter(ref => ref.name !== '')
}

/**
 * Repo-level session lock (ADR 0002 D5). `value` is recorded in the journal so
 * the release is itself a compare-and-swap and cannot clobber another owner.
 */
export async function acquireLock(repoRoot: string, value: string, options: GitOptions = {}): Promise<boolean> {
  return await createRefIfAbsent(repoRoot, LOCK_REF, value, options)
}

export async function releaseLock(repoRoot: string, value: string, options: GitOptions = {}): Promise<boolean> {
  return await deleteRef(repoRoot, LOCK_REF, value, options)
}

export async function readLock(repoRoot: string, options: GitOptions = {}): Promise<string | null> {
  return await resolveRef(repoRoot, LOCK_REF, options)
}
