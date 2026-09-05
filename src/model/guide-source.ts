import type { GitOptions } from '../git/exec'
import type { HeuristicOptions } from '../guide/heuristic'
import type { SidecarSource } from '../guide/sidecar'
import type { Guide, GuideDiagnostic, ReviewDiff } from '../guide/types'
import { atom } from '@reatom/core'
import { readDiff, showBlob } from '../git/diff'
import { buildHeuristicGuide } from '../guide/heuristic'
import { mergeGuide } from '../guide/merge'
import { parseUnifiedDiff } from '../guide/parse-diff'
import { isSafeRepoPath, loadSidecar, resolveGuideFile } from '../guide/sidecar'

/**
 * The seam between the session and the guide engine.
 *
 * The session knows only that *something* turns an immutable `(base, after)`
 * pair into a frozen `Guide`. Everything below the seam is the pure pipeline —
 * `parseUnifiedDiff` → `buildHeuristicGuide` → `loadSidecar` → `mergeGuide` —
 * with exactly two effectful steps: reading the patch and reading the sidecar.
 */

export interface GuideRequest {
  readonly repoRoot: string
  readonly baseRev: string
  readonly afterRev: string
  readonly options: HeuristicOptions
  readonly guideFile: string
  /** Prefer this over a git blob lookup when the user started from an open guide. */
  readonly sidecar?: SidecarSource
  readonly signal?: AbortSignal
  readonly exec?: GitOptions['exec']
}

export interface GuideResult {
  readonly diff: ReviewDiff
  readonly guide: Guide
  readonly diagnostics: readonly GuideDiagnostic[]
}

export type GuideSource = (request: GuideRequest) => Promise<GuideResult>

/**
 * The after revision first, base second.
 *
 * An agent that authored the change writes the guide beside it, so the after
 * tree is where a fresh sidecar lives — and for the working-tree entry it is
 * the *only* place it still exists, because the capture commit is taken before
 * the stash and the file is gone from disk by the time this runs. Reading the
 * working copy here would be worse than useless: post-stash the disk holds the
 * base content, which is exactly what the second lookup returns anyway.
 */
async function readSidecar(request: GuideRequest, options: GitOptions): Promise<SidecarSource | null> {
  const path = resolveGuideFile(request.guideFile)
  if (!isSafeRepoPath(path))
    return null

  for (const rev of [request.afterRev, request.baseRev]) {
    const text = await showBlob(request.repoRoot, rev, path, options)
    if (text !== null && text.trim() !== '')
      return { path, text }
  }
  return null
}

export const buildGuideSource: GuideSource = async (request) => {
  const options: GitOptions = { signal: request.signal, exec: request.exec }

  const raw = await readDiff(request.repoRoot, request.baseRev, request.afterRev, options)
  const sidecar = request.sidecar ?? await readSidecar(request, options)

  // Pure from here down: no I/O, no clock, no randomness — which is what makes
  // the ordering suite a fixture test rather than an integration test.
  const diff = parseUnifiedDiff(raw.patch, raw.nameStatus, { gap: request.options.intraHunkGap })
  const heuristic = buildHeuristicGuide(diff, request.options)
  const loaded = loadSidecar(sidecar)
  const merged = mergeGuide({
    diff,
    heuristic,
    ...(loaded.doc === null ? {} : { sidecar: loaded.doc }),
    options: request.options,
  })

  const diagnostics: readonly GuideDiagnostic[] = [...loaded.diagnostics, ...merged.diagnostics]

  return {
    diff,
    guide: { ...merged.guide, diagnostics },
    diagnostics,
  }
}

/**
 * Read by `session.start`.
 *
 * Boxed in an object because `atom(fn)` is the `computed` overload — storing a
 * bare function would make Reatom call it as a derivation instead of holding it
 * as state. Tests substitute a scripted source through the same atom.
 */
export const guideSource = atom<{ readonly build: GuideSource }>(
  { build: buildGuideSource },
  'guide.source',
)
