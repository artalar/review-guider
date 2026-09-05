import type {
  DiffFile,
  DiffHunk,
  DiffLine,
  FileStatus,
  LineGroup,
  NameStatusEntry,
  ReviewDiff,
} from './types'
import { groupHunkLines } from './groups'
import { computeDiffDigest } from './schema'
import { utf8Decode } from './text'

export interface ParseDiffOptions {
  /** Context-line tolerance when merging adjacent changed runs. Default 1. */
  readonly gap?: number
  /** Override the built-in generated-path detection. */
  readonly isGenerated?: (path: string) => boolean
}

const GENERATED_FILENAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'flake.lock',
  'podfile.lock',
  'go.sum',
])

const GENERATED_DIR = /(?:^|\/)(?:dist|build|out|coverage|node_modules|vendor|generated|__generated__|__snapshots__|\.next|\.nuxt|\.svelte-kit)\//
const GENERATED_FILE = /(?:\.min\.(?:js|css)|\.map|\.snap|\.pb\.go|_pb2\.py|\.generated\.[^/]+|\.g\.dart|\.freezed\.dart)$/

/**
 * Best-effort, filesystem-free version of git's `linguist-generated`. The pure
 * layer cannot read `.gitattributes`, so callers that can may inject their own
 * predicate through {@link ParseDiffOptions}.
 */
export function isGeneratedPath(path: string): boolean {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  return GENERATED_FILENAMES.has(name) || GENERATED_DIR.test(lower) || GENERATED_FILE.test(lower)
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** Undo git's C-style quoting (`"src/a\tb"`, `"\303\251.txt"`). */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2)
    return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      for (const b of utf8EncodeChar(body, i)) bytes.push(b)
      continue
    }
    const next = body[++i]
    if (next === undefined)
      break
    if (next >= '0' && next <= '7') {
      const octal = next + (body[i + 1] ?? '') + (body[i + 2] ?? '')
      const digits = /^[0-7]{1,3}/.exec(octal)?.[0] ?? next
      i += digits.length - 1
      bytes.push(Number.parseInt(digits, 8) & 0xFF)
      continue
    }
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }
    bytes.push(simple[next] ?? next.charCodeAt(0))
  }
  return utf8Decode(bytes)
}

function utf8EncodeChar(source: string, index: number): number[] {
  const code = source.charCodeAt(index)
  if (code < 0x80)
    return [code]
  // Non-ASCII characters inside a quoted path are already decoded text; pass
  // the code unit through by re-encoding it.
  if (code < 0x800)
    return [0xC0 | (code >> 6), 0x80 | (code & 0x3F)]
  return [0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F)]
}

function stripSidePrefix(raw: string): string | null {
  let value = raw
  const tab = value.indexOf('\t')
  if (tab >= 0)
    value = value.slice(0, tab)
  value = unquotePath(value.trim())
  if (value === '/dev/null')
    return null
  if (value.startsWith('a/') || value.startsWith('b/'))
    return value.slice(2)
  return value
}

/** `diff --git a/x b/x` — the only header binary and mode-only files carry. */
function splitDiffGitHeader(rest: string): { a: string | null, b: string | null } {
  if (rest.length >= 3 && (rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2
    if (rest[half] === ' ') {
      const a = rest.slice(0, half)
      const b = rest.slice(half + 1)
      if (a.startsWith('a/') && b.startsWith('b/'))
        return { a: stripSidePrefix(a), b: stripSidePrefix(b) }
    }
  }
  for (let i = rest.indexOf(' '); i >= 0; i = rest.indexOf(' ', i + 1)) {
    const a = rest.slice(0, i)
    const b = rest.slice(i + 1)
    if ((a.startsWith('a/') || a.startsWith('"a/')) && (b.startsWith('b/') || b.startsWith('"b/')))
      return { a: stripSidePrefix(a), b: stripSidePrefix(b) }
  }
  return { a: null, b: null }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface HunkDraft {
  index: number
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
  pendingOld: number
  pendingNew: number
}

interface FileDraft {
  headerA: string | null
  headerB: string | null
  minusPath: string | null
  plusPath: string | null
  renameFrom?: string
  renameTo?: string
  isBinary: boolean
  noTrailingNewline: boolean
  oldTrailingNewline?: boolean
  newTrailingNewline?: boolean
  lastContentSide?: 'old' | 'new' | 'both'
  oldMode?: string
  newMode?: string
  isAdded: boolean
  isDeleted: boolean
  isRenamed: boolean
  hunks: HunkDraft[]
}

function newFileDraft(): FileDraft {
  return {
    headerA: null,
    headerB: null,
    minusPath: null,
    plusPath: null,
    isBinary: false,
    noTrailingNewline: false,
    isAdded: false,
    isDeleted: false,
    isRenamed: false,
    hunks: [],
  }
}

function draftPaths(draft: FileDraft): { path: string, oldPath?: string } {
  const post = draft.renameTo ?? draft.plusPath ?? draft.headerB
  const pre = draft.renameFrom ?? draft.minusPath ?? draft.headerA
  const path = post ?? pre ?? ''
  const oldPath = pre !== null && pre !== undefined && pre !== path ? pre : undefined
  return oldPath === undefined ? { path } : { path, oldPath }
}

function draftStatus(draft: FileDraft, fromNameStatus: string | undefined): FileStatus {
  if (draft.isBinary)
    return 'binary'
  if (draft.isRenamed || fromNameStatus?.startsWith('R') === true || fromNameStatus?.startsWith('C') === true)
    return 'renamed'
  if (draft.isAdded || fromNameStatus === 'A')
    return 'added'
  if (draft.isDeleted || fromNameStatus === 'D')
    return 'deleted'
  if (draft.hunks.length === 0 && draft.oldMode !== undefined && draft.newMode !== undefined && draft.oldMode !== draft.newMode)
    return 'mode-only'
  return 'modified'
}

function sealHunk(draft: HunkDraft): DiffHunk {
  return {
    index: draft.index,
    header: draft.header,
    oldStart: draft.oldStart,
    oldLines: draft.oldLines,
    newStart: draft.newStart,
    newLines: draft.newLines,
    lines: draft.lines,
  }
}

/**
 * Unified diff text → structured model. Total: malformed input yields fewer
 * files, never a throw.
 */
export function parseUnifiedDiff(
  patch: string,
  nameStatus: readonly NameStatusEntry[] = [],
  opts?: ParseDiffOptions,
): ReviewDiff {
  const generated = opts?.isGenerated ?? isGeneratedPath
  const byPath = new Map<string, NameStatusEntry>()
  for (const entry of nameStatus) byPath.set(entry.path, entry)

  const drafts: FileDraft[] = []
  let file: FileDraft | null = null
  let hunk: HunkDraft | null = null

  const raw = patch.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '')
    raw.pop()

  for (const rawLine of raw) {
    const line = stripCr(rawLine)

    if (hunk !== null && (hunk.pendingOld > 0 || hunk.pendingNew > 0)) {
      const marker = rawLine.length === 0 ? ' ' : rawLine[0]
      if (marker === ' ' || marker === '+' || marker === '-') {
        const text = rawLine.length === 0 ? '' : rawLine.slice(1)
        if (marker === ' ') {
          hunk.lines.push({
            kind: 'context',
            text,
            oldLine: hunk.oldStart + (hunk.oldLines - hunk.pendingOld),
            newLine: hunk.newStart + (hunk.newLines - hunk.pendingNew),
          })
          hunk.pendingOld--
          hunk.pendingNew--
          file!.lastContentSide = 'both'
        }
        else if (marker === '+') {
          hunk.lines.push({
            kind: 'add',
            text,
            newLine: hunk.newStart + (hunk.newLines - hunk.pendingNew),
          })
          hunk.pendingNew--
          file!.lastContentSide = 'new'
        }
        else {
          hunk.lines.push({
            kind: 'del',
            text,
            oldLine: hunk.oldStart + (hunk.oldLines - hunk.pendingOld),
          })
          hunk.pendingOld--
          file!.lastContentSide = 'old'
        }
        continue
      }
      if (marker === '\\') {
        if (file !== null) {
          file.noTrailingNewline = true
          if (file.lastContentSide === 'old' || file.lastContentSide === 'both')
            file.oldTrailingNewline = false
          if (file.lastContentSide === 'new' || file.lastContentSide === 'both')
            file.newTrailingNewline = false
        }
        continue
      }
      // Truncated hunk: fall through and re-read this line as a header.
      hunk = null
    }

    if (line.startsWith('\\ ')) {
      if (file !== null) {
        file.noTrailingNewline = true
        if (file.lastContentSide === 'old' || file.lastContentSide === 'both')
          file.oldTrailingNewline = false
        if (file.lastContentSide === 'new' || file.lastContentSide === 'both')
          file.newTrailingNewline = false
      }
      continue
    }

    if (line.startsWith('diff --git ')) {
      hunk = null
      file = newFileDraft()
      const { a, b } = splitDiffGitHeader(line.slice('diff --git '.length))
      file.headerA = a
      file.headerB = b
      drafts.push(file)
      continue
    }

    if (line.startsWith('diff --combined ') || line.startsWith('diff --cc ')) {
      // Merge-commit diffs are out of scope; skip the whole file entry.
      hunk = null
      file = null
      continue
    }

    if (line.startsWith('--- ')) {
      hunk = null
      if (file === null) {
        file = newFileDraft()
        drafts.push(file)
      }
      const value = stripSidePrefix(line.slice(4))
      file.minusPath = value
      if (value === null)
        file.isAdded = true
      continue
    }

    if (file === null)
      continue

    if (line.startsWith('+++ ')) {
      const value = stripSidePrefix(line.slice(4))
      file.plusPath = value
      if (value === null)
        file.isDeleted = true
      continue
    }

    const hunkMatch = HUNK_HEADER.exec(line)
    if (hunkMatch !== null) {
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2])
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4])
      hunk = {
        index: file.hunks.length,
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines,
        newStart: Number(hunkMatch[3]),
        newLines,
        lines: [],
        pendingOld: oldLines,
        pendingNew: newLines,
      }
      file.hunks.push(hunk)
      continue
    }

    if (line.startsWith('old mode ')) {
      file.oldMode = line.slice('old mode '.length).trim()
      continue
    }
    if (line.startsWith('new mode ')) {
      file.newMode = line.slice('new mode '.length).trim()
      continue
    }
    if (line.startsWith('new file mode ')) {
      file.isAdded = true
      file.newMode = line.slice('new file mode '.length).trim()
      continue
    }
    if (line.startsWith('deleted file mode ')) {
      file.isDeleted = true
      file.oldMode = line.slice('deleted file mode '.length).trim()
      continue
    }
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      file.isRenamed = true
      file.renameFrom = unquotePath(line.slice(line.indexOf('from ') + 5).trim())
      continue
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      file.isRenamed = true
      file.renameTo = unquotePath(line.slice(line.indexOf('to ') + 3).trim())
      continue
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch' || line.startsWith('Binary file ')) {
      file.isBinary = true
      continue
    }
  }

  const files: DiffFile[] = drafts.map((draft) => {
    const entry = byPath.get(draftPaths(draft).path)
    if (entry?.oldPath !== undefined && entry.oldPath !== entry.path && draft.renameFrom === undefined)
      draft.renameFrom = entry.oldPath
    const resolved = draftPaths(draft)
    const status = draftStatus(draft, entry?.code)
    const hunks = draft.hunks.map(sealHunk)
    const groups: LineGroup[] = []
    for (const sealed of hunks)
      groups.push(...groupHunkLines(sealed, resolved.path, { gap: opts?.gap }))
    return {
      path: resolved.path,
      ...(resolved.oldPath === undefined ? {} : { oldPath: resolved.oldPath }),
      status,
      isBinary: draft.isBinary,
      isGenerated: generated(resolved.path),
      noTrailingNewline: draft.noTrailingNewline,
      oldTrailingNewline: draft.oldTrailingNewline ?? true,
      newTrailingNewline: draft.newTrailingNewline ?? true,
      ...(draft.oldMode === undefined ? {} : { oldMode: draft.oldMode }),
      ...(draft.newMode === undefined ? {} : { newMode: draft.newMode }),
      hunks,
      groups,
    }
  }).filter(entry => entry.path !== '')

  return { files, digest: computeDiffDigest(patch) }
}

/** Parse `git diff --name-status -z` output. Pure string work, kept with the parser. */
export function parseNameStatusZ(raw: string): NameStatusEntry[] {
  const fields = raw.split('\0').filter(field => field !== '')
  const entries: NameStatusEntry[] = []
  for (let i = 0; i < fields.length;) {
    const code = fields[i++]
    if (code === undefined)
      break
    if ((code.startsWith('R') || code.startsWith('C')) && i + 1 < fields.length) {
      const oldPath = fields[i++]
      const path = fields[i++]
      entries.push({ code, path, oldPath })
      continue
    }
    const path = fields[i++]
    if (path === undefined)
      break
    entries.push({ code, path })
  }
  return entries
}
