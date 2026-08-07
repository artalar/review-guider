import type { DiffFile, Guide } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
import { buildHeuristicGuide, fileTier, scoreGroup } from '../../src/guide/heuristic'
import { parseUnifiedDiff } from '../../src/guide/parse-diff'
import { readDiffFixture } from '../helpers/fixtures'

const foundation = parseUnifiedDiff(readDiffFixture('foundation-order.diff'))

function firstTouch(guide: Guide): string[] {
  const seen: string[] = []
  for (const step of guide.steps) {
    if (!seen.includes(step.path))
      seen.push(step.path)
  }
  return seen
}

function fileAt(files: readonly DiffFile[], path: string): DiffFile {
  const found = files.find(file => file.path === path)
  if (found === undefined)
    throw new Error(`fixture has no file ${path}`)
  return found
}

describe('buildHeuristicGuide — foundation before consumer', () => {
  const guide = buildHeuristicGuide(foundation)

  it('orders types → service → component → test → supporting', () => {
    expect(firstTouch(guide)).toEqual([
      'src/types.ts',
      'src/service.ts',
      'src/ui/Component.tsx',
      'test/unit/service.test.ts',
      'pnpm-lock.yaml',
      'res/icon.png',
    ])
  })

  it('names the rule that fired on every step, in one short line', () => {
    for (const step of guide.steps) {
      expect(step.rationale.length).toBeGreaterThan(0)
      expect(step.rationale.length).toBeLessThanOrEqual(120)
      expect(step.rationale).not.toContain('\n')
    }
    expect(guide.steps[0].rationale).toBe('Types before callers')
  })

  it('gives a binary file a visible stub step so k/n stays honest', () => {
    const stub = guide.steps.find(step => step.path === 'res/icon.png')
    expect(stub).toMatchObject({ kind: 'stub', groups: [], rationale: 'Skipped: binary file' })
    expect(guide.steps.filter(step => step.kind === 'reveal').length).toBeGreaterThan(0)
  })

  it('puts every line group in exactly one step (I1)', () => {
    const all = foundation.files.flatMap(file => file.groups.map(group => group.id))
    const assigned = guide.steps.flatMap(step => step.groups.map(group => group.id))
    expect(assigned.slice().sort()).toEqual(all.slice().sort())
    expect(new Set(assigned).size).toBe(assigned.length)
  })

  it('keeps step ids unique (I2) and yields at least one step for a non-empty diff (I3)', () => {
    const ids = guide.steps.map(step => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(guide.steps.length).toBeGreaterThan(0)
  })

  it('is deterministic across runs and independent of input file order (I4)', () => {
    expect(buildHeuristicGuide(foundation)).toEqual(guide)
    const reversed = { ...foundation, files: [...foundation.files].reverse() }
    expect(buildHeuristicGuide(reversed).steps.map(step => step.id)).toEqual(guide.steps.map(step => step.id))
  })
})

describe('fileTier', () => {
  const cases: readonly [string, number][] = [
    ['src/types.ts', 0],
    ['src/model/schema.ts', 0],
    ['proto/user.proto', 0],
    ['src/index.d.ts', 0],
    ['db/migrations/001_init.sql', 0],
    ['src/lib/calc.ts', 1],
    ['src/service.ts', 1],
    ['src/services/api.ts', 2],
    ['src/state/session.ts', 2],
    ['src/ui/Component.tsx', 3],
    ['src/components/Button.vue', 3],
    ['styles/app.css', 3],
    ['test/unit/service.test.ts', 4],
    ['src/foo.spec.ts', 4],
    ['package.json', 5],
    ['README.md', 5],
    ['.github/workflows/ci.yml', 5],
    ['pnpm-lock.yaml', 6],
  ]

  it.each(cases)('puts %s in tier %i', (path, tier) => {
    const file: DiffFile = {
      path,
      status: 'modified',
      isBinary: false,
      isGenerated: path === 'pnpm-lock.yaml',
      noTrailingNewline: false,
      hunks: [],
      groups: [],
    }
    expect(fileTier(file)).toBe(tier)
  })

  it('classifies a test for a type file as a test, not a type', () => {
    const file: DiffFile = {
      path: 'test/unit/types.test.ts',
      status: 'modified',
      isBinary: false,
      isGenerated: false,
      noTrailingNewline: false,
      hunks: [],
      groups: [],
    }
    expect(fileTier(file)).toBe(4)
  })
})

describe('import-graph refinement inside a tier', () => {
  it('puts an imported file before the file that imports it, against path order', () => {
    const patch = 'diff --git a/src/lib/alpha.ts b/src/lib/alpha.ts\n'
      + '--- a/src/lib/alpha.ts\n'
      + '+++ b/src/lib/alpha.ts\n'
      + '@@ -1,2 +1,2 @@\n'
      + ' import { zeta } from \'./zeta\'\n'
      + '-export const a = zeta(1)\n'
      + '+export const a = zeta(2)\n'
      + 'diff --git a/src/lib/zeta.ts b/src/lib/zeta.ts\n'
      + '--- a/src/lib/zeta.ts\n'
      + '+++ b/src/lib/zeta.ts\n'
      + '@@ -1 +1 @@\n'
      + '-export const zeta = (n: number) => n\n'
      + '+export const zeta = (n: number) => n + 1\n'
    const guide = buildHeuristicGuide(parseUnifiedDiff(patch))
    expect(firstTouch(guide)).toEqual(['src/lib/zeta.ts', 'src/lib/alpha.ts'])
  })

  it('falls back to path order when the imports form a cycle', () => {
    const patch = 'diff --git a/src/lib/one.ts b/src/lib/one.ts\n'
      + '--- a/src/lib/one.ts\n'
      + '+++ b/src/lib/one.ts\n'
      + '@@ -1 +1,2 @@\n'
      + ' import \'./two\'\n'
      + '+export const one = 1\n'
      + 'diff --git a/src/lib/two.ts b/src/lib/two.ts\n'
      + '--- a/src/lib/two.ts\n'
      + '+++ b/src/lib/two.ts\n'
      + '@@ -1 +1,2 @@\n'
      + ' import \'./one\'\n'
      + '+export const two = 2\n'
    const guide = buildHeuristicGuide(parseUnifiedDiff(patch))
    expect(firstTouch(guide)).toEqual(['src/lib/one.ts', 'src/lib/two.ts'])
  })
})

describe('hunk significance', () => {
  const service = fileAt(foundation.files, 'src/service.ts')
  const types = fileAt(foundation.files, 'src/types.ts')

  it('scores a new exported function above a changed import', () => {
    const exported = scoreGroup(service, service.groups[1])
    const importChurn = scoreGroup(service, service.groups[0])
    expect(exported.score).toBeGreaterThan(importChurn.score)
    expect(exported.significance).toBe('critical')
    expect(exported.rationale).toBe('New public surface')
  })

  it('scores a new exported type as high or better', () => {
    const scored = scoreGroup(types, types.groups[0])
    expect(['critical', 'high']).toContain(scored.significance)
  })

  it('scores a comment- and whitespace-only change at zero', () => {
    const patch = 'diff --git a/src/lib/fmt.ts b/src/lib/fmt.ts\n'
      + '--- a/src/lib/fmt.ts\n'
      + '+++ b/src/lib/fmt.ts\n'
      + '@@ -1,2 +1,3 @@\n'
      + ' const kept = 1\n'
      + '-// old note\n'
      + '+// new note\n'
      + '+\n'
    const file = parseUnifiedDiff(patch).files[0]
    expect(scoreGroup(file, file.groups[0]).score).toBe(0)
    expect(scoreGroup(file, file.groups[0]).significance).toBe('low')
    expect(scoreGroup(file, file.groups[0], true).significance).toBe('skip')
    expect(scoreGroup(file, file.groups[0]).rationale).toBe('Formatting only')
  })

  it('does not let a large body edit inflate itself into a critical step', () => {
    const body = Array.from({ length: 30 }, (_, i) => `+  total += ${i}`).join('\n')
    const patch = 'diff --git a/src/lib/sum.ts b/src/lib/sum.ts\n'
      + '--- a/src/lib/sum.ts\n'
      + '+++ b/src/lib/sum.ts\n'
      + '@@ -1,1 +1,31 @@\n'
      + ' let total = 0\n'
      + `${body}\n`
    const file = parseUnifiedDiff(patch).files[0]
    expect(scoreGroup(file, file.groups[0]).significance).toBe('low')
  })
})

describe('step sizing', () => {
  const calc = parseUnifiedDiff(readDiffFixture('intra-hunk-groups.diff'))

  it('coalesces low-significance groups up to maxLinesPerStep', () => {
    const guide = buildHeuristicGuide(calc)
    expect(guide.steps).toHaveLength(1)
    expect(guide.steps[0].groups).toHaveLength(2)
  })

  it('stops coalescing at the configured bound', () => {
    const guide = buildHeuristicGuide(calc, { maxLinesPerStep: 4 })
    expect(guide.steps).toHaveLength(2)
    expect(guide.steps.flatMap(step => step.groups)).toHaveLength(2)
  })

  it('never spans files in one step', () => {
    for (const step of buildHeuristicGuide(foundation).steps) {
      for (const group of step.groups)
        expect(group.path).toBe(step.path)
    }
  })

  it('gives a high-significance group a step of its own', () => {
    const guide = buildHeuristicGuide(foundation)
    const own = guide.steps.find(step => step.path === 'src/service.ts' && step.significance === 'critical')
    expect(own?.groups).toHaveLength(1)
  })
})

describe('hideFormattingSteps', () => {
  const patch = 'diff --git a/src/lib/mix.ts b/src/lib/mix.ts\n'
    + '--- a/src/lib/mix.ts\n'
    + '+++ b/src/lib/mix.ts\n'
    + '@@ -1,6 +1,7 @@\n'
    + '-// note\n'
    + '+// tidier note\n'
    + ' const a = 1\n'
    + ' const b = 2\n'
    + ' const c = 3\n'
    + ' const d = 4\n'
    + '-export function run(): void {}\n'
    + '+export function run(flag: boolean): void {\n'
    + '+  if (flag) return\n'
    + '+}\n'

  it('leaves formatting groups as their own low step by default', () => {
    const guide = buildHeuristicGuide(parseUnifiedDiff(patch))
    expect(guide.steps.map(step => step.significance)).toEqual(['low', 'critical'])
  })

  it('folds a skip group into the next step in the same file', () => {
    const guide = buildHeuristicGuide(parseUnifiedDiff(patch), { hideFormattingSteps: true })
    expect(guide.steps).toHaveLength(1)
    expect(guide.steps[0].significance).toBe('critical')
    expect(guide.steps[0].groups).toHaveLength(2)
  })
})
