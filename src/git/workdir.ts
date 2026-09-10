import type { GitOptions } from './exec'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { canonicalizeRepoRoot, isUnderRoot } from './paths'

/** Working-tree file bytes, or `null` when the path is missing or outside the repo. */
export async function readWorktreeFile(
  repoRoot: string,
  path: string,
  _options: GitOptions = {},
): Promise<string | null> {
  const root = canonicalizeRepoRoot(repoRoot)
  const absolute = canonicalizeRepoRoot(isAbsolute(path) ? path : resolve(repoRoot, path))
  if (!isUnderRoot(root, absolute))
    return null
  try {
    return await readFile(absolute, 'utf8')
  }
  catch {
    return null
  }
}
