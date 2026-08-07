import type { IsolationHandle } from '../git/isolate'
import type { ReviewTarget } from '../git/types'
import type { Guide, GuideStep, ReviewDiff } from '../guide/types'
import { action, atom, computed } from '@reatom/core'

/**
 * One session instance (architecture/reatom-model.md §5).
 *
 * The guide is frozen plain data; only the cursor is an atom. Advance and
 * retreat are therefore pure state movement — no I/O, no `async` — which is
 * what makes Tab feel instant and makes Shift+Tab correct by construction.
 */

export interface SessionInit {
  readonly id: string
  readonly repoRoot: string
  readonly entry: ReviewTarget
  readonly baseRev: string
  readonly afterRev: string
  readonly handle: IsolationHandle
  readonly diff: ReviewDiff
  readonly guide: Guide
}

export interface SessionProgress {
  readonly index: number
  readonly total: number
}

export function reatomSession(init: SessionInit) {
  const name = `session#${init.id}`
  const steps = init.guide.steps

  /** `-1` means "nothing revealed yet". */
  const cursor = atom(-1, `${name}.cursor`)

  const currentStep = computed((): GuideStep | null => steps[cursor()] ?? null, `${name}.currentStep`)
  const nextStep = computed((): GuideStep | null => steps[cursor() + 1] ?? null, `${name}.nextStep`)
  const canAdvance = computed(() => cursor() < steps.length - 1, `${name}.canAdvance`)
  const canRetreat = computed(() => cursor() >= 0, `${name}.canRetreat`)
  const isComplete = computed(() => cursor() >= steps.length - 1, `${name}.isComplete`)
  const progress = computed(
    (): SessionProgress => ({ index: Math.max(0, cursor() + 1), total: steps.length }),
    `${name}.progress`,
  )

  const next = action(() => {
    if (!canAdvance())
      return false
    cursor.set(index => index + 1)
    return true
  }, `${name}.next`)

  const prev = action(() => {
    if (!canRetreat())
      return false
    cursor.set(index => index - 1)
    return true
  }, `${name}.prev`)

  const jumpTo = action((index: number) => {
    cursor.set(Math.min(Math.max(index, -1), steps.length - 1))
  }, `${name}.jumpTo`)

  return {
    id: init.id,
    repoRoot: init.repoRoot,
    entry: init.entry,
    baseRev: init.baseRev,
    afterRev: init.afterRev,
    handle: init.handle,
    diff: init.diff,
    guide: init.guide,
    cursor,
    currentStep,
    nextStep,
    canAdvance,
    canRetreat,
    isComplete,
    progress,
    next,
    prev,
    jumpTo,
  }
}

export type Session = ReturnType<typeof reatomSession>
