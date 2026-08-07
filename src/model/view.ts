import type { GuideStep } from '../guide/types'
import { computed } from '@reatom/core'
import { session, sessionStatus, showRationale, startBlockedReason } from './session'

/**
 * The bridge's projections. Everything VS Code renders is derived here, so the
 * UI layer holds no branching logic of its own.
 */

function basename(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index === -1 ? path : path.slice(index + 1)
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
  return lines.join('\n')
}, 'ui.statusTooltip')

export interface ReviewViewModel {
  readonly sessionId: string
  readonly progress: { readonly index: number, readonly total: number }
  readonly step: GuideStep | null
  readonly activePath: string | null
  readonly complete: boolean
}

/**
 * The bridge's single subscription. Phase 5 extends it with the reveal text and
 * the current step's ranges; the shape it exposes today is deliberately the
 * part that does not depend on the reveal fold.
 */
export const reviewViewModel = computed((): ReviewViewModel | null => {
  const model = session()
  if (model === null)
    return null

  const step = model.currentStep()
  return {
    sessionId: model.id,
    progress: model.progress(),
    step,
    activePath: step?.path ?? null,
    complete: model.isComplete(),
  }
}, 'ui.reviewViewModel')
