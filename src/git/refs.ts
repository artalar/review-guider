import type { GitOptions } from './exec'
import { splitLines, tryGit } from './exec'

/**
 * Every artifact the safety protocol leaves behind is an ordinary git ref, so a
 * user can always inspect it with `git for-each-ref refs/tabthrough` and
 * recover by hand. See architecture/overview.md §3.5 and ADR 0002 D3/D5.
 */

export const REF_NAMESPACE = 'refs/tabthrough'
export const LOCK_REF = `${REF_NAMESPACE}/lock`
export const ZERO_OID = '0000000000000000000000000000000000000000'

export function afterRefName(sessionId: string): string {
  return `${REF_NAMESPACE}/after/${sessionId}`
}

export function backupRefName(sessionId: string): string {
  return `${REF_NAMESPACE}/backup/${sessionId}`
}

export function appliedRefName(sessionId: string): string {
  return `${REF_NAMESPACE}/applied/${sessionId}`
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
 * Repo-level session lock (ADR 0002 D5).
 *
 * The lock names its owner: the value is derived from the `sessionId`, so the
 * release is a compare-and-swap that actually distinguishes owners. It used to
 * be the HEAD commit sha, which two windows at the same HEAD both compute, so
 * either could delete the other's lock.
 *
 * A ref can only point at an object, so the id travels as a blob and the ref
 * points at that blob. Content addressing is what makes it work: the release
 * and the ownership check recompute the value they compare against instead of
 * trusting the ref they are about to act on.
 */
const LOCK_PAYLOAD_PREFIX = 'tabthrough-lock:'

async function lockObject(
  repoRoot: string,
  sessionId: string,
  write: boolean,
  options: GitOptions,
): Promise<string | null> {
  const args = write
    ? ['hash-object', '-t', 'blob', '-w', '--stdin']
    : ['hash-object', '-t', 'blob', '--stdin']
  const result = await tryGit(repoRoot, args, { ...options, stdin: LOCK_PAYLOAD_PREFIX + sessionId })
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : null
}

export async function acquireLock(repoRoot: string, sessionId: string, options: GitOptions = {}): Promise<boolean> {
  const object = await lockObject(repoRoot, sessionId, true, options)
  if (object === null)
    return false
  return await createRefIfAbsent(repoRoot, LOCK_REF, object, options)
}

/** Releases the lock only if this session still owns it. */
export async function releaseLock(repoRoot: string, sessionId: string, options: GitOptions = {}): Promise<boolean> {
  const object = await lockObject(repoRoot, sessionId, false, options)
  if (object !== null && await deleteRef(repoRoot, LOCK_REF, object, options))
    return true

  // A token written before the lock named its owner recorded the ref value
  // itself. Releasing one of those is still a compare-and-swap, on the old value.
  return await deleteRef(repoRoot, LOCK_REF, sessionId, options)
}

/**
 * The session id holding the lock, or `null` when the repository is free.
 *
 * A lock this extension did not write — the stale-lock drill points the ref at
 * HEAD by hand — reports its raw object name instead, because "held by
 * something" is still the honest answer to "is this repository locked?".
 */
export async function readLock(repoRoot: string, options: GitOptions = {}): Promise<string | null> {
  const object = await resolveRef(repoRoot, LOCK_REF, options)
  if (object === null)
    return null

  const payload = await tryGit(repoRoot, ['cat-file', 'blob', object], options)
  const text = payload.stdout.trim()
  return payload.code === 0 && text.startsWith(LOCK_PAYLOAD_PREFIX)
    ? text.slice(LOCK_PAYLOAD_PREFIX.length)
    : object
}
