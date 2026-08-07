import type { GuideDoc } from './schema'
import type { GuideDiagnostic } from './types'
import { validateGuideDoc } from './schema'

export const DEFAULT_GUIDE_FILE = '.guide.json'

/** The sidecar as read by the caller. The pure layer never touches a filesystem. */
export interface SidecarSource {
  /** Repo-relative path the text came from, used in diagnostics. */
  readonly path: string
  readonly text: string
}

export interface SidecarLoad {
  readonly doc: GuideDoc | null
  readonly diagnostics: readonly GuideDiagnostic[]
}

/** guide-schema.md §2: setting first, then `.guide.json`. */
export function resolveGuideFile(setting?: string | null): string {
  const trimmed = (setting ?? '').trim()
  return trimmed === '' ? DEFAULT_GUIDE_FILE : normalizeRepoPath(trimmed)
}

export function normalizeRepoPath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

/**
 * A guide is untrusted input and `path` is the only field that could reach
 * outside the repository, so this is a security rule, not hygiene.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path === '')
    return false
  const normalized = normalizeRepoPath(path)
  if (normalized.startsWith('/') || /^[A-Z]:\//i.test(normalized))
    return false
  return !normalized.split('/').includes('..')
}

/**
 * Parse and validate a sidecar. Every failure mode degrades to "no document"
 * plus exactly one warning, so a malformed guide can never block a review.
 */
export function loadSidecar(source: SidecarSource | null): SidecarLoad {
  if (source === null)
    return { doc: null, diagnostics: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(source.text)
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      doc: null,
      diagnostics: [{
        code: 'parse-error',
        severity: 'warning',
        message: `${source.path} is not valid JSON (${reason}); using the heuristic order`,
      }],
    }
  }

  const result = validateGuideDoc(parsed)
  if (!result.ok) {
    const first = result.error.slice(0, 3)
    const detail = first
      .map(problem => (problem.at === undefined ? problem.message : `${problem.at}: ${problem.message}`))
      .join('; ')
    const more = result.error.length > first.length ? ` (+${result.error.length - first.length} more)` : ''
    return {
      doc: null,
      diagnostics: [{
        code: result.error[0].code,
        severity: 'warning',
        message: `${source.path} was ignored — ${detail}${more}`,
      }],
    }
  }

  return { doc: result.value.doc, diagnostics: result.value.diagnostics }
}
