import type { CommitSummary } from '../git/log'
import type { ReviewTarget } from '../git/types'
import type { GuideScopeDoc } from '../guide/schema'
import {
  abortVar,
  action,
  atom,
  computed,
  framePromise,
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
import { guideFile, heuristicOptions, stashIncludeUntracked } from './config'
import { EmptyDiffError, gitCapability, ports, sessionStatus } from './session'

export type SetupPhase
  = | { readonly kind: 'home' }
    | { readonly kind: 'targets' }
    | {
      readonly kind: 'commits'
      readonly commits: readonly CommitSummary[]
      readonly loading: boolean
      readonly error: string | null
    }
    | { readonly kind: 'range', readonly error: string | null }
    | { readonly kind: 'generate', readonly target: ReviewTarget }

export const SKILL_TARGETS = [
  '.cursor/skills/tabthrough/SKILL.md',
  '.agents/skills/tabthrough/SKILL.md',
] as const

export const COMMAND_TARGET = '.cursor/commands/tabthrough.md'

export const COMMAND_BODY = `Follow the Tabthrough skill and write \`.tabthrough-guide.json\` for the review target in this chat.

Study the real git patch first. One thought per Tab step. Use ranges when a file has more than one thought. Rationales explain position, not content. No quizzes.
`

export const setupPhase = atom<SetupPhase>({ kind: 'home' }, 'setup.phase')
export const lastCommits = atom<readonly CommitSummary[]>([], 'setup.lastCommits')
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
  setupPhase.set({ kind: 'home' })
}, 'setup.reset')

export const openTargetPicker = action(() => {
  if (peek(sessionStatus) !== 'idle')
    return
  setupPhase.set({ kind: 'targets' })
}, 'setup.openTargets')

export const setupBack = action(() => {
  const phase = peek(setupPhase)
  if (phase.kind === 'generate') {
    if (phase.target.kind === 'commit') {
      setupPhase.set({ kind: 'commits', commits: peek(lastCommits), loading: false, error: null })
      return
    }
    if (phase.target.kind === 'range') {
      setupPhase.set({ kind: 'range', error: null })
      return
    }
    setupPhase.set({ kind: 'targets' })
    return
  }
  if (phase.kind === 'commits' || phase.kind === 'range') {
    setupPhase.set({ kind: 'targets' })
    return
  }
  setupPhase.set({ kind: 'home' })
}, 'setup.back')

export const pickWorkingTree = action(() => {
  setupPhase.set({ kind: 'generate', target: { kind: 'workingTree' } })
}, 'setup.pickWorkingTree')

export const loadCommits = action(async (): Promise<void> => {
  setupPhase.set({ kind: 'commits', commits: peek(lastCommits), loading: true, error: null })
  framePromise().catch(wrap(() => {
    const phase = peek(setupPhase)
    if (phase.kind === 'commits' && phase.loading)
      setupPhase.set({ kind: 'commits', commits: peek(lastCommits), loading: false, error: 'Could not load recent history.' })
  }))
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    setupPhase.set({ kind: 'commits', commits: [], loading: false, error: null })
    return
  }
  const commits = await wrap(readRecentCommits(capability.repoRoot, {
    limit: DEFAULT_COMMIT_LIMIT,
    signal: abortVar.require().signal,
  }))
  lastCommits.set(commits)
  if (peek(setupPhase).kind === 'commits')
    setupPhase.set({ kind: 'commits', commits, loading: false, error: null })
}, 'setup.loadCommits').extend(withAsync(), withAbort('first-in-win'))

export const pickRange = action(() => {
  setupPhase.set({ kind: 'range', error: null })
}, 'setup.pickRange')

export const selectCommit = action((rev: string) => {
  const error = commitRevError(rev)
  if (error !== null) {
    const phase = peek(setupPhase)
    if (phase.kind === 'commits')
      setupPhase.set({ ...phase, error })
    return
  }
  setupPhase.set({ kind: 'generate', target: { kind: 'commit', rev: rev.trim() } })
}, 'setup.selectCommit')

export const submitRange = action((raw: string) => {
  const error = rangeInputError(raw)
  if (error !== null) {
    setupPhase.set({ kind: 'range', error })
    return
  }
  const range = parseRangeInput(raw)
  if (range === null) {
    setupPhase.set({ kind: 'range', error: 'Expected two revisions separated by .. or ...' })
    return
  }
  setupPhase.set({ kind: 'generate', target: { kind: 'range', from: range.from, to: range.to } })
}, 'setup.submitRange')

function scopeFor(target: ReviewTarget, baseRev: string, afterRev: string | null): GuideScopeDoc {
  if (target.kind === 'workingTree')
    return { kind: 'workingTree', base: baseRev }
  if (target.kind === 'commit')
    return { kind: 'commit', base: baseRev, head: afterRev ?? target.rev }
  return { kind: 'range', base: baseRev, head: afterRev ?? target.to }
}

function gitDiffHint(target: ReviewTarget, baseRev: string, afterRev: string | null): string {
  const quoted = 'git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch'
  if (afterRev === null) {
    return [
      'git status --porcelain=v1 --untracked-files=all',
      `${quoted} ${baseRev}`,
    ].join('\n')
  }
  return `${quoted} ${baseRev} ${afterRev}`
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
    '- use ranges whenever one file has more than one thought',
    '- rationale is about position (why this step is here), one line, ≤ 120 chars',
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
    { entry: phase.target, includeUntracked: peek(stashIncludeUntracked), sessionMode: 'readonly' },
    { signal },
  ))
  if (await refuseEmptyPlan(phase.target, plan.preflight.changedLineCount, plan.substantiveLineCount))
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
    createdAt: new Date(peek(ports).clock.now()).toISOString(),
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
    { entry: phase.target, includeUntracked: peek(stashIncludeUntracked), sessionMode: 'readonly' },
    { signal },
  ))
  if (await refuseEmptyPlan(phase.target, plan.preflight.changedLineCount, plan.substantiveLineCount))
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
