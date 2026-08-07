import type { DiffHunk, LineGroup } from './types'

export interface GroupOptions {
  /**
   * Two changed runs separated by at most this many context lines merge into
   * one group. Default 1.
   */
  readonly gap?: number
}

export const DEFAULT_GROUP_GAP = 1

interface Pending {
  oldAnchor: number
  newAnchor: number
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  addedLines: number
  deletedLines: number
}

function emptyPending(oldAnchor: number, newAnchor: number): Pending {
  return {
    oldAnchor,
    newAnchor,
    oldStart: 0,
    oldEnd: 0,
    newStart: 0,
    newEnd: 0,
    addedLines: 0,
    deletedLines: 0,
  }
}

function seal(pending: Pending, path: string, hunkIndex: number): LineGroup {
  const hasOld = pending.deletedLines > 0
  const hasNew = pending.addedLines > 0
  const kind = hasOld && hasNew ? 'replace' : hasNew ? 'add' : 'del'
  return {
    id: `${path}#${hunkIndex}:${pending.oldAnchor}-${pending.newAnchor}`,
    path,
    hunkIndex,
    kind,
    ...(hasOld ? { oldRange: { start: pending.oldStart, end: pending.oldEnd } } : {}),
    ...(hasNew ? { newRange: { start: pending.newStart, end: pending.newEnd } } : {}),
    oldAnchor: pending.oldAnchor,
    newAnchor: pending.newAnchor,
    addedLines: pending.addedLines,
    deletedLines: pending.deletedLines,
  }
}

/**
 * Extract the contiguous runs of changed lines from one hunk.
 *
 * Ranges cover only *changed* lines: when two runs merge across a context line,
 * that context line's number sits inside the range but the line itself is never
 * a member of the group. Membership is therefore always `kind + containment`,
 * which is what keeps {@link groupLineIndex} unambiguous.
 */
export function groupHunkLines(hunk: DiffHunk, path: string, opts?: GroupOptions): LineGroup[] {
  const gap = opts?.gap ?? DEFAULT_GROUP_GAP
  const groups: LineGroup[] = []
  let oldCursor = hunk.oldStart
  let newCursor = hunk.newStart
  let pending: Pending | null = null
  let contextRun = 0

  for (const line of hunk.lines) {
    if (line.kind === 'context') {
      contextRun++
      oldCursor++
      newCursor++
      continue
    }

    if (pending !== null && contextRun > gap) {
      groups.push(seal(pending, path, hunk.index))
      pending = null
    }
    if (pending === null)
      pending = emptyPending(oldCursor, newCursor)
    contextRun = 0

    if (line.kind === 'add') {
      const n = line.newLine ?? newCursor
      pending.newStart = pending.addedLines === 0 ? n : Math.min(pending.newStart, n)
      pending.newEnd = Math.max(pending.newEnd, n)
      pending.addedLines++
      newCursor++
    }
    else {
      const o = line.oldLine ?? oldCursor
      pending.oldStart = pending.deletedLines === 0 ? o : Math.min(pending.oldStart, o)
      pending.oldEnd = Math.max(pending.oldEnd, o)
      pending.deletedLines++
      oldCursor++
    }
  }

  if (pending !== null)
    groups.push(seal(pending, path, hunk.index))

  return groups
}

export interface GroupLineIndex {
  /** `${hunkIndex}:${newLine}` → group id, for `add` lines. */
  readonly add: ReadonlyMap<string, string>
  /** `${hunkIndex}:${oldLine}` → group id, for `del` lines. */
  readonly del: ReadonlyMap<string, string>
}

/** Reverse index used by the reveal fold to ask "which group owns this line?". */
export function groupLineIndex(groups: readonly LineGroup[]): GroupLineIndex {
  const add = new Map<string, string>()
  const del = new Map<string, string>()
  for (const group of groups) {
    if (group.newRange) {
      for (let n = group.newRange.start; n <= group.newRange.end; n++)
        add.set(`${group.hunkIndex}:${n}`, group.id)
    }
    if (group.oldRange) {
      for (let o = group.oldRange.start; o <= group.oldRange.end; o++)
        del.set(`${group.hunkIndex}:${o}`, group.id)
    }
  }
  return { add, del }
}

/** Total changed lines a group reveals. The unit `maxLinesPerStep` counts. */
export function groupSize(group: LineGroup): number {
  return group.addedLines + group.deletedLines
}

/**
 * Document order: hunk first, then position. Groups within a hunk never share
 * an anchor pair, so this is a total order.
 */
export function compareGroups(a: LineGroup, b: LineGroup): number {
  if (a.hunkIndex !== b.hunkIndex)
    return a.hunkIndex - b.hunkIndex
  if (a.oldAnchor !== b.oldAnchor)
    return a.oldAnchor - b.oldAnchor
  if (a.newAnchor !== b.newAnchor)
    return a.newAnchor - b.newAnchor
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
