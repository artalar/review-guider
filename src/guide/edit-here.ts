import type { DiffFile, GuideStep, LineGroup, LineRange } from './types'
import { renderReveal } from './render'

/**
 * Edit-here projection (ADR 0005 D4): map the current step onto the real file.
 *
 * Ranges start from `renderReveal(base, file, file.groups).groupRanges`. After
 * disk edits they re-anchor by the group's added-line text, then fall back to
 * the nearest line. A pure deletion opens at the position the removed lines
 * occupied.
 */

export interface EditHereProjection {
  readonly path: string
  readonly line: number
  readonly ranges: readonly LineRange[]
  readonly editedOnDisk: boolean
  readonly enabled: boolean
  readonly hint: string | null
}

export const EDIT_HERE_HINT
  = 'Start in Rebase or Worktree mode to edit the real file.'

export function projectEditHere(input: {
  readonly entryKind: 'workingTree' | 'commit' | 'range'
  readonly sessionMode?: 'readonly' | 'rebase' | 'worktree'
  readonly file: DiffFile
  readonly step: GuideStep
  readonly baseText: string
  readonly diskText: string | null
}): EditHereProjection {
  const after = renderReveal(input.baseText, input.file, input.file.groups)
  const snapshotRanges = input.step.groups
    .map(group => after.groupRanges.get(group.id))
    .filter(isRange)

  const diskHoldsAfter = input.entryKind === 'workingTree' || input.sessionMode === 'rebase'
  if (!diskHoldsAfter) {
    return {
      path: input.step.path,
      line: firstLine(snapshotRanges),
      ranges: snapshotRanges,
      editedOnDisk: false,
      enabled: false,
      hint: EDIT_HERE_HINT,
    }
  }

  const diskText = input.diskText
  const editedOnDisk = diskText !== null && diskText !== after.text
  if (!editedOnDisk || diskText === null) {
    return {
      path: input.step.path,
      line: firstLine(snapshotRanges),
      ranges: snapshotRanges,
      editedOnDisk,
      enabled: true,
      hint: null,
    }
  }

  const ranges = input.step.groups.map(group =>
    reanchorGroup(group, input.file, diskText, after.groupRanges.get(group.id)),
  )
  return {
    path: input.step.path,
    line: firstLine(ranges),
    ranges,
    editedOnDisk: true,
    enabled: true,
    hint: null,
  }
}

function isRange(range: LineRange | undefined): range is LineRange {
  return range !== undefined
}

function firstLine(ranges: readonly LineRange[]): number {
  const first = ranges[0]
  if (first === undefined)
    return 1
  return Math.max(1, first.start)
}

function reanchorGroup(
  group: LineGroup,
  file: DiffFile,
  diskText: string,
  snapshot: LineRange | undefined,
): LineRange {
  const added = addedLineTexts(file, group)
  if (added.length > 0) {
    const found = findBlock(splitFileLines(diskText), added)
    if (found !== null)
      return { start: found, end: found + added.length - 1 }
  }

  const fallback = snapshot?.start ?? group.newAnchor ?? group.oldAnchor ?? 1
  const lineCount = splitFileLines(diskText).length
  const nearest = Math.min(Math.max(fallback, 1), Math.max(lineCount, 1))
  if (group.kind === 'del')
    return { start: nearest, end: nearest - 1 }
  return { start: nearest, end: nearest }
}

function addedLineTexts(file: DiffFile, group: LineGroup): string[] {
  const hunk = file.hunks[group.hunkIndex]
  if (hunk === undefined || group.newRange === undefined)
    return []
  const texts: string[] = []
  for (const line of hunk.lines) {
    if (line.kind !== 'add' || line.newLine === undefined)
      continue
    if (line.newLine >= group.newRange.start && line.newLine <= group.newRange.end)
      texts.push(line.text)
  }
  return texts
}

function splitFileLines(text: string): string[] {
  if (text === '')
    return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

function findBlock(haystack: readonly string[], needle: readonly string[]): number | null {
  if (needle.length === 0 || needle.length > haystack.length)
    return null
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    let match = true
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[index + offset] !== needle[offset]) {
        match = false
        break
      }
    }
    if (match)
      return index + 1
  }
  return null
}
