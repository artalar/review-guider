import type { GitOptions } from '../git/exec'
import type { IsolationHandle, IsolationPlan } from '../git/isolate'
import type { GitCapability, RepoStatus } from '../git/probe'
import type { RebaseRefuseReason } from '../git/rebase'
import type { GitCommandResult, GitState } from '../git/state'
import type { ReviewTarget, SessionMode } from '../git/types'
import type { SidecarSource } from '../guide/sidecar'
import type { GuideDiagnostic } from '../guide/types'
import type { Ports } from './ports'
import type { Session } from './steps'
import {
  abortVar,
  action,
  atom,
  computed,
  effect,
  framePromise,
  isAbort,
  peek,
  sleep,
  take,
  throwAbort,
  withAbort,
  withAsync,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { resolveCommit, showBlob } from '../git/diff'
import { GitCommandError } from '../git/exec'
import {
  beginReview,
  EntryNotSupportedError,
  MissingObjectsError,
  planIsolation,
  releaseReview,
  sweepStaleAfterRefs,
} from '../git/isolate'
import { probeGit, readStatus } from '../git/probe'
import {
  countCommitsAfter,
  formatRebaseCommand,
  gitOutput,
  ownsRebase,
  readCommitGpgSign,
  readOwnership,
  abortRebase as rebaseAbort,
  rebaseRefuseReason,
  finishRebase as runFinishRebase,
  startRebase,
  stripGitProgress,
} from '../git/rebase'
import {
  abortRebase as gitAbortRebase,
  continueRebase as gitContinueRebase,
  popAutostash as gitPopAutostash,
  pruneWorktrees as gitPruneWorktrees,
  removeWorktree as gitRemoveWorktree,
  showAutostash as gitShowAutostash,
  readGitState,
} from '../git/state'
import { describeTarget } from '../git/types'
import { readWorktreeFile } from '../git/workdir'
import { projectEditHere } from '../guide/edit-here'
import { resolveFinishPolicy } from '../guide/merge'
import {
  finishHooks,
  finishSign,
  guideFile,
  heuristicOptions,
  sequenceEditorExecPath,
  sequenceEditorPath,
  sessionModeSetting,
  worktreeDir,
} from './config'
import { guideSource, peekSidecarFinish } from './guide-source'
import { inertPorts } from './ports'
import { reatomSession } from './steps'

export {
  finishHooks,
  finishSign,
  guideFile,
  heuristicOptions,
  revealMode,
  sequenceEditorExecPath,
  sequenceEditorPath,
  sessionModeSetting,
  showRationale,
  worktreeDir,
} from './config'

export const WORKTREE_HINT = 'This commit is not on the current branch, so Rebase is unavailable.'
export const MERGE_AFTER_HINT = 'This commit is a merge — Rebase cannot stop here.'
export const MERGE_ABOVE_HINT = 'There is a merge above this commit — Rebase cannot stop here.'
export const REBASE_IN_PROGRESS_HINT = 'Finish or abort the rebase in progress first'
export const CONFLICT_STOP = 'Stopped on a conflict — resolve, then Continue in the sidebar.'
export const RETRY_WITHOUT_HOOKS = 'Retry without hooks / signing'
export const OWNERSHIP_LOST = 'The rebase is no longer stopped at the reviewed commit.'
export const WORKTREE_LATER = 'Worktree mode lands in a later phase.'

export function rebaseCompletedMessage(origHead: string): string {
  return `The rebase completed instead of stopping at the reviewed commit. ORIG_HEAD is ${origHead}.`
}

export const workspaceRoot = atom<string | null>(null, 'workspaceRoot')
export const ports = atom<Ports>(inertPorts, 'ports')
export const gitWatchToken = atom(0, 'git.watchToken')
export const gitRepoToken = atom(0, 'git.repoToken')
export const sidebarLive = atom(false, 'ui.sidebarLive')

const pendingGitRepoBump = atom(false, 'git.pendingRepoBump')
const GIT_WATCH_DEBOUNCE_MS = 200

const flushGitWatch = action(async () => {
  await wrap(sleep(GIT_WATCH_DEBOUNCE_MS))
  if (peek(pendingGitRepoBump)) {
    pendingGitRepoBump.set(false)
    gitRepoToken.set(value => value + 1)
  }
  gitWatchToken.set(value => value + 1)
}, 'git.flushWatch').extend(withAbort())

export const bumpGitWatch = action((scope: 'repo' | 'worktree') => {
  if (scope === 'repo')
    pendingGitRepoBump.set(true)
  void flushGitWatch()
}, 'git.bumpWatch')

export type SessionStatus
  = | 'idle'
    | 'starting'
    | 'active'
    | 'finishing'

export const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['starting'],
  starting: ['active', 'idle'],
  active: ['finishing', 'idle'],
  finishing: ['idle', 'active'],
}

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError'
  constructor(readonly from: SessionStatus, readonly to: SessionStatus) {
    super(`illegal session status transition ${from} -> ${to}`)
  }
}

export class SessionAlreadyActiveError extends Error {
  override readonly name = 'SessionAlreadyActiveError'
  constructor(readonly status: SessionStatus) {
    super(`A Tabthrough session is already ${status}.`)
  }
}

export class GitUnavailableError extends Error {
  override readonly name = 'GitUnavailableError'
  constructor(readonly capability: GitCapability | null) {
    super(capability !== null && !capability.ok ? capability.message : 'git is unavailable.')
  }
}

export type EmptyDiffReason = 'empty' | 'whitespace'

export class EmptyDiffError extends Error {
  override readonly name = 'EmptyDiffError'
  constructor(readonly entry: ReviewTarget, readonly reason: EmptyDiffReason = 'empty') {
    super(reason === 'whitespace'
      ? `Only whitespace changed in ${describeTarget(entry)} — there is nothing to review.`
      : `Nothing to review in ${describeTarget(entry)}.`)
  }
}

export const sessionStatus = atom<SessionStatus>('idle', 'session.status').extend(target => ({
  to: action((next: SessionStatus): SessionStatus => {
    const current = target()
    if (current === next)
      return current
    if (!LEGAL_TRANSITIONS[current].includes(next))
      throw new IllegalTransitionError(current, next)
    target.set(next)
    return next
  }, 'session.status.to'),
}))

export const isSessionActive = computed(() => sessionStatus() === 'active', 'session.isActive')
export const isSessionOpen = computed(() => sessionStatus() !== 'idle', 'session.isOpen')
export const isSessionFinishing = computed(() => sessionStatus() === 'finishing', 'session.isFinishing')
export const gitSurfaceLive = computed(
  () => sidebarLive() || session()?.mode === 'rebase',
  'ui.gitSurfaceLive',
)

const NO_WORKSPACE: GitCapability = {
  ok: false,
  reason: 'no-workspace',
  message: 'Open a folder to use Tabthrough.',
}

export const gitCapability = computed(async (): Promise<GitCapability | null> => {
  const root = workspaceRoot()
  if (!isSessionOpen())
    gitRepoToken()

  if (root === null)
    return NO_WORKSPACE

  return await wrap(probeGit(root, { signal: abortVar.require().signal }))
}, 'git.capability').extend(withAsyncData({ initState: null }))

export const repoStatus = computed(async (): Promise<RepoStatus | null> => {
  const capabilityPromise = gitCapability()
  gitWatchToken()

  const capability = await wrap(capabilityPromise)
  if (capability === null || !capability.ok)
    return null

  return await wrap(readStatus(capability.repoRoot, { signal: abortVar.require().signal }))
}, 'git.repoStatus').extend(withAsyncData({ initState: null }))

export const gitState = computed(async (): Promise<GitState | null> => {
  const capabilityPromise = gitCapability()
  const dir = worktreeDir()
  gitWatchToken()

  const capability = await wrap(capabilityPromise)
  if (capability === null || !capability.ok)
    return null

  return await wrap(readGitState(capability.repoRoot, {
    signal: abortVar.require().signal,
    worktreeDir: dir,
  }))
}, 'git.state').extend(withAsyncData({ initState: null }))

export const session = atom<Session | null>(null, 'session')
export const isolation = atom<IsolationHandle | null>(null, 'session.isolation')
export const guideDiagnostics = atom<readonly GuideDiagnostic[]>([], 'session.diagnostics')
export const pendingEntry = atom<ReviewTarget | null>(null, 'session.pendingEntry')
export const chosenMode = atom<SessionMode | null>(null, 'session.chosenMode')
export const rebaseOwnership = atom<{ readonly after: string, readonly origHead: string } | null>(null, 'session.rebaseOwnership')
const pauseOwnership = atom(false, 'session.pauseOwnership')
const inflightWillRun = atom('nothing', 'session.inflightWillRun')

export interface StartPreview {
  readonly mode: SessionMode
  readonly willRun: string
  readonly notes: string
  readonly rebaseApplicable: boolean
  readonly rebaseHint: string | null
  readonly startEnabled: boolean
  readonly startHint: string | null
  readonly showModePicker: boolean
  readonly showRebase: boolean
}

export const idleStartPreview: StartPreview = {
  mode: 'readonly',
  willRun: 'nothing',
  notes: 'Read-only — the working tree is not checked out.',
  rebaseApplicable: false,
  rebaseHint: null,
  startEnabled: true,
  startHint: null,
  showModePicker: false,
  showRebase: false,
}

const EMPTY_EDITED_PATHS: readonly string[] = []
export const idleEditedPaths: readonly string[] = EMPTY_EDITED_PATHS

export function previewMode(
  setting: 'ask' | SessionMode,
  chosen: SessionMode | null,
  entry: ReviewTarget | null,
): SessionMode {
  const requested = setting === 'ask' ? (chosen ?? 'readonly') : setting
  if (requested === 'worktree')
    return 'readonly'
  if (requested === 'rebase' && entry?.kind === 'workingTree')
    return 'readonly'
  return requested
}

export const startPreview = computed(async (): Promise<StartPreview> => {
  const entry = pendingEntry()
  const setting = sessionModeSetting()
  const chosen = chosenMode()

  const requested = setting === 'ask' ? (chosen ?? 'readonly') : setting
  const showModePicker = setting === 'ask' && entry !== null
  const showRebase = entry !== null && entry.kind !== 'workingTree'
  const mode = previewMode(setting, chosen, entry)

  if (requested === 'worktree') {
    return {
      ...idleStartPreview,
      mode,
      showModePicker,
      showRebase,
      startEnabled: false,
      startHint: WORKTREE_LATER,
    }
  }

  if (entry === null)
    return mode === idleStartPreview.mode ? idleStartPreview : { ...idleStartPreview, mode }

  const hooks = finishHooks()
  const sign = finishSign()
  const options = heuristicOptions()
  const guide = guideFile()
  gitWatchToken()
  const capabilityPromise = gitCapability()
  const statusPromise = repoStatus()
  const statePromise = entry.kind === 'workingTree' ? null : gitState()

  const capability = await wrap(capabilityPromise)
  if (capability === null || !capability.ok) {
    return {
      ...idleStartPreview,
      mode,
      showModePicker,
      showRebase,
      startEnabled: false,
      startHint: capability === null ? 'Checking the repository…' : capability.message,
    }
  }

  const signal = abortVar.require().signal
  const state = statePromise === null ? null : await wrap(statePromise)
  if (entry.kind === 'workingTree' || mode === 'readonly') {
    const applicability = entry.kind === 'workingTree'
      ? { applicable: false, hint: null as string | null, plan: null, after: null }
      : await wrap(assessRebase(capability.repoRoot, entry, { signal, state }))
    return {
      ...idleStartPreview,
      mode: 'readonly',
      showModePicker,
      showRebase,
      rebaseApplicable: applicability.applicable,
      rebaseHint: applicability.hint,
    }
  }

  const applicability = await wrap(assessRebase(capability.repoRoot, entry, { signal, state }))
  if (applicability.plan === null || applicability.after === null) {
    return {
      ...idleStartPreview,
      mode: 'readonly',
      showModePicker,
      showRebase,
      startEnabled: false,
      startHint: applicability.hint ?? 'Could not resolve that revision.',
    }
  }

  if (!applicability.applicable) {
    return {
      ...idleStartPreview,
      mode: 'readonly',
      showModePicker,
      showRebase,
      rebaseApplicable: false,
      rebaseHint: applicability.hint,
      startEnabled: requested !== 'rebase',
      startHint: requested === 'rebase' ? applicability.hint : null,
    }
  }

  const guideFinish = await wrap(peekSidecarFinish({
    repoRoot: capability.repoRoot,
    baseRev: applicability.plan.baseRev,
    afterRev: applicability.after,
    options,
    guideFile: guide,
    signal,
  }))
  const policy = resolveFinishPolicy(guideFinish, { hooks, sign })
  const above = await wrap(countCommitsAfter(capability.repoRoot, applicability.after, { signal }))
  const gpgsign = await wrap(readCommitGpgSign(capability.repoRoot, { signal }))
  const status = await wrap(statusPromise)
  const dirty = status === null ? 0 : new Set([...status.staged, ...status.unstaged]).size
  const staged = status?.staged.length ?? 0
  const notes = rebaseStartNotes(dirty, staged, above, gpgsign && !policy.sign)

  return {
    mode: 'rebase',
    willRun: formatRebaseCommand(applicability.plan.baseRev, policy.hooks, policy.sign),
    notes,
    rebaseApplicable: true,
    rebaseHint: null,
    startEnabled: true,
    startHint: null,
    showModePicker,
    showRebase,
  }
}, 'session.startPreview').extend(withAsyncData({ initState: idleStartPreview }))

export const willRun = computed((): string => {
  if (sessionStatus() !== 'idle')
    return inflightWillRun()
  return startPreview.data().willRun
}, 'session.willRun')

export const editedPaths = computed(async (): Promise<readonly string[]> => {
  const model = session()
  if (model === null || !diskHoldsAfter(model.entry.kind, model.mode))
    return EMPTY_EDITED_PATHS

  gitWatchToken()
  const statusPromise = model.mode === 'rebase' ? repoStatus() : null
  const status = statusPromise === null ? null : await wrap(statusPromise)
  const dirty = status === null
    ? null
    : new Set([
        ...status.staged,
        ...status.unstaged,
        ...status.untracked,
      ])
  if (dirty !== null && dirty.size === 0)
    return EMPTY_EDITED_PATHS

  const signal = abortVar.require().signal
  const out: string[] = []
  for (const file of model.diff.files) {
    if (file.isBinary || (dirty !== null && !dirty.has(file.path)))
      continue
    const after = await wrap(showBlob(model.repoRoot, model.afterRev, file.path, { signal }))
    const disk = await wrap(readWorktreeFile(model.repoRoot, file.path))
    if (after !== null && disk !== null && after !== disk)
      out.push(file.path)
  }
  return out
}, 'session.editedPaths').extend(withAsyncData({ initState: EMPTY_EDITED_PATHS }))

export const editHereEnabled = computed((): boolean => {
  const model = session()
  return model !== null && sessionStatus() === 'active' && diskHoldsAfter(model.entry.kind, model.mode)
}, 'session.editHereEnabled')

export interface StartRequest {
  readonly entry: ReviewTarget
  readonly guideFile?: string
  readonly sidecar?: SidecarSource
  readonly sessionMode?: SessionMode
}

const startAttempt = atom(0, 'session.startAttempt')
const cancelledStartAttempt = atom<number | null>(null, 'session.cancelledStartAttempt')
const startRebaseInFlight = atom(false, 'session.startRebaseInFlight')
const startSettled = action((attempt: number) => attempt, 'session.startSettled')

export const chooseMode = action((mode: SessionMode) => {
  chosenMode.set(mode)
}, 'session.chooseMode')

export class RebaseNotApplicableError extends Error {
  override readonly name = 'RebaseNotApplicableError'
  constructor(message = WORKTREE_HINT) {
    super(message)
  }
}

export class WorktreeNotReadyError extends Error {
  override readonly name = 'WorktreeNotReadyError'
  constructor() {
    super(WORKTREE_LATER)
  }
}

function landedMode(requested: SessionMode | undefined, entry: ReviewTarget): SessionMode {
  if (requested === 'worktree')
    throw new WorktreeNotReadyError()
  if (requested === 'readonly' || requested === 'rebase')
    return requested
  const setting = peek(sessionModeSetting)
  return previewMode(setting, peek(chosenMode), entry)
}

function diskHoldsAfter(entryKind: ReviewTarget['kind'], mode: SessionMode): boolean {
  return entryKind === 'workingTree' || mode === 'rebase'
}

function rebaseStartNotes(dirty: number, staged: number, above: number, unsigned: boolean): string {
  const parts: string[] = []
  if (dirty > 0)
    parts.push(`autostash will park ${dirty} file${dirty === 1 ? '' : 's'}`)
  if (staged > 0)
    parts.push('staged changes come back unstaged')
  if (above > 0)
    parts.push(`${above} commit${above === 1 ? '' : 's'} above will be rewritten`)
  if (unsigned)
    parts.push('replayed commits will be unsigned')
  return parts.length === 0
    ? 'Rebase stops at the reviewed commit.'
    : parts.join('; ')
}

function hintForRefuse(reason: RebaseRefuseReason): string {
  switch (reason) {
    case 'not-ancestor':
      return WORKTREE_HINT
    case 'merge-after':
      return MERGE_AFTER_HINT
    case 'merge-above':
      return MERGE_ABOVE_HINT
    case 'in-progress':
      return REBASE_IN_PROGRESS_HINT
  }
}

async function assessRebase(
  repoRoot: string,
  entry: ReviewTarget,
  options: GitOptions & { readonly state?: GitState | null } = {},
): Promise<{
  readonly after: string | null
  readonly plan: IsolationPlan | null
  readonly applicable: boolean
  readonly hint: string | null
}> {
  try {
    const plan = await planIsolation(repoRoot, { entry }, options)
    if (plan.afterRev === null)
      return { after: null, plan, applicable: false, hint: WORKTREE_HINT }
    const reason = await rebaseRefuseReason(repoRoot, plan.afterRev, plan.baseRev, options)
    return {
      after: plan.afterRev,
      plan,
      applicable: reason === null,
      hint: reason === null ? null : hintForRefuse(reason),
    }
  }
  catch {
    return { after: null, plan: null, applicable: false, hint: 'Could not resolve that revision.' }
  }
}

function finishSessionStillOpen(model: Session, expected: 'active' | 'finishing'): boolean {
  return peek(sessionStatus) === expected
    && peek(session) === model
    && peek(rebaseOwnership) !== null
}

interface StartFailure {
  readonly error: unknown
  readonly inherited: IsolationHandle | null
  readonly attempt: number
  readonly repoRoot: string | null
}

const startFailed = action(async ({ error, inherited, attempt, repoRoot }: StartFailure): Promise<void> => {
  const handle = peek(isolation)
  try {
    const owned = peek(rebaseOwnership)
    if (owned !== null) {
      const root = repoRoot ?? peek(workspaceRoot)
      if (root !== null)
        await wrap(reportGit(await wrap(rebaseAbort(root))))
      rebaseOwnership.set(null)
    }
    inflightWillRun.set('nothing')

    if (handle !== null && handle === inherited) {
      if (!isAbort(error))
        await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
      return
    }

    if (handle !== null && handle !== inherited)
      await wrap(releaseReview(handle))

    isolation.set(null)
    session.set(null)
    rebaseOwnership.set(null)
    inflightWillRun.set('nothing')
    if (peek(sessionStatus) !== 'idle')
      sessionStatus.to('idle')

    if (!isAbort(error))
      await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
  }
  catch (failure) {
    isolation.set(null)
    session.set(null)
    if (peek(sessionStatus) !== 'idle')
      sessionStatus.to('idle')
    await wrap(peek(ports).ui.notify('error', `Could not close the review: ${failure instanceof Error ? failure.message : String(failure)}`))
  }
  finally {
    startSettled(attempt)
  }
}, 'session.failed').extend(withAsync())

export const startSession = action(async (request: StartRequest): Promise<Session> => {
  if (peek(sessionStatus) !== 'idle')
    throw new SessionAlreadyActiveError(peek(sessionStatus))

  const inherited = peek(isolation)
  const attempt = startAttempt.set(value => value + 1)
  cancelledStartAttempt.set(null)
  let startRepoRoot: string | null = null
  framePromise().catch((error) => {
    abortVar.spawn(() => {
      void startFailed({ error, inherited, attempt, repoRoot: startRepoRoot }).catch((failure) => {
        if (!isAbort(failure))
          void peek(ports).ui.notify('error', describeStartFailure(failure))
      })
    })
  })
  sessionStatus.to('starting')

  const signal = abortVar.require().signal
  const root = peek(workspaceRoot)
  const capability = root === null ? NO_WORKSPACE : await wrap(probeGit(root, { signal }))
  if (!capability.ok)
    throw new GitUnavailableError(capability)

  const { repoRoot } = capability
  startRepoRoot = repoRoot
  const resolvedMode = landedMode(request.sessionMode, request.entry)
  if (resolvedMode === 'rebase' && request.entry.kind === 'workingTree')
    throw new RebaseNotApplicableError('Rebase is not offered for working changes.')

  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  if (request.entry.kind === 'workingTree' || resolvedMode === 'rebase') {
    const saved = await wrap(peek(ports).ui.saveDocuments(repoRoot, []))
    if (!saved.ok) {
      await wrap(peek(ports).ui.notify('warn', `Save ${saved.path} before starting Tabthrough.`))
      throwAbort()
    }
  }

  const plan = await wrap(planIsolation(repoRoot, { entry: request.entry }, { signal }))
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()
  if (plan.changedLineCount === 0)
    throw new EmptyDiffError(request.entry, 'empty')
  if (plan.substantiveLineCount === 0)
    throw new EmptyDiffError(request.entry, 'whitespace')

  const guideFinish = await wrap(peekSidecarFinish({
    repoRoot,
    baseRev: plan.baseRev,
    afterRev: plan.afterRev ?? plan.baseRev,
    options: peek(heuristicOptions),
    guideFile: request.guideFile ?? peek(guideFile),
    ...(request.sidecar === undefined ? {} : { sidecar: request.sidecar }),
    signal,
  }))
  const finish = resolveFinishPolicy(guideFinish, {
    hooks: peek(finishHooks),
    sign: peek(finishSign),
  })

  if (resolvedMode === 'rebase') {
    if (plan.afterRev === null)
      throw new RebaseNotApplicableError()
    const refuse = await wrap(rebaseRefuseReason(repoRoot, plan.afterRev, plan.baseRev, { signal }))
    if (refuse !== null)
      throw new RebaseNotApplicableError(hintForRefuse(refuse))

    const origHead = await wrap(resolveCommit(repoRoot, 'HEAD', { signal }))
    if (origHead === null)
      throw new GitUnavailableError(capability)

    const editor = peek(sequenceEditorPath)
    const execPath = peek(sequenceEditorExecPath)
    if (editor === null || execPath === null)
      throw new Error('Tabthrough could not find its rebase sequence editor.')

    inflightWillRun.set(formatRebaseCommand(plan.baseRev, finish.hooks, finish.sign))
    startRebaseInFlight.set(true)
    let started: GitCommandResult
    try {
      started = await wrap(startRebase({
        repoRoot,
        base: plan.baseRev,
        after: plan.afterRev,
        hooks: finish.hooks,
        sign: finish.sign,
        execPath,
        sequenceEditor: editor,
      }))
      peek(ports).ui.logGit(started)
      gitWatchToken.set(value => value + 1)

      if (started.code === 0)
        rebaseOwnership.set({ after: plan.afterRev, origHead })

      if (peek(cancelledStartAttempt) === attempt) {
        if (started.code === 0)
          await wrap(reportGit(await wrap(rebaseAbort(repoRoot))))
        rebaseOwnership.set(null)
        throwAbort()
      }

      if (started.code !== 0)
        throw new GitCommandError(['rebase', '-i', '--autostash'], started.code, started.stdout, started.stderr)

      const ownership = await wrap(readOwnership(repoRoot, plan.afterRev, origHead))
      if (peek(cancelledStartAttempt) === attempt) {
        if (ownership.rebase !== null)
          await wrap(reportGit(await wrap(rebaseAbort(repoRoot))))
        rebaseOwnership.set(null)
        throwAbort()
      }
      if (!ownership.ours) {
        if (ownership.rebase !== null) {
          await wrap(reportGit(await wrap(rebaseAbort(repoRoot))))
          rebaseOwnership.set(null)
          throw new RebaseNotApplicableError(gitOutput(started))
        }
        rebaseOwnership.set(null)
        throw new RebaseNotApplicableError(rebaseCompletedMessage(origHead))
      }
    }
    finally {
      startRebaseInFlight.set(false)
    }
  }
  else {
    inflightWillRun.set('nothing')
  }

  const id = peek(ports).clock.sessionId()
  const handle = await wrap(beginReview({ repoRoot, sessionId: id, plan, signal }))
  isolation.set(handle)

  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  const built = await wrap(peek(guideSource).build({
    repoRoot,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    options: peek(heuristicOptions),
    guideFile: request.guideFile ?? peek(guideFile),
    ...(request.sidecar === undefined ? {} : { sidecar: request.sidecar }),
    signal,
  }))
  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  const model = reatomSession({
    id,
    repoRoot,
    entry: request.entry,
    baseRev: handle.baseRev,
    afterRev: handle.afterRev,
    handle,
    diff: built.diff,
    guide: built.guide,
    mode: resolvedMode,
  })

  guideDiagnostics.set(built.diagnostics)
  session.set(model)
  sessionStatus.to('active')
  model.next()
  cancelledStartAttempt.set(null)
  startSettled(attempt)
  return model
}, 'session.start').extend(withAsync({ status: true }), withAbort('first-in-win'))

export type CancelReason = 'finish' | 'cancel' | 'deactivate' | 'ownership' | 'conflict'

const teardownSession = action(async ({
  reason,
  abortOwnedRebase,
  silent = false,
}: {
  reason: CancelReason
  abortOwnedRebase: boolean
  silent?: boolean
}): Promise<void> => {
  const handle = peek(isolation)
  const owned = peek(rebaseOwnership)
  sessionStatus.to('finishing')
  if (abortOwnedRebase && owned !== null) {
    const repoRoot = handle?.repoRoot ?? peek(session)?.repoRoot
    if (repoRoot === undefined)
      throw new Error('Tabthrough has no repository to abort.')
    await wrap(reportGit(await wrap(rebaseAbort(repoRoot))))
  }
  if (handle !== null)
    await wrap(releaseReview(handle))
  isolation.set(null)
  session.set(null)
  rebaseOwnership.set(null)
  inflightWillRun.set('nothing')
  pauseOwnership.set(false)
  sessionStatus.to('idle')
  if (silent)
    return
  if (reason === 'ownership')
    await wrap(peek(ports).ui.notify('info', OWNERSHIP_LOST))
  else
    await wrap(peek(ports).ui.notify('info', describeClosed(reason)))
}, 'session.teardown').extend(withAsync())

export const syncRebaseOwnership = action(async (): Promise<void> => {
  if (peek(pauseOwnership))
    return
  if (peek(sessionStatus) !== 'active')
    return
  const model = peek(session)
  if (model?.mode !== 'rebase')
    return
  const owned = peek(rebaseOwnership)
  if (owned === null)
    return
  const state = peek(gitState.data)
  if (state === null)
    return
  if (ownsRebase(state.rebase, owned.after, owned.origHead))
    return
  await wrap(teardownSession({ reason: 'ownership', abortOwnedRebase: false }))
}, 'session.syncRebaseOwnership').extend(withAsync())

export const finishSession = action(async (): Promise<void> => {
  if (peek(sessionStatus) !== 'active')
    return
  const model = peek(session)
  if (model === null)
    return

  if (model.mode !== 'rebase') {
    await wrap(teardownSession({ reason: 'finish', abortOwnedRebase: false }))
    return
  }

  const saved = await wrap(peek(ports).ui.saveDocuments(model.repoRoot, []))
  if (!finishSessionStillOpen(model, 'active'))
    return
  if (!saved.ok) {
    await wrap(peek(ports).ui.notify('warn', `Save ${saved.path} before finishing Tabthrough.`))
    return
  }

  const status = await wrap(readStatus(model.repoRoot))
  if (!finishSessionStillOpen(model, 'active'))
    return
  const picked = status.untracked.length === 0
    ? []
    : await wrap(peek(ports).ui.pickUntracked(status.untracked))
  if (picked === undefined)
    return
  if (!finishSessionStillOpen(model, 'active'))
    return

  const guideFinish = await wrap(peekSidecarFinish({
    repoRoot: model.repoRoot,
    baseRev: model.baseRev,
    afterRev: model.afterRev,
    options: peek(heuristicOptions),
    guideFile: peek(guideFile),
  }))
  if (!finishSessionStillOpen(model, 'active'))
    return
  const policy = resolveFinishPolicy(guideFinish, {
    hooks: peek(finishHooks),
    sign: peek(finishSign),
  })

  const owned = peek(rebaseOwnership)
  if (owned === null)
    return
  const ownership = await wrap(readOwnership(model.repoRoot, owned.after, owned.origHead))
  if (!finishSessionStillOpen(model, 'active'))
    return
  if (!ownership.ours) {
    await wrap(teardownSession({ reason: 'ownership', abortOwnedRebase: false }))
    return
  }

  pauseOwnership.set(true)
  sessionStatus.to('finishing')
  try {
    let result = await wrap(runFinishRebase({
      repoRoot: model.repoRoot,
      hooks: policy.hooks,
      sign: policy.sign,
      stageUntracked: picked,
    }))
    for (const command of result.results)
      peek(ports).ui.logGit(command)
    gitWatchToken.set(value => value + 1)

    if (!finishSessionStillOpen(model, 'finishing'))
      return

    if (!result.ok && result.kind === 'hooks-or-sign') {
      const retry = await wrap(peek(ports).ui.notify('error', gitOutput(result.failed), [RETRY_WITHOUT_HOOKS]))
      if (retry !== RETRY_WITHOUT_HOOKS)
        return
      if (!finishSessionStillOpen(model, 'finishing'))
        return
      const retryOwned = peek(rebaseOwnership)
      if (retryOwned === null)
        return
      const retryOwnership = await wrap(readOwnership(model.repoRoot, retryOwned.after, retryOwned.origHead))
      if (!finishSessionStillOpen(model, 'finishing'))
        return
      if (!retryOwnership.ours) {
        await wrap(teardownSession({ reason: 'ownership', abortOwnedRebase: false }))
        return
      }
      result = await wrap(runFinishRebase({
        repoRoot: model.repoRoot,
        hooks: false,
        sign: false,
        stageUntracked: [],
        from: 'amend',
      }))
      for (const command of result.results)
        peek(ports).ui.logGit(command)
      gitWatchToken.set(value => value + 1)
      if (!finishSessionStillOpen(model, 'finishing'))
        return
    }

    if (!result.ok && result.kind === 'conflict') {
      await wrap(teardownSession({ reason: 'conflict', abortOwnedRebase: false }))
      await wrap(peek(ports).ui.notify('error', gitOutput(result.failed)))
      return
    }

    if (!result.ok) {
      await wrap(peek(ports).ui.notify('error', gitOutput(result.failed)))
      return
    }

    const continued = result.results.at(-1)
    const leftover = await wrap(readGitState(model.repoRoot))
    if (!finishSessionStillOpen(model, 'finishing'))
      return
    const leftoverProblem = leftover.conflicts.length > 0 || leftover.autostashes.length > 0
    if (leftoverProblem) {
      const leftoverNotice = continued === undefined
        ? 'Applying autostash resulted in conflicts. Your changes are safe in the stash.'
        : gitOutput(continued)
      await wrap(teardownSession({ reason: 'finish', abortOwnedRebase: false, silent: true }))
      await wrap(peek(ports).ui.notify('warn', leftoverNotice))
      return
    }

    await wrap(teardownSession({ reason: 'finish', abortOwnedRebase: false }))
  }
  finally {
    pauseOwnership.set(false)
    if (peek(sessionStatus) === 'finishing')
      sessionStatus.to('active')
    if (peek(sessionStatus) === 'active')
      await wrap(syncRebaseOwnership())
  }
}, 'session.finish').extend(withAsync({ status: true }), withAbort('first-in-win'))

export const commitHandoff = action(async (): Promise<void> => {
  await wrap(peek(ports).ui.openSourceControl())
}, 'session.commitHandoff').extend(withAsync())

export const cancelSession = action(async (reason: CancelReason = 'cancel'): Promise<void> => {
  const status = peek(sessionStatus)
  if (status === 'idle')
    return

  if (status === 'starting') {
    const attempt = peek(startAttempt)
    cancelledStartAttempt.set(attempt)
    const settled = take(startSettled, value => value === attempt || throwAbort(), 'startCancelled')
    if (!peek(startRebaseInFlight))
      startSession.abort()
    await wrap(settled)
    return
  }

  if (status === 'finishing')
    return

  const model = peek(session)
  const abortOwnedRebase = reason === 'cancel' && model?.mode === 'rebase' && peek(rebaseOwnership) !== null
  await wrap(teardownSession({ reason, abortOwnedRebase }))
}, 'session.cancel').extend(withAsync({ status: true }), withAbort('first-in-win'))

export const editHere = action(async (): Promise<void> => {
  const model = peek(session)
  if (model === null || peek(sessionStatus) !== 'active')
    return
  const step = peek(model.currentStep)
  if (step === null)
    return
  const file = model.fileByPath.get(step.path)
  if (file === undefined) {
    await wrap(peek(ports).ui.notify('info', 'This step has no file to open.'))
    return
  }

  const base = peek(file.baseText.data) ?? ''
  const disk = diskHoldsAfter(model.entry.kind, model.mode)
    ? await wrap(readWorktreeFile(model.repoRoot, step.path))
    : null
  const target = projectEditHere({
    entryKind: model.entry.kind,
    sessionMode: model.mode,
    file: file.file,
    step,
    baseText: base,
    diskText: disk,
  })
  if (!target.enabled) {
    await wrap(peek(ports).ui.notify('info', target.hint ?? 'Edit here is not available for this review.'))
    return
  }
  await wrap(peek(ports).ui.openFileAt(model.repoRoot, target.path, target.line, target.ranges))
}, 'session.editHere').extend(withAsync(), withAbort('first-in-win'))

export const sweepOnActivate = action(async (): Promise<void> => {
  const root = peek(workspaceRoot)
  if (root === null)
    return
  const capability = await wrap(probeGit(root))
  if (!capability.ok)
    return
  await wrap(sweepStaleAfterRefs(capability.repoRoot))
  const pruned = await wrap(gitPruneWorktrees(capability.repoRoot))
  peek(ports).ui.logGit(pruned)
  gitWatchToken.set(value => value + 1)
}, 'session.sweepOnActivate').extend(withAsync())

async function reportGit(result: GitCommandResult): Promise<void> {
  peek(ports).ui.logGit(result)
  gitWatchToken.set(value => value + 1)
  const body = [stripGitProgress(result.stdout), stripGitProgress(result.stderr)].filter(part => part !== '').join('\n')
  if (result.code === 0) {
    if (body !== '')
      await wrap(peek(ports).ui.notify('info', body))
    return
  }
  await wrap(peek(ports).ui.notify('error', body === '' ? `${result.command} exited ${result.code}` : body))
}

async function requireRepoRoot(): Promise<string | null> {
  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    await wrap(peek(ports).ui.notify('warn', capability === null
      ? 'Tabthrough is still checking the repository.'
      : capability.message))
    return null
  }
  return capability.repoRoot
}

export const continueRebase = action(async (): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  await wrap(reportGit(await wrap(gitContinueRebase(repoRoot))))
}, 'session.continueRebase').extend(withAsync(), withAbort('first-in-win'))

export const abortRebase = action(async (): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  await wrap(reportGit(await wrap(gitAbortRebase(repoRoot))))
}, 'session.abortRebase').extend(withAsync(), withAbort('first-in-win'))

export const popAutostash = action(async (selector?: string): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  const pick = selector ?? peek(gitState.data)?.autostashes[0]?.selector
  if (pick === undefined) {
    await wrap(peek(ports).ui.notify('info', 'No autostash entry to pop.'))
    return
  }
  await wrap(reportGit(await wrap(gitPopAutostash(repoRoot, pick))))
}, 'session.popAutostash').extend(withAsync(), withAbort('first-in-win'))

export const showAutostash = action(async (selector?: string): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  const pick = selector ?? peek(gitState.data)?.autostashes[0]?.selector
  if (pick === undefined) {
    await wrap(peek(ports).ui.notify('info', 'No autostash entry to show.'))
    return
  }
  await wrap(reportGit(await wrap(gitShowAutostash(repoRoot, pick))))
}, 'session.showAutostash').extend(withAsync(), withAbort('first-in-win'))

export const openWorktree = action(async (dir: string): Promise<void> => {
  await wrap(peek(ports).ui.openFolder(dir, true))
}, 'session.openWorktree').extend(withAsync())

export const removeWorktree = action(async (dir: string): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  await wrap(reportGit(await wrap(gitRemoveWorktree(repoRoot, dir))))
}, 'session.removeWorktree').extend(withAsync(), withAbort('first-in-win'))

export const pruneWorktrees = action(async (): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  await wrap(reportGit(await wrap(gitPruneWorktrees(repoRoot))))
}, 'session.pruneWorktrees').extend(withAsync(), withAbort('first-in-win'))

export const openConflict = action(async (path: string): Promise<void> => {
  const repoRoot = await wrap(requireRepoRoot())
  if (repoRoot === null)
    return
  await wrap(peek(ports).ui.openWorkspaceFile(repoRoot, path))
}, 'session.openConflict').extend(withAsync())

export const gitUsable = computed(() => gitCapability.data()?.ok === true, 'ui.gitUsable')

export const canStart = computed(
  () => gitUsable() && sessionStatus() === 'idle',
  'ui.canStart',
)

export const rebaseInProgress = computed(() => {
  if (!gitSurfaceLive())
    return false
  return gitState.data()?.rebase !== null
}, 'ui.rebaseInProgress')
export const hasAutostash = computed(() => {
  if (!gitSurfaceLive())
    return false
  return (gitState.data()?.autostashes.length ?? 0) > 0
}, 'ui.hasAutostash')
export const hasTabthroughWorktree = computed(() => {
  if (!gitSurfaceLive())
    return false
  return (gitState.data()?.worktrees.length ?? 0) > 0
}, 'ui.hasTabthroughWorktree')
export const hasConflicts = computed(() => {
  if (!gitSurfaceLive())
    return false
  return (gitState.data()?.conflicts.length ?? 0) > 0
}, 'ui.hasConflicts')

export const startBlockedReason = computed((): string | null => {
  const capability = gitCapability.data()
  if (capability === null)
    return 'Checking the repository…'
  if (!capability.ok)
    return capability.hint === undefined ? capability.message : `${capability.message} ${capability.hint}`
  const status = sessionStatus()
  if (status !== 'idle')
    return `A Tabthrough session is already ${status}.`
  return null
}, 'ui.startBlockedReason')

export function describeStartFailure(error: unknown): string {
  if (error instanceof EmptyDiffError || error instanceof SessionAlreadyActiveError)
    return error.message
  if (error instanceof MissingObjectsError || error instanceof EntryNotSupportedError)
    return error.message
  if (error instanceof GitUnavailableError)
    return error.message
  if (error instanceof RebaseNotApplicableError || error instanceof WorktreeNotReadyError)
    return error.message
  if (error instanceof GitCommandError)
    return error.message
  return `Tabthrough could not start: ${error instanceof Error ? error.message : String(error)}`
}

export function describeClosed(reason: CancelReason): string {
  switch (reason) {
    case 'finish':
      return 'Review finished.'
    case 'cancel':
      return 'Review cancelled.'
    case 'deactivate':
      return 'Tabthrough closed the review.'
    case 'ownership':
      return OWNERSHIP_LOST
    case 'conflict':
      return CONFLICT_STOP
  }
}

export function connectOwnershipWatch(): () => void {
  return effect(() => {
    if (sessionStatus() !== 'active')
      return
    if (session()?.mode !== 'rebase')
      return
    gitState.data()
    abortVar.spawn(() => {
      void syncRebaseOwnership()
    })
  }, 'session.ownershipWatch').unsubscribe
}
