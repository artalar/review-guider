import type { Atom, Computed } from '@reatom/core'
import type { IsolationHandle } from '../git/isolate'
import type { ReviewTarget, SessionMode } from '../git/types'
import type { DiffFile, Guide, GuideStep, LineGroup, LineRange, RevealRender, ReviewDiff } from '../guide/types'
import type { Ports } from './ports'
import {
  abortVar,
  action,
  atom,
  computed,
  isAbort,
  withAbort,
  withAsync,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { applyGuideStep } from '../git/apply'
import { showBlob } from '../git/diff'
import { renderReveal } from '../guide/render'
import { revealMode } from './config'

/**
 * One session instance (architecture/reatom-model.md §5).
 *
 * Read-only: advance/retreat are pure state movement. Apply: next/prev are
 * async mutations that write the working tree (ADR 0004).
 */

export interface SessionRuntime {
  readonly ports: () => Ports
  readonly beginApply: () => boolean
  readonly endApply: (next: 'active' | 'blocked') => void
}

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
  readonly runtime: SessionRuntime
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

/**
 * The reveal model for one changed file (architecture/reatom-model.md §5.1).
 *
 * Three properties make Tab feel instant: `revealText` is a pure fold over
 * immutable data, `baseText` is fetched lazily once per file and cached by
 * `withAsyncData`, and the view model touches the *next* step's file so the
 * dependency graph warms it before the cursor arrives.
 */
export function reatomReviewFile(file: DiffFile, ctx: ReviewFileCtx) {
  const name = `${ctx.name}.file#${file.path}`

  // Pure precomputation: which steps touch this file, in order. No reactivity.
  const ownSteps = ctx.steps
    .map((step, index) => ({ index, step }))
    .filter(entry => entry.step.path === file.path)

  const baseText = computed(async (): Promise<string> => {
    // An added file has no base side, and a binary one has no text side at all.
    if (file.isBinary || file.status === 'added')
      return ''

    const blobPath = file.oldPath ?? file.path
    const text = await wrap(showBlob(ctx.repoRoot, ctx.baseRev, blobPath, {
      signal: abortVar.require().signal,
    }))
    // A path git cannot resolve at the base revision reads as empty rather than
    // failing: a missing blob must not take the whole review down with it.
    return text ?? ''
  }, `${name}.baseText`).extend(withAsyncData({ initState: null as string | null }))

  /** `steps[0..cursor]` restricted to this file — monotonic by construction. */
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

  /**
   * The pure fold. In `dim` mode the document always holds the full after text
   * and the bridge greys out what the cursor has not reached; the two modes
   * share this fold, these URIs, and the same `LineGroup` data (ADR 0002 D1).
   */
  const render = computed((): RevealRender | null => {
    const base = baseText.data()
    if (base === null)
      return null
    return renderReveal(base, file, revealMode() === 'dim' ? file.groups : revealedGroups())
  }, `${name}.render`)

  const revealText = computed((): string | null => render()?.text ?? null, `${name}.revealText`)

  /** Where the current step sits inside `revealText`, for the highlight. */
  const currentRanges = computed((): readonly LineRange[] => {
    const snapshot = render()
    const step = ctx.currentStep()
    if (snapshot === null || step === null || step.path !== file.path)
      return []
    return step.groups.map(group => snapshot.groupRanges.get(group.id)).filter(isRange)
  }, `${name}.currentRanges`)

  /**
   * What the cursor has not reached yet. Empty in progressive mode — those
   * lines are absent from the document rather than dimmed — which is exactly
   * how the two modes stay one code path.
   */
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
  const mode = init.mode
  const runtime = init.runtime

  /** `-1` means "nothing revealed / applied yet". */
  const cursor = atom(-1, `${name}.cursor`)
  const appliedIndex = atom(init.handle.token.appliedIndex, `${name}.appliedIndex`)

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
    if (mode === 'apply')
      return
    cursor.set(Math.min(Math.max(index, -1), steps.length - 1))
  }, `${name}.jumpTo`)

  const base = {
    id: init.id,
    repoRoot: init.repoRoot,
    entry: init.entry,
    baseRev: init.baseRev,
    afterRev: init.afterRev,
    handle: init.handle,
    diff: init.diff,
    guide: init.guide,
    mode,
    files,
    fileByPath,
    cursor,
    appliedIndex,
    currentStep,
    nextStep,
    canAdvance,
    canRetreat,
    isComplete,
    progress,
    activeFile,
    jumpTo,
  }

  if (mode !== 'apply') {
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

    const applyPending = computed((): boolean => false, `${name}.applyPending`)

    return { ...base, applyPending, next, prev }
  }

  const next = action(async (): Promise<boolean> => {
    if (!canAdvance())
      return false

    const k = cursor() + 1
    const step = steps[k]
    if (step === undefined)
      return false

    const ui = runtime.ports().ui
    if (!runtime.beginApply())
      return false

    try {
      const saved = await wrap(ui.saveDocuments(init.repoRoot, [step.path]))
      if (!saved.ok) {
        runtime.endApply('active')
        await wrap(ui.notify('warn', `Save ${saved.path} before applying the next step.`))
        return false
      }
      const outcome = await wrap(applyGuideStep({
        repoRoot: init.repoRoot,
        baseRev: init.baseRev,
        stepIndex: k,
        direction: 'forward',
        steps,
        files: init.diff.files,
        store: runtime.ports().store,
        token: init.handle.token,
      }))

      init.handle.token = outcome.token

      if (outcome.kind === 'applied') {
        cursor.set(k)
        appliedIndex.set(k)
        runtime.endApply('active')
        if (outcome.stub)
          await wrap(ui.notify('info', 'Skipped a stub step (no file write).'))
        if (outcome.driftPaths.length > 0) {
          await wrap(ui.notify(
            'warn',
            `Other files changed outside this step: ${outcome.driftPaths.slice(0, 3).join(', ')}${outcome.driftPaths.length > 3 ? '…' : ''}`,
          ))
        }
        if (outcome.paths[0] !== undefined)
          await wrap(ui.openWorkspaceFile(init.repoRoot, outcome.paths[0]))
        return true
      }

      // Conflict/refuse stay `active` so Tab can retry after the user resolves
      // markers (review 002 B3). `blocked` is reserved for restore failures.
      runtime.endApply('active')
      await wrap(ui.notify('warn', outcome.message))
      if (outcome.kind === 'conflict')
        await wrap(ui.openWorkspaceFile(init.repoRoot, outcome.path))
      return false
    }
    catch (error) {
      if (isAbort(error))
        throw error
      const message = error instanceof Error ? error.message : String(error)
      await wrap(ui.notify('warn', `Apply failed: ${message}`))
      return false
    }
    finally {
      // Throws (e.g. index.lock) must not pin status at `applying` (B2).
      runtime.endApply('blocked')
    }
  }, `${name}.next`).extend(withAsync({ status: true }), withAbort('first-in-win'))

  const prev = action(async (): Promise<boolean> => {
    if (!canRetreat())
      return false

    const k = appliedIndex()
    if (k < 0)
      return false

    const step = steps[k]
    if (step === undefined)
      return false

    const ui = runtime.ports().ui
    if (!runtime.beginApply())
      return false

    try {
      const saved = await wrap(ui.saveDocuments(init.repoRoot, [step.path]))
      if (!saved.ok) {
        runtime.endApply('active')
        await wrap(ui.notify('warn', `Save ${saved.path} before reverting.`))
        return false
      }
      const outcome = await wrap(applyGuideStep({
        repoRoot: init.repoRoot,
        baseRev: init.baseRev,
        stepIndex: k,
        direction: 'backward',
        steps,
        files: init.diff.files,
        store: runtime.ports().store,
        token: init.handle.token,
      }))

      init.handle.token = outcome.token

      if (outcome.kind === 'applied') {
        cursor.set(k - 1)
        appliedIndex.set(k - 1)
        runtime.endApply('active')
        if (outcome.paths[0] !== undefined)
          await wrap(ui.openWorkspaceFile(init.repoRoot, outcome.paths[0]))
        return true
      }

      runtime.endApply('active')
      await wrap(ui.notify('warn', outcome.message))
      if (outcome.kind === 'conflict')
        await wrap(ui.openWorkspaceFile(init.repoRoot, outcome.path))
      return false
    }
    catch (error) {
      if (isAbort(error))
        throw error
      const message = error instanceof Error ? error.message : String(error)
      await wrap(ui.notify('warn', `Revert failed: ${message}`))
      return false
    }
    finally {
      runtime.endApply('blocked')
    }
  }, `${name}.prev`).extend(withAsync({ status: true }), withAbort('first-in-win'))

  const applyPending = computed(
    (): boolean => next.status().isPending || prev.status().isPending,
    `${name}.applyPending`,
  )

  return { ...base, applyPending, next, prev }
}

export type Session = ReturnType<typeof reatomSession>
