import type { GitExec } from '../git/exec'
import type { HeuristicOptions } from '../guide/heuristic'
import type { DiffFile, FileStatus, Guide, GuideDiagnostic, GuideStep, ReviewDiff } from '../guide/types'
import { atom } from '@reatom/core'
import { readNameStatus } from '../git/diff'

/**
 * The seam between the session and the guide engine (plan Phase 3).
 *
 * The session knows only that *something* turns an immutable `(base, after)`
 * pair into a frozen `Guide`. Phase 3 installs the real pipeline —
 * `parseUnifiedDiff` → `buildHeuristicGuide` → `validateGuideDoc` →
 * `mergeGuide` — by writing `guideSource`. Until then the stub below keeps the
 * safety protocol end-to-end testable.
 */

export interface GuideRequest {
  readonly repoRoot: string
  readonly baseRev: string
  readonly afterRev: string
  readonly options: HeuristicOptions
  readonly guideFile: string
  readonly signal?: AbortSignal
  readonly exec?: GitExec
}

export interface GuideResult {
  readonly diff: ReviewDiff
  readonly guide: Guide
  readonly diagnostics: readonly GuideDiagnostic[]
}

export type GuideSource = (request: GuideRequest) => Promise<GuideResult>

const STATUS_BY_CODE: Readonly<Record<string, FileStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'added',
  T: 'mode-only',
}

/**
 * One visible step per changed file, so `k/n` is honest and the reveal loop has
 * something to walk even before the guide engine lands.
 */
export const stubGuideSource: GuideSource = async (request) => {
  const entries = await readNameStatus(request.repoRoot, request.baseRev, request.afterRev, {
    signal: request.signal,
    exec: request.exec,
  })

  const files: DiffFile[] = entries.map(entry => ({
    path: entry.path,
    oldPath: entry.oldPath,
    status: STATUS_BY_CODE[entry.code[0] ?? 'M'] ?? 'modified',
    isBinary: false,
    isGenerated: false,
    noTrailingNewline: false,
    hunks: [],
    groups: [],
  }))

  const steps: GuideStep[] = files.map(file => ({
    id: `stub:${file.path}`,
    path: file.path,
    groups: [],
    kind: 'stub',
    significance: 'normal',
    rationale: 'Whole file — guide engine not installed',
    source: 'heuristic',
  }))

  return {
    diff: { files, digest: 'sha256:stub' },
    guide: { steps, stale: false, diagnostics: [] },
    diagnostics: [],
  }
}

/**
 * Written once by the guide engine at import time; read by `session.start`.
 *
 * Boxed in an object because `atom(fn)` is the `computed` overload — storing a
 * bare function would make Reatom call it as a derivation instead of holding it
 * as state.
 */
export const guideSource = atom<{ readonly build: GuideSource }>(
  { build: stubGuideSource },
  'guide.source',
)
