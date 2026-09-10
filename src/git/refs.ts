import type { GitOptions } from './exec'
import { splitLines, tryGit } from './exec'

/**
 * Tabthrough artifacts are ordinary git refs. Phase 12 only writes
 * `refs/tabthrough/after/<id>` for a working-tree snapshot (ADR 0005 D1).
 */

export const REF_NAMESPACE = 'refs/tabthrough'
export const AFTER_REF_PREFIX = `${REF_NAMESPACE}/after`

export function afterRefName(sessionId: string): string {
  return `${AFTER_REF_PREFIX}/${sessionId}`
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

/** Deletes a ref, refusing when `expected` is set and does not match. */
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

export interface DatedRef {
  readonly name: string
  readonly objectName: string
  readonly committerUnix: number | null
}

export async function listAfterRefs(
  repoRoot: string,
  options: GitOptions = {},
): Promise<DatedRef[]> {
  const result = await tryGit(
    repoRoot,
    ['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:unix)', AFTER_REF_PREFIX],
    options,
  )
  if (result.code !== 0)
    return []
  return splitLines(result.stdout).map((line) => {
    const [name, objectName, date] = line.split('\t')
    const unix = date === undefined || date === '' ? Number.NaN : Number(date)
    return {
      name: name ?? '',
      objectName: objectName ?? '',
      committerUnix: Number.isFinite(unix) ? unix : null,
    }
  }).filter(ref => ref.name !== '')
}
