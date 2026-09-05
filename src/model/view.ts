import type { PreflightRequest, SessionMode } from '../git/types'
import type { GuideStep, LineRange } from '../guide/types'
import type { SessionStatus } from './session'
import type { SessionProgress } from './steps'
import { computed } from '@reatom/core'
import { describeTarget } from '../git/types'
import { showRationale } from './config'
import {
  preflightRequest,
  recoveryPending,
  restoreBlock,
  session,
  canStart as sessionCanStart,
  sessionLiveElsewhere,
  sessionStatus,
  startBlockedReason,
} from './session'

/**
 * The bridge's projections. Everything VS Code renders is derived here, so the
 * UI layer holds no branching logic of its own.
 */

export const REVIEW_SCHEME = 'tabthrough'

/**
 * Two read-only documents per file (architecture/overview.md §7.1):
 *
 * ```
 * tabthrough://base/<sessionId>/<path>?rev=<baseRev>
 * tabthrough://reveal/<sessionId>/<path>
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
  return `${basename(path)} (Tabthrough)`
}

export const statusText = computed((): string | null => {
  const model = session()
  if (model === null)
    return null

  if (model.mode === 'apply') {
    if (model.applyPending())
      return '$(sync~spin) Applying step…'
    if (model.isComplete())
      return '$(edit) Apply complete · Finish keeps · Cancel restores'
    const { index, total } = model.progress()
    const step = model.currentStep()
    const parts = [`$(edit) ${index} of ${total}`]
    if (step !== null)
      parts.push(basename(step.path))
    if (showRationale() && step !== null && step.rationale !== '')
      parts.push(step.rationale)
    return parts.join(' · ')
  }

  if (model.isComplete())
    return '$(book) Walkthrough complete · Finish and restore'

  const { index, total } = model.progress()
  const step = model.currentStep()
  const parts = [`$(book) ${index} of ${total}`]
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
    return reason === null ? null : `Tabthrough: ${reason}`
  }

  if (sessionStatus() === 'blocked')
    return 'Workspace restore needs attention'

  const step = model.currentStep()
  const lines = [`Tabthrough — ${sessionStatus()}`]
  if (step !== null) {
    lines.push(step.title ?? step.path)
    if (step.rationale !== '')
      lines.push(step.rationale)
    if (step.notes !== undefined)
      lines.push(step.notes)
  }
  const upcoming = model.nextStep()
  if (upcoming !== null) {
    const nextBits = [`Next: ${basename(upcoming.path)}`]
    if (showRationale() && upcoming.rationale !== '')
      nextBits.push(upcoming.rationale)
    lines.push(nextBits.join(' · '))
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
  // Apply mode uses ordinary file editors (ADR 0004 D2); no virtual diff.
  if (model.mode === 'apply')
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
    title: activePath === null ? 'Tabthrough' : reviewDocTitle(activePath),
    baseText: stub ? '' : active?.baseText.data() ?? null,
    revealText: stub && step !== null ? stubDocumentText(step) : active?.revealText() ?? null,
    ranges: stub ? [] : active?.currentRanges() ?? [],
    pendingRanges: stub ? [] : active?.pendingRanges() ?? [],
    complete: model.isComplete(),
  }
}, 'ui.reviewViewModel')

/** Bound into VS Code context keys so keybindings see live apply-in-flight (R-apply-5). */
export const applyPending = computed(
  (): boolean => session()?.applyPending() ?? false,
  'ui.applyPending',
)

/**
 * The native sidebar reads one projection instead of reaching into the
 * session model itself. Keeping the projection here makes the extension host
 * bridge a renderer, while all session state remains owned by Reatom.
 */
export interface SidebarViewModel {
  readonly status: SessionStatus
  readonly mode: SessionMode | null
  readonly entry: string | null
  readonly summary: string | null
  readonly canStart: boolean
  readonly progress: SessionProgress | null
  readonly currentStep: GuideStep | null
  readonly nextStep: GuideStep | null
  readonly complete: boolean
  readonly applyPending: boolean
  readonly canAdvance: boolean
  readonly canRetreat: boolean
  readonly preflight: PreflightRequest | null
  readonly recoveryPending: boolean
  readonly liveElsewhere?: boolean
  readonly blockedMessage: string | null
  readonly idleReason: string | null
}

export const sidebarViewModel = computed((): SidebarViewModel => {
  const model = session()
  const status = sessionStatus()
  const current = model?.currentStep() ?? null
  const next = model?.nextStep() ?? null
  const block = restoreBlock()

  return {
    status,
    mode: model?.mode ?? null,
    entry: model === null ? null : describeTarget(model.entry),
    summary: model?.guide.summary ?? null,
    canStart: sessionCanStart(),
    progress: model?.progress() ?? null,
    currentStep: current,
    nextStep: next,
    complete: model?.isComplete() ?? false,
    applyPending: model?.applyPending() ?? false,
    canAdvance: model?.canAdvance() ?? false,
    canRetreat: model?.canRetreat() ?? false,
    preflight: preflightRequest(),
    recoveryPending: recoveryPending(),
    liveElsewhere: sessionLiveElsewhere(),
    blockedMessage: block?.kind === 'blocked' ? `${block.message}\n${block.commands.join('\n')}` : null,
    idleReason: status === 'idle' ? startBlockedReason() : null,
  }
}, 'ui.sidebarViewModel')
