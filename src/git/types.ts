/** Shapes shared across the git layer and quoted by the session model. */

/** What the user asked to review. Resolves to an immutable `(base, after)` pair. */
export type ReviewTarget
  = | { readonly kind: 'workingTree' }
    | { readonly kind: 'commit', readonly rev: string }
    | { readonly kind: 'range', readonly from: string, readonly to: string }

export function describeTarget(target: ReviewTarget): string {
  switch (target.kind) {
    case 'workingTree':
      return 'working tree'
    case 'commit':
      return `commit ${target.rev}`
    case 'range':
      return `${target.from}..${target.to}`
  }
}

/** Where HEAD pointed before the session detached it. */
export type HeadPosition
  = | { readonly kind: 'branch', readonly name: string }
    | { readonly kind: 'detached', readonly sha: string }

export interface PreflightFiles {
  readonly staged: readonly string[]
  readonly unstaged: readonly string[]
  readonly untracked: readonly string[]
}

/**
 * Everything the pre-flight modal must state plainly before anything is
 * touched: what will be stashed, and what the session will check out.
 */
export interface PreflightRequest {
  readonly entry: ReviewTarget
  readonly repoRoot: string
  readonly changedFileCount: number
  readonly changedLineCount: number
  readonly willStash: boolean
  readonly willCheckout: string | null
  readonly files: PreflightFiles
}
