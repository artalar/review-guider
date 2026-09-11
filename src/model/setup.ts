import type { CommitSummary } from '../git/log'
import type { ReviewTarget } from '../git/types'
import type { GuideScopeDoc } from '../guide/schema'
import {
  abortVar,
  action,
  atom,
  computed,
  isAbort,
  peek,
  withAbort,
  withAsync,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { readDiff } from '../git/diff'
import { planIsolation } from '../git/isolate'
import { DEFAULT_COMMIT_LIMIT, readRecentCommits } from '../git/log'
import { readWorkingTreeCaptureDiff } from '../git/snapshot'
import { commitRevError, describeTarget, parseRangeInput, rangeInputError } from '../git/types'
import { buildHeuristicGuide } from '../guide/heuristic'
import { parseUnifiedDiff } from '../guide/parse-diff'
import { formatGuideJson, serializeGuide } from '../guide/serialize'
import { resolveSafeSidecarPath } from '../guide/sidecar'
import { guideFile, heuristicOptions } from './config'
import { chosenMode, EmptyDiffError, gitCapability, pendingEntry, ports, sessionStatus } from './session'

export interface HistorySetupPhase {
  readonly commits: readonly CommitSummary[]
  readonly loading: boolean
  readonly error: string | null
}

export interface CommitsSetupPhase extends HistorySetupPhase {
  readonly kind: 'commits'
}

export interface RangeSetupPhase extends HistorySetupPhase {
  readonly kind: 'range'
  readonly from: string | null
  readonly to: string | null
}

export type SetupPhase
  = | { readonly kind: 'home' }
    | { readonly kind: 'targets' }
    | CommitsSetupPhase
    | RangeSetupPhase
    | { readonly kind: 'generate', readonly target: ReviewTarget }

export const SKILL_TARGETS = [
  '.cursor/skills/tabthrough/SKILL.md',
  '.agents/skills/tabthrough/SKILL.md',
] as const

export const COMMAND_TARGET = '.cursor/commands/tabthrough.md'

export const COMMAND_BODY = `Follow the Tabthrough skill and write \`.tabthrough-guide.json\` for the review target in this chat.

Study the real git patch first. One thought per Tab step; \`ranges\` when a file has more than one thought, anchored with new-file line numbers from \`git diff -U0\` hunk headers. Every step gets a \`title\` that names the thought, a \`rationale\` that says why it comes here, and \`notes\` only where the code cannot explain itself (plain text). No quizzes, no restating the diff.
`

type SetupKind = SetupPhase['kind']

const EMPTY_COMMITS: readonly CommitSummary[] = []

const setupKind = atom<SetupKind>('home', 'setup.kind')
const setupError = atom<string | null>(null, 'setup.error')
const rangeFrom = atom<string | null>(null, 'setup.rangeFrom')
const rangeTo = atom<string | null>(null, 'setup.rangeTo')
const generateTarget = atom<ReviewTarget | null>(null, 'setup.generateTarget')

export const recentCommits = computed(async (): Promise<readonly CommitSummary[]> => {
  const kind = setupKind()
  if (kind !== 'commits' && kind !== 'range')
    return peek(recentCommits.data)

  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok)
    return EMPTY_COMMITS

  return await wrap(readRecentCommits(capability.repoRoot, {
    limit: DEFAULT_COMMIT_LIMIT,
    signal: abortVar.require().signal,
  }))
}, 'setup.recentCommits').extend(withAsyncData({ initState: EMPTY_COMMITS }))

export const setupPhase = computed((): SetupPhase => {
  const kind = setupKind()
  const commits = recentCommits.data()
  const loading = recentCommits.pending() > 0 && commits.length === 0
  const fetchFailed: unknown = recentCommits.error()
  const error = setupError() ?? (fetchFailed == null ? null : 'Could not load recent history.')

  if (kind === 'commits')
    return { kind: 'commits', commits, loading, error }
  if (kind === 'range')
    return { kind: 'range', commits, loading, error, from: rangeFrom(), to: rangeTo() }
  if (kind === 'generate') {
    const target = generateTarget()
    if (target !== null)
      return { kind: 'generate', target }
  }
  if (kind === 'targets')
    return { kind: 'targets' }
  return { kind: 'home' }
}, 'setup.phase')

export const skillEpoch = atom(0, 'setup.skillEpoch')
export const sidecarEpoch = atom(0, 'setup.sidecarEpoch')
export const focusedGuidePath = atom<string | null>(null, 'setup.focusedGuide')

export const skillInstalled = computed(async () => {
  skillEpoch()
  const capability = await wrap(gitCapability())
  if (capability === null)
    return null
  if (!capability.ok)
    return false
  const exists = peek(ports).ui.fileExists
  for (const relative of SKILL_TARGETS) {
    if (await wrap(exists(capability.repoRoot, relative)))
      return true
  }
  return false
}, 'setup.skillInstalled').extend(withAsyncData({ initState: null as boolean | null }))

export const sidecarExists = computed(async () => {
  sidecarEpoch()
  const sidecarPath = resolveSafeSidecarPath(guideFile())
  if (sidecarPath === null)
    return false
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok)
    return false
  return await wrap(peek(ports).ui.fileExists(capability.repoRoot, sidecarPath))
}, 'setup.sidecarExists').extend(withAsyncData({ initState: false }))

export const resetSetup = action(() => {
  setupError.set(null)
  rangeFrom.set(null)
  rangeTo.set(null)
  generateTarget.set(null)
  pendingEntry.set(null)
  chosenMode.set(null)
  setupKind.set('home')
}, 'setup.reset')

export const openTargetPicker = action(() => {
  if (peek(sessionStatus) !== 'idle')
    return
  setupError.set(null)
  setupKind.set('targets')
}, 'setup.openTargets')

export const setupBack = action(() => {
  const kind = peek(setupKind)
  const target = peek(generateTarget)
  if (kind === 'generate' && target !== null) {
    setupError.set(null)
    if (target.kind === 'commit') {
      setupKind.set('commits')
      return
    }
    if (target.kind === 'range') {
      rangeFrom.set(target.from)
      rangeTo.set(target.to)
      setupKind.set('range')
      return
    }
    setupKind.set('targets')
    return
  }
  setupError.set(null)
  if (kind === 'commits' || kind === 'range' || kind === 'generate') {
    setupKind.set('targets')
    return
  }
  setupKind.set('home')
}, 'setup.back')

export const pickWorkingTree = action(() => {
  setupError.set(null)
  generateTarget.set({ kind: 'workingTree' })
  pendingEntry.set({ kind: 'workingTree' })
  setupKind.set('generate')
}, 'setup.pickWorkingTree')

export const loadCommits = action(async (): Promise<void> => {
  setupError.set(null)
  setupKind.set('commits')
  await settleRecentCommits()
}, 'setup.loadCommits')

export const pickRange = action(async (): Promise<void> => {
  setupError.set(null)
  rangeFrom.set(null)
  rangeTo.set(null)
  setupKind.set('range')
  await settleRecentCommits()
}, 'setup.pickRange')

export const selectCommit = action((rev: string) => {
  const error = commitRevError(rev)
  if (error !== null) {
    if (peek(setupKind) === 'commits')
      setupError.set(error)
    return
  }
  setupError.set(null)
  generateTarget.set({ kind: 'commit', rev: rev.trim() })
  pendingEntry.set({ kind: 'commit', rev: rev.trim() })
  setupKind.set('generate')
}, 'setup.selectCommit')

export const selectRangeRev = action((rev: string) => {
  if (peek(setupKind) !== 'range')
    return
  const error = commitRevError(rev)
  if (error !== null) {
    setupError.set(error)
    return
  }
  const next = nextRangeSelection(peek(rangeFrom), peek(rangeTo), rev, peek(recentCommits.data))
  rangeFrom.set(next.from)
  rangeTo.set(next.to)
  setupError.set(null)
}, 'setup.selectRangeRev')

export const submitRange = action((raw: string) => {
  if (peek(setupKind) !== 'range')
    return
  const error = rangeInputError(raw)
  if (error !== null) {
    setupError.set(error)
    return
  }
  const range = parseRangeInput(raw)
  if (range === null) {
    setupError.set('Expected two revisions separated by .. or ...')
    return
  }
  setupError.set(null)
  generateTarget.set({ kind: 'range', from: range.from, to: range.to })
  pendingEntry.set({ kind: 'range', from: range.from, to: range.to })
  setupKind.set('generate')
}, 'setup.submitRange')

function scopeFor(target: ReviewTarget, baseRev: string, afterRev: string | null): GuideScopeDoc {
  if (target.kind === 'workingTree')
    return { kind: 'workingTree', base: baseRev }
  if (target.kind === 'commit')
    return { kind: 'commit', base: baseRev, head: afterRev ?? target.rev }
  return { kind: 'range', base: baseRev, head: afterRev ?? target.to }
}

function gitDiffHint(target: ReviewTarget, baseRev: string, afterRev: string | null): string {
  const quoted = 'git -c core.quotepath=false diff --no-color --no-ext-diff -M'
  const revs = afterRev === null ? baseRev : `${baseRev} ${afterRev}`
  const patch = `${quoted} -U3 --patch ${revs}`
  const anchors = `${quoted} -U0 ${revs} | grep -E '^(\\+\\+\\+ |@@ )'`
  if (afterRev === null) {
    return [
      'git status --porcelain=v1 --untracked-files=all',
      patch,
      anchors,
    ].join('\n')
  }
  return [patch, anchors].join('\n')
}

export function agentPromptFor(target: ReviewTarget, sidecarPath: string, baseRev: string, afterRev: string | null): string {
  const review = describeTarget(target)
  const workingTreeNotes = target.kind === 'workingTree'
    ? [
        'Include untracked files — Start captures with git add -A.',
        'Omit scope.diffDigest: the sidecar is written into the tree it describes.',
      ]
    : []
  return [
    '/tabthrough',
    '',
    `Write ${sidecarPath} for a Tabthrough review of ${review}.`,
    'Study the real patch before any step — never invent order from memory:',
    '',
    '```bash',
    gitDiffHint(target, baseRev, afterRev),
    '```',
    '',
    ...workingTreeNotes,
    '',
    'Then emit a valid v1 sidecar at the repo root:',
    `- path: ${sidecarPath}`,
    `- scope.kind: ${target.kind}`,
    target.kind === 'commit' ? `- scope.head: ${afterRev ?? target.rev}` : '',
    target.kind === 'range' ? `- scope.base / scope.head: ${target.from} .. ${target.to}` : '',
    '- one thought per step; split helper vs consumer, type vs caller, failure vs fix',
    '- use ranges whenever one file has more than one thought; anchor with new-file line numbers from `git diff -U0` hunk headers',
    '- every step: `title` names the thought (≤ 60 chars); `rationale` says why it comes here (one line, ≤ 120 chars); `notes` only for the why that is not in the code (plain text)',
    '- `summary`: 2–3 sentences — the map the reviewer sees on every step',
    '- demote lockfiles, generated files, and mechanical fallout via `files` (`skip` / `low`) with a rationale that says why',
    '- no quizzes, scores, or restating the diff',
    '',
    `When the file is written, leave it focused so the reviewer can press Start.`,
  ].filter(line => line !== '').join('\n')
}

async function refuseEmptyPlan(target: ReviewTarget, changedLineCount: number, substantiveLineCount: number): Promise<boolean> {
  if (changedLineCount === 0) {
    await wrap(peek(ports).ui.notify('warn', new EmptyDiffError(target, 'empty').message))
    return true
  }
  if (substantiveLineCount === 0) {
    await wrap(peek(ports).ui.notify('warn', new EmptyDiffError(target, 'whitespace').message))
    return true
  }
  return false
}

export const generateSimpleGuide = action(async (): Promise<void> => {
  const phase = peek(setupPhase)
  if (phase.kind !== 'generate')
    return

  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    await wrap(peek(ports).ui.notify('warn', capability === null
      ? 'Tabthrough is still checking the repository.'
      : capability.message))
    return
  }

  const { repoRoot } = capability
  const sidecarPath = resolveSafeSidecarPath(peek(guideFile))
  if (sidecarPath === null) {
    await wrap(peek(ports).ui.notify('warn', 'tabthrough.guideFile is not a safe repository path.'))
    return
  }

  const signal = abortVar.require().signal
  const plan = await wrap(planIsolation(
    repoRoot,
    { entry: phase.target },
    { signal },
  ))
  if (await refuseEmptyPlan(phase.target, plan.changedLineCount, plan.substantiveLineCount))
    return

  const raw = plan.afterRev === null
    ? await wrap(readWorkingTreeCaptureDiff(repoRoot, plan.baseRev, { signal }))
    : await wrap(readDiff(repoRoot, plan.baseRev, plan.afterRev, { signal }))

  const diff = parseUnifiedDiff(raw.patch, raw.nameStatus, { gap: peek(heuristicOptions).intraHunkGap })
  const heuristic = buildHeuristicGuide(diff, peek(heuristicOptions))
  const scope = scopeFor(phase.target, plan.baseRev, plan.afterRev)
  const doc = serializeGuide({
    guide: heuristic,
    scope: phase.target.kind === 'workingTree' ? scope : { ...scope, diffDigest: diff.digest },
    sidecarPath,
    createdAt: new Date().toISOString(),
  })
  await wrap(peek(ports).ui.writeTextFile(repoRoot, sidecarPath, formatGuideJson(doc)))
  sidecarEpoch.set(value => value + 1)
  await wrap(peek(ports).ui.openWorkspaceFile(repoRoot, sidecarPath))
}, 'setup.generateSimple').extend(withAsync(), withAbort('first-in-win'))

export const generateAgentGuide = action(async (): Promise<void> => {
  const phase = peek(setupPhase)
  if (phase.kind !== 'generate')
    return

  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    await wrap(peek(ports).ui.notify('warn', capability === null
      ? 'Tabthrough is still checking the repository.'
      : capability.message))
    return
  }

  const sidecarPath = resolveSafeSidecarPath(peek(guideFile))
  if (sidecarPath === null) {
    await wrap(peek(ports).ui.notify('warn', 'tabthrough.guideFile is not a safe repository path.'))
    return
  }

  const signal = abortVar.require().signal
  const plan = await wrap(planIsolation(
    capability.repoRoot,
    { entry: phase.target },
    { signal },
  ))
  if (await refuseEmptyPlan(phase.target, plan.changedLineCount, plan.substantiveLineCount))
    return
  const prompt = agentPromptFor(phase.target, sidecarPath, plan.baseRev, plan.afterRev)
  await wrap(peek(ports).ui.openAgentChat(prompt))
}, 'setup.generateAgent').extend(withAsync(), withAbort('first-in-win'))

export const installWorkspaceSkill = action(async (): Promise<void> => {
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    await wrap(peek(ports).ui.notify(
      'warn',
      capability === null
        ? 'Tabthrough is still checking the repository.'
        : capability.message,
    ))
    return
  }

  const ui = peek(ports).ui
  const text = await wrap(ui.readBundledSkill())
  if (text === null) {
    await wrap(ui.notify('warn', 'Tabthrough could not find its bundled skill.'))
    return
  }

  const { repoRoot } = capability
  let wrote = false
  for (const relative of SKILL_TARGETS) {
    if (await wrap(ui.fileExists(repoRoot, relative)))
      continue
    await wrap(ui.writeTextFile(repoRoot, relative, text))
    wrote = true
  }
  if (!(await wrap(ui.fileExists(repoRoot, COMMAND_TARGET)))) {
    await wrap(ui.writeTextFile(repoRoot, COMMAND_TARGET, COMMAND_BODY))
    wrote = true
  }
  skillEpoch.set(value => value + 1)
  if (wrote) {
    await wrap(ui.notify(
      'info',
      'Installed /tabthrough in this workspace. Agent can now generate .tabthrough-guide.json.',
    ))
    return
  }
  await wrap(ui.notify('info', '/tabthrough is already installed in this workspace.'))
}, 'setup.installSkill').extend(withAsync())

export function describeSetupTarget(target: ReviewTarget): string {
  return describeTarget(target, { short: true })
}

async function settleRecentCommits(): Promise<void> {
  try {
    await wrap(recentCommits())
  }
  catch (error) {
    if (!isAbort(error))
      throw error
  }
}

function nextRangeSelection(
  from: string | null,
  to: string | null,
  rev: string,
  commits: readonly CommitSummary[],
): { from: string | null, to: string | null } {
  const trimmed = rev.trim()
  if (from === null && to === null)
    return { from: trimmed, to: null }

  if (to === null) {
    if (from === null || sameCommitRev(from, trimmed, commits))
      return { from: null, to: null }
    return orderRangeBounds(from, trimmed, commits)
  }

  if (sameCommitRev(from, trimmed, commits))
    return { from: to, to: null }
  if (sameCommitRev(to, trimmed, commits))
    return { from, to: null }
  return { from: trimmed, to: null }
}

function orderRangeBounds(
  first: string,
  second: string,
  commits: readonly CommitSummary[],
): { from: string, to: string } {
  const firstIndex = commits.findIndex(commit => matchesRev(commit, first))
  const secondIndex = commits.findIndex(commit => matchesRev(commit, second))
  if (firstIndex >= 0 && secondIndex >= 0 && firstIndex !== secondIndex) {
    return firstIndex < secondIndex
      ? { from: second, to: first }
      : { from: first, to: second }
  }
  return { from: first, to: second }
}

function sameCommitRev(left: string | null, right: string, commits: readonly CommitSummary[]): boolean {
  if (left === null)
    return false
  if (left === right)
    return true
  const leftCommit = commits.find(commit => matchesRev(commit, left))
  const rightCommit = commits.find(commit => matchesRev(commit, right))
  return leftCommit !== undefined && leftCommit === rightCommit
}

function matchesRev(commit: CommitSummary, rev: string): boolean {
  return commit.sha === rev || commit.shortSha === rev
}
