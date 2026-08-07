# Guide Reviewer — Reatom Session Model

**Version:** 1.0 (MVP / v0.1)
**Owner:** Architect
**Status:** Proposed for implementation
**Target:** `@reatom/core@1001`
**Last updated:** 2026-08-07
**Companions:** [overview.md](overview.md) · [guide-schema.md](guide-schema.md) · [ADR 0002](../decisions/0002-architecture.md)
**Unblocks:** plan P0-8

> Read `.agents/skills/reatom/SKILL.md` and `.agents/skills/reatom-async/SKILL.md` before touching this model. Everything below follows those defaults; where this document is more specific, the reason is stated.

---

## 1. Conventions

| Rule | Applied here |
|------|--------------|
| Everything is named | Every `atom` / `computed` / `action` / `effect` takes a name as its last argument |
| Names mirror structure | `git.capability`, `session.start`, `session#a1b2c3.cursor`, `session#a1b2c3.file#src/api.ts.revealText` |
| Dynamic instances use `#id` | `session#<sessionId>`, `…file#<path>` |
| Factories use the `reatom*` prefix | `reatomSession`, `reatomReviewFile` |
| Reads are zero-arg calls, writes are `.set(...)` | `cursor()` / `cursor.set(3)` |
| No identity actions | The bridge writes `gitWatchToken.set(v => v + 1)` directly — there is no `bumpWatchToken` action |
| Queries are `computed` + `withAsyncData` | `git.capability`, `git.repoStatus`, `…baseText`, `recovery.token` |
| Mutations are `action` + `withAsync` | `session.start`, `session.finish`, `session.cancel`, `recovery.restore` |
| Every async boundary uses `wrap` | §7 |
| Immutable data stays plain | `Guide`, `GuideStep`, `DiffFile`, `LineGroup` are frozen values; only live state is atoms |

**Atomization boundary.** Reatom's rule is "mutable properties → atoms, readonly properties → primitives". A session's *plan* is plain data computed once (entry, base and after revisions, parsed diff, merged guide); its *live state* is atoms (`sessionStatus`, `cursor`, per-file async base text). Individual steps are deliberately **not** atomized: a step is immutable, and revealing is a cursor move, not a per-step mutation.

---

## 2. Model map

```
workspaceRoot                atom<string | null>
ports                        atom<Ports>                         installed once at activation
config.showRationale         atom<boolean>                       mirrored from VS Code settings
config.heuristicOptions      atom<HeuristicOptions>
config.guideFile             atom<string>
config.revealMode            atom<'progressive' | 'dim'>

git.watchToken               atom<number>                        bumped by the bridge's FS watcher
git.capability               computed + withAsyncData            repo? git? shallow? mid-rebase?
git.repoStatus               computed + withAsyncData            porcelain=v2, refreshed by watchToken

recovery.epoch               atom<number>
recovery.token               computed + withAsyncData            persisted SessionToken via StorePort
recovery.pending             computed<boolean>
recovery.orphanRefs          computed + withAsyncData            refs/guide-reviewer/** with no token
recovery.restore             action + withAsync({status}) + withAbort('first-in-win')
recovery.discard             action + withAsync

preflight.request            atom<PreflightRequest | null>
preflight.answer             action<(approved: boolean) => boolean>

session.status               atom<SessionStatus>                 the single state machine
session.status.to            action                              the ONLY writer; validates transitions
session                      atom<Session | null>
session.isolation            atom<IsolationHandle | null>        survives a failed start, for unwind
session.diagnostics          atom<readonly GuideDiagnostic[]>
session.isActive             computed<boolean>
session.start                action + withAsync({status}) + withAbort('first-in-win')
session.finish               action + withAsync({status}) + withAbort('first-in-win')
session.cancel               action + withAsync({status}) + withAbort('first-in-win')
session.teardown             action + withAsync                  internal; never aborted mid-git
session.failed               action + withAsync                  internal; unwinds isolation

ui.gitUsable                 computed<boolean>
ui.canStart                  computed<boolean>
ui.statusText                computed<string | null>
ui.statusTooltip             computed<string | null>
ui.reviewViewModel           computed<ReviewViewModel | null>    the bridge's single subscription

— per session instance (reatomSession) —
session#<id>.cursor          atom<number>                        -1 = nothing revealed
session#<id>.currentStep     computed<GuideStep | null>
session#<id>.nextStep        computed<GuideStep | null>
session#<id>.progress        computed<{ index, total }>
session#<id>.canAdvance      computed<boolean>
session#<id>.canRetreat      computed<boolean>
session#<id>.isComplete      computed<boolean>
session#<id>.activeFile      computed<ReviewFile | null>
session#<id>.next            action
session#<id>.prev            action
session#<id>.jumpTo          action
session#<id>.trace           effect                              inside withConnectHook; dev tracing

— per file (reatomReviewFile) —
…file#<path>.baseText        computed + withAsyncData            git cat-file blob <base>:<path>
…file#<path>.revealedGroups  computed<readonly LineGroup[]>
…file#<path>.render          computed<RevealRender | null>       pure fold: base + revealed groups
…file#<path>.revealText      computed<string | null>
…file#<path>.currentRanges   computed<readonly LineRange[]>      for decorations
```

---

## 3. Root atoms and probes

```ts
// src/model/session.ts
import {
  abortVar, action, atom, computed, peek, withAbort, withAsync, withAsyncData, wrap,
} from '@reatom/core'
import { probeGit, readStatus } from '../git/probe'
import type { GitCapability, RepoStatus } from '../git/probe'
import type { Ports } from './ports'

/** Set by the bridge at activation. MVP: first workspace folder (P2: multi-root). */
export const workspaceRoot = atom<string | null>(null, 'workspaceRoot')

/** Injected VS Code capabilities. Tests substitute in-memory implementations. */
export const ports = atom<Ports>(inertPorts, 'ports')

/** Bumped by the bridge's FileSystemWatcher on `.git/**` and workspace writes. */
export const gitWatchToken = atom(0, 'git.watchToken')

export const gitCapability = computed(async (): Promise<GitCapability | null> => {
  const root = workspaceRoot()
  if (!root)
    return { ok: false, reason: 'no-workspace', message: 'Open a folder to use Guide Reviewer.' }

  return await wrap(probeGit(root, { signal: abortVar.require().signal }))
}, 'git.capability').extend(withAsyncData({ initState: null }))

export const repoStatus = computed(async (): Promise<RepoStatus | null> => {
  // Hoist every reactive read above the first await — rule W5 in §7.
  const capabilityPromise = gitCapability()
  gitWatchToken()

  const capability = await wrap(capabilityPromise)
  if (!capability?.ok)
    return null

  return await wrap(readStatus(capability.repoRoot, { signal: abortVar.require().signal }))
}, 'git.repoStatus').extend(withAsyncData({ initState: null }))
```

- `withAsyncData` already includes `withAbort()`, so `abortVar.require()` is available and a stale probe is cancelled the instant its dependencies change. The subprocess dies with it, because `git/exec.ts` forwards the signal.
- `git.repoStatus` refetches **reactively**: the bridge never calls a refresh function, it writes `gitWatchToken.set(v => v + 1)`. That difference — dependency-driven refresh versus an imperative `refresh()` method — is the whole reason for using Reatom here.
- Neither probe takes a write lock (`GIT_OPTIONAL_LOCKS=0`), so background polling can never collide with the user's own git commands.

---

## 4. The state machine

The plan requires that status transitions be centralised in one action and that illegal transitions be rejected rather than silently applied. That rules out `reatomEnum` for this particular atom: its generated `setActive()` / `setIdle()` actions would be a second, unguarded write path — exactly the drift the single-source-of-truth rule exists to prevent. A plain atom with one guarded action is the right trade here.

```ts
// src/model/session.ts
export type SessionStatus =
  | 'idle'        // no session; commands available
  | 'preflight'   // summary shown, waiting for the user; nothing touched yet
  | 'stashing'    // isolation in progress; the tree may be mid-change
  | 'active'      // reviewing
  | 'restoring'   // restore in flight
  | 'blocked'     // restore could not be verified; everything preserved, user must act
  | 'error'       // start failed and was unwound

const LEGAL: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: ['preflight'],
  preflight: ['stashing', 'idle', 'error'],
  stashing: ['active', 'restoring', 'error'],
  active: ['restoring'],
  restoring: ['idle', 'blocked'],
  blocked: ['restoring', 'idle'],
  error: ['idle'],
}

export const sessionStatus = atom<SessionStatus>('idle', 'session.status').extend(target => ({
  to: action((next: SessionStatus) => {
    const current = target()
    if (current === next)
      return current
    if (!LEGAL[current].includes(next))
      throw new IllegalTransitionError(current, next)
    target.set(next)
    return next
  }, 'session.status.to'),
}))

export const isSessionActive = computed(() => sessionStatus() === 'active', 'session.isActive')
```

Everything else writes status only through `sessionStatus.to(...)`. The transition table is a fixture the tests enumerate directly (plan Phase 1 gate: "legal + illegal pairs").

---

## 5. The session instance

```ts
// src/model/steps.ts
import { abortVar, action, atom, computed, effect, ifChanged, log, withAsyncData, withConnectHook, wrap } from '@reatom/core'
import { renderReveal } from '../guide/render'
import { showBlob } from '../git/diff'

export interface SessionInit {
  readonly id: string
  readonly repoRoot: string
  readonly entry: ReviewTarget
  readonly baseRev: string        // immutable commit
  readonly afterRev: string       // immutable commit (a real commit, or refs/guide-reviewer/after/<id>)
  readonly handle: IsolationHandle
  readonly diff: ReviewDiff
  readonly guide: Guide           // frozen; never mutated after construction
}

export function reatomSession(init: SessionInit) {
  const name = `session#${init.id}`
  const steps = init.guide.steps

  /** -1 means "nothing revealed yet". */
  const cursor = atom(-1, `${name}.cursor`)

  const currentStep = computed(() => steps[cursor()] ?? null, `${name}.currentStep`)
  const nextStep = computed(() => steps[cursor() + 1] ?? null, `${name}.nextStep`)
  const canAdvance = computed(() => cursor() < steps.length - 1, `${name}.canAdvance`)
  const canRetreat = computed(() => cursor() >= 0, `${name}.canRetreat`)
  const isComplete = computed(() => cursor() >= steps.length - 1, `${name}.isComplete`)
  const progress = computed(
    () => ({ index: Math.max(0, cursor() + 1), total: steps.length }),
    `${name}.progress`,
  )

  // One model per changed file. A plain array: the file set is fixed for the session.
  const files: readonly ReviewFile[] = init.diff.files.map(file =>
    reatomReviewFile(file, { name, cursor, currentStep, steps, repoRoot: init.repoRoot, baseRev: init.baseRev }),
  )
  const fileByPath = new Map(files.map(entry => [entry.path, entry]))

  const activeFile = computed(() => {
    const step = currentStep()
    return step ? fileByPath.get(step.path) ?? null : null
  }, `${name}.activeFile`)

  const next = action(() => {
    if (!canAdvance())
      return false
    cursor.set(index => index + 1)
    return true
  }, `${name}.next`)

  const prev = action(() => {
    if (!canRetreat())
      return false
    cursor.set(index => index - 1)
    return true
  }, `${name}.prev`)

  const jumpTo = action((index: number) => {
    cursor.set(Math.min(Math.max(index, -1), steps.length - 1))
  }, `${name}.jumpTo`)

  /**
   * Dev tracing. Created inside a connect hook, so it is aborted automatically when the
   * session model loses its subscriber — no module-scope effect, no manual disposal.
   */
  const trace = atom(null, `${name}.trace`).extend(
    withConnectHook(() => {
      effect(() => {
        ifChanged(cursor, index => log.state(`${name}.cursor`, index))
      }, `${name}.trace.effect`)
    }),
  )

  return {
    id: init.id, entry: init.entry, baseRev: init.baseRev, afterRev: init.afterRev,
    handle: init.handle, guide: init.guide, files, fileByPath,
    cursor, currentStep, nextStep, canAdvance, canRetreat, isComplete, progress, activeFile, trace,
    next, prev, jumpTo,
  }
}
export type Session = ReturnType<typeof reatomSession>
```

Advance and retreat are **pure state movement** — no I/O, no `async`, no `withAsync`. The revealed set is `steps[0..cursor]` by construction, which makes Shift+Tab correct by construction too.

### 5.1 Per-file reveal

```ts
function reatomReviewFile(file: DiffFile, ctx: ReviewFileCtx) {
  const name = `${ctx.name}.file#${file.path}`

  // Pure precomputation: which steps touch this file, in order. No reactivity needed.
  const ownSteps = ctx.steps
    .map((step, index) => ({ index, step }))
    .filter(entry => entry.step.path === file.path)

  const baseText = computed(async (): Promise<string> => {
    if (file.isBinary || file.status === 'added')
      return ''

    return await wrap(showBlob(ctx.repoRoot, ctx.baseRev, file.oldPath ?? file.path, {
      signal: abortVar.require().signal,
    }))
  }, `${name}.baseText`).extend(withAsyncData({ initState: null as string | null }))

  const revealedGroups = computed((): readonly LineGroup[] => {
    const upTo = ctx.cursor()
    const out: LineGroup[] = []
    for (const entry of ownSteps) {
      if (entry.index > upTo)
        break
      out.push(...entry.step.groups)
    }
    return out
  }, `${name}.revealedGroups`)

  /** The pure fold. Produces document text plus the range of every revealed group. */
  const render = computed((): RevealRender | null => {
    const base = baseText.data()
    if (base === null)
      return null
    return renderReveal(base, file, revealedGroups())
  }, `${name}.render`)

  const revealText = computed(() => render()?.text ?? null, `${name}.revealText`)

  const currentRanges = computed((): readonly LineRange[] => {
    const snapshot = render()
    const step = ctx.currentStep()
    if (!snapshot || !step || step.path !== file.path)
      return []
    return step.groups
      .map(group => snapshot.groupRanges.get(group.id))
      .filter((range): range is LineRange => range !== undefined)
  }, `${name}.currentRanges`)

  return { path: file.path, file, baseText, revealedGroups, render, revealText, currentRanges }
}
export type ReviewFile = ReturnType<typeof reatomReviewFile>
```

Three properties make Tab feel instant:

1. `revealText` is a **pure fold over immutable data** — nothing on the Tab path does I/O.
2. `baseText` is fetched **lazily, once per file**, triggered by connection (reading `.data()` from a connected computed) and cached by `withAsyncData`.
3. The bridge subscribes to `ui.reviewViewModel`, which also reads the *next* step's file base text (§6). Connection starts that fetch, so the next file is warm before the cursor arrives. No prefetch scheduler, no imperative cache — the dependency graph does it.

---

## 6. Lifecycle actions

```ts
// src/model/session.ts
export const session = atom<Session | null>(null, 'session')
export const isolation = atom<IsolationHandle | null>(null, 'session.isolation')
export const guideDiagnostics = atom<readonly GuideDiagnostic[]>([], 'session.diagnostics')

export const preflightRequest = atom<PreflightRequest | null>(null, 'preflight.request')
export const preflightAnswer = action((approved: boolean) => approved, 'preflight.answer')
```

### 6.1 Start

```ts
export const startSession = action(async (request: StartRequest): Promise<Session> => {
  // Attach failure handling once, at the top; the happy path below stays flat.
  framePromise().catch(error => startFailed(error))

  if (peek(sessionStatus) !== 'idle')
    throw new SessionAlreadyActiveError(peek(sessionStatus))
  if (peek(recoveryPending))
    throw new RecoveryPendingError()

  const capability = await wrap(gitCapability())
  if (!capability?.ok)
    throw new GitUnavailableError(capability)

  const { repoRoot } = capability
  const signal = abortVar.require().signal

  sessionStatus.to('preflight')

  // Stat-only pass: resolves base/after and counts changed lines. Touches nothing.
  const plan = await wrap(planIsolation(repoRoot, request, { signal }))
  if (plan.changedLineCount === 0)
    throw new EmptyDiffError(plan)

  // Confirmation as a reactive event rather than a callback: the bridge renders
  // `preflight.request` as a modal and calls `preflight.answer`. Declining aborts the
  // whole frame, so nothing below runs and there is nothing to unwind.
  preflightRequest.set(plan.preflight)
  await wrap(take(preflightAnswer, approved => approved || throwAbort(), 'preflightApproval'))
  preflightRequest.set(null)

  sessionStatus.to('stashing')
  const id = peek(ports).clock.sessionId()

  // From here the working tree can change. `isolate` acquires the lock ref, captures
  // before it mutates, and journals before each step (overview §3.5). It publishes its
  // handle immediately so any later failure can still unwind.
  const handle = await wrap(isolate({ repoRoot, plan, id, store: peek(ports).store, signal }))
  isolation.set(handle)

  const raw = await wrap(readDiff(repoRoot, handle.baseRev, handle.afterRev, { signal }))
  const sidecarRaw = await wrap(readSidecar(repoRoot, handle.baseRev, peek(guideFile), { signal }))

  // Pure and synchronous. Nothing leaves the frame, so nothing needs wrapping.
  const diff = parseUnifiedDiff(raw.patch, raw.nameStatus)
  const heuristic = buildHeuristicGuide(diff, peek(heuristicOptions))
  const sidecar = sidecarRaw ? validateGuideDoc(sidecarRaw) : undefined
  const merged = mergeGuide({ diff, heuristic, sidecar: sidecar?.ok ? sidecar.value : undefined })

  const model = reatomSession({
    id, repoRoot, entry: request.entry,
    baseRev: handle.baseRev, afterRev: handle.afterRev,
    handle, diff, guide: merged.guide,
  })

  guideDiagnostics.set([...merged.diagnostics, ...(sidecar?.ok === false ? sidecar.errors : [])])
  session.set(model)
  sessionStatus.to('active')
  model.next()
  return model
}, 'session.start').extend(withAsync({ status: true }), withAbort('first-in-win'))
```

Why `withAbort('first-in-win')`: a double-invoked command (palette plus keybinding, or an impatient user) must not start two isolations. The first call runs to completion; the second is aborted at its call site. The explicit `SessionAlreadyActiveError` covers the different case of starting while a previous session is open — that one deserves a real message, not a silent no-op. Both together answer P0-7 in-window; the repo-level lock ref (overview §10.2) covers the cross-window case.

Why `{ status: true }`: the bridge drives a progress notification from `startSession.status()`, and the async skill requires opting in. We deliberately do **not** enable `cacheParams`: `startSession.retry()` would be meaningless, because a retry must re-run pre-flight.

### 6.2 Failure unwind

```ts
const startFailed = action(async (error: unknown) => {
  const handle = peek(isolation)
  if (handle) {
    sessionStatus.to('restoring')
    // No signal — see §8.
    await wrap(restore(handle, { store: peek(ports).store }))
    isolation.set(null)
  }
  session.set(null)
  preflightRequest.set(null)
  sessionStatus.to(peek(sessionStatus) === 'restoring' ? 'idle' : 'error')
  sessionStatus.to('idle')

  // Aborts are a user choice (declined pre-flight, superseded call), not a business error.
  if (!isAbortError(error))
    await wrap(peek(ports).ui.notify('error', describeStartFailure(error)))
}, 'session.failed').extend(withAsync())
```

### 6.3 Finish, Cancel, teardown

```ts
export const finishSession = action(async () => {
  if (peek(sessionStatus) !== 'active')
    return
  await wrap(teardownSession({ reason: 'finish' }))
}, 'session.finish').extend(withAsync({ status: true }), withAbort('first-in-win'))

export const cancelSession = action(async (reason: CancelReason = 'cancel') => {
  if (peek(sessionStatus) === 'idle')
    return
  await wrap(teardownSession({ reason }))
}, 'session.cancel').extend(withAsync({ status: true }), withAbort('first-in-win'))

const teardownSession = action(async ({ reason }: { reason: CancelReason }) => {
  const handle = peek(isolation)
  if (!handle) {
    session.set(null)
    sessionStatus.to('idle')
    return
  }

  sessionStatus.to('restoring')

  // No `signal` on purpose: `git stash apply` must never be cancelled halfway.
  const outcome = await wrap(restore(handle, { store: peek(ports).store }))

  if (outcome.kind === 'restored') {
    isolation.set(null)
    session.set(null)
    sessionStatus.to('idle')
    await wrap(peek(ports).ui.notify('info', describeRestore(outcome, reason)))
    return
  }

  // Conflict or verification mismatch: keep everything. Stash entry, both refs, the lock
  // and the token all stay, so the user — or the next activation — can finish the job.
  sessionStatus.to('blocked')
  await wrap(peek(ports).ui.notify(
    'warn',
    describeRestoreBlocked(outcome),
    ['Open merge editor', 'Show recovery commands'],
  ))
}, 'session.teardown').extend(withAsync())
```

`cancelSession` intentionally still works when `session()` is `null` but `isolation()` is not — that is the shape of a mid-start failure and of a post-crash resume.

Cancel is **not** a discard. It runs exactly the same restore as Finish; the only difference is the message.

### 6.4 Recovery

```ts
export const recoveryEpoch = atom(0, 'recovery.epoch')

export const recoveryToken = computed(async (): Promise<SessionToken | null> => {
  const store = ports().store
  const root = workspaceRoot()
  recoveryEpoch()
  if (!root)
    return null
  return await wrap(store.readToken(root))
}, 'recovery.token').extend(withAsyncData({ initState: null }))

export const recoveryPending = computed(() => {
  const token = recoveryToken.data()
  return token !== null && token.stage !== 'planned' && token.stage !== 'done'
}, 'recovery.pending')

export const recoverBackup = action(async () => {
  const token = await wrap(recoveryToken())
  if (!token)
    return
  const outcome = await wrap(restoreFromToken(token, { store: peek(ports).store }))
  recoveryEpoch.set(value => value + 1)
  await wrap(peek(ports).ui.notify(
    outcome.kind === 'restored' ? 'info' : 'warn',
    describeRecovery(outcome),
  ))
}, 'recovery.restore').extend(withAsync({ status: true }), withAbort('first-in-win'))

export const discardRecovery = action(async () => {
  const token = await wrap(recoveryToken())
  if (!token)
    return
  const confirmed = await wrap(peek(ports).ui.confirm(discardWarning(token)))
  if (!confirmed)
    return
  // Clears the journal only. Refs and stash entries are intentionally left in git.
  await wrap(peek(ports).store.clearToken(token.repoRoot))
  recoveryEpoch.set(value => value + 1)
}, 'recovery.discard').extend(withAsync())
```

`discardRecovery` forgets a reminder; it never destroys a backup. Deleting refs is a separate, explicitly named command.

### 6.5 Gating

```ts
export const gitUsable = computed(() => gitCapability.data()?.ok === true, 'ui.gitUsable')
export const canStart = computed(
  () => gitUsable() && !recoveryPending() && sessionStatus() === 'idle',
  'ui.canStart',
)
```

The bridge mirrors both into `when`-clause context keys, so Start is *disabled with a reason* rather than failing after the user clicks it (plan P0-1 exit criterion).

---

## 7. The bridge's single view model

```ts
// src/model/view.ts
export const statusText = computed(() => {
  const model = session()
  if (!model)
    return null

  const { index, total } = model.progress()
  const step = model.currentStep()
  const parts = [`$(book) Step ${index}/${total}`]
  if (step)
    parts.push(basename(step.path))
  if (showRationale() && step?.rationale)
    parts.push(step.rationale)
  return parts.join(' · ')
}, 'ui.statusText')

export const reviewViewModel = computed((): ReviewViewModel | null => {
  const model = session()
  if (!model)
    return null

  const active = model.activeFile()
  const upcoming = model.nextStep()

  // Touching the next file's base text keeps it connected, which starts its fetch now.
  // Lookahead warming with zero imperative scheduling.
  if (upcoming)
    model.fileByPath.get(upcoming.path)?.baseText.data()

  return {
    sessionId: model.id,
    progress: model.progress(),
    step: model.currentStep(),
    activePath: active?.path ?? null,
    text: active?.revealText() ?? null,
    ranges: active?.currentRanges() ?? [],
    complete: model.isComplete(),
  }
}, 'ui.reviewViewModel')
```

One computed, one subscription, one place where connection lifetime is owned.

---

## 8. `wrap` discipline

The rules, paired with the mistakes actually likely in this codebase.

| # | Rule | Bad | Good |
|---|------|-----|------|
| W1 | Every promise crossing out of a frame | `const out = await execGit(args)` then `atom.set(out)` | `const out = await wrap(execGit(args))` |
| W2 | Every external callback that touches the model | `useCommand('gr.next', () => session()?.next())` | `useCommand('gr.next', wrap(() => peek(session)?.next()))` |
| W3 | Do not chain after `wrap` | `await wrap(readFile(p)).then(JSON.parse)` | `await wrap(readFile(p).then(JSON.parse))` |
| W4 | Do not wrap inside Reatom hooks | `withCallHook(wrap(() => …))` | `withCallHook(() => …)` |
| W5 | Hoist reactive reads above the first `await` | `const c = await wrap(cap()); token()` | `const p = cap(); token(); const c = await wrap(p)` |
| W6 | Do not wrap synchronous writes already inside a frame | `wrap(() => cursor.set(1))` | `cursor.set(1)` |
| W7 | `take` / `onEvent` return promises | `take(preflightAnswer)` | `await wrap(take(preflightAnswer, …))` |

W5 deserves emphasis. Dependency tracking happens during the *synchronous* portion of a computed body; an atom read placed after an `await` is not tracked, and the computed silently stops updating. `git.repoStatus` is the live case — `gitWatchToken()` must be read before awaiting the capability probe. This is the single most likely subtle bug in the whole model, and it fails silently, which is why it gets its own review-checklist line.

---

## 9. Cancellation policy

| Target | Extension | Signal passed to git | Why |
|--------|-----------|---------------------|-----|
| `git.capability`, `git.repoStatus`, `…baseText`, `recovery.token`, `recovery.orphanRefs` | `withAsyncData` (includes `withAbort`) | yes | Stale probes should die; they only read |
| `session.start` | `withAsync({status:true})`, `withAbort('first-in-win')` | yes, through `isolate` | An abort during isolation triggers `startFailed`, which restores |
| `session.finish`, `session.cancel`, `recovery.restore` | `withAsync({status:true})`, `withAbort('first-in-win')` | **no** | A second cancel must be ignored, never allowed to interrupt the first restore |
| `session.teardown`, `session.failed` | `withAsync()` | **no** | Restore is atomic from the user's point of view |
| `session#….next / .prev / .jumpTo` | none (synchronous) | n/a | Pure state movement |

Corollaries the Reviewer should check:

- Every `withAsync` has a row in this table.
- Abort errors are never rendered as failures (the `isAbortError` guard in `startFailed`).
- `.status()` is read only on actions that opted in with `{ status: true }`.
- No `.retry()` on actions — none set `cacheParams: true`, and none should: retrying a git mutation with stale parameters is the bug class we are avoiding. `recoveryToken.retry()` is fine, because computed retry needs no parameter cache.
- `withCache()` is unused; if it ever appears, it must come *after* `withAsyncData()`.

---

## 10. Binding to reactive-vscode

`reactive-vscode` owns VS Code lifetimes and disposal; Reatom owns state. The seam is one small adapter plus `wrap` on every callback.

```ts
// src/ui/binding.ts
import type { Atom } from '@reatom/core'
import { peek } from '@reatom/core'
import { type ShallowRef, shallowRef, useDisposable } from 'reactive-vscode'
import { logger } from '../utils'

/** Project a Reatom atom into a reactive-vscode ref, disposed with the current scope. */
export function useAtomRef<T>(target: Atom<T>): ShallowRef<T> {
  const state = shallowRef(peek(target)) as ShallowRef<T>
  const unsubscribe = target.subscribe(
    value => { state.value = value },
    error => logger.error(`[${target.name}]`, error),
  )
  useDisposable({ dispose: unsubscribe })
  return state
}
```

The error listener is not optional: an async computed that rejects — a failing `git cat-file`, say — must land in the output channel rather than becoming an unhandled rejection.

### 10.1 Extension entry and disposal order

```ts
// src/index.ts
import { connectLogger } from '@reatom/core'
import { defineExtension } from 'reactive-vscode'

const { activate, deactivate: disposeScope } = defineExtension(() => {
  if (process.env.NODE_ENV === 'development')
    connectLogger()

  installPorts()          // ports.set({ store, ui, clock })
  bindWorkspaceRoot()     // workspaceRoot.set(folders[0]?.uri.fsPath ?? null)
  bindConfig()            // settings -> atoms, one way
  bindGitWatcher()        // .git/** changes -> gitWatchToken.set(v => v + 1)

  useReviewDocuments()
  useGuideCommands()
  useGuideStatusBar()
  useGuideDecorations()
  useGuideContextKeys()

  void checkRecoveryOnActivate()
})

export { activate }

export async function deactivate() {
  // Ordering is load-bearing: drain the restore BEFORE disposing the scope, because
  // disposal unsubscribes the Reatom projections. A truncated deactivate is safe —
  // the journal on disk is what the next activation reads.
  await Promise.race([cancelSession('deactivate'), sleep(4000)])
  disposeScope?.()
}
```

There is **no Reatom scope to create.** Atoms are module-level and live in the implicit global context; `context.start` is for tests and SSR, not for application bootstrapping. And `context.reset()` must never be called in production — the reference states it rejects wrapped promises with abort errors, which during an in-flight restore is precisely the outcome the whole safety design exists to prevent.

Raw `Promise.race` is acceptable here (rather than Reatom's `race`) because there is no loser to clean up: the process is exiting, and the journal covers the truncated case.

### 10.2 Commands

```ts
// src/commands/index.ts
import { peek, wrap } from '@reatom/core'
import { useCommands } from 'reactive-vscode'

export function useGuideCommands() {
  useCommands({
    'guide-reviewer.start': wrap(async () => {
      const entry = await wrap(pickWorkingTreeEntry())
      if (entry)
        await wrap(startSession({ entry }))
    }),
    'guide-reviewer.startFromCommit': wrap(async () => {
      const entry = await wrap(pickCommit())
      if (entry)
        await wrap(startSession({ entry }))
    }),
    'guide-reviewer.startFromRange': wrap(async () => {
      const entry = await wrap(promptRange())
      if (entry)
        await wrap(startSession({ entry }))
    }),
    'guide-reviewer.next': wrap(() => { peek(session)?.next() }),
    'guide-reviewer.previous': wrap(() => { peek(session)?.prev() }),
    'guide-reviewer.finish': wrap(() => finishSession()),
    'guide-reviewer.cancel': wrap(() => cancelSession('cancel')),
    'guide-reviewer.restoreBackup': wrap(() => recoverBackup()),
  })
}
```

Handlers read with `peek` (a snapshot read, no accidental subscription) and write only by calling actions. There is no branching logic here — every decision lives in the model, which is exactly why the model is testable without an extension host.

### 10.3 Status bar, context keys, decorations

```ts
export function useGuideStatusBar() {
  const text = useAtomRef(statusText)
  const tooltip = useAtomRef(statusTooltip)

  useStatusBarItem({
    id: 'guideReviewer.session',
    alignment: StatusBarAlignment.Left,
    priority: 100,
    text: () => text.value ?? '',
    tooltip: () => tooltip.value ?? undefined,
    command: 'guide-reviewer.showStepDetail',
    visible: () => text.value !== null,
  })
}

export function useGuideContextKeys() {
  const usable = useAtomRef(gitUsable)
  const start = useAtomRef(canStart)
  const active = useAtomRef(isSessionActive)
  const recovery = useAtomRef(recoveryPending)
  const editor = useActiveTextEditor()

  useVscodeContext('guideReviewer.gitUsable', () => usable.value)
  useVscodeContext('guideReviewer.canStart', () => start.value)
  useVscodeContext('guideReviewer.sessionActive', () => active.value)
  useVscodeContext('guideReviewer.recoveryPending', () => recovery.value)
  useVscodeContext('guideReviewer.reviewEditorFocused', () => editor.value?.document.uri.scheme === SCHEME)
}

export function useGuideDecorations() {
  const view = useAtomRef(reviewViewModel)
  const editor = useActiveTextEditor()

  useEditorDecorations(
    editor,
    { isWholeLine: true, backgroundColor: new ThemeColor('editor.wordHighlightBackground') },
    () => (editor.value?.document.uri.scheme === SCHEME ? toVsRanges(view.value?.ranges) : []),
  )
}
```

### 10.4 Progressive review documents

```ts
export function useReviewDocuments() {
  const emitter = useDisposable(new EventEmitter<Uri>())
  const cache = new Map<string, string>()      // the only imperative cache; a write-only projection

  useDisposable(workspace.registerTextDocumentContentProvider(SCHEME, {
    onDidChange: emitter.event,
    provideTextDocumentContent: uri => cache.get(uri.toString()) ?? LOADING_PLACEHOLDER,
  }))

  const view = useAtomRef(reviewViewModel)

  watch(view, (next) => {
    if (!next?.activePath || next.text === null)
      return
    const uri = revealUri(next.sessionId, next.activePath)
    const key = uri.toString()
    if (cache.get(key) === next.text)
      return
    cache.set(key, next.text)
    emitter.fire(uri)                          // VS Code re-reads; the native diff re-renders
  }, { immediate: true })
}
```

Base documents are static per `(sessionId, path, baseRev)` and are filled the same way from `baseText.data()`. Opening the pair is `commands.executeCommand('vscode.diff', baseUri, revealUri, title, { preview: false })`.

### 10.5 Settings

```ts
watchEffect(wrap(() => {
  heuristicOptions.set({
    maxLinesPerStep: config.maxLinesPerStep,
    intraHunkGap: 1,
    hideFormattingSteps: config.hideFormattingSteps,
  })
  showRationale.set(config.showRationale)
  guideFile.set(config.guideFile)
  revealMode.set(config.reveal.mode)
}))
```

Settings flow one way, VS Code → atoms. The model never writes settings.

---

## 11. Testing the model

```ts
import { context } from '@reatom/core'

beforeEach(() => context.reset())     // tests only — never in production code

it('refuses a second session', async () => {
  await context.start(async () => {
    ports.set(memoryPorts({ approve: true }))
    workspaceRoot.set(await makeTempRepo({ dirty: true }))

    await startSession({ entry: { kind: 'workingTree' } })
    await expect(startSession({ entry: { kind: 'workingTree' } }))
      .rejects.toThrow(SessionAlreadyActiveError)
  })
})
```

- `context.start` isolates a test; `context.reset` clears the default context between runs.
- `ports` is the injection point. `memoryPorts` supplies a scripted `UiPort` (auto-approve / auto-decline) and an in-memory `StorePort`.
- The **crash matrix** uses a `StorePort` that stops accepting writes after a chosen stage, then re-reads the journal in a fresh context and asserts that `recoverBackup()` restores a byte-identical tree. No process is killed; the journal is the only thing that matters.
- Prefer asserting on `.data()` and settled promises over `.pending()` — the async reference warns that reading `.pending()` in hot tests perturbs scheduling.
- The status transition table is enumerated directly: every legal pair succeeds, every illegal pair throws `IllegalTransitionError`.
- Pure-layer fixture tests create no Reatom context at all.

---

## 12. Anti-pattern checklist (for the Reviewer)

1. Any `let` or module-level `Map` holding session state outside the model — except the reveal document cache in §10.4, which is a write-only projection.
2. An `await` before a reactive read inside a `computed` (rule W5). Fails silently; check every async computed.
3. A VS Code callback that touches Reatom without `wrap`.
4. `effect` at module scope. Effects live inside `withConnectHook` bodies, or are replaced by derived state.
5. A query implemented as an `action` with manual pending flags instead of `computed` + `withAsyncData`.
6. An abort signal threaded into a stash or restore mutation.
7. Business errors and abort errors handled by the same branch.
8. `.status()` or `.retry()` used without the corresponding option.
9. A one-line action that only forwards a value into an atom — write `atom.set(...)`.
10. Any writer of `session.status` other than `sessionStatus.to(...)`.
11. `context.reset()` or `clearStack()` anywhere under `src/`.
12. A command handler that reads model state reactively instead of with `peek`.
