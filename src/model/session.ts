import type { IsolationHandle } from '../git/isolate'
import type { GitCapability, RepoStatus } from '../git/probe'
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
  framePromise,
  isAbort,
  peek,
  take,
  throwAbort,
  withAbort,
  withAsync,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { showBlob } from '../git/diff'
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
import { guideFile, heuristicOptions, sessionModeSetting, worktreeDir } from './config'
import { guideSource } from './guide-source'
import { inertPorts } from './ports'
import { reatomSession } from './steps'

export {
  guideFile,
  heuristicOptions,
  revealMode,
  sessionModeSetting,
  showRationale,
  worktreeDir,
} from './config'

export const workspaceRoot = atom<string | null>(null, 'workspaceRoot')
export const ports = atom<Ports>(inertPorts, 'ports')
export const gitWatchToken = atom(0, 'git.watchToken')

export type SessionStatus
  = | 'idle'
    | 'starting'
    | 'active'
    | 'finishing'

export const LEGAL_TRANSITIONS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['starting'],
  starting: ['active', 'idle'],
  active: ['finishing', 'idle'],
  finishing: ['idle'],
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

const NO_WORKSPACE: GitCapability = {
  ok: false,
  reason: 'no-workspace',
  message: 'Open a folder to use Tabthrough.',
}

export const gitCapability = computed(async (): Promise<GitCapability | null> => {
  const root = workspaceRoot()
  if (sessionStatus() === 'idle')
    gitWatchToken()

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

export const willRun = computed((): string => 'nothing', 'session.willRun')

export const editedPaths = computed(async (): Promise<readonly string[]> => {
  const model = session()
  gitWatchToken()
  if (model === null || model.entry.kind !== 'workingTree')
    return []

  const out: string[] = []
  for (const file of model.diff.files) {
    if (file.isBinary)
      continue
    const after = await wrap(showBlob(model.repoRoot, model.afterRev, file.path))
    const disk = await wrap(readWorktreeFile(model.repoRoot, file.path))
    if (after !== null && disk !== null && after !== disk)
      out.push(file.path)
  }
  return out
}, 'session.editedPaths').extend(withAsyncData({ initState: [] as readonly string[] }))

export const editHereEnabled = computed((): boolean => {
  const model = session()
  return model !== null && sessionStatus() === 'active' && model.entry.kind === 'workingTree'
}, 'session.editHereEnabled')

export interface StartRequest {
  readonly entry: ReviewTarget
  readonly guideFile?: string
  readonly sidecar?: SidecarSource
  readonly sessionMode?: SessionMode
}

const startAttempt = atom(0, 'session.startAttempt')
const cancelledStartAttempt = atom<number | null>(null, 'session.cancelledStartAttempt')
const startSettled = action((attempt: number) => attempt, 'session.startSettled')

function landedMode(requested: SessionMode | undefined): SessionMode {
  if (requested === 'readonly' || requested === 'rebase' || requested === 'worktree')
    return 'readonly'
  const setting = peek(sessionModeSetting)
  return setting === 'ask' ? 'readonly' : 'readonly'
}

interface StartFailure {
  readonly error: unknown
  readonly inherited: IsolationHandle | null
  readonly attempt: number
}

const startFailed = action(async ({ error, inherited, attempt }: StartFailure): Promise<void> => {
  const handle = peek(isolation)
  try {
    if (handle !== null && handle === inherited) {
      if (!isAbort(error))
        await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
      return
    }

    if (handle !== null && handle !== inherited)
      await wrap(releaseReview(handle))

    isolation.set(null)
    session.set(null)
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
  framePromise().catch(error => startFailed({ error, inherited, attempt }))
  sessionStatus.to('starting')

  const signal = abortVar.require().signal
  const root = peek(workspaceRoot)
  const capability = root === null ? NO_WORKSPACE : await wrap(probeGit(root, { signal }))
  if (!capability.ok)
    throw new GitUnavailableError(capability)

  const { repoRoot } = capability
  const resolvedMode = landedMode(request.sessionMode)

  if (peek(cancelledStartAttempt) === attempt)
    throwAbort()

  if (request.entry.kind === 'workingTree') {
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

export type CancelReason = 'finish' | 'cancel' | 'deactivate'

const teardownSession = action(async ({ reason }: { reason: CancelReason }): Promise<void> => {
  const handle = peek(isolation)
  sessionStatus.to('finishing')
  if (handle !== null)
    await wrap(releaseReview(handle))
  isolation.set(null)
  session.set(null)
  sessionStatus.to('idle')
  await wrap(peek(ports).ui.notify('info', describeClosed(reason)))
}, 'session.teardown').extend(withAsync())

export const finishSession = action(async (): Promise<void> => {
  if (peek(sessionStatus) !== 'active')
    return
  await wrap(teardownSession({ reason: 'finish' }))
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
    const settled = take(startSettled, value => value === attempt, 'startCancelled')
    startSession.abort()
    await wrap(settled)
    return
  }

  if (status === 'finishing')
    return

  await wrap(teardownSession({ reason }))
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
  const disk = model.entry.kind === 'workingTree'
    ? await wrap(readWorktreeFile(model.repoRoot, step.path))
    : null
  const target = projectEditHere({
    entryKind: model.entry.kind,
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
  const body = [result.stdout.trim(), result.stderr.trim()].filter(part => part !== '').join('\n')
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

export const rebaseInProgress = computed(() => gitState.data()?.rebase !== null, 'ui.rebaseInProgress')
export const hasAutostash = computed(() => (gitState.data()?.autostashes.length ?? 0) > 0, 'ui.hasAutostash')
export const hasTabthroughWorktree = computed(() => (gitState.data()?.worktrees.length ?? 0) > 0, 'ui.hasTabthroughWorktree')
export const hasConflicts = computed(() => (gitState.data()?.conflicts.length ?? 0) > 0, 'ui.hasConflicts')

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
  }
}
