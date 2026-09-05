import type { HeadPosition, ReviewTarget, SessionMode } from './types'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

/**
 * The write-ahead journal (ADR 0002 D3).
 *
 * The stage is persisted *before* the operation it names, so recovery always
 * knows how far the previous run got and never has to guess. This module is
 * pure over an injected {@link TokenStore}; the bridge supplies a `globalState`
 * implementation.
 */

export type { SessionMode }

export type IsolationStage
  /** Nothing touched. */
  = | 'planned'
  /** After-ref written; the working tree is still untouched. */
    | 'captured'
  /** Working tree cleaned by the stash. */
    | 'stashed'
  /** Detached HEAD at the target revision. */
    | 'checkedout'
  /** Steady state (read-only reveal or apply walk between Tabs). */
    | 'reviewing'
  /** Apply mode: mid Tab/Previous write (journalled before mutate). */
    | 'applying'
  /** Apply mode Finish: carrying the working tree back to headBefore. */
    | 'finishing-keep'
  /** Restore in flight. */
    | 'restoring'
  /** Restored and verified; the token is about to be deleted. */
    | 'done'
  /** Apply Finish succeeded; tree kept; refs retained until cleanup. */
    | 'done-kept'

export const ISOLATION_STAGES: readonly IsolationStage[] = [
  'planned',
  'captured',
  'stashed',
  'checkedout',
  'reviewing',
  'applying',
  'finishing-keep',
  'restoring',
  'done',
  'done-kept',
]

const LEGAL_STAGES: Readonly<Record<IsolationStage, readonly IsolationStage[]>> = {
  'planned': ['captured', 'restoring', 'done'],
  // `checkedout` is reachable directly because a clean tree is never stashed.
  'captured': ['stashed', 'checkedout', 'restoring', 'done'],
  'stashed': ['checkedout', 'restoring'],
  'checkedout': ['reviewing', 'restoring'],
  'reviewing': ['applying', 'restoring', 'finishing-keep'],
  'applying': ['reviewing', 'restoring'],
  'finishing-keep': ['done-kept', 'restoring'],
  'restoring': ['restoring', 'done'],
  'done': [],
  'done-kept': [],
}

export class IllegalStageError extends Error {
  override readonly name = 'IllegalStageError'
  constructor(readonly from: IsolationStage, readonly to: IsolationStage) {
    super(`illegal journal stage transition ${from} -> ${to}`)
  }
}

export interface SessionToken {
  readonly v: 1
  readonly sessionId: string
  readonly createdAt: number
  /**
   * Last time the window that owns this session said it was still running.
   * `null` on a token written before the field existed, which reads as "not
   * live" — the safe answer, since it only ever costs a recovery prompt.
   *
   * Still `v: 1`: the field is optional on read and every reader builds the
   * token field by field, so a 1.0 reader ignores it rather than choking.
   */
  readonly heartbeatAt: number | null
  readonly repoRoot: string
  readonly stage: IsolationStage
  readonly entry: ReviewTarget
  readonly headBefore: HeadPosition
  /**
   * Owner written to `refs/tabthrough/lock` — the `sessionId`, so the
   * compare-and-swap release cannot clobber another window (see `refs.ts`).
   */
  readonly lockValue: string | null
  readonly afterRef: string
  readonly afterCommit: string | null
  /** Tree of the after-commit. Restore verification recomputes and compares it. */
  readonly afterTree: string | null
  /** sha256 of the pre-stash `status --porcelain=v2 -z`, so the index split is verifiable. */
  readonly statusDigest: string | null
  readonly backupRef: string | null
  readonly backupCommit: string | null
  readonly stashMessage: string | null
  readonly checkedOut: string | null
  /**
   * Session contract. Additive on `v: 1`: readers that predate the field treat
   * a missing value as `readonly`.
   */
  readonly mode: SessionMode
  /** Last successfully applied step index; `-1` means none. Missing → `-1`. */
  readonly appliedIndex: number
  /** `refs/tabthrough/applied/<id>`, apply mode only. */
  readonly appliedRef: string | null
}

/** Persistence seam. `StorePort` in the model is this interface. */
export interface TokenStore {
  readToken: (repoRoot: string) => Promise<SessionToken | null>
  writeToken: (token: SessionToken) => Promise<void>
  clearToken: (repoRoot: string) => Promise<void>
}

/**
 * Collapse the path forms git, VS Code, and Node disagree about into one key:
 * macOS `/var` ↔ `/private/var`, Windows drive-letter case, trailing slashes,
 * and backslashes. Used for the journal key and for every `repoRoot` we persist.
 */
export function canonicalizeRepoRoot(repoRoot: string): string {
  let resolved = repoRoot
  try {
    resolved = realpathSync(repoRoot)
  }
  catch {
    // The path may not exist yet in a unit fixture; still normalize the spelling.
  }
  let normalized = resolved.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:\//i.test(normalized))
    normalized = normalized[0]!.toLowerCase() + normalized.slice(1)
  return normalized
}

/**
 * Key the token is stored under. A hash of the repo root rather than the path
 * itself, so a second window on the same repository finds the same entry and
 * the key is safe in a flat `globalState` namespace.
 */
export function repoKey(repoRoot: string): string {
  return createHash('sha256').update(canonicalizeRepoRoot(repoRoot)).digest('hex').slice(0, 32)
}

export function stashMessageFor(sessionId: string): string {
  return `tabthrough:${sessionId}`
}

export function withStage(token: SessionToken, stage: IsolationStage): SessionToken {
  if (token.stage === stage)
    return token
  if (!LEGAL_STAGES[token.stage].includes(stage))
    throw new IllegalStageError(token.stage, stage)
  return { ...token, stage }
}

/** Persists the next stage *before* its operation runs. */
export async function advanceStage(
  store: TokenStore,
  token: SessionToken,
  stage: IsolationStage,
): Promise<SessionToken> {
  const next = withStage(token, stage)
  await store.writeToken(next)
  return next
}

/** Persists a token whose payload changed but whose stage did not. */
export async function persistToken(store: TokenStore, token: SessionToken): Promise<SessionToken> {
  await store.writeToken(token)
  return token
}

/**
 * A token worth offering crash recovery for: something was mutated and not yet
 * undone. `done-kept` is terminal after Apply Finish — Start may proceed; refs
 * stay until explicit cleanup (ADR 0004 D6 / R-apply-3).
 */
export function isRecoverable(token: SessionToken | null): token is SessionToken {
  return token !== null
    && token.stage !== 'planned'
    && token.stage !== 'done'
    && token.stage !== 'done-kept'
}

/** How long a heartbeat is trusted before the window behind it counts as gone. */
export const HEARTBEAT_STALE_MS = 30_000

/**
 * "Owned by a window that is still running", as opposed to
 * {@link isRecoverable}'s "something was mutated and not yet undone". From git
 * state alone a crashed session and a live one in another window are
 * indistinguishable, which is the whole reason the owning window stamps the
 * token while it holds the working tree.
 *
 * The age is absolute on purpose. A heartbeat from the future can only come
 * from a clock jump, and reading that as fresh would suppress recovery until
 * the wall clock caught up — the one failure this subsystem exists to prevent.
 */
export function isSessionLive(token: SessionToken | null, now: number): boolean {
  if (!isRecoverable(token) || token.heartbeatAt === null)
    return false
  return Math.abs(now - token.heartbeatAt) < HEARTBEAT_STALE_MS
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function asString(input: unknown): string | null {
  return typeof input === 'string' ? input : null
}

function asNullableString(input: unknown): string | null {
  return typeof input === 'string' ? input : null
}

function parseEntry(input: unknown): ReviewTarget | null {
  if (!isRecord(input))
    return null
  if (input.kind === 'workingTree')
    return { kind: 'workingTree' }
  if (input.kind === 'commit' && typeof input.rev === 'string')
    return { kind: 'commit', rev: input.rev }
  if (input.kind === 'range' && typeof input.from === 'string' && typeof input.to === 'string')
    return { kind: 'range', from: input.from, to: input.to }
  return null
}

function parseHead(input: unknown): HeadPosition | null {
  if (!isRecord(input))
    return null
  if (input.kind === 'branch' && typeof input.name === 'string')
    return { kind: 'branch', name: input.name }
  if (input.kind === 'detached' && typeof input.sha === 'string')
    return { kind: 'detached', sha: input.sha }
  return null
}

/**
 * Total validator for whatever `globalState` hands back. A malformed token is
 * reported as absent rather than crashing activation — but it is never
 * deleted*, because the refs it points at may still hold the user's work.
 */
export function parseToken(input: unknown): SessionToken | null {
  if (!isRecord(input) || input.v !== 1)
    return null

  const sessionId = asString(input.sessionId)
  const repoRoot = asString(input.repoRoot)
  const afterRef = asString(input.afterRef)
  const stage = asString(input.stage)
  const entry = parseEntry(input.entry)
  const headBefore = parseHead(input.headBefore)

  if (sessionId === null || repoRoot === null || afterRef === null || entry === null || headBefore === null)
    return null
  if (stage === null || !ISOLATION_STAGES.includes(stage as IsolationStage))
    return null

  const mode = input.mode === 'apply' || input.mode === 'readonly' ? input.mode : 'readonly'
  const appliedIndex = typeof input.appliedIndex === 'number' && Number.isFinite(input.appliedIndex)
    ? Math.trunc(input.appliedIndex)
    : -1

  return {
    v: 1,
    sessionId,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : 0,
    heartbeatAt: typeof input.heartbeatAt === 'number' ? input.heartbeatAt : null,
    repoRoot,
    stage: stage as IsolationStage,
    entry,
    headBefore,
    lockValue: asNullableString(input.lockValue),
    afterRef,
    afterCommit: asNullableString(input.afterCommit),
    afterTree: asNullableString(input.afterTree),
    statusDigest: asNullableString(input.statusDigest),
    backupRef: asNullableString(input.backupRef),
    backupCommit: asNullableString(input.backupCommit),
    stashMessage: asNullableString(input.stashMessage),
    checkedOut: asNullableString(input.checkedOut),
    mode,
    appliedIndex,
    appliedRef: asNullableString(input.appliedRef),
  }
}
