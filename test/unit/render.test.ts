import type { DiffFile } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
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
const awkward = parseUnifiedDiff(readDiffFixture('awkward.diff'))

describe('renderReveal', () => {
  it('returns the base text when nothing is revealed', () => {
    expect(renderReveal(CALC_BASE, calc, []).text).toBe(CALC_BASE)
  })

  it('returns the after text when everything is revealed', () => {
    expect(renderReveal(CALC_BASE, calc, calc.groups).text).toBe(CALC_AFTER)
  })

  it('applies one group at a time, leaving the rest at the base', () => {
    const first = renderReveal(CALC_BASE, calc, [calc.groups[0]]).text
    expect(first.split('\n').slice(0, 4)).toEqual([
      'const a = 2',
      'const b = 2',
      'const c = 4',
      'const d = 4',
    ])
    expect(first).toContain('const h = 8')
    expect(first).not.toContain('const i = 10')
  })

  it('reports where each revealed group landed in the rendered text', () => {
    const render = renderReveal(CALC_BASE, calc, calc.groups)
    expect(render.groupRanges.get(calc.groups[0].id)).toEqual({ start: 1, end: 3 })
    expect(render.groupRanges.get(calc.groups[1].id)).toEqual({ start: 8, end: 9 })
    expect(render.groupRanges.size).toBe(2)
  })

  it('reports no range for a group that is not revealed', () => {
    const render = renderReveal(CALC_BASE, calc, [calc.groups[1]])
    expect(render.groupRanges.has(calc.groups[0].id)).toBe(false)
  })

  it('is monotonic: revealing more never un-reveals what came before', () => {
    let previous = renderReveal(CALC_BASE, calc, []).text
    for (let k = 1; k <= calc.groups.length; k++) {
      const next = renderReveal(CALC_BASE, calc, calc.groups.slice(0, k)).text
      const added = previous.split('\n').filter(line => line.startsWith('const a = 2') || line.startsWith('const c = 4'))
      for (const line of added)
        expect(next).toContain(line)
      previous = next
    }
    expect(previous).toBe(CALC_AFTER)
  })

  it('is a pure function of its arguments', () => {
    const a = renderReveal(CALC_BASE, calc, [calc.groups[0]])
    const b = renderReveal(CALC_BASE, calc, [calc.groups[0]])
    expect(a.text).toBe(b.text)
    expect([...a.groupRanges]).toEqual([...b.groupRanges])
  })
})

describe('renderReveal — file lifecycle', () => {
  it('tracks a removed final newline independently from the added side', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/file.txt b/file.txt\n'
      + '--- a/file.txt\n'
      + '+++ b/file.txt\n'
      + '@@ -1 +1 @@\n'
      + '-old\n'
      + '+new\n'
      + '\\ No newline at end of file\n',
    ).files[0]
    expect(diff.oldTrailingNewline).toBe(true)
    expect(diff.newTrailingNewline).toBe(false)
    expect(renderReveal('old\n', diff, []).text).toBe('old\n')
    expect(renderReveal('old\n', diff, diff.groups).text).toBe('new')
  })

  it('tracks an added final newline independently from the removed side', () => {
    const diff = parseUnifiedDiff(
      'diff --git a/file.txt b/file.txt\n'
      + '--- a/file.txt\n'
      + '+++ b/file.txt\n'
      + '@@ -1 +1 @@\n'
      + '-old\n'
      + '\\ No newline at end of file\n'
      + '+new\n',
    ).files[0]
    expect(diff.oldTrailingNewline).toBe(false)
    expect(diff.newTrailingNewline).toBe(true)
    expect(renderReveal('old', diff, []).text).toBe('old')
    expect(renderReveal('old', diff, diff.groups).text).toBe('new\n')
  })

  it('renders an added file from an empty base and honours its missing newline', () => {
    const added = fileAt(awkward.files, 'src/added.ts')
    expect(renderReveal('', added, []).text).toBe('')
    expect(renderReveal('', added, added.groups).text).toBe(
      'export const answer = 42\n\nexport const other = 1',
    )
  })

  it('renders a deleted file down to nothing', () => {
    const removed = fileAt(awkward.files, 'src/removed.ts')
    const base = 'export const gone = true\n\n'
    expect(renderReveal(base, removed, []).text).toBe(base)
    expect(renderReveal(base, removed, removed.groups).text).toBe('')
  })

  it('gives a pure deletion an empty range at the point the lines left', () => {
    const removed = fileAt(awkward.files, 'src/removed.ts')
    const render = renderReveal('export const gone = true\n\n', removed, removed.groups)
    expect(render.groupRanges.get(removed.groups[0].id)).toEqual({ start: 1, end: 0 })
  })

  it('renders a renamed file the same way as a modified one', () => {
    const renamed = fileAt(awkward.files, 'docs/new-name.md')
    expect(renderReveal('# Title\n\nOld body.\n', renamed, renamed.groups).text)
      .toBe('# Title\n\nNew body.\n')
  })

  it('renders a file with no hunks as its base text', () => {
    const script = fileAt(awkward.files, 'scripts/deploy.sh')
    expect(renderReveal('#!/bin/sh\necho hi\n', script, []).text).toBe('#!/bin/sh\necho hi\n')
  })

  it('preserves CRLF line endings', () => {
    const crlf = parseUnifiedDiff(
      'diff --git a/src/crlf.ts b/src/crlf.ts\n'
      + '--- a/src/crlf.ts\n'
      + '+++ b/src/crlf.ts\n'
      + '@@ -1,2 +1,2 @@\n'
      + ' const a = 1\r\n'
      + '-const b = 2\r\n'
      + '+const b = 3\r\n',
    ).files[0]
    const base = 'const a = 1\r\nconst b = 2\r\n'
    expect(renderReveal(base, crlf, crlf.groups).text).toBe('const a = 1\r\nconst b = 3\r\n')
  })

  it('prefers the base text over the diff context when they disagree', () => {
    const drifted = renderReveal(CALC_BASE.replace('const e = 5', 'const e = 500'), calc, [])
    expect(drifted.text).toContain('const e = 500')
  })
})
