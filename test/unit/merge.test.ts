import type { GuideDoc } from '../../src/guide/schema'
import type { Guide, ReviewDiff } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
import { buildHeuristicGuide } from '../../src/guide/heuristic'
import { mergeGuide } from '../../src/guide/merge'
import { parseUnifiedDiff } from '../../src/guide/parse-diff'
import { validateGuideDoc } from '../../src/guide/schema'
import { loadSidecar } from '../../src/guide/sidecar'
import { readDiffFixture, readGuideFixture, readGuideFixtureText } from '../helpers/fixtures'

const diff: ReviewDiff = parseUnifiedDiff(readDiffFixture('foundation-order.diff'))
const heuristic: Guide = buildHeuristicGuide(diff)

function docFrom(input: unknown): GuideDoc {
  const result = validateGuideDoc(input)
  if (!result.ok)
    throw new Error(`fixture is invalid: ${JSON.stringify(result.error)}`)
  return result.value.doc
}

function docFromFixture(name: string): GuideDoc {
  return docFrom(readGuideFixture(name))
}

function firstTouch(guide: Guide): string[] {
  const seen: string[] = []
  for (const step of guide.steps) {
    if (!seen.includes(step.path))
      seen.push(step.path)
  }
  return seen
}

function assertI1(guide: Guide, source: ReviewDiff): void {
  const all = source.files.flatMap(file => file.groups.map(group => group.id)).sort()
  const assigned = guide.steps.flatMap(step => step.groups.map(group => group.id))
  expect(new Set(assigned).size).toBe(assigned.length)
  expect(assigned.slice().sort()).toEqual(all)
}

describe('mergeGuide — no sidecar', () => {
  it('returns the heuristic guide untouched', () => {
    const { guide } = mergeGuide({ diff, heuristic })
    expect(guide).toBe(heuristic)
  })
})

describe('mergeGuide — a valid sidecar', () => {
  const sidecar = docFromFixture('valid.guide.json')
  const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })

  it('overrides the heuristic order', () => {
    expect(heuristic.steps[0].path).toBe('src/types.ts')
    expect(guide.steps[0].id).toBe('service-resume')
    expect(firstTouch(guide)[0]).toBe('src/service.ts')
  })

  it('honours dependsOn as a refinement of order', () => {
    const ids = guide.steps.map(step => step.id)
    expect(ids.slice(0, 3)).toEqual(['service-resume', 'types-session', 'component'])
    expect(ids.indexOf('types-session')).toBeLessThan(ids.indexOf('component'))
  })

  it('carries the author\'s rationale, title, notes and significance', () => {
    expect(guide.steps[0]).toMatchObject({
      source: 'sidecar',
      significance: 'critical',
      title: 'resume()',
      rationale: 'The behaviour the rest of the change exists for',
    })
    expect(guide.steps[0].notes).toContain('Start here')
  })

  it('appends the heuristic remainder after every sidecar step', () => {
    const sidecarSteps = guide.steps.filter(step => step.source === 'sidecar')
    const lastSidecar = guide.steps.lastIndexOf(sidecarSteps[sidecarSteps.length - 1])
    const firstHeuristic = guide.steps.findIndex(step => step.source === 'heuristic')
    expect(firstHeuristic).toBeGreaterThan(lastSidecar)
  })

  it('keeps the import churn the sidecar did not claim', () => {
    const remainder = guide.steps.find(step => step.source === 'heuristic' && step.path === 'src/service.ts')
    expect(remainder?.groups.map(group => group.id)).toEqual(['src/service.ts#0:1-1'])
  })

  it('applies per-file overrides to heuristic steps', () => {
    const lockfile = guide.steps.find(step => step.path === 'pnpm-lock.yaml')
    expect(lockfile).toMatchObject({
      significance: 'skip',
      rationale: 'Lockfile churn from the same install',
    })
  })

  it('keeps the binary stub so k/n stays honest', () => {
    expect(guide.steps.find(step => step.path === 'res/icon.png')?.kind).toBe('stub')
  })

  it('keeps every invariant', () => {
    assertI1(guide, diff)
    const ids = guide.steps.map(step => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(guide.steps.length).toBeGreaterThan(0)
    expect(guide.stale).toBe(false)
  })

  it('emits no warnings for a clean guide', () => {
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toEqual([])
  })

  it('is deterministic', () => {
    expect(mergeGuide({ diff, heuristic, sidecar }).guide).toEqual(guide)
  })
})

describe('mergeGuide — replace strategy', () => {
  const sidecar = docFromFixture('replace.guide.json')
  const { guide } = mergeGuide({ diff, heuristic, sidecar })

  it('discards the heuristic ordering but never a line', () => {
    expect(guide.steps[0].id).toBe('types-session')
    assertI1(guide, diff)
  })

  it('gives each remaining file exactly one trailing step', () => {
    const remainders = guide.steps.filter(step => step.id.startsWith('h:remainder:'))
    expect(remainders.map(step => step.path)).toEqual([
      'pnpm-lock.yaml',
      'src/service.ts',
      'src/ui/Component.tsx',
      'test/unit/service.test.ts',
    ])
    expect(remainders[0].rationale).toBe('Remaining changes in pnpm-lock.yaml')
  })

  it('still emits the stub steps', () => {
    expect(guide.steps.find(step => step.path === 'res/icon.png')?.kind).toBe('stub')
  })
})

describe('mergeGuide — anchoring', () => {
  it('drops a step whose path is not in the diff', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'ghost', path: 'src/does-not-exist.ts', rationale: 'nothing here' },
        { id: 'real', path: 'src/types.ts', rationale: 'The shape' },
      ],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.steps.map(step => step.id)).not.toContain('ghost')
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('path-unknown')
    assertI1(guide, diff)
  })

  it('drops a step whose path escapes the repository', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'escape', path: '../../etc/passwd', rationale: 'not ours' },
        { id: 'real', path: 'src/types.ts', rationale: 'The shape' },
      ],
    })
    const { diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(diagnostics.find(diagnostic => diagnostic.code === 'path-unsafe')?.stepId).toBe('escape')
  })

  it('drops a step whose ranges match nothing and says why', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'missed', path: 'src/types.ts', ranges: [{ start: 900, end: 950 }], rationale: 'far away' },
        { id: 'real', path: 'src/types.ts', rationale: 'The shape' },
      ],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.steps.map(step => step.id)).not.toContain('missed')
    expect(diagnostics.find(diagnostic => diagnostic.code === 'anchor-unmatched')?.stepId).toBe('missed')
  })

  it('falls back to the pure heuristic when no sidecar step survives', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [{ id: 'missed', path: 'src/types.ts', ranges: [{ start: 900 }], rationale: 'far away' }],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.steps).toEqual(heuristic.steps)
    expect(diagnostics.filter(diagnostic => diagnostic.code === 'anchor-unmatched')).toHaveLength(1)
  })

  it('gives an overlapping group to the step with the larger overlap', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'wide', order: 10, path: 'src/service.ts', ranges: [{ start: 1, end: 11 }], rationale: 'all of it' },
        { id: 'narrow', order: 20, path: 'src/service.ts', ranges: [{ start: 6, end: 6 }], rationale: 'a sliver' },
      ],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    const wide = guide.steps.find(step => step.id === 'wide')
    expect(wide?.groups.map(group => group.id)).toEqual(['src/service.ts#0:1-1', 'src/service.ts#0:6-6'])
    expect(diagnostics.find(diagnostic => diagnostic.code === 'range-overlap')?.stepId).toBe('narrow')
    assertI1(guide, diff)
  })

  it('anchors a pure deletion on the old side', () => {
    const removals = parseUnifiedDiff(readDiffFixture('awkward.diff'))
    const base = buildHeuristicGuide(removals)
    const sidecar = docFrom({
      version: 1,
      steps: [{
        id: 'gone',
        path: 'src/removed.ts',
        ranges: [{ side: 'old', start: 1, end: 2 }],
        rationale: 'What this replaces',
      }],
    })
    const { guide } = mergeGuide({ diff: removals, heuristic: base, sidecar })
    expect(guide.steps[0]).toMatchObject({ id: 'gone', source: 'sidecar' })
    expect(guide.steps[0].groups).toHaveLength(1)
    assertI1(guide, removals)
  })

  it('lets an explicit range beat a whole-file claim', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'whole', order: 10, path: 'src/service.ts', rationale: 'everything' },
        { id: 'exact', order: 20, path: 'src/service.ts', ranges: [{ start: 6, end: 11 }], rationale: 'the new function' },
      ],
    })
    const { guide } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.steps.find(step => step.id === 'exact')?.groups.map(group => group.id))
      .toEqual(['src/service.ts#0:6-6'])
    expect(guide.steps.find(step => step.id === 'whole')?.groups.map(group => group.id))
      .toEqual(['src/service.ts#0:1-1'])
  })
})

describe('mergeGuide — dependsOn', () => {
  it('warns about an unknown dependency and ignores it', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [{ id: 'a', path: 'src/types.ts', rationale: 'r', dependsOn: ['nope'] }],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(diagnostics.find(diagnostic => diagnostic.code === 'depends-unknown')?.stepId).toBe('a')
    expect(guide.steps[0].id).toBe('a')
  })

  it('drops every edge on a cycle and keeps the order sort', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        { id: 'a', order: 10, path: 'src/types.ts', rationale: 'r', dependsOn: ['b'] },
        { id: 'b', order: 20, path: 'src/service.ts', rationale: 'r', dependsOn: ['a'] },
      ],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('depends-cycle')
    expect(guide.steps.slice(0, 2).map(step => step.id)).toEqual(['a', 'b'])
  })
})

describe('mergeGuide — grouping', () => {
  it('splits a large step into sub-steps that share one rationale', () => {
    const sidecar = docFrom({
      version: 1,
      defaults: { maxLinesPerStep: 1 },
      steps: [{
        id: 'big',
        path: 'src/service.ts',
        grouping: 'split',
        title: 'The service',
        rationale: 'One thought, several screens',
      }],
    })
    const { guide } = mergeGuide({ diff, heuristic, sidecar })
    const parts = guide.steps.filter(step => step.id.startsWith('big#'))
    expect(parts.map(step => step.id)).toEqual(['big#1', 'big#2'])
    expect(parts.map(step => step.title)).toEqual(['The service (1/2)', 'The service (2/2)'])
    expect(new Set(parts.map(step => step.rationale)).size).toBe(1)
    assertI1(guide, diff)
  })

  it('reveals a mergeWithNext step together with its successor', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [
        {
          id: 'imports',
          order: 10,
          path: 'src/service.ts',
          ranges: [{ start: 1, end: 1 }],
          grouping: 'mergeWithNext',
          rationale: 'Comes with the function below',
        },
        {
          id: 'body',
          order: 20,
          path: 'src/service.ts',
          ranges: [{ start: 6, end: 11 }],
          rationale: 'The new function',
        },
      ],
    })
    const { guide } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.steps.map(step => step.id)).not.toContain('imports')
    expect(guide.steps.find(step => step.id === 'body')?.groups.map(group => group.id)).toEqual([
      'src/service.ts#0:1-1',
      'src/service.ts#0:6-6',
    ])
    assertI1(guide, diff)
  })

  it('reports mergeWithNext on a step with no successor', () => {
    const sidecar = docFrom({
      version: 1,
      steps: [{ id: 'lonely', path: 'src/types.ts', grouping: 'mergeWithNext', rationale: 'nowhere to go' }],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(diagnostics.find(diagnostic => diagnostic.code === 'merge-no-successor')?.stepId).toBe('lonely')
    expect(guide.steps.map(step => step.id)).toContain('lonely')
    assertI1(guide, diff)
  })
})

describe('mergeGuide — staleness', () => {
  it('marks the guide stale when the digest does not match, but still uses it', () => {
    const sidecar = docFrom({
      version: 1,
      scope: { kind: 'commit', diffDigest: `sha256:${'0'.repeat(64)}` },
      steps: [{ id: 'a', path: 'src/types.ts', rationale: 'The shape' }],
    })
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    expect(guide.stale).toBe(true)
    expect(diagnostics.find(diagnostic => diagnostic.code === 'stale-guide')?.severity).toBe('warning')
    expect(guide.steps[0].id).toBe('a')
  })

  it('is not stale when the digest matches', () => {
    const sidecar = docFrom({
      version: 1,
      scope: { kind: 'workingTree', diffDigest: diff.digest },
      steps: [{ id: 'a', path: 'src/types.ts', rationale: 'The shape' }],
    })
    expect(mergeGuide({ diff, heuristic, sidecar }).guide.stale).toBe(false)
  })
})

describe('mergeGuide — a broken sidecar never breaks the session', () => {
  it('falls back to the heuristic with exactly one warning', () => {
    const load = loadSidecar({ path: '.guide.json', text: readGuideFixtureText('invalid.guide.json') })
    const { guide, diagnostics } = mergeGuide({
      diff,
      heuristic: { ...heuristic, diagnostics: load.diagnostics },
      ...(load.doc === null ? {} : { sidecar: load.doc }),
    })
    expect(guide.steps).toEqual(heuristic.steps)
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toHaveLength(1)
    assertI1(guide, diff)
  })
})
