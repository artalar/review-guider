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

export interface RangeInput {
  readonly from: string
  readonly to: string
}

/**
 * Parses what a user types into the range box.
 *
 * Both `A..B` and `A...B` are accepted and both mean the same thing here: the
 * review runs from `merge-base(A, B)` to `B`, which is git's three-dot
 * semantics. Two dots are accepted because that is what people type, and
 * reviewing a branch against the tip of another branch — rather than against
 * their common ancestor — would fold in commits the author never wrote.
 */
export function parseRangeInput(raw: string): RangeInput | null {
  const text = raw.trim()
  const separator = text.indexOf('..')
  // Scanned rather than matched with a regex: revisions contain dots
  // (`v1.0..v2.0`), and the patterns that get that right are the ones that
  // backtrack badly on adversarial input.
  if (separator <= 0)
    return null

  const from = text.slice(0, separator).trim()
  const to = text.slice(text[separator + 2] === '.' ? separator + 3 : separator + 2).trim()

  if (from === '' || to === '' || from.startsWith('.') || to.startsWith('.'))
    return null
  if (from.includes(' ') || to.includes(' ') || from.includes('\t') || to.includes('\t'))
    return null
  return { from, to }
}

/** `null` when the input is a usable range; otherwise the reason it is not. */
export function rangeInputError(raw: string): string | null {
  if (raw.trim() === '')
    return 'Enter a commit range, for example main..HEAD.'
  if (parseRangeInput(raw) === null)
    return 'Expected two revisions separated by .. or ..., for example main..HEAD.'
  return null
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
