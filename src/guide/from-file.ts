import type { GuideScopeDoc } from './schema'

/** Basename match for `.tabthrough-guide.json` and legacy `*.guide.json`. */
export function isGuideFileName(fileName: string): boolean {
  return fileName.endsWith('.tabthrough-guide.json') || fileName.endsWith('.guide.json')
}

/**
 * Review target implied by a guide's `scope`. Structurally matches
 * {@link import('../git/types').ReviewTarget} without importing the git layer.
 */
export type GuideReviewEntry
  = | { readonly kind: 'workingTree' }
    | { readonly kind: 'commit', readonly rev: string }
    | { readonly kind: 'range', readonly from: string, readonly to: string }

/**
 * Map a guide's `scope` to a review target.
 *
 * `base` / `head` are optional in the schema; when a commit or range guide
 * omits the refs the caller should ask the user.
 */
export type ScopeEntry
  = | { readonly kind: 'entry', readonly entry: GuideReviewEntry }
    | { readonly kind: 'needs-commit' }
    | { readonly kind: 'needs-range' }

export function entryFromGuideScope(scope: GuideScopeDoc | undefined): ScopeEntry {
  if (scope === undefined || scope.kind === 'workingTree')
    return { kind: 'entry', entry: { kind: 'workingTree' } }

  if (scope.kind === 'commit') {
    const rev = scope.head ?? scope.base
    if (rev === undefined || rev.trim() === '')
      return { kind: 'needs-commit' }
    return { kind: 'entry', entry: { kind: 'commit', rev: rev.trim() } }
  }

  const from = scope.base?.trim() ?? ''
  const to = scope.head?.trim() ?? ''
  if (from === '' || to === '')
    return { kind: 'needs-range' }
  return { kind: 'entry', entry: { kind: 'range', from, to } }
}
