/**
 * Pure data model for the guide engine.
 *
 * Nothing in `src/guide/**` may import `vscode`, `@reatom/core`, or a node
 * builtin — see architecture/overview.md §2. This file therefore declares every
 * shared shape the layer needs and imports nothing at all.
 */

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary' | 'mode-only'

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  readonly kind: DiffLineKind
  /** Line content without the leading `+`/`-`/space marker. */
  readonly text: string
  /** 1-based; present for `context` and `del`. */
  readonly oldLine?: number
  /** 1-based; present for `context` and `add`. */
  readonly newLine?: number
}

export interface DiffHunk {
  readonly index: number
  readonly header: string
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly newLines: number
  readonly lines: readonly DiffLine[]
}

/** A contiguous run of changed lines. The atomic unit of reveal. */
export interface LineGroup {
  /** `${path}#${hunkIndex}:${oldAnchor}-${newAnchor}` — stable and fixture-safe. */
  readonly id: string
  readonly path: string
  readonly hunkIndex: number
  readonly kind: 'add' | 'del' | 'replace'
  /** Absent for pure additions. */
  readonly oldRange?: LineRange
  /** Absent for pure deletions. */
  readonly newRange?: LineRange
  /** Old-side line the group starts at; the insertion point for a pure add. */
  readonly oldAnchor: number
  /** New-side line the group starts at; the deletion point for a pure del. */
  readonly newAnchor: number
  readonly addedLines: number
  readonly deletedLines: number
}

export interface DiffFile {
  /** Post-image path; pre-image path for deletions. */
  readonly path: string
  /** Pre-image path for renames and copies. */
  readonly oldPath?: string
  readonly status: FileStatus
  readonly isBinary: boolean
  readonly isGenerated: boolean
  readonly noTrailingNewline: boolean
  readonly oldMode?: string
  readonly newMode?: string
  readonly hunks: readonly DiffHunk[]
  readonly groups: readonly LineGroup[]
}

export interface ReviewDiff {
  readonly files: readonly DiffFile[]
  /** `sha256:<hex>` over the normalized patch — see guide-schema.md §7. */
  readonly digest: string
}

/** 1-based, inclusive. An empty range is encoded as `end === start - 1`. */
export interface LineRange {
  readonly start: number
  readonly end: number
}

export interface RevealRender {
  readonly text: string
  /** Group id → the range that group occupies inside `text`. */
  readonly groupRanges: ReadonlyMap<string, LineRange>
}

/** One entry of `git diff --name-status -z`. */
export interface NameStatusEntry {
  /** Raw status letter with optional similarity score, e.g. `M`, `A`, `R100`. */
  readonly code: string
  /** Post-image path. */
  readonly path: string
  /** Pre-image path, for renames and copies. */
  readonly oldPath?: string
}

export type Significance = 'critical' | 'high' | 'normal' | 'low' | 'skip'

export type GuideDiagnosticCode
  = | 'parse-error'
    | 'unsupported-version'
    | 'invalid-document'
    | 'unknown-field'
    | 'anchor-unmatched'
    | 'range-overlap'
    | 'depends-unknown'
    | 'depends-cycle'
    | 'merge-no-successor'
    | 'path-unknown'
    | 'path-unsafe'
    | 'stale-guide'
    | 'too-many-steps'

export type GuideDiagnosticSeverity = 'info' | 'warning'

export interface GuideDiagnostic {
  readonly code: GuideDiagnosticCode
  readonly severity: GuideDiagnosticSeverity
  readonly message: string
  /** Sidecar step id the diagnostic is about, when it is about one. */
  readonly stepId?: string
  /** Document location, e.g. `steps[2].ranges[0].start`. */
  readonly at?: string
}

export interface GuideStep {
  readonly id: string
  readonly path: string
  /** Empty for stub steps. */
  readonly groups: readonly LineGroup[]
  readonly kind: 'reveal' | 'stub'
  readonly significance: Significance
  readonly rationale: string
  readonly title?: string
  readonly notes?: string
  readonly source: 'heuristic' | 'sidecar'
}

export interface Guide {
  readonly steps: readonly GuideStep[]
  readonly stale: boolean
  readonly diagnostics: readonly GuideDiagnostic[]
}

export type Result<T, E>
  = | { readonly ok: true, readonly value: T }
    | { readonly ok: false, readonly error: E }

export function ok<T, E>(value: T): Result<T, E> {
  return { ok: true, value }
}

export function err<T, E>(error: E): Result<T, E> {
  return { ok: false, error }
}
