import type { GitOptions } from './exec'
import { splitLines, tryGit } from './exec'

export interface GitRemote {
  readonly name: string
  readonly fetchUrl: string
}

export interface GitBranch {
  readonly name: string
  readonly ref: string
  readonly remote: string | null
  readonly current: boolean
  readonly shortSha: string
}

export type FetchRemoteResult
  = | { readonly ok: true }
    | { readonly ok: false, readonly message: string }

const BRANCH_FORMAT = '%(refname)%09%(refname:short)%09%(objectname:short)%09%(HEAD)'

export function remoteNameError(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '')
    return 'Enter a remote name.'
  if (trimmed.startsWith('-') || /\s/.test(trimmed))
    return 'That does not look like a remote name.'
  return null
}

export function refNameError(ref: string): string | null {
  const trimmed = ref.trim()
  if (trimmed === '')
    return 'Enter a branch or ref.'
  if (trimmed.startsWith('-') || /\s/.test(trimmed))
    return 'That does not look like a branch or ref.'
  return null
}

export async function listRemotes(repoRoot: string, options: GitOptions = {}): Promise<GitRemote[]> {
  const result = await tryGit(repoRoot, ['remote', '-v'], options)
  if (result.code !== 0)
    return []

  const byName = new Map<string, string>()
  for (const line of splitLines(result.stdout)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined)
      continue
    if (!byName.has(match[1]))
      byName.set(match[1], match[2])
  }

  const names = [...byName.keys()].sort((left, right) => compareRemoteNames(left, right))
  return names.map((name) => {
    const fetchUrl = byName.get(name)
    return { name, fetchUrl: fetchUrl ?? '' }
  })
}

export async function listBranches(
  repoRoot: string,
  options: GitOptions & { readonly remote?: string } = {},
): Promise<GitBranch[]> {
  const remoteFilter = options.remote
  if (remoteFilter !== undefined && remoteNameError(remoteFilter) !== null)
    return []

  const result = await tryGit(
    repoRoot,
    ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'],
    options,
  )
  if (result.code !== 0)
    return []

  const branches: GitBranch[] = []
  for (const line of splitLines(result.stdout)) {
    const [ref, shortName, shortSha, head] = line.split('\t')
    if (ref === undefined || shortName === undefined)
      continue
    const parsed = parseBranchRef(ref, shortName)
    if (parsed === null)
      continue
    if (remoteFilter !== undefined && parsed.remote !== null && parsed.remote !== remoteFilter)
      continue
    branches.push({
      name: parsed.name,
      ref,
      remote: parsed.remote,
      current: head === '*',
      shortSha: shortSha ?? '',
    })
  }
  return branches
}

export async function defaultBaseRef(
  repoRoot: string,
  options: GitOptions & { readonly preferredRemote?: string | null } = {},
): Promise<string | null> {
  const remotes = await listRemotes(repoRoot, options)
  const hasUpstream = remotes.some(remote => remote.name === 'upstream')
  const hasOrigin = remotes.some(remote => remote.name === 'origin')
  const preferred = options.preferredRemote
  const candidates: string[] = []

  if (preferred !== undefined && preferred !== null && remotes.some(remote => remote.name === preferred)) {
    candidates.push(`${preferred}/HEAD`, `${preferred}/main`, `${preferred}/master`)
  }
  else if (hasUpstream) {
    candidates.push('upstream/HEAD', 'upstream/main', 'upstream/master')
  }
  else if (hasOrigin) {
    candidates.push('origin/HEAD', 'origin/main', 'origin/master')
  }
  candidates.push('main', 'master')

  for (const candidate of candidates) {
    const resolved = await resolveCommitRef(repoRoot, candidate, options)
    if (resolved !== null)
      return candidate
  }
  return null
}

export async function fetchRemote(
  repoRoot: string,
  remote: string,
  options: GitOptions = {},
): Promise<FetchRemoteResult> {
  const message = remoteNameError(remote)
  if (message !== null)
    return { ok: false, message }

  const result = await tryGit(repoRoot, ['fetch', '--', remote], options)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    return { ok: false, message: detail === '' ? `Could not fetch ${remote}.` : detail }
  }
  return { ok: true }
}

function compareRemoteNames(left: string, right: string): number {
  const rank = (name: string): number => {
    if (name === 'origin')
      return 0
    if (name === 'upstream')
      return 1
    return 2
  }
  const delta = rank(left) - rank(right)
  if (delta !== 0)
    return delta
  return left.localeCompare(right)
}

function parseBranchRef(
  ref: string,
  shortName: string,
): { readonly name: string, readonly remote: string | null } | null {
  if (ref.startsWith('refs/heads/'))
    return { name: shortName, remote: null }
  if (!ref.startsWith('refs/remotes/'))
    return null
  const rest = ref.slice('refs/remotes/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0)
    return null
  return { name: shortName, remote: rest.slice(0, slash) }
}

async function resolveCommitRef(repoRoot: string, ref: string, options: GitOptions): Promise<string | null> {
  if (refNameError(ref) !== null)
    return null
  const result = await tryGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options)
  const sha = result.stdout.trim()
  return result.code === 0 && sha !== '' ? sha : null
}
