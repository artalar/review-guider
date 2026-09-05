import type { DiffFile, LineGroup, LineRange, RevealRender } from './types'
import { groupLineIndex } from './groups'

interface SplitText {
  readonly lines: readonly string[]
  readonly trailingNewline: boolean
}

function splitLines(text: string): SplitText {
  if (text === '')
    return { lines: [], trailingNewline: false }
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  return { lines: body.split('\n'), trailingNewline }
}

/**
 * The progressive-reveal fold: base text plus the groups revealed so far in,
 * the "after so far" text out. Pure, cheap, and exactly reversible — Shift+Tab
 * is just a smaller `groups`.
 *
 * With no groups the result is the base text; with every group of the file the
 * result is the after text. A group's range in the output is where the decoration
 * layer highlights the current step; a pure deletion yields an empty range
 * (`end === start - 1`) anchored where the lines used to be.
 */
export function renderReveal(
  baseText: string,
  file: DiffFile,
  groups: readonly LineGroup[],
): RevealRender {
  const revealed = new Set(groups.filter(group => group.path === file.path).map(group => group.id))
  const index = groupLineIndex(file.groups)
  const { lines, trailingNewline } = splitLines(baseText)

  const out: string[] = []
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()
  let oldPos = 1

  const copyBaseThrough = (limit: number): void => {
    while (oldPos < limit && oldPos <= lines.length) {
      out.push(lines[oldPos - 1])
      oldPos++
    }
  }

  const hunks = [...file.hunks].sort((a, b) => a.oldStart - b.oldStart || a.index - b.index)
  for (const hunk of hunks) {
    // `@@ -N,0 +M,K @@` means "insert after old line N", not "at old line N".
    const insertAt = hunk.oldLines === 0 ? hunk.oldStart + 1 : Math.max(hunk.oldStart, 1)
    copyBaseThrough(insertAt)

    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        out.push(lines[oldPos - 1] ?? line.text)
        oldPos++
        continue
      }
      if (line.kind === 'del') {
        const id = index.del.get(`${hunk.index}:${line.oldLine ?? oldPos}`)
        if (id !== undefined && revealed.has(id)) {
          if (!starts.has(id)) {
            starts.set(id, out.length + 1)
            ends.set(id, out.length)
          }
        }
        else {
          out.push(lines[oldPos - 1] ?? line.text)
        }
        oldPos++
        continue
      }
      const id = index.add.get(`${hunk.index}:${line.newLine ?? 0}`)
      if (id === undefined || !revealed.has(id))
        continue
      out.push(line.text)
      if (!starts.has(id))
        starts.set(id, out.length)
      ends.set(id, out.length)
    }
  }
  copyBaseThrough(lines.length + 1)

  // Until every group is revealed the document is still the base-side view,
  // including its final-newline byte. Once the file is complete, use the
  // post-image marker. A single `noTrailingNewline` flag cannot distinguish a
  // replacement where only the old or only the new line is unterminated.
  const complete = file.groups.length > 0 && revealed.size === file.groups.length
  const endsWithNewline = complete
    ? (file.newTrailingNewline ?? !file.noTrailingNewline)
    : (baseText === '' ? !file.noTrailingNewline : trailingNewline)
  const text = out.length === 0 ? '' : out.join('\n') + (endsWithNewline ? '\n' : '')

  const groupRanges = new Map<string, LineRange>()
  for (const [id, start] of starts)
    groupRanges.set(id, { start, end: ends.get(id) ?? start - 1 })

  return { text, groupRanges }
}
