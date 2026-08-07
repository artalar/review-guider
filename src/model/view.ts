import type { GuideStep, LineRange } from '../guide/types'
import type { SessionProgress } from './steps'
import { computed } from '@reatom/core'
import { showRationale } from './config'
import { session, sessionStatus, startBlockedReason } from './session'

/**
 * The bridge's projections. Everything VS Code renders is derived here, so the
 * UI layer holds no branching logic of its own.
 */

export const REVIEW_SCHEME = 'guide-reviewer'

/**
 * Two read-only documents per file (architecture/overview.md §7.1):
 *
 * ```
 * guide-reviewer://base/<sessionId>/<path>?rev=<baseRev>
 * guide-reviewer://reveal/<sessionId>/<path>
 * ```
 *
 * The kind is the URI authority and the repo-relative path is kept verbatim at
 * the end, so the editor picks the right language from the file extension.
 */
export type ReviewDocKind = 'base' | 'reveal'

export interface ReviewDocRef {
  readonly kind: ReviewDocKind
  readonly sessionId: string
  readonly path: string
}

export function reviewDocPath(ref: ReviewDocRef): string {
  return `/${ref.sessionId}/${ref.path}`
}

export function parseReviewDocPath(authority: string, path: string): ReviewDocRef | null {
  if (authority !== 'base' && authority !== 'reveal')
    return null
  const trimmed = path.startsWith('/') ? path.slice(1) : path
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1)
    return null
  return { kind: authority, sessionId: trimmed.slice(0, slash), path: trimmed.slice(slash + 1) }
}

export function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * Stable per file rather than per step: a title that carried `k/n` would rename
 * the editor tab on every Tab press. The status bar is where `k/n` belongs.
 */
export function reviewDocTitle(path: string): string {
  return `${basename(path)} (Guide Reviewer)`
}

export const statusText = computed((): string | null => {
  const model = session()
  if (model === null)
    return null

  const { index, total } = model.progress()
  const step = model.currentStep()
  const parts = [`$(book) Step ${index}/${total}`]
  if (step !== null)
    parts.push(basename(step.path))
  if (showRationale() && step !== null && step.rationale !== '')
    parts.push(step.rationale)
  return parts.join(' · ')
}, 'ui.statusText')

export const statusTooltip = computed((): string | null => {
  const model = session()
  if (model === null) {
    const reason = startBlockedReason()
    return reason === null ? null : `Guide Reviewer: ${reason}`
  }

  const step = model.currentStep()
  const lines = [`Guide Reviewer — ${sessionStatus()}`]
  if (step !== null) {
    lines.push(step.title ?? step.path)
    if (step.rationale !== '')
      lines.push(step.rationale)
    if (step.notes !== undefined)
      lines.push(step.notes)
  }
  lines.push('Click to jump to the current step.')
  return lines.join('\n')
}, 'ui.statusTooltip')

export interface ReviewViewModel {
  readonly sessionId: string
  readonly progress: SessionProgress
  readonly step: GuideStep | null
  readonly activePath: string | null
  readonly baseRev: string
  readonly title: string
  /** `null` until the base blob has been read. */
  readonly baseText: string | null
  readonly revealText: string | null
  /** The current step's lines inside `revealText`, for the highlight. */
  readonly ranges: readonly LineRange[]
  /** Unreached lines, for the dim mode's grey-out. Empty when progressive. */
  readonly pendingRanges: readonly LineRange[]
  readonly complete: boolean
}

/**
 * A binary, generated, or mode-only file has nothing to reveal, so its step
 * shows why it is in the list instead. Keeping it in the list is what keeps
 * `k/n` honest — silently dropping it would make the count a lie.
 */
function stubDocumentText(step: GuideStep): string {
  return `${step.path}\n\n${step.rationale}\n`
}

/** One computed, one subscription, one place where connection lifetime is owned. */
export const reviewViewModel = computed((): ReviewViewModel | null => {
  const model = session()
  if (model === null)
    return null

  const active = model.activeFile()
  const upcoming = model.nextStep()

  // Touching the next file's base text keeps it connected, which starts its
  // fetch now. Lookahead warming with zero imperative scheduling.
  if (upcoming !== null && upcoming.path !== active?.path)
    model.fileByPath.get(upcoming.path)?.baseText.data()

  const step = model.currentStep()
  const activePath = active?.path ?? step?.path ?? null
  const stub = step !== null && step.kind === 'stub'

  return {
    sessionId: model.id,
    progress: model.progress(),
    step,
    activePath,
    baseRev: model.baseRev,
    title: activePath === null ? 'Guide Reviewer' : reviewDocTitle(activePath),
    baseText: stub ? '' : active?.baseText.data() ?? null,
    revealText: stub && step !== null ? stubDocumentText(step) : active?.revealText() ?? null,
    ranges: stub ? [] : active?.currentRanges() ?? [],
    pendingRanges: stub ? [] : active?.pendingRanges() ?? [],
    complete: model.isComplete(),
  }
}, 'ui.reviewViewModel')
