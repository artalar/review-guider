# Tabthrough — Implementation Plan (v0.1 MVP)

**Owner:** Planner
**Status:** Ready for Architect + Implementer
**Last updated:** 2026-08-07
**Scope source of truth:** [ADR 0001](../decisions/0001-mvp-scope.md) · [specs/product.md](../specs/product.md) · [backlog.md](./backlog.md)

> This plan sequences **only P0**. Nothing here adds scope. Where a decision is genuinely open, it is marked **[ARCH]** and handed to the Architect rather than guessed at by the Implementer.

---

## Sequencing principle

```mermaid
flowchart LR
  P0[Phase 0<br/>Toolchain] --> P1[Phase 1<br/>Foundation]
  P1 --> P2[Phase 2<br/>Safety]
  P2 --> P3[Phase 3<br/>Guide engine]
  P2 --> P4[Phase 4<br/>Entry points]
  P3 --> P5[Phase 5<br/>UX loop]
  P4 --> P5
  P5 --> P6[Phase 6<br/>Edge hardening]
```

Safety (Phase 2) precedes everything user-visible. **No phase after 2 may merge while the stash round-trip suite is red.** Phases 3 and 4 are independent of each other and may interleave.

---

## Phase 0 — Toolchain foundation

**Backlog IDs:** none (prerequisite). **Depends on:** nothing.

The template is unmodified and currently does not typecheck: `src/config.ts` and `src/utils.ts` import `./generated/meta`, which does not exist until `vscode-ext-gen` runs. Reatom is not a dependency yet. Fix this before writing feature code so every later phase has a working gate.

### Tasks

| # | Task | Detail |
|---|------|--------|
| 0-a | Install deps | `pnpm install` (no `node_modules` in a fresh clone) |
| 0-b | Add Reatom | `@reatom/core` v1001. Put it in `devDependencies` to match the template: `ext:package` runs `vsce package --no-dependencies` and tsdown bundles everything except `vscode` |
| 0-c | Extension identity | `package.json`: `publisher`, `name: tabthrough`, `displayName`, `description`, `categories: ["Other", "SCM Providers", "Education"]`, `repository`. Add config scope `tabthrough` with the settings listed in [Configuration surface](#configuration-surface) |
| 0-d | Generate meta | `pnpm update` → `src/generated/meta.ts`. Confirm `.gitignore` treatment matches template intent |
| 0-e | Test runner | `vitest.config.ts` with `environment: 'node'`, `include: ['test/**/*.test.ts']`, and a longer `testTimeout` for the git integration suite. Add `"test:ci": "vitest run"` so local `pnpm test` can stay in watch mode without ambiguity |
| 0-f | CI | Existing `.github/workflows/ci.yml` already runs lint + typecheck + test on ubuntu/windows/macos. Leave the matrix intact — it is the mitigation for [R7](#r7--git-version--platform-variance) |

### Exit criteria

- [ ] `pnpm install && pnpm lint && pnpm typecheck && pnpm test:ci` green on a clean clone
- [ ] F5 (`Extension` launch config) starts an extension host that activates without error
- [ ] `@reatom/core` imports and a trivial `atom` round-trips in a vitest test

### Test gate

`test/unit/toolchain.test.ts` — one test that creates a Reatom scope, sets an atom, reads it back. Proves the dependency and the runner work before anyone depends on them.

---

## Phase 1 — Foundation: git probe + Reatom session model

**Backlog IDs:** P0-1, P0-8. **Depends on:** Phase 0.

Two independent workstreams that can be done in either order or in parallel by one implementer. They meet at the end of the phase when the probe result lands in the model.

### P0-1 — Git capability probe

A single async probe returning a **discriminated result**, never a thrown string:

```
ok:    { ok: true,  repoRoot, headSha, headRef | null, detached, shallow, dirty, gitVersion }
fail:  { ok: false, reason: 'git-missing' | 'not-a-repo' | 'bare-repo' | 'shallow-missing-objects'
                          | 'unborn-head' | 'rebase-or-merge-in-progress' | 'git-too-old',
         message, hint? }
```

- All git access goes through one `exec` wrapper: `spawn` (never `shell: true`), explicit `cwd`, arg array, timeout, captured stdout/stderr, non-zero exit surfaced as a typed error. The wrapper is **injectable** so unit tests can feed recorded outputs.
- `rebase-or-merge-in-progress` is a P2 "refuse start" row in the product edge table — detect it here, do not implement recovery.
- The probe drives a VS Code context key (`tabthrough.gitUsable`) so command `enablement` in `package.json` disables Start with an explanation, per the P0 edge row "Git not a repo / no git".

### P0-8 — Reatom session model

Single source of truth. Everything else in the extension reads it; nothing keeps a parallel copy.

- `sessionStatusAtom`: `'idle' | 'preflight' | 'stashing' | 'active' | 'restoring' | 'error'`
- `sessionAtom`: `{ id, repoRoot, entry, targetRev, originalHead, startedAt } | null`
- `stashHandleAtom`: `{ stashSha, backupRef, includedUntracked, fileCount } | null`
- `stepsAtom`: `Step[]` (from the guide engine, Phase 3)
- `cursorAtom`: `number` (index of last revealed step; `-1` = nothing revealed)
- `currentStep`, `revealedSteps`, `progressLabel`, `canAdvance`, `canRetreat` — all `computed`
- Git mutations are `action(async () => …).extend(withAsync())`; every subprocess boundary is `await wrap(...)`
- **[ARCH]** Scope ownership: who creates the Reatom scope relative to `defineExtension`, and how `deactivate` drains a pending restore. See [R6](#r6--async-restore-during-deactivate).

### Exit criteria

- [ ] Probe returns a correct discriminated result for: valid repo, non-repo directory, repo with no commits, shallow clone
- [ ] Start command is visibly disabled with a reason when the probe fails
- [ ] Session status transitions are centralised in one action; illegal transitions (e.g. `active → stashing`) are rejected, not silently applied
- [ ] No module outside `src/ui/` and `src/commands/` imports `vscode`

### Test gate

| Test | Type |
|------|------|
| Probe parses recorded `rev-parse` / `status` outputs into each result variant | unit, injected exec |
| Probe against a real temp repo and a real non-repo temp dir | integration |
| Session transition table: legal + illegal pairs | unit |
| Lint rule or test asserting the `vscode` import boundary | unit |

---

## Phase 2 — Safety: stash pipeline, restore, session lock

**Backlog IDs:** P0-5, P0-6, P0-7. **Depends on:** Phase 1.

The highest-risk phase and the one non-negotiable in ADR 0001. Gate it hardest.

### P0-5 — Stash pipeline

Order of operations matters and is itself the safety property:

1. Probe → refuse if unusable.
2. Compute the pre-flight summary: file list split into staged / unstaged / untracked, with counts.
3. Show pre-flight UI. **Cancel is the default action.** State exactly what will be stashed and how to abort.
4. Write the **durable recovery token** to `globalState` *before* any mutation.
5. `git stash push --include-untracked -m "tabthrough:<sessionId>"`.
   - **Never `--all`.** `--all` sweeps ignored files (`node_modules`, `.env`, build output) — slow, and a restore failure there is catastrophic. See [R8](#r8--untracked--ignored-scope-in-stash).
6. Resolve the stash commit SHA and pin it with `git update-ref refs/tabthrough/backup/<sessionId> <sha>`. The ref is what makes the work survive a `git stash drop` or `git stash clear` by the user or another tool.
7. Update the token with `stashSha` + `backupRef`, then enter the target revision.

If any step fails, unwind the ones already done and refuse to start. A failed start must leave the tree exactly as found.

### P0-6 — Restore on all exit paths

| Exit path | Behaviour |
|-----------|-----------|
| Finish | Full restore, verify, drop stash, delete backup ref, clear token |
| Cancel | Identical to Finish — cancel is not a "discard" |
| `deactivate()` | Best-effort restore; token guarantees completion on next activation |
| Window close / crash | Nothing at the time; next activation sees the token and offers **Resume restore** *before any other git operation* |
| Recovery command | `Tabthrough: Restore from backup` works standalone, even with no session |

Restore algorithm: **apply → verify → then drop.** Use `git stash apply`, never `pop` (pop drops on partial success). Verify by comparing `git status --porcelain=v2 -z` and content hashes against the pre-stash snapshot. Only on a verified match do we `stash drop` and delete the backup ref.

On conflict: **never force, never `checkout -f`, never `clean`.** Keep the backup ref, keep the stash entry, put the user in front of the 3-way merge UI, and show the exact `git` command to recover manually. Clear the token only when the user explicitly dismisses.

### P0-7 — Single-session lock

`sessionStatusAtom !== 'idle'` blocks a second Start with a toast. Also guard per-`repoRoot` so two windows on the same repo cannot both stash — a repo-level lock (backup ref existence or a lock file under `.git/`) is the real protection; the atom only covers one window. **[ARCH]** pick the mechanism.

### Exit criteria

- [ ] Round-trip is byte-identical across the fixture matrix below
- [ ] Every one of the five exit paths restores or defers safely
- [ ] Stash-apply conflict produces zero data loss and a surviving backup ref
- [ ] Second Start attempt is blocked with a clear message, in the same window and across two windows on one repo
- [ ] `progress/test-matrix.md` documents the manual crash drill

### Test gate — the sacred suite

`test/integration/stash-roundtrip.test.ts`, running against **real temp git repos** built by `test/helpers/tmp-repo.ts`:

| Fixture repo state | Assert |
|--------------------|--------|
| Clean tree | No stash created; start proceeds without touching anything |
| Unstaged edits only | Byte-identical restore |
| Staged + unstaged edits to the same file | Both hunks restored **and** the index state restored |
| Untracked files present | Restored, still untracked |
| File mode change (`chmod +x`) | Mode preserved (skip on Windows) |
| CRLF / mixed line endings | No normalisation drift |
| Deleted-but-not-staged file | Still deleted after restore |
| Apply conflict (target rev touches a stashed file) | Error surfaced, backup ref present, no content lost |

Comparison is `git status --porcelain=v2 -z` plus a SHA-256 of every tracked and untracked file, before vs after.

**This suite is a merge blocker for every subsequent phase.**

---

## Phase 3 — Guide engine (pure, offline)

**Backlog IDs:** P0-9, P0-10, P0-15. **Depends on:** Phase 2 merged (not technically, but to keep review attention ordered). Parallel with Phase 4.

Everything in this phase is **pure functions over strings** — no `vscode`, no subprocess, no I/O except the sidecar read, which is injected. That makes it the cheapest phase to test exhaustively and the safest to parallelise.

### P0-9 — Diff → step graph

Unified diff text → structured model:

- `DiffFile`: `path`, `oldPath`, `status` (`added|modified|deleted|renamed|binary|mode-only`), `hunks[]`
- `DiffHunk`: `oldStart/oldLines/newStart/newLines`, `header`, `lines[]` typed `add|del|context`
- `LineGroup`: contiguous runs of `add`/`del` separated by context, so a hunk can be revealed in pieces

Must handle: `\ No newline at end of file`, `Binary files … differ`, rename headers (`similarity index` / `rename from|to`), mode-only changes, empty hunks, and diffs with no trailing newline.

### P0-10 — Heuristic orderer

Pure, **deterministic**, stable-sorted (ties broken by path then hunk index so fixtures never flake). Three tiers, each contributing a score:

1. **File tier** — by extension and path segment: types/schema/interfaces/migrations/config → core/lib/domain → services/api → UI/components → tests → docs, generated files, lockfiles.
2. **Hunk significance** — new exported symbol > signature change > logic change > import/rename churn > whitespace-only.
3. **Intra-hunk line groups** — file order within the hunk.

Every emitted `Step` carries a one-line `rationale` naming the rule that fired ("types before callers", "new export before its call sites"). P0-13's status bar consumes this directly, so it is not optional decoration — it is part of the data model.

Binary and generated files emit a **visible skipped stub step** so the ordering and the `k/n` count stay honest, per the P0 edge row.

### P0-15 — Sidecar `.guide.json` read (minimal)

- Read from repo root; path overridable by setting.
- Validate against the shape the Architect freezes in `architecture/guide-schema.md`. Validation is hand-rolled and total — no schema library dependency for MVP.
- **Valid** → override order for the hunks it references; hunks it does not reference are appended in heuristic order.
- **Invalid or unparseable** → one warning, full heuristic fallback. Never a hard failure.
- **Explicitly out of MVP:** partial/stale merge semantics (that is P1-3) and any write path.

**Blocked on:** `architecture/guide-schema.md` from the Architect (parallel track C). Implementer should not invent the shape.

### Exit criteria

- [ ] Parser handles every fixture in `test/fixtures/diffs/` including the four awkward cases above
- [ ] Foundation-before-consumer fixture orders `types.ts` → `service.ts` → `Component.tsx` → `service.test.ts`
- [ ] Ordering is stable across repeated runs on the same input
- [ ] A binary file in the diff yields a skipped stub without breaking `k/n`
- [ ] A valid `.guide.json` fixture changes the order of at least one step (ADR gate 5)
- [ ] An invalid `.guide.json` fixture falls back with exactly one warning

### Test gate

Pure vitest, no VS Code host, no temp repos. Snapshot tests over checked-in `.diff` fixtures; explicit assertion tests (not snapshots) for the ordering rules, so a fixture refresh cannot silently accept a regression.

---

## Phase 4 — Session entry points

**Backlog IDs:** P0-2, P0-3, P0-4. **Depends on:** Phase 1 (probe). Parallel with Phase 3.

Each entry point resolves to the same thing: a target revision plus a unified diff string that Phase 3 consumes. Keep the interface that narrow.

| ID | Entry | Command | Notes |
|----|-------|---------|-------|
| P0-2 | Working tree | `git diff HEAD` | Covers staged + unstaged in one pass. Untracked files are included only if they were in stash scope — keep the two consistent or the reveal will show content the restore does not cover |
| P0-3 | Single commit | `git diff <sha>~1 <sha>` | Root commit → diff against the empty tree. Merge commit → `--first-parent` and say so in the pre-flight |
| P0-4 | Commit range | `git merge-base A B` then `git diff <base> B` | Accept `A..B` as user input, resolve through merge-base so ancestor noise is excluded. Document the three-dot semantics in the command description so the behaviour is not a surprise |

Empty or whitespace-only diff (`git diff -w` returns nothing) **blocks start** with a clear message, per the P0 edge row.

### Exit criteria

- [x] All three entries produce a step list on scripted fixture repos
- [x] Range output matches `git diff $(git merge-base A B) B` textually
- [x] Root commit and merge commit both produce sensible output rather than an error
- [x] Empty and whitespace-only diffs are blocked, not started

### Test gate

`test/integration/entry-points.test.ts` on scripted repos: linear history, a branch with a merge, a root commit, an empty-diff repo, a whitespace-only change.

---

## Phase 5 — UX loop: Tab, reveal, status bar, commands

**Backlog IDs:** P0-11, P0-12, P0-13, P0-14. **Depends on:** Phases 3 and 4.

### Prerequisite spike (do this before committing to P0-12)

> **Resolved without a spike.** The Architect's built-document design (overview §7.1, ADR 0002 D1) sidesteps the whole comparison: unrevealed lines are *absent* from a virtual document rather than hidden in a real one, so no API needs to delete lines. `progressive` shipped as the default and `dim` as a fold over the same `LineGroup` data, sharing the provider and the URIs. The table below is kept as the record of what was rejected.

VS Code decorations **cannot delete lines**. There is no supported "hide these ranges" API. The three candidate reveal mechanisms have materially different risk:

| Option | How | Risk |
|--------|-----|------|
| **Dim** (recommended default) | Read-only virtual document holding the target revision; unrevealed ranges get a low-opacity `TextEditorDecorationType` | Content is technically visible if the user squints or copies. Honest, simple, fully reversible |
| **Fold** | Programmatic folding of unrevealed ranges | Fights user folding; folding API is coarse |
| **Staged apply** | Write revealed hunks into real files progressively | Couples reveal to the working tree — exactly what the stash pipeline is trying to keep clean. Highest risk |

Spike output: a short recommendation appended to `architecture/overview.md`. **Default to dim** unless the spike shows fold is clean. Expose `tabthrough.reveal.mode` so the choice is not permanent.

### P0-12 — Reveal rendering

Render into a **read-only virtual document** (`TextDocumentContentProvider`, scheme `tabthrough:`) holding the target-revision content. This buys three things at once:

- The working tree is never written to during reveal, so stash safety is independent of rendering.
- Read-only means Tab has no competing indent/completion/snippet semantics in that editor — the single biggest mitigation for [R1](#r1--tab-keybinding-conflicts).
- Reveal is a pure function of `cursorAtom`, so Shift+Tab is trivially correct.

Prior steps stay visible: revealed set is `steps[0..cursor]`, monotonic on advance.

### P0-11 — Tab / Shift+Tab

Recommended `when` clause shape (**[ARCH]** to finalise):

```
tabthrough.sessionActive && editorTextFocus && resourceScheme == 'tabthrough'
  && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode
  && !editorHasSelection && !editorReadonly
```

Always ship an **alternate chord** (`alt+]` / `alt+[`) bound unconditionally, plus a `tabthrough.keybinding.useTab` setting to switch Tab off entirely. If the conflict matrix cannot be made clean, the fallback position is to make the alternate chord the default and Tab opt-in — that is a UX downgrade, not a scope change.

### P0-13 — Status bar

`$(book) Step k/n · service.ts · types before callers`. Driven by `computed` values so it updates synchronously with the model, never by imperative refresh calls. Rationale suppressed when `tabthrough.showRationale` is false. Clicking jumps to the current step.

### P0-14 — Commands

`tabthrough.start`, `.startFromCommit`, `.startFromRange`, `.next`, `.previous`, `.finish`, `.cancel`, `.restoreBackup`. All registered in `contributes.commands` with `enablement` clauses driven by the same context keys, so the palette never offers an action that will fail.

### UX guardrails (PO checklist, verified this phase)

No score, no timer, no streak, no "did you get it?" gate, no red/green judgment on pace. Tab past the last step is a **no-op** plus a subtle "Review complete" toast offering Finish.

### Exit criteria

- [x] Tab advances through ≥10 steps with monotonic visibility on a sample diff (ADR gate) — `reveal-loop.test.ts`, three modules, twelve-odd steps, driven by `next()`
- [x] Shift+Tab retreats without corrupting the revealed set — the previous document is restored byte for byte, not undone
- [x] Tab at the end no-ops and offers Finish — the no-op is asserted in the model; the toast itself is bridge code with no host test
- [ ] Tab in a normal editor with a session active still does normal Tab things — **needs a keyboard**, runbook at `test-matrix.md` §6.4
- [x] Status bar `k/n` matches the model at every step — it is a computed over the same cursor, so there is no path by which it can disagree
- [ ] Time-to-first-reveal <3s on a 500-line diff (product metric) — **unmeasured**, runbook at `test-matrix.md` §6.5
- [x] PO UX checklist: zero exam-like elements — no score, timer, streak, or comprehension gate anywhere in the surface

### Test gate

| Test | Type |
|------|------|
| Advance / retreat / clamp at both ends | unit, model-level |
| Reveal set is a pure function of cursor | unit |
| Status bar label composition incl. rationale toggle | unit |
| Keybinding conflict matrix: IntelliSense open, inline suggestion, snippet mode, selection active, terminal focus, normal editor focus | **manual runbook** in `progress/test-matrix.md` |
| Time-to-first-reveal benchmark | manual |

---

## Phase 6 — Edge hardening + dogfood

**Backlog IDs:** P0-16. **Depends on:** Phases 2–5.

Walk all ten P0 edge rows in `specs/product.md` and give each one a passing test or a written runbook. Most are already covered by earlier phases; this phase closes the gaps and proves it in one place.

| P0 edge case | Covered by | Remaining work |
|--------------|-----------|----------------|
| Dirty tree at start | Phase 2 | — |
| Stash pop conflict | Phase 2 | — |
| VS Code closed mid-session | Phase 2 token | Manual drill (`test-matrix.md` §6.1) |
| Tab with no steps remaining | Phase 5 | — |
| Empty / whitespace-only diff | Phase 4 | — |
| Binary / generated files | Phase 3 stub | ~~End-to-end check~~ — `test/integration/edge-cases.test.ts` |
| Extension crash | Phase 2 backup ref | Manual drill (`test-matrix.md` §6.1) |
| Concurrent sessions | Phase 2 lock | Two-window drill (`test-matrix.md` §6.2) |
| Not a repo / no git | Phase 1 | ~~—~~ model-level gating now asserted too |
| Detached HEAD / shallow | Phase 1 | ~~Shallow-clone fixture~~ — and it found a defect: `test-matrix.md` §2.1 |

Also in this phase: README with a "Known limitations" section covering the P2 rows, marketplace metadata review, and five dogfood sessions.

### Exit criteria — MVP done

- [x] Every P0 edge row has a test or a documented runbook (`progress/test-matrix.md` §2 — all ten rows automated; four also carry a human drill that has not been run)
- [ ] ADR 0001 acceptance gates 1–5 all satisfied
- [ ] Product spec MVP acceptance checklist all ticked
- [ ] Dogfood: 5 sessions, zero restore failures
- [ ] Reviewer sign-off (`progress/reviews/`) with no open blockers
- [ ] PO sign-off

---

## Parallel tracks

These run **beside** the core sequence and never block it.

| Track | Work | Owner | Starts after | Must land before |
|-------|------|-------|--------------|------------------|
| **A — Core** | Phases 0→6 above | Implementer | — | — |
| **B — Fixtures & matrix** | `test/helpers/tmp-repo.ts`, diff fixtures, `progress/test-matrix.md` skeleton | Tester | Phase 0 | Phase 2 needs the temp-repo helper; Phase 3 needs the diff fixtures |
| **C — Architecture docs** | `architecture/overview.md`, `architecture/reatom-model.md`, `architecture/guide-schema.md` | Architect | Now | `guide-schema.md` blocks P0-15; `reatom-model.md` blocks P0-8 |
| **D — Product surface** | README, marketplace metadata, settings descriptions, keybinding documentation | Implementer (low priority) | Phase 0 | Phase 6 |
| **E — P1 prep (docs only)** | `.guide.json` schema v1 publication + agent skill draft | Anyone idle | Phase 3 green | **Not MVP-blocking.** Zero code in `src/` |

Track B is the one worth starting immediately in parallel — the temp-repo helper is on the critical path for Phase 2, and building it early de-risks the hardest phase.

Track E exists because ADR 0001 fixes the `.guide.json` shape early precisely so agent-facing work can proceed independently. **It writes documentation, not extension code.** LLM generation and the `gh` PR entry point remain out of MVP.

---

## Risk register

Ordered by expected cost, not likelihood.

### R2 — Stash conflict / data loss

**Likelihood:** Medium · **Impact:** Critical · **Owner:** Implementer + Reviewer

The one failure mode that kills the product. A single lost-work report in dogfood ends the MVP.

*Mitigations:* backup ref via `update-ref` survives `stash drop`/`clear`; apply-verify-then-drop ordering; durable token written before any mutation; never `--force`, `checkout -f`, or `clean`; the round-trip suite blocks merges.
*Trigger:* any round-trip test failing on any platform halts feature work until green.

### R5 — Reveal rendering feasibility

**Likelihood:** Medium · **Impact:** High · **Owner:** Architect

Decorations cannot hide lines. If "reveal" degrades to "dim", the core demo is weaker than the pitch.

*Mitigations:* spike before Phase 5 commits; read-only virtual document makes all three options viable; `tabthrough.reveal.mode` setting keeps the choice reversible; dim is an acceptable MVP floor.
*Trigger:* if the spike shows dim is unconvincing in a real session, escalate to PO — this is a UX decision, not an engineering one.

### R1 — Tab keybinding conflicts

**Likelihood:** High · **Impact:** High · **Owner:** Implementer

Tab is the most contested key in the editor: IntelliSense accept, inline/Copilot suggestion accept, snippet navigation, indent, emmet.

*Mitigations:* the reveal document is read-only and on its own scheme, which removes most competitors structurally; narrow `when` clause; unconditional alternate chord; setting to disable the Tab binding.
*Trigger:* if the conflict matrix cannot be made clean, ship the alternate chord as default and Tab as opt-in.

### R6 — Async restore during `deactivate()`

**Likelihood:** Medium · **Impact:** High · **Owner:** Architect

VS Code does not reliably await async work in `deactivate()`. A restore started there may be cut off mid-flight.

*Mitigations:* never depend on `deactivate` alone; the durable token makes next-activation resume authoritative; keep the deactivate path as short as possible; the resume prompt runs before any other git operation.

### R8 — Untracked / ignored scope in stash

**Likelihood:** Medium · **Impact:** High · **Owner:** Implementer

`git stash --all` would sweep `.env`, `node_modules`, and build output. Slow, surprising, and a restore failure there is unrecoverable in practice.

*Mitigations:* `--include-untracked` only, never `--all`; the pre-flight lists exactly what is included; stash scope and diff scope for the working-tree entry point must match.

### R4 — Reatom + reactive-vscode boundary

**Likelihood:** Medium · **Impact:** Medium · **Owner:** Architect

Two reactivity systems in one process. The failure mode is subtle: state drifting into `reactive-vscode` refs, or async git work escaping the Reatom frame.

*Mitigations:* strict layering (pure core → Reatom orchestration → reactive-vscode binding); no `vscode` import below `src/ui/` and `src/commands/`; one scope created in `defineExtension`; `await wrap(...)` at every subprocess boundary; Reviewer runs the `reatom-review` skill on every slice.
*Open:* scope lifetime vs `defineExtension`, and disposal ordering. **[ARCH]**

### R3 — Heuristic order quality

**Likelihood:** High · **Impact:** Medium · **Owner:** PO (accepted debt)

The heuristic will be wrong on complex refactors. ADR 0001 already accepts this.

*Mitigations:* the MVP bar is **defensible, deterministic, and explainable** — not optimal; every step states its reason; `.guide.json` is the escape hatch; P1 LLM is the real fix.
*Trigger:* heuristic tuning must not block Phase 5. Timebox it; log disagreements as P1 input rather than iterating.

### R7 — Git version / platform variance

**Likelihood:** Low · **Impact:** Medium · **Owner:** Tester

`--porcelain=v2`, `stash push`, and `-z` behaviour vary across git versions; file modes and line endings vary across platforms.

*Mitigations:* the probe records `gitVersion` and refuses below a documented minimum with a clear message; CI already runs the test matrix on ubuntu, windows, and macos — keep it.

### R9 — Scope creep into P1

**Likelihood:** Medium · **Impact:** Medium · **Owner:** Planner + PO

LLM generation, agent skill publication, and `gh` PR entry are all tempting and all out.

*Mitigation:* Track E is documentation-only. Any PR touching `src/` for a P1 item is rejected at review.

---

## Suggested module layout

High level only — the Architect owns the details, and the Implementer should follow `architecture/overview.md` where it disagrees.

```
src/
  index.ts                  # defineExtension: scope, context keys, disposal
  config.ts                 # existing — generated meta binding
  utils.ts                  # existing — logger
  generated/meta.ts         # vscode-ext-gen output

  git/                      # subprocess layer — no vscode imports
    exec.ts                 # injectable spawn wrapper (cwd, args, timeout)
    probe.ts                # P0-1
    diff.ts                 # P0-2, P0-3, P0-4 — revision resolution + raw diff
    stash.ts                # P0-5, P0-6 — push, backup ref, apply/verify/drop
    snapshot.ts             # porcelain + content hashes for restore verification

  guide/                    # pure — no vscode, no subprocess, no I/O
    types.ts                # DiffFile, DiffHunk, LineGroup, Step, GuideGraph
    parse-diff.ts           # P0-9
    heuristic.ts            # P0-10
    sidecar.ts              # P0-15 — validate + merge (injected reader)

  model/                    # Reatom — orchestration only
    session.ts              # P0-8 — status, session, stash handle
    steps.ts                # steps, cursor, revealed set, derived labels
    recovery.ts             # P0-6 — durable token in globalState
    lock.ts                 # P0-7

  ui/                       # vscode allowed from here down
    document.ts             # P0-12 — read-only virtual doc provider
    decorations.ts          # P0-12 — reveal rendering
    status-bar.ts           # P0-13
    prompts.ts              # pre-flight, conflict, resume dialogs

  commands/
    index.ts                # P0-14 — registration + enablement

test/
  unit/                     # pure: parser, heuristic, sidecar, model transitions
  integration/              # real temp git repos: stash round-trip, entry points
  fixtures/
    diffs/*.diff
    guides/*.guide.json
  helpers/
    tmp-repo.ts             # build + mutate + hash a throwaway git repo
```

**The load-bearing rule:** nothing under `git/`, `guide/`, or `model/` imports `vscode`. That is what lets the majority of the codebase run under plain vitest with no extension host, which in turn is what makes the safety and ordering suites cheap enough to run on every commit.

---

## Configuration surface

Settings to declare in Phase 0 so later phases can read them without re-touching `package.json`:

| Setting | Type | Default | Phase |
|---------|------|---------|-------|
| `tabthrough.keybinding.useTab` | boolean | `true` | 5 |
| `tabthrough.showRationale` | boolean | `true` | 5 |
| `tabthrough.reveal.mode` | `'dim' \| 'fold'` | `'dim'` | 5 |
| `tabthrough.guideFile` | string | `.guide.json` | 3 |
| `tabthrough.stash.includeUntracked` | boolean | `true` | 2 |

---

## Test gates at a glance

| Phase | Automated gate | Manual gate |
|-------|---------------|-------------|
| 0 | lint + typecheck + `vitest run` green; Reatom smoke test | F5 launches |
| 1 | Probe variants; session transition table; import-boundary check | — |
| 2 | **Stash round-trip matrix (merge blocker)**; conflict test | Crash drill; two-window drill |
| 3 | Diff parser fixtures; ordering assertions; sidecar override + fallback | — |
| 4 | Entry-point integration on scripted repos | — |
| 5 | Advance/retreat/clamp; reveal purity; status bar composition | Keybinding conflict matrix; <3s benchmark; PO UX checklist |
| 6 | Full P0 edge matrix | 5 dogfood sessions; Reviewer + PO sign-off |

Per the Planner rules, **every P0 has a gate**: P0-1/8 in Phase 1, P0-5/6/7 in Phase 2, P0-9/10/15 in Phase 3, P0-2/3/4 in Phase 4, P0-11/12/13/14 in Phase 5, P0-16 in Phase 6.

---

## Definition of done for an Implementer slice

1. `pnpm lint && pnpm typecheck && pnpm test:ci` green.
2. New behaviour has a test at the phase's stated gate.
3. No `any` or unsafe casts; no drive-by refactors outside the slice.
4. `progress/iteration-log.md` appended; `progress/backlog.md` status updated.
5. Reatom code reviewed against the `reatom-review` skill before requesting review.

---

## First Implementer slice

**Phase 0 in full, plus P0-1.** One branch, small commits.

1. `pnpm install`; add `@reatom/core`; fix the `generated/meta` gap so `pnpm typecheck` passes for the first time.
2. Rename the extension (`tabthrough`) and declare the five settings above.
3. Add `vitest.config.ts` and `test:ci`; land the Reatom smoke test.
4. Implement `git/exec.ts` and `git/probe.ts` with the discriminated result, and wire `tabthrough.gitUsable` to a stub Start command that is disabled with a reason when the probe fails.
5. Tests: probe variants against recorded outputs; a real temp repo and a real non-repo directory.

Do **not** start the stash pipeline in this slice. Phase 2 deserves its own review pass, and the temp-repo helper (Track B) should land first.

---

## References

- [ADR 0001 — MVP scope](../decisions/0001-mvp-scope.md)
- [Product spec](../specs/product.md)
- [Backlog](./backlog.md)
- [Process](../process/README.md)
- Reatom skills: `.agents/skills/reatom/`, `.agents/skills/reatom-async/`, `.agents/skills/reatom-review/`
