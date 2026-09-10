import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Collapse the path forms git, VS Code, and Node disagree about into one key:
 * macOS `/var` ↔ `/private/var`, Windows drive-letter case, trailing slashes,
 * and backslashes.
 */
export function canonicalizeRepoRoot(repoRoot: string): string {
  let resolved = repoRoot
  try {
    resolved = realpathSync(repoRoot)
  }
  catch {
    // The path may not exist yet in a unit fixture; still normalize the spelling.
  }
  let normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:\//i.test(normalized))
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1)
  return normalized
}

/** Default `tabthrough.worktree.dir` — `os.tmpdir()/tabthrough`. */
export function defaultWorktreeRoot(): string {
  return join(tmpdir(), 'tabthrough')
}

export function resolveWorktreeRoot(configured: string): string {
  const trimmed = configured.trim()
  return canonicalizeRepoRoot(trimmed === '' ? defaultWorktreeRoot() : trimmed)
}

export function isUnderRoot(root: string, path: string): boolean {
  const parent = canonicalizeRepoRoot(root)
  const child = canonicalizeRepoRoot(path)
  return child === parent || child.startsWith(`${parent}/`)
}
