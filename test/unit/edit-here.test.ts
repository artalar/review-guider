import type { DiffFile, GuideStep } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
import { EDIT_HERE_HINT, projectEditHere } from '../../src/guide/edit-here'
import { parseUnifiedDiff } from '../../src/guide/parse-diff'
import { renderReveal } from '../../src/guide/render'
import { readDiffFixture } from '../helpers/fixtures'

const CALC_BASE = [
  'const a = 1',
  'const b = 2',
  'const c = 3',
  'const d = 4',
  'const e = 5',
  'const f = 6',
  'const g = 7',
  'const h = 8',
  'const j = 10',
  'const k = 11',
  'const l = 12',
].join('\n').concat('\n')

const CALC_AFTER = [
  'const a = 2',
  'const b = 2',
  'const c = 4',
  'const d = 4',
  'const e = 5',
  'const f = 6',
  'const g = 7',
  'const h = 9',
  'const i = 10',
  'const j = 10',
  'const k = 11',
  'const l = 12',
].join('\n').concat('\n')

function fileAt(files: readonly DiffFile[], path: string): DiffFile {
  const found = files.find(file => file.path === path)
  if (found === undefined)
    throw new Error(`fixture has no file ${path}`)
  return found
}

const calc = fileAt(parseUnifiedDiff(readDiffFixture('intra-hunk-groups.diff')).files, 'src/lib/calc.ts')
const removed = fileAt(parseUnifiedDiff(readDiffFixture('awkward.diff')).files, 'src/removed.ts')

function guideStep(file: DiffFile, groups: DiffFile['groups'], overrides: Partial<GuideStep> = {}): GuideStep {
  return {
    id: groups.map(group => group.id).join('+') || 'empty',
    path: file.path,
    groups: [...groups],
    kind: 'reveal',
    significance: 'normal',
    rationale: 'fixture',
    source: 'heuristic',
    ...overrides,
  }
}

describe('projectEditHere', () => {
  it('opens each of two reverse-ordered steps at its own after-side range', () => {
    const later = calc.groups[1]
    const earlier = calc.groups[0]
    if (later === undefined || earlier === undefined)
      throw new Error('fixture missing groups')

    const after = renderReveal(CALC_BASE, calc, calc.groups)
    const laterRange = after.groupRanges.get(later.id)
    const earlierRange = after.groupRanges.get(earlier.id)
    expect(laterRange).toEqual({ start: 8, end: 9 })
    expect(earlierRange).toEqual({ start: 1, end: 3 })
    expect(later.newAnchor).toBeGreaterThan(earlier.newAnchor)

    const laterHit = projectEditHere({
      entryKind: 'workingTree',
      file: calc,
      step: guideStep(calc, [later]),
      baseText: CALC_BASE,
      diskText: CALC_AFTER,
    })
    const earlierHit = projectEditHere({
      entryKind: 'workingTree',
      file: calc,
      step: guideStep(calc, [earlier]),
      baseText: CALC_BASE,
      diskText: CALC_AFTER,
    })

    expect(laterHit.enabled).toBe(true)
    expect(laterHit.line).toBe(8)
    expect(laterHit.ranges).toEqual([{ start: 8, end: 9 }])
    expect(earlierHit.line).toBe(1)
    expect(earlierHit.ranges).toEqual([{ start: 1, end: 3 }])
  })

  it('re-anchors by added-line text after an edit above the step', () => {
    const later = calc.groups[1]
    if (later === undefined)
      throw new Error('fixture missing groups')

    const disk = `// header\n// more\n${CALC_AFTER}`
    const hit = projectEditHere({
      entryKind: 'workingTree',
      file: calc,
      step: guideStep(calc, [later]),
      baseText: CALC_BASE,
      diskText: disk,
    })

    expect(hit.editedOnDisk).toBe(true)
    expect(hit.line).toBe(10)
    expect(hit.ranges).toEqual([{ start: 10, end: 11 }])
  })

  it('falls back to the nearest line when the added text is gone', () => {
    const later = calc.groups[1]
    if (later === undefined)
      throw new Error('fixture missing groups')

    const disk = CALC_AFTER.replace('const h = 9', 'const h = 900').replace('const i = 10', 'const i = 100')
    const hit = projectEditHere({
      entryKind: 'workingTree',
      file: calc,
      step: guideStep(calc, [later]),
      baseText: CALC_BASE,
      diskText: disk,
    })

    expect(hit.editedOnDisk).toBe(true)
    expect(hit.ranges[0]?.start).toBeGreaterThanOrEqual(1)
    expect(hit.line).toBe(hit.ranges[0]?.start)
  })

  it('opens a pure deletion at the removed lines\' position', () => {
    const base = 'export const gone = true\n\n'
    const hit = projectEditHere({
      entryKind: 'workingTree',
      file: removed,
      step: guideStep(removed, removed.groups),
      baseText: base,
      diskText: '',
    })

    expect(hit.enabled).toBe(true)
    expect(hit.line).toBe(1)
    expect(hit.ranges[0]).toEqual({ start: 1, end: 0 })
  })

  it('disables commit and range reviews with the Rebase / Worktree hint', () => {
    const group = calc.groups[0]
    if (group === undefined)
      throw new Error('fixture missing groups')

    for (const entryKind of ['commit', 'range'] as const) {
      const hit = projectEditHere({
        entryKind,
        file: calc,
        step: guideStep(calc, [group]),
        baseText: CALC_BASE,
        diskText: CALC_AFTER,
      })
      expect(hit.enabled).toBe(false)
      expect(hit.hint).toBe(EDIT_HERE_HINT)
    }
  })
})
