import type { IsolationHandle } from '../../src/git/isolate'
import type { GuideStep } from '../../src/guide/types'
import { context } from '@reatom/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { reatomSession } from '../../src/model/steps'

/**
 * Cursor movement is pure state motion — no I/O — which is what makes Tab
 * instant and Shift+Tab correct by construction.
 */

const HANDLE: IsolationHandle = {
  sessionId: 's',
  repoRoot: '/repo',
  baseRev: 'base',
  afterRev: 'after',
  afterRef: null,
}

function step(path: string): GuideStep {
  return {
    id: `step:${path}`,
    path,
    groups: [],
    kind: 'stub',
    significance: 'normal',
    rationale: `because of ${path}`,
    source: 'heuristic',
  }
}

function makeSession(paths: readonly string[]) {
  return reatomSession({
    id: 's',
    repoRoot: '/repo',
    entry: { kind: 'workingTree' },
    baseRev: 'base',
    afterRev: 'after',
    handle: HANDLE,
    diff: { files: [], digest: 'sha256:test' },
    guide: { steps: paths.map(step), stale: false, diagnostics: [] },
    mode: 'readonly',
  })
}

beforeEach(() => context.reset())

describe('reatomSession cursor', () => {
  it('starts before the first step', () => {
    context.start(() => {
      const model = makeSession(['a.ts', 'b.ts'])
      expect(model.cursor()).toBe(-1)
      expect(model.currentStep()).toBeNull()
      expect(model.nextStep()?.path).toBe('a.ts')
      expect(model.canAdvance()).toBe(true)
      expect(model.canRetreat()).toBe(false)
      expect(model.progress()).toEqual({ index: 0, total: 2 })
    })
  })

  it('advances and retreats symmetrically', () => {
    context.start(() => {
      const model = makeSession(['a.ts', 'b.ts', 'c.ts'])

      expect(model.next()).toBe(true)
      expect(model.next()).toBe(true)
      expect(model.currentStep()?.path).toBe('b.ts')
      expect(model.progress()).toEqual({ index: 2, total: 3 })

      expect(model.prev()).toBe(true)
      expect(model.currentStep()?.path).toBe('a.ts')
      expect(model.prev()).toBe(true)
      expect(model.currentStep()).toBeNull()
      expect(model.cursor()).toBe(-1)
    })
  })

  it('clamps at both ends and reports the no-op', () => {
    context.start(() => {
      const model = makeSession(['only.ts'])

      expect(model.prev()).toBe(false)
      expect(model.cursor()).toBe(-1)

      expect(model.next()).toBe(true)
      expect(model.isComplete()).toBe(true)
      expect(model.next()).toBe(false)
      expect(model.cursor()).toBe(0)
    })
  })

  it('clamps a jump into range', () => {
    context.start(() => {
      const model = makeSession(['a.ts', 'b.ts'])

      model.jumpTo(99)
      expect(model.cursor()).toBe(1)
      model.jumpTo(-99)
      expect(model.cursor()).toBe(-1)
      model.jumpTo(1)
      expect(model.currentStep()?.path).toBe('b.ts')
    })
  })

  it('treats an empty guide as immediately complete', () => {
    context.start(() => {
      const model = makeSession([])

      expect(model.canAdvance()).toBe(false)
      expect(model.isComplete()).toBe(true)
      expect(model.next()).toBe(false)
      expect(model.progress()).toEqual({ index: 0, total: 0 })
    })
  })
})
