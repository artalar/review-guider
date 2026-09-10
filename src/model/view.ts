import type { GitState } from '../git/state'
import type { SessionMode } from '../git/types'
import type { GuideStep, LineRange } from '../guide/types'
import type { SessionStatus } from './session'
import type { SetupPhase } from './setup'
import type { SessionProgress } from './steps'
import { computed } from '@reatom/core'
import { describeTarget } from '../git/types'
import { resolveGuideFile } from '../guide/sidecar'
import { guideFile, showRationale } from './config'
import {
  editedPaths,
  editHereEnabled,
  gitState,
  session,
  canStart as sessionCanStart,
  sessionStatus,
  startBlockedReason,
  willRun,
} from './session'
import {
  focusedGuidePath,
  setupPhase,
  sidecarExists,
  skillInstalled,
} from './setup'

export const REVIEW_SCHEME = 'tabthrough'

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

export function reviewDocTitle(path: string): string {
  return `${basename(path)} (Tabthrough)`
}

export const statusText = computed((): string | null => {
  const model = session()
  if (model === null)
    return null

  if (model.isComplete())
    return '$(book) Walkthrough complete · Finish'

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
  readonly baseText: string | null
  readonly revealText: string | null
  readonly ranges: readonly LineRange[]
  readonly pendingRanges: readonly LineRange[]
  readonly complete: boolean
}

function stubDocumentText(step: GuideStep): string {
  return `${step.path}\n\n${step.rationale}\n`
}

export const reviewViewModel = computed((): ReviewViewModel | null => {
  const model = session()
  if (model === null)
    return null

  const active = model.activeFile()
  const upcoming = model.nextStep()

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
  readonly canAdvance: boolean
  readonly canRetreat: boolean
  readonly idleReason: string | null
  readonly setup: SetupPhase
  readonly skillInstalled: boolean | null
  readonly guideFocused: boolean
  readonly sidecarReady: boolean
  readonly focusedGuideMismatch: boolean
  readonly guideFileName: string
  readonly gitState: GitState | null
  readonly willRun: string
  readonly editHereEnabled: boolean
  readonly editedPaths: readonly string[]
}

export const sidebarViewModel = computed((): SidebarViewModel => {
  const model = session()
  const status = sessionStatus()
  const current = model?.currentStep() ?? null
  const next = model?.nextStep() ?? null
  const configuredGuide = guideFile().trim()

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
    canAdvance: model?.canAdvance() ?? false,
    canRetreat: model?.canRetreat() ?? false,
    idleReason: status === 'idle' ? startBlockedReason() : null,
    setup: setupPhase(),
    skillInstalled: skillInstalled.data(),
    guideFocused: focusedGuidePath() !== null,
    sidecarReady: sidecarExists.data(),
    focusedGuideMismatch: focusedGuidePath() !== null && focusedGuidePath() !== resolveGuideFile(guideFile()),
    guideFileName: resolveGuideFile(configuredGuide),
    gitState: gitState.data(),
    willRun: willRun(),
    editHereEnabled: editHereEnabled(),
    editedPaths: editedPaths.data(),
  }
}, 'ui.sidebarViewModel')
