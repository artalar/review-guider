import type { DiffFile, GuideStep, LineGroup } from '../guide/types'
import type { GitOptions } from './exec'
import type { SessionToken, TokenStore } from './journal'
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { renderReveal } from '../guide/render'
import { showBlob } from './diff'
import { runGit, splitNul, tryGit } from './exec'
import { advanceStage, persistToken } from './journal'
import { readStatus } from './probe'
import { appliedRefName, writeRef } from './refs'
import { writeWorkingTree } from './snapshot'

/**
 * Apply-mode write engine (ADR 0004 D4/D5): intended trees from `renderReveal`,
 * fast-path write or 3-way merge, applied checkpoint. No `vscode` import.
 */

const IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Tabthrough',
  GIT_AUTHOR_EMAIL: 'tabthrough@localhost',
  GIT_COMMITTER_NAME: 'Tabthrough',
  GIT_COMMITTER_EMAIL: 'tabthrough@localhost',
}

export type ApplyRefuseReason = 'unmerged' | 'io' | 'missing-step'

export type ApplyStepOutcome
  = | {
    readonly kind: 'applied'
    readonly token: SessionToken
    readonly paths: readonly string[]
    readonly stub: boolean
    readonly driftPaths: readonly string[]
  }
  | {
    readonly kind: 'conflict'
    readonly path: string
    readonly message: string
    readonly token: SessionToken
  }
  | {
    readonly kind: 'refused'
    readonly reason: ApplyRefuseReason
    readonly message: string
    readonly token: SessionToken
  }

export interface ApplyStepArgs {
  readonly repoRoot: string
  readonly baseRev: string
  /** 0-based index of the step to apply (forward) or revert (backward). */
  readonly stepIndex: number
  readonly direction: 'forward' | 'backward'
  readonly steps: readonly GuideStep[]
  readonly files: readonly DiffFile[]
  readonly store: TokenStore
  readonly token: SessionToken
  readonly exec?: GitOptions['exec']
}

function fileForPath(files: readonly DiffFile[], path: string): DiffFile | null {
  return files.find(entry => entry.path === path) ?? null
}

function groupsThrough(
  steps: readonly GuideStep[],
  path: string,
  endExclusive: number,
): readonly LineGroup[] {
  const out: LineGroup[] = []
  for (let index = 0; index < endExclusive && index < steps.length; index++) {
    const step = steps[index]
    if (step !== undefined && step.path === path)
      out.push(...step.groups)
  }
  return out
}

async function readWorkingFile(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, 'utf8')
  }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code === 'ENOENT')
      return null
    throw error
  }
}

async function writeWorkingFile(absolutePath: string, text: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, text, 'utf8')
}

async function removeWorkingFile(absolutePath: string): Promise<void> {
  try {
    await unlink(absolutePath)
  }
  catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code !== 'ENOENT')
      throw error
  }
}

/** Refuse writes through symlinks or paths escaping the repository. */
async function ensureSafeWorkingPath(repoRoot: string, relativePath: string): Promise<void> {
  if (isAbsolute(relativePath))
    throw new Error(`Refusing to write absolute path ${relativePath}.`)
  const absolutePath = resolve(repoRoot, relativePath)
  const fromRoot = relative(resolve(repoRoot), absolutePath)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error(`Refusing to write path outside the repository: ${relativePath}.`)

  const parts = fromRoot.split(sep).filter(Boolean)
  let current = resolve(repoRoot)
  for (const part of parts) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink())
        throw new Error(`Refusing to write through symbolic link ${relativePath}.`)
    }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : ''
      if (code === 'ENOENT')
        break
      throw error
    }
  }
}

/**
 * Line-oriented 3-way via `git merge-file -p`. Exit `0` is clean; positive is
 * conflict count with markers left in the text.
 */
export async function mergeThreeWay(
  repoRoot: string,
  base: string,
  ours: string,
  theirs: string,
  options: GitOptions = {},
): Promise<{ readonly clean: true, readonly text: string } | { readonly clean: false, readonly text: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tabthrough-merge-'))
  const basePath = join(dir, 'base')
  const oursPath = join(dir, 'ours')
  const theirsPath = join(dir, 'theirs')
  try {
    await writeFile(basePath, base, 'utf8')
    await writeFile(oursPath, ours, 'utf8')
    await writeFile(theirsPath, theirs, 'utf8')
    const result = await tryGit(
      repoRoot,
      ['merge-file', '-p', '-L', 'current', '-L', 'intended-prev', '-L', 'intended-next', oursPath, basePath, theirsPath],
      options,
    )
    // merge-file returns the number of conflicts for a normal merge. 255 is
    // Git's error exit for an invalid invocation or I/O failure; treating that
    // as a conflict would write an empty/partial stdout over the user's file.
    if (result.code < 0 || result.code >= 128)
      throw new Error(`git merge-file failed: ${result.stderr.trim() || result.stdout.trim()}`)
    if (result.code === 0)
      return { clean: true, text: result.stdout }
    return { clean: false, text: result.stdout }
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function resolveIntendedText(
  repoRoot: string,
  baseRev: string,
  file: DiffFile,
  groups: readonly LineGroup[],
  options: GitOptions,
): Promise<string> {
  if (file.isBinary)
    return ''
  if (file.status === 'added')
    return renderReveal('', file, groups).text
  const blobPath = file.oldPath ?? file.path
  const baseText = await showBlob(repoRoot, baseRev, blobPath, options) ?? ''
  return renderReveal(baseText, file, groups).text
}

/** Snapshot the working tree to `refs/tabthrough/applied/<id>` (Finish + Tab). */
export async function writeAppliedCheckpoint(
  repoRoot: string,
  sessionId: string,
  options: GitOptions = {},
): Promise<{ readonly commit: string, readonly ref: string }> {
  const tree = await writeWorkingTree(repoRoot, options)
  const commit = (await runGit(
    repoRoot,
    ['commit-tree', tree, '-p', 'HEAD', '-m', `tabthrough applied ${sessionId}`],
    { ...options, env: IDENTITY },
  )).trim()
  const ref = appliedRefName(sessionId)
  await writeRef(repoRoot, ref, commit, options)
  return { commit, ref }
}

/** True when the working tree still has unresolved merge-file markers. */
export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)
}

/** First step path whose on-disk contents still hold conflict markers, if any. */
export async function findConflictMarkedPath(
  repoRoot: string,
  paths: readonly string[],
): Promise<string | null> {
  for (const path of paths) {
    try {
      const text = await readFile(join(repoRoot, path), 'utf8')
      if (hasConflictMarkers(text))
        return path
    }
    catch {
      // Missing path is fine — stubs / deletions have nothing to scan.
    }
  }
  return null
}

/**
 * Paths dirty since the last apply checkpoint (or `base` when none yet).
 * ADR 0004 D4 / review 002 M1 — do not warn about Tabthrough's own prior writes.
 */
async function driftOutsideStep(
  repoRoot: string,
  stepPath: string,
  againstRev: string,
  options: GitOptions,
): Promise<readonly string[]> {
  // Diff two trees: ordinary git diff treats a checkpointed, still-untracked
  // addition as deleted because it is absent from the real index.
  const currentTree = await writeWorkingTree(repoRoot, options)
  const changed = await runGit(repoRoot, ['diff', '--name-only', '-z', againstRev, currentTree], options)
  const dirty = new Set(splitNul(changed))
  dirty.delete(stepPath)
  return [...dirty].sort()
}

/**
 * Apply or revert one guide step onto the real working tree.
 *
 * Journals `applying` before any disk write. Advances `appliedIndex` and the
 * applied-ref only after a successful write (or a no-op stub advance).
 */
export async function applyGuideStep(args: ApplyStepArgs): Promise<ApplyStepOutcome> {
  const options: GitOptions = { exec: args.exec }
  const { repoRoot, store } = args
  let token = args.token

  const status = await readStatus(repoRoot, options)
  if (status.unmerged.length > 0) {
    return {
      kind: 'refused',
      reason: 'unmerged',
      message: 'Resolve unmerged paths before applying the next step.',
      token,
    }
  }

  const step = args.steps[args.stepIndex]
  if (step === undefined) {
    return {
      kind: 'refused',
      reason: 'missing-step',
      message: `No guide step at index ${args.stepIndex}.`,
      token,
    }
  }

  try {
    await ensureSafeWorkingPath(repoRoot, step.path)
    const file = fileForPath(args.files, step.path)
    if (file?.oldPath !== undefined && args.direction === 'backward')
      await ensureSafeWorkingPath(repoRoot, file.oldPath)
  }
  catch (error) {
    return {
      kind: 'refused',
      reason: 'io',
      message: error instanceof Error ? error.message : String(error),
      token,
    }
  }

  token = await advanceStage(store, token, 'applying')

  const againstRev = token.appliedRef
    ?? token.checkedOut
    ?? args.baseRev
  const driftPaths = step.kind === 'stub'
    ? []
    : await driftOutsideStep(repoRoot, step.path, againstRev, options)

  const finishStub = async (): Promise<ApplyStepOutcome> => {
    const checkpoint = await writeAppliedCheckpoint(repoRoot, token.sessionId, options)
    const nextIndex = args.direction === 'forward' ? args.stepIndex : args.stepIndex - 1
    token = await persistToken(store, {
      ...token,
      appliedIndex: nextIndex,
      appliedRef: checkpoint.ref,
    })
    token = await advanceStage(store, token, 'reviewing')
    return {
      kind: 'applied',
      token,
      paths: [],
      stub: true,
      driftPaths,
    }
  }

  if (step.kind === 'stub')
    return await finishStub()

  const file = fileForPath(args.files, step.path)
  if (file === null || file.isBinary)
    return await finishStub()

  const beforeExclusive = args.direction === 'forward' ? args.stepIndex : args.stepIndex
  const afterExclusive = args.direction === 'forward' ? args.stepIndex + 1 : args.stepIndex + 1
  const groupsBefore = groupsThrough(args.steps, step.path, beforeExclusive)
  const groupsAfter = groupsThrough(args.steps, step.path, afterExclusive)

  const mergeBaseGroups = args.direction === 'forward' ? groupsBefore : groupsAfter
  const mergeTheirsGroups = args.direction === 'forward' ? groupsAfter : groupsBefore

  let intendedBase: string
  let intendedTarget: string
  try {
    intendedBase = await resolveIntendedText(repoRoot, args.baseRev, file, mergeBaseGroups, options)
    intendedTarget = await resolveIntendedText(repoRoot, args.baseRev, file, mergeTheirsGroups, options)
  }
  catch (error) {
    token = await advanceStage(store, token, 'reviewing')
    return {
      kind: 'refused',
      reason: 'io',
      message: error instanceof Error ? error.message : String(error),
      token,
    }
  }

  const absolutePath = join(repoRoot, step.path)
  let current: string | null
  try {
    current = await readWorkingFile(absolutePath)
  }
  catch (error) {
    token = await advanceStage(store, token, 'reviewing')
    return {
      kind: 'refused',
      reason: 'io',
      message: error instanceof Error ? error.message : String(error),
      token,
    }
  }

  const currentText = current ?? ''

  if (hasConflictMarkers(currentText)) {
    token = await advanceStage(store, token, 'reviewing')
    return {
      kind: 'refused',
      reason: 'unmerged',
      message: `Resolve conflict markers in ${step.path} before applying again.`,
      token,
    }
  }

  let nextText: string

  if (currentText === intendedBase) {
    nextText = intendedTarget
  }
  else {
    const merged = await mergeThreeWay(repoRoot, intendedBase, currentText, intendedTarget, options)
    if (!merged.clean) {
      try {
        await writeWorkingFile(absolutePath, merged.text)
      }
      catch {
        // Conflict markers are best-effort; not advancing is the safety bar.
      }
      token = await advanceStage(store, token, 'reviewing')
      return {
        kind: 'conflict',
        path: step.path,
        message: args.direction === 'forward'
          ? `Conflict applying step onto your edits in ${step.path}. Resolve the markers in that file, then press Tab to continue.`
          : `Conflict reverting step in ${step.path}. Resolve the markers in that file, then press Shift+Tab to continue.`,
        token,
      }
    }
    nextText = merged.text
  }

  try {
    if (nextText === '' && (file.status === 'deleted' || (file.status === 'added' && args.direction === 'backward')))
      await removeWorkingFile(absolutePath)
    else
      await writeWorkingFile(absolutePath, nextText)
  }
  catch (error) {
    token = await advanceStage(store, token, 'reviewing')
    return {
      kind: 'refused',
      reason: 'io',
      message: error instanceof Error ? error.message : String(error),
      token,
    }
  }

  const checkpoint = await writeAppliedCheckpoint(repoRoot, token.sessionId, options)
  const nextIndex = args.direction === 'forward' ? args.stepIndex : args.stepIndex - 1
  token = await persistToken(store, {
    ...token,
    appliedIndex: nextIndex,
    appliedRef: checkpoint.ref,
  })
  token = await advanceStage(store, token, 'reviewing')

  return {
    kind: 'applied',
    token,
    paths: [step.path],
    stub: false,
    driftPaths,
  }
}
