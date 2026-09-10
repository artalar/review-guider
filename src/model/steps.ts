import type { Atom, Computed } from '@reatom/core'
import type { IsolationHandle } from '../git/isolate'
import type { ReviewTarget, SessionMode } from '../git/types'
import type { DiffFile, Guide, GuideStep, LineGroup, LineRange, RevealRender, ReviewDiff } from '../guide/types'
import { abortVar, action, atom, computed, withAsyncData, wrap } from '@reatom/core'
import { showBlob } from '../git/diff'
import { renderReveal } from '../guide/render'
import { revealMode } from './config'

/**
 * One session instance. Advance/retreat are pure state movement — the reveal
 * is a fold over the cursor (ADR 0005 D4).
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
  readonly mode: SessionMode
}

export interface SessionProgress {
  readonly index: number
  readonly total: number
}

interface ReviewFileCtx {
  readonly name: string
  readonly cursor: Atom<number>
  readonly currentStep: Computed<GuideStep | null>
  readonly steps: readonly GuideStep[]
  readonly repoRoot: string
  readonly baseRev: string
}

function isRange(range: LineRange | undefined): range is LineRange {
  return range !== undefined
}

export function reatomReviewFile(file: DiffFile, ctx: ReviewFileCtx) {
  const name = `${ctx.name}.file#${file.path}`

  const ownSteps = ctx.steps
    .map((step, index) => ({ index, step }))
    .filter(entry => entry.step.path === file.path)

  const baseText = computed(async (): Promise<string> => {
    if (file.isBinary || file.status === 'added')
      return ''

    const blobPath = file.oldPath ?? file.path
    const text = await wrap(showBlob(ctx.repoRoot, ctx.baseRev, blobPath, {
      signal: abortVar.require().signal,
    }))
    return text ?? ''
  }, `${name}.baseText`).extend(withAsyncData({ initState: null as string | null }))

  const revealedGroups = computed((): readonly LineGroup[] => {
    const upTo = ctx.cursor()
    const out: LineGroup[] = []
    for (const entry of ownSteps) {
      if (entry.index > upTo)
        break
      out.push(...entry.step.groups)
    }
    return out
  }, `${name}.revealedGroups`)

  const render = computed((): RevealRender | null => {
    const base = baseText.data()
    if (base === null)
      return null
    return renderReveal(base, file, revealMode() === 'dim' ? file.groups : revealedGroups())
  }, `${name}.render`)

  const revealText = computed((): string | null => render()?.text ?? null, `${name}.revealText`)

  const currentRanges = computed((): readonly LineRange[] => {
    const snapshot = render()
    const step = ctx.currentStep()
    if (snapshot === null || step === null || step.path !== file.path)
      return []
    return step.groups.map(group => snapshot.groupRanges.get(group.id)).filter(isRange)
  }, `${name}.currentRanges`)

  const pendingRanges = computed((): readonly LineRange[] => {
    const snapshot = render()
    if (snapshot === null)
      return []
    const revealed = new Set(revealedGroups().map(group => group.id))
    return file.groups
      .filter(group => !revealed.has(group.id))
      .map(group => snapshot.groupRanges.get(group.id))
      .filter(isRange)
  }, `${name}.pendingRanges`)

  return { path: file.path, file, baseText, revealedGroups, render, revealText, currentRanges, pendingRanges }
}

export type ReviewFile = ReturnType<typeof reatomReviewFile>

export function reatomSession(init: SessionInit) {
  const name = `session#${init.id}`
  const steps = init.guide.steps

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

  const files: readonly ReviewFile[] = init.diff.files.map(file => reatomReviewFile(file, {
    name,
    cursor,
    currentStep,
    steps,
    repoRoot: init.repoRoot,
    baseRev: init.baseRev,
  }))
  const fileByPath = new Map(files.map(entry => [entry.path, entry]))

  const activeFile = computed((): ReviewFile | null => {
    const step = currentStep() ?? nextStep()
    return step === null ? null : fileByPath.get(step.path) ?? null
  }, `${name}.activeFile`)

  const jumpTo = action((index: number) => {
    cursor.set(Math.min(Math.max(index, -1), steps.length - 1))
  }, `${name}.jumpTo`)

  const next = action((): boolean => {
    if (!canAdvance())
      return false
    cursor.set(index => index + 1)
    return true
  }, `${name}.next`)

  const prev = action((): boolean => {
    if (!canRetreat())
      return false
    cursor.set(index => index - 1)
    return true
  }, `${name}.prev`)

  return {
    id: init.id,
    repoRoot: init.repoRoot,
    entry: init.entry,
    baseRev: init.baseRev,
    afterRev: init.afterRev,
    handle: init.handle,
    diff: init.diff,
    guide: init.guide,
    mode: init.mode,
    files,
    fileByPath,
    cursor,
    currentStep,
    nextStep,
    canAdvance,
    canRetreat,
    isComplete,
    progress,
    activeFile,
    jumpTo,
    next,
    prev,
  }
}

export type Session = ReturnType<typeof reatomSession>
