import type { GuideDoc } from '../../src/guide/schema'
import type { Guide, ReviewDiff } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
import { buildHeuristicGuide } from '../../src/guide/heuristic'
import { mergeGuide } from '../../src/guide/merge'
import { parseUnifiedDiff } from '../../src/guide/parse-diff'
import { validateGuideDoc } from '../../src/guide/schema'
import { readDiffFixture, readGuideFixture } from '../helpers/fixtures'

const DIFF_NAME = 'helper-consumer-refactor.diff'
const GOOD_GUIDE = 'helper-consumer.guide.json'
const MERGED_GUIDE = 'helper-consumer-merged.guide.json'
const DOGFOOD_GUIDE = 'helper-consumer.dogfood.guide.json'

const diff: ReviewDiff = parseUnifiedDiff(readDiffFixture(DIFF_NAME))
const heuristic: Guide = buildHeuristicGuide(diff)

function docFrom(input: unknown): GuideDoc {
  const result = validateGuideDoc(input)
  if (!result.ok)
    throw new Error(`fixture is invalid: ${JSON.stringify(result.error)}`)
  return result.value.doc
}

function assertI1(guide: Guide, source: ReviewDiff): void {
  const all = source.files.flatMap(file => file.groups.map(group => group.id)).sort()
  const assigned = guide.steps.flatMap(step => step.groups.map(group => group.id))
  expect(new Set(assigned).size).toBe(assigned.length)
  expect(assigned.slice().sort()).toEqual(all)
}

describe('p0-g2 golden helper+consumer fixture', () => {
  it('parses two distinct thoughts in one file (helper add, then consumer refactor)', () => {
    expect(diff.files.map(file => file.path)).toEqual(['src/jsx/events.ts'])
    expect(diff.files[0].groups.length).toBeGreaterThanOrEqual(2)
    const [helper, ...consumer] = diff.files[0].groups
    expect(helper.kind).toBe('add')
    expect(helper.newRange).toMatchObject({ start: 1, end: 5 })
    expect(consumer.length).toBeGreaterThanOrEqual(1)
    expect(consumer.every(group => group.kind === 'replace')).toBe(true)
  })

  it('accepts the correct split guide against schema', () => {
    const result = validateGuideDoc(readGuideFixture(GOOD_GUIDE))
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.value.doc.steps.map(step => step.id)).toEqual([
      'event-action-name',
      'jsx-event-adopts',
    ])
  })

  it('merges the correct guide into two sidecar steps in helper→consumer order', () => {
    const sidecar = docFrom(readGuideFixture(GOOD_GUIDE))
    const { guide, diagnostics } = mergeGuide({ diff, heuristic, sidecar })
    const sidecarSteps = guide.steps.filter(step => step.source === 'sidecar')

    expect(sidecarSteps.map(step => step.id)).toEqual([
      'event-action-name',
      'jsx-event-adopts',
    ])
    expect(sidecarSteps[0].groups.map(group => group.id)).toEqual([
      'src/jsx/events.ts#0:1-1',
    ])
    expect(sidecarSteps[1].groups.map(group => group.id)).toEqual([
      'src/jsx/events.ts#0:3-8',
      'src/jsx/events.ts#0:9-13',
    ])
    expect(guide.steps.indexOf(sidecarSteps[0]))
      .toBeLessThan(guide.steps.indexOf(sidecarSteps[1]))
    expect(diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toEqual([])
    assertI1(guide, diff)
  })

  it('accepts the merged anti-pattern guide against schema (valid JSON, wrong pedagogy)', () => {
    const result = validateGuideDoc(readGuideFixture(MERGED_GUIDE))
    expect(result.ok).toBe(true)
  })

  it('shows why the merged guide fails dogfood: one sidecar step claims both thoughts', () => {
    const sidecar = docFrom(readGuideFixture(MERGED_GUIDE))
    const { guide } = mergeGuide({ diff, heuristic, sidecar })
    const sidecarSteps = guide.steps.filter(step => step.source === 'sidecar')

    expect(sidecarSteps).toHaveLength(1)
    expect(sidecarSteps[0].id).toBe('events')
    expect(sidecarSteps[0].groups).toHaveLength(diff.files[0].groups.length)
    assertI1(guide, diff)
  })

  it('accepts the P0-G3 dogfood attempt against schema with helper before consumer', () => {
    const result = validateGuideDoc(readGuideFixture(DOGFOOD_GUIDE))
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    const { steps } = result.value.doc
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps.every(step => step.path === 'src/jsx/events.ts')).toBe(true)
    expect(steps.every(step => Array.isArray(step.ranges) && step.ranges.length > 0)).toBe(true)
    expect(steps[0].id).toBe('event-action-name')
    expect(steps.slice(1).some(step => step.id.includes('jsx-event') || step.dependsOn?.includes('event-action-name'))).toBe(true)
  })
})
