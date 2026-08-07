import type { DiffFile } from '../../src/guide/types'
import { describe, expect, it } from 'vitest'
import { isGeneratedPath, parseNameStatusZ, parseUnifiedDiff, unquotePath } from '../../src/guide/parse-diff'
import { readDiffFixture } from '../helpers/fixtures'

function fileAt(files: readonly DiffFile[], path: string): DiffFile {
  const found = files.find(file => file.path === path)
  if (found === undefined)
    throw new Error(`fixture has no file ${path}; got ${files.map(f => f.path).join(', ')}`)
  return found
}

describe('parseUnifiedDiff — ordinary patches', () => {
  const diff = parseUnifiedDiff(readDiffFixture('foundation-order.diff'))

  it('finds every file in patch order', () => {
    expect(diff.files.map(file => file.path)).toEqual([
      'pnpm-lock.yaml',
      'res/icon.png',
      'src/service.ts',
      'src/types.ts',
      'src/ui/Component.tsx',
      'test/unit/service.test.ts',
    ])
  })

  it('numbers hunk lines on both sides', () => {
    const hunk = fileAt(diff.files, 'src/ui/Component.tsx').hunks[0]
    expect(hunk.oldStart).toBe(1)
    expect(hunk.oldLines).toBe(5)
    expect(hunk.newStart).toBe(1)
    expect(hunk.newLines).toBe(6)
    expect(hunk.lines.map(line => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['context', 3, 3],
      ['del', 4, undefined],
      ['add', undefined, 4],
      ['context', 5, 5],
    ])
  })

  it('splits a hunk into contiguous line groups', () => {
    const service = fileAt(diff.files, 'src/service.ts')
    expect(service.groups).toHaveLength(2)
    expect(service.groups[0]).toMatchObject({
      kind: 'replace',
      oldRange: { start: 1, end: 1 },
      newRange: { start: 1, end: 1 },
      addedLines: 1,
      deletedLines: 1,
    })
    expect(service.groups[1]).toMatchObject({
      kind: 'add',
      newRange: { start: 6, end: 11 },
      addedLines: 6,
      deletedLines: 0,
    })
    expect(service.groups[1].oldRange).toBeUndefined()
  })

  it('gives every group a stable, unique, path-qualified id', () => {
    const ids = diff.files.flatMap(file => file.groups.map(group => group.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(fileAt(diff.files, 'src/service.ts').groups[0].id).toBe('src/service.ts#0:1-1')
  })

  it('flags generated paths without touching a filesystem', () => {
    expect(fileAt(diff.files, 'pnpm-lock.yaml').isGenerated).toBe(true)
    expect(fileAt(diff.files, 'src/service.ts').isGenerated).toBe(false)
    expect(isGeneratedPath('src/generated/meta.ts')).toBe(true)
    expect(isGeneratedPath('dist/index.js')).toBe(true)
    expect(isGeneratedPath('src/dist-helper.ts')).toBe(false)
  })

  it('records a binary file with no hunks', () => {
    const icon = fileAt(diff.files, 'res/icon.png')
    expect(icon).toMatchObject({ status: 'binary', isBinary: true })
    expect(icon.hunks).toHaveLength(0)
    expect(icon.groups).toHaveLength(0)
  })
})

describe('parseUnifiedDiff — the awkward cases', () => {
  const diff = parseUnifiedDiff(readDiffFixture('awkward.diff'))

  it('reads a rename header', () => {
    const renamed = fileAt(diff.files, 'docs/new-name.md')
    expect(renamed.status).toBe('renamed')
    expect(renamed.oldPath).toBe('docs/old-name.md')
    expect(renamed.groups).toHaveLength(1)
  })

  it('reads a mode-only change, which has no ---/+++ header at all', () => {
    const script = fileAt(diff.files, 'scripts/deploy.sh')
    expect(script).toMatchObject({ status: 'mode-only', oldMode: '100644', newMode: '100755' })
    expect(script.hunks).toHaveLength(0)
  })

  it('reads an added file and its missing trailing newline', () => {
    const added = fileAt(diff.files, 'src/added.ts')
    expect(added.status).toBe('added')
    expect(added.noTrailingNewline).toBe(true)
    expect(added.groups).toHaveLength(1)
    expect(added.groups[0]).toMatchObject({ kind: 'add', newRange: { start: 1, end: 3 }, addedLines: 3 })
  })

  it('reads a deleted file', () => {
    const removed = fileAt(diff.files, 'src/removed.ts')
    expect(removed.status).toBe('deleted')
    expect(removed.groups[0]).toMatchObject({ kind: 'del', oldRange: { start: 1, end: 2 }, deletedLines: 2 })
    expect(removed.groups[0].newRange).toBeUndefined()
  })

  it('reads a GIT binary patch body without mistaking it for content', () => {
    expect(fileAt(diff.files, 'assets/logo.bin')).toMatchObject({ status: 'binary', isBinary: true })
  })

  it('survives an empty hunk', () => {
    const empty = fileAt(diff.files, 'src/empty-hunk.ts')
    expect(empty.hunks).toHaveLength(1)
    expect(empty.hunks[0].lines).toHaveLength(0)
    expect(empty.groups).toHaveLength(0)
  })
})

describe('parseUnifiedDiff — paths and line endings', () => {
  const patch = readDiffFixture('quoted-and-nonewline.diff')
  const diff = parseUnifiedDiff(patch)

  it('unquotes paths with spaces and octal-escaped UTF-8', () => {
    expect(diff.files.map(file => file.path)).toEqual(['src/with space.ts', 'docs/café.md'])
  })

  it('strips the timestamp git adds to ---/+++ in some modes', () => {
    expect(fileAt(diff.files, 'src/with space.ts').status).toBe('modified')
  })

  it('handles "\\ No newline at end of file" on both sides of one hunk', () => {
    expect(fileAt(diff.files, 'src/with space.ts').noTrailingNewline).toBe(true)
  })

  it('parses identically when the patch has no trailing newline', () => {
    const trimmed = parseUnifiedDiff(patch.replace(/\n$/, ''))
    expect(trimmed).toEqual(diff)
  })

  it('keeps CRLF content bytes in the line text', () => {
    const crlf = parseUnifiedDiff(
      'diff --git a/src/crlf.ts b/src/crlf.ts\n'
      + '--- a/src/crlf.ts\n'
      + '+++ b/src/crlf.ts\n'
      + '@@ -1,2 +1,2 @@\n'
      + ' const a = 1\r\n'
      + '-const b = 2\r\n'
      + '+const b = 3\r\n',
    )
    const lines = crlf.files[0].hunks[0].lines
    expect(lines[0].text).toBe('const a = 1\r')
    expect(lines[2].text).toBe('const b = 3\r')
  })

  it('unquotes standalone paths', () => {
    expect(unquotePath('"a\\tb.ts"')).toBe('a\tb.ts')
    expect(unquotePath('"caf\\303\\251"')).toBe('café')
    expect(unquotePath('plain.ts')).toBe('plain.ts')
  })
})

describe('parseUnifiedDiff — name-status enrichment', () => {
  it('takes the pre-image path from --name-status when the patch omits it', () => {
    const patch = 'diff --git a/src/new.ts b/src/new.ts\n'
      + '--- a/src/new.ts\n'
      + '+++ b/src/new.ts\n'
      + '@@ -1 +1 @@\n'
      + '-const a = 1\n'
      + '+const a = 2\n'
    const diff = parseUnifiedDiff(patch, [{ code: 'R096', path: 'src/new.ts', oldPath: 'src/old.ts' }])
    expect(diff.files[0]).toMatchObject({ status: 'renamed', oldPath: 'src/old.ts' })
  })

  it('parses NUL-separated --name-status output', () => {
    expect(parseNameStatusZ('M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0A\0src/b.ts\0')).toEqual([
      { code: 'M', path: 'src/a.ts' },
      { code: 'R100', path: 'src/new.ts', oldPath: 'src/old.ts' },
      { code: 'A', path: 'src/b.ts' },
    ])
  })
})

describe('parseUnifiedDiff — totality', () => {
  it.each([
    ['empty patch', ''],
    ['header only', 'diff --git a/a.ts b/a.ts\n'],
    ['truncated hunk', 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,5 @@\n a\n'],
    ['garbage', 'not a diff at all\njust some text\n'],
    ['lone hunk header', '@@ -1,1 +1,1 @@\n'],
  ])('never throws on %s', (_name, patch) => {
    expect(() => parseUnifiedDiff(patch)).not.toThrow()
  })

  it('is deterministic', () => {
    const patch = readDiffFixture('awkward.diff')
    expect(parseUnifiedDiff(patch)).toEqual(parseUnifiedDiff(patch))
  })
})
