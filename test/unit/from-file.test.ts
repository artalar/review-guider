import { describe, expect, it } from 'vitest'
import { entryFromGuideScope, isGuideFileName } from '../../src/guide/from-file'

describe('isGuideFileName', () => {
  it('matches *.guide.json including the default sidecar name', () => {
    expect(isGuideFileName('.guide.json')).toBe(true)
    expect(isGuideFileName('pr-42.guide.json')).toBe(true)
    expect(isGuideFileName('nested/name.guide.json')).toBe(true)
    expect(isGuideFileName('.tabthrough-guide.json')).toBe(true)
    expect(isGuideFileName('review.tabthrough-guide.json')).toBe(true)
  })

  it('rejects plain guide.json and other JSON', () => {
    expect(isGuideFileName('guide.json')).toBe(false)
    expect(isGuideFileName('package.json')).toBe(false)
    expect(isGuideFileName('guide.jsonl')).toBe(false)
  })
})

describe('entryFromGuideScope', () => {
  it('defaults a missing scope to the working tree', () => {
    expect(entryFromGuideScope(undefined)).toEqual({
      kind: 'entry',
      entry: { kind: 'workingTree' },
    })
  })

  it('uses head (then base) for a commit scope', () => {
    expect(entryFromGuideScope({ kind: 'commit', head: 'abc' })).toEqual({
      kind: 'entry',
      entry: { kind: 'commit', rev: 'abc' },
    })
    expect(entryFromGuideScope({ kind: 'commit', base: 'def' })).toEqual({
      kind: 'entry',
      entry: { kind: 'commit', rev: 'def' },
    })
    expect(entryFromGuideScope({ kind: 'commit' })).toEqual({ kind: 'needs-commit' })
  })

  it('requires both ends of a range', () => {
    expect(entryFromGuideScope({ kind: 'range', base: 'main', head: 'HEAD' })).toEqual({
      kind: 'entry',
      entry: { kind: 'range', from: 'main', to: 'HEAD' },
    })
    expect(entryFromGuideScope({ kind: 'range', base: 'main' })).toEqual({ kind: 'needs-range' })
  })
})
