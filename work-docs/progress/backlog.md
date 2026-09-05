# Tabthrough — Prioritized Backlog

**Last updated:** 2026-08-07 (Planner — P0-A2 Done; Phases 7–10 sequenced)  
**Ordering principle:** Safety → core Tab loop → offline guide → **apply-with-user / ownership** → guide authoring quality → polish → LLM/agents → nice-to-have

Legend: **P0** ship blocker (v0.1 or v0.2 as marked) · **P1** fast follow · **P2** later

---

## P0 — MVP v0.1 (ship blockers)

Status legend: **Next** = in the current Implementer slice · **Not started** = planned, phase assigned · **In progress** / **Done** set by Implementer.
Phases are defined in [plan.md](./plan.md).

| ID | Item | Acceptance hint | Depends | Phase | Status |
|----|------|-----------------|--------|-------|--------|
| P0-0 | **Toolchain foundation** (Planner-added prerequisite) — deps, `@reatom/core`, extension identity, generated meta, vitest config | `pnpm lint && typecheck && test:ci` green on clean clone | — | 0 | **Done** |
| P0-1 | **Git capability probe** — repo detection, dirty state, HEAD, shallow/missing objects | Commands disabled with clear message when git unusable | — | 1 | **Done** (`src/git/{exec,probe}.ts`) |
| P0-2 | **Session entry: working tree** — diff staged+unstaged vs HEAD | Command produces step list; empty diff blocked | P0-1 | 4 | **Done** (`tabthrough.start`; whitespace-only now refused too) |
| P0-3 | **Session entry: single commit** — show commit vs first parent | Works on linear history sample | P0-1 | 4 | **Done** (`tabthrough.startFromCommit`, QuickPick over `readRecentCommits` + free-form ref; root and merge commits covered) |
| P0-4 | **Session entry: commit range** — `A..B` merge-base aware | Range diff matches `git diff A..B` | P0-1 | 4 | **Done** (`tabthrough.startFromRange`; `A..B` and `A...B` both resolve through merge-base) |
| P0-5 | **Stash pipeline** — scoped message, backup ref, pre-flight summary | Automated test: stash → mutate → restore byte-identical | P0-1 | 2 | **Done** (`src/git/{snapshot,stash,refs,journal,isolate}.ts`; 17-case sacred suite) |
| P0-6 | **Restore on all exit paths** — Finish, Cancel, deactivate, crash recovery command | Matrix test for Finish/Cancel; manual crash drill | P0-5 | 2 | **Done** for code + automated matrix; crash drill written in `test-matrix.md` §6.1 but **not yet run** |
| P0-7 | **Single-session lock** — reject second start while active | Error toast if session already running | P0-5 | 2 | **Done** (CAS on `refs/tabthrough/lock`, valued by `sessionId`; token heartbeat keeps a second window out of a live session's recovery); two-window drill §6.2 not yet run |
| P0-8 | **Reatom session model** — session, stashHandle, steps, cursor, status | All UI/commands read/write one model | — | 1 | **Done** (`src/model/{session,steps,ports,view,guide-source}.ts`) |
| P0-9 | **Diff → step graph** — parse unified diff into hunks/lines | Fixture tests for split/join | P0-8 | 3 | **Done** (`src/guide/{types,parse-diff,groups,render}.ts`) |
| P0-10 | **Heuristic orderer** — file tier + hunk significance + line groups | Foundation-before-consumer fixture passes | P0-9 | 3 | **Done** (`src/guide/{heuristic,steps}.ts`) |
| P0-11 | **Tab / Shift+Tab advance** — configurable keybinding, default avoids IntelliSense conflict | Step k→k+1 reveals new regions; Shift+Tab undoes | P0-10 | 5 | **Done** in code (ADR 0002 D2 `when` clause + unconditional `alt+]`/`alt+[`); the conflict matrix in `test-matrix.md` §6.4 still needs a human |
| P0-12 | **Reveal rendering** — decorations or staged apply in diff editor | Prior steps stay visible; binary skip stub | P0-11 | 5 | **Done** (`src/ui/documents.ts`; R5 closed by the Architect's built-document design, no spike needed. `dim` shares the provider) |
| P0-13 | **Status bar UI** — `step k/n`, file, one-line rationale | Updates synchronously with model | P0-8 | 5 | **Done** (`src/ui/status-bar.ts`; click runs `showStepDetail`) |
| P0-14 | **Commands** — Start, Next, Previous, Finish, Cancel | Palette + keybindings registered | P0-6, P0-11 | 5 | **Done** (ten commands, all with `enablement`; asserted by `test/unit/contributions.test.ts`) |
| P0-15 | **Sidecar guide read (minimal)** — load `.guide.json` if present; validate or fallback | Override step order for fixture guide | P0-10 | 3 | **Done** and wired (`buildGuideSource` reads the blob from the after ref, then the base ref) |
| P0-16 | **P0 edge cases** — see product.md table | Each row has test or runbook | P0-5–P0-12 | 6 | **Done** for the automated half: all ten rows in [test-matrix.md §2](./test-matrix.md), the last three closed by `test/integration/edge-cases.test.ts`. Walking row 10 found a real defect — a shallow boundary commit was reviewed against the empty tree — now refused with a fetch hint. **Open:** the five human drills in §6, none of which has been run |

**MVP v0.1 milestone:** P0-1 through P0-16 complete + dogfood sign-off + five manual drills in `test-matrix.md` §6.

### Non-P0 tracks running in parallel

| Track | Work | Owner | Status |
|-------|------|-------|--------|
| B | `test/helpers/tmp-repo.ts`, diff fixtures, `progress/test-matrix.md` | Tester | **Done** (helper + `test/helpers/protocol.ts` crash driver + the matrix, now led by the ten-row P0 edge table in §2; the five manual drills in §6 still need a human) |
| C | `architecture/overview.md`, `reatom-model.md`, `guide-schema.md` | Architect | **Done** for v0.1; **v0.2 apply** amended (ADR 0004, overview §7.3, reatom-model 1.1) |
| D | README, marketplace metadata, settings docs | Implementer | **Done** (usage, safety model, settings, known-limitations table; marketplace fields were set in Phase 0) |
| E | `.guide.json` schema publication + agent skill draft (docs only, no `src/`) | — | Schema file **Done**. Skill/long-form **Done** (P0-G1). Golden helper+consumer fixture **Done** (P0-G2). P0-G3 dogfood **PASS** |
| F | Apply mode Phases 7–10 | Implementer | **Sequenced** (P0-A2); first slice = Phase 7 foundation |
| G | Guide quality P0-G1–G3 | Docs / Tester | G1–G3 **Done** — **parallel** with F (reference only) |

---

## P0 — v0.2 next milestone (Apply & own + guide quality)

Product direction: [specs/product.md](../specs/product.md). **Safety still outranks pedagogy.** Architect P0-A1 **Done** ([ADR 0004](../decisions/0004-apply-mode.md)). Planner P0-A2 **Done** ([plan.md](./plan.md) Phases 7–10).

### Track A — Apply-with-user / commit-oriented walkthrough

| ID | Item | Acceptance hint | Depends | Phase | Owner | Status |
|----|------|-----------------|--------|-------|-------|--------|
| P0-A1 | **Architect: reopen ADR 0002 D1** — `apply` mode beside `progressive`/`dim`; stash/journal under writes; Finish vs Cancel | ADR + overview §7 amended; risks in product.md addressed | v0.1 drills preferably green | — | Architect | **Done** (ADR 0004; overview §7.3; reatom-model 1.1) |
| P0-A2 | **Planner: phase plan for apply mode** — entry points (commit + working tree), crash matrix, UX commands | Phases + test gates in `plan.md`; risks R-apply-* registered | P0-A1 | — | Planner | **Done** (Phases 7–10; R-apply-1…9; test-matrix §9) |
| P0-A3 | **Apply mode — commit target** — checkout `C^`, Tab applies `C`’s steps to real files; user may edit; Cancel sacred | [product apply acceptance](../specs/product.md#acceptance-criteria-apply-mode); sacred suite extended; Shift+Tab revert; file-scheme/chord | P0-A1, P0-A2 | **7** | Implementer | **Fixes landed — awaiting re-review** ([review 004](./reviews/004.md)): **G1/G2/G4/G5 Done**; G3 (drift) + G6/G7 still open. Phase 8 still blocked until gate re-opens |
| P0-A4 | **Apply mode — working-tree target** — stash/capture, checkout base, reapply step-by-step with user | Abort restores pre-session WIP byte-identical | P0-A3 engine | **8** | Implementer | **Blocked** — [review 004](./reviews/004.md) withholds the Phase 7 gate; G1–G4 must land first (Phase 8 always detaches at `base` and enters from the user's dirty tree, so it inherits every one of them) |
| P0-A5 | **Finish vs Commit UX** — copy + commands; Cancel = restore; Finish keeps tree / offers commit handoff | No silent auto-commit; pre-flight discloses disk writes; `done-kept` | P0-A3 | **9** | Implementer | **Fixes landed — awaiting re-review** ([review 003](./reviews/003.md)): **F2–F5 Done** (+ F11 rows 1–3, partial F8/F12). F6–F7/F9–F10 and remaining F11 rows still open |
| P0-A6 | **Apply crash / mid-edit recovery** — journal step index; conflict on user-edit vs next step is honest | Recovery UI; never silent overwrite; `applying` / `done-kept` matrix | P0-A3, P0-A5 | **10** | Implementer | Not started — ADR 0004 D7. **Note:** review 002 B3 means Phase 10's task 10-c (resume after the user resolves a conflict) has no state to resume *from* until F2 lands |

#### Review 002 fix items — gate on Phase 8 / Phase 9 ship

Filed by the Reviewer from [review 002](./reviews/002.md). **F1–F4 block P0-A4 and any dogfood.**
F5–F8 block the P0-A5 Finish-keep UX shipping. Severity letters are the review's own.
F2–F8 re-verified as landed in [reviews 003](./reviews/003.md) and [004](./reviews/004.md); **F1 and
F9 are re-opened by [review 004](./reviews/004.md)** — see **P0-A3-G1…G4**.

| ID | Fix | Review ref | Where | Blocks | Status |
|----|-----|-----------|-------|--------|--------|
| **P0-A3-F1** | Apply Cancel must not run a bare `git clean -fd`. Scope the discard to what the session wrote, and never run it before the "already restored?" verification | **B1** | `src/git/isolate.ts` | P0-A4, dogfood, sacred bar | **Done** (004 G1 + G4 closed the regression and the mid-walk predicate) |
| **P0-A3-F2** | Give `applying` and conflict a reachable exit: `try/finally { endApply }`; Cancel keyed on `applyPending()`; conflict stays `active` + marker refuse (no nest) | **B2 + B3** | `src/model/steps.ts`, `src/model/session.ts` | P0-A4, P0-A6 (10-c) | **Done** |
| **P0-A3-F3** | `pnpm test:ci` deterministically green — serialise files so `context.reset()` cannot race in-flight `take()` | **M8** | `vitest.config.ts` | every apply gate | **Done** |
| **P0-A3-F4** | Apply rows in the **sacred suite**: both `includeUntracked` settings + restore twice | **T2** | `test/integration/stash-roundtrip.test.ts` | P0-A4 | **Done** |
| **P0-A3-F5** | Delete `appliedRef` in `finalize` on verified Cancel | **M4** | `src/git/isolate.ts` | P0-A5 cleanup | **Done** |
| **P0-A3-F6** | Heartbeat across `applying` / open sessions (not only `active`/`reviewing`) | **M5** | `src/model/session.ts`, `src/index.ts` | P0-A5, drill §6.2 | **Done** |
| **P0-A3-F7** | Live `tabthrough.applyPending` via Reatom `computed` + `useAtomRef` | **M2** | `src/model/view.ts`, `src/ui/status-bar.ts` | P0-A5, §9.4 | **Done** |
| **P0-A3-F8** | Suppress virtual diff in apply; `sessionMode != 'apply'` on scheme Tab bindings | **M3** | `src/model/view.ts`, `package.json` | dogfood, §9.4 | **Done** |
| **P0-A3-F9** | Drift warning vs `applied` checkpoint, not HEAD | **M1** | `src/git/apply.ts` | dogfood | **Not closed.** Right anchor, wrong comparison — the checkpoint tree contains untracked files and the diff enumerates the index, so every step warns about every untracked path ([004 M1](./reviews/004.md), verified) → **G3** |
| **P0-A3-F10** | Correctness gaps: renames / mode-only / utf8 / deletion inference | **m1–m4** | `src/git/apply.ts` | P1 | Open |
| **P0-A3-F11** | Remaining §9.1 rows (clean edit-then-Tab, unsaved buffer, double-Tab, stub, real mid-write crash inject) | **T1, m7** | tests | dogfood | Partial (markers + drift + B2/B3/M4 covered). The crash-inject row is **not injectable**: `steps.ts` never passes `exec` to `applyGuideStep` ([004 T2](./reviews/004.md)) |
| **P0-A5-F1** | `finishApplyKeep` blocked branch → `blocked` (was illegal `restoring → active`) | **M7** | `src/model/session.ts` | P0-A5 ship | **Done** (verified in reviews 003 + 004) |

#### Review 004 fix items — gate on Phase 8 (P0-A4)

Filed by the Reviewer from [review 004](./reviews/004.md), the Phase 7 gate. **G1–G4 block P0-A4
and any dogfood** — Phase 8 always detaches at `base` and starts from the user's own dirty tree, so
it runs straight through all four. Severity letters are the review's own. G4 is the same defect as
**P0-A5-F4 / 003 M1** — one fix, not two.

| ID | Fix | Review ref | Where | Blocks | Status |
|----|-----|-----------|-------|--------|--------|
| **P0-A3-G1** | `verification.ok` must not short-circuit the HEAD restore — a read-only review of `HEAD` with a clean tree now ends on a **detached HEAD** and every ref is dropped, so nothing can bring it back. Require a settled head position alongside the verification; gate the discard on `!verification.ok`. **Regression, sacred path** | **B1** | `src/git/isolate.ts:528` | P0-A4, dogfood, sacred bar, v0.1 read-only | **Done** |
| **P0-A3-G2** | Apply-mode Tab is bound on `resourceScheme == 'file'` with no editor check, so Tab writes to disk in **every** file in the workspace instead of indenting — on by default, and it makes 002-B3's own "resolve the markers, then press Tab" instruction unusable. Drop the binding (§9.4 row 1 already expects `alt+]`), or gate it on a new `stepEditorFocused` key. Record the decision in §9.4 | **B2**, R-apply-8 | `package.json`, `test/unit/contributions.test.ts`, test-matrix §9.4 | P0-A4, dogfood | **Done** (dropped file-scheme Tab; apply uses `alt+]` / `alt+[`) |
| **P0-A3-G3** | Drift compared tree-to-tree (`writeWorkingTree` + `diff-tree`), not checkpoint-tree vs index; drop the per-path `cat-file -e` patch-up. Plus a test row with an untracked file present under both `includeUntracked` settings | **M1, T3** | `src/git/apply.ts:191`, `test/unit/apply-step.test.ts` | P0-A4, dogfood | Open |
| **P0-A3-G4** | `discardApplyWrites` scoped to paths the session actually wrote — the shipped predicate `!afterPaths.has(path)` deletes files the **user** authored mid-walk (**= P0-A5-F4 / 003 M1**; fix once) | **M5 / 003 M1** | `src/git/isolate.ts:491` | P0-A4, P0-A5 ship, dogfood | **Done** (remove only untracked paths tracked at `headBefore`) |
| **P0-A3-G5** | Clean-tree round trip in the **sacred suite** — commit entry and apply entry, asserting `symbolic-ref HEAD` names the original branch. Every existing head-movement row writes WIP first, which is why G1 shipped green. Highest-value missing test in the project; fails today | **T1** | `test/integration/stash-roundtrip.test.ts` | P0-A4 | **Done** (clean WT + clean commit-of-HEAD rows) |
| **P0-A3-G6** | An apply exception lands in `blocked`, which has no way back to the walk, so a transient `index.lock` costs the whole session. Make a pre-write `readStatus` failure a `refused` outcome (`reason: 'io'`) that stays `active`; only a throw after the first byte needs `blocked`. Full resume is Phase 10 task 10-c | **M2** | `src/model/steps.ts:299`, `src/model/session.ts` | dogfood | Open |
| **P0-A3-G7** | Minors: aborts reported as *"Apply failed"* (**M3**, `isAbort` re-throw); `endApply` not owner-scoped (**m1**); `next`/`previous` enablement lacks `!applyPending` (**m2**); `keybinding.useTab` description now false in apply mode (**m3**); restore-twice row skips the retry path (**m4**); no `view.applyPending` test (**m5**); `fileParallelism: false` is a mitigation and the suite costs 435 s (**m6**) | **M3, m1–m6** | see review | P1 | Open |

#### Review 003 fix items — gate on Phase 9 ship

Filed by the Reviewer from [review 003](./reviews/003.md). **F2–F5 block the Finish-keep ship.**
F6/F10 are Phase 10 inputs; F7–F9 block dogfood. Severity letters are the review's own. Five of
these were confirmed by executing the code against real temp repos, not only by reading it.

| ID | Fix | Review ref | Where | Blocks | Status |
|----|-----|-----------|-------|--------|--------|
| **P0-A5-F2** | A conflict must not be announced as "Apply complete" with a Finish button, and Finish must refuse a tree that still holds conflict markers (`hasConflictMarkers` already exists). Gate the completion offer on `canAdvance()`; better, have apply `next`/`prev` return a discriminated outcome instead of `boolean` | **B1** | `src/commands/index.ts`, `src/model/{steps,session}.ts` | P0-A5 ship | **Done** (`canAdvance` gate + Finish marker/unmerged refuse) |
| **P0-A5-F3** | `deactivate` must not run the destructive apply Cancel. Window close / reload skips D6's confirmation, discards the walk and deletes user-authored files; leave the token for Phase 10 recovery | **B2** | `src/index.ts`, `src/model/session.ts` | P0-A5 ship, zero-data-loss bar | **Done** |
| **P0-A5-F4** | `discardApplyWrites` must scope removal to paths **this session wrote**, not "absent from the pre-session capture" — the latter is every file the user authored mid-walk | **M1** | `src/git/isolate.ts` | P0-A5 ship, **P0-A4 inherits it** | **Done** (= G4) |
| **P0-A5-F5** | Post-Finish recovery copy: modal confirm on **Clean Up Backups** naming the pre-session stash; put `git stash apply <backupRef>` in the Finish message; `recoverBackup` on `done-kept` must refuse with that message instead of throwing `IllegalStageError` | **M2** | `src/model/session.ts`, `src/git/isolate.ts`, `src/commands/index.ts` | P0-A5 ship (R-apply-3) | **Done** |
| **P0-A5-F6** | The next Start silently overwrites the `done-kept` token, erasing the only pointer to the orphaned pre-session stash. Keep terminal kept-session records outside the single-slot key | **M3** | `src/git/{isolate,journal}.ts` | P0-A6 | Open |
| **P0-A5-F7** | Finish's `git add -A` stages the whole tree and never unstages it, contradicting D3's "ordinary unstaged files". Try the plain checkout first; on carry failure restore the index or disclose it | **M4** | `src/git/isolate.ts` | dogfood | Open |
| **P0-A5-F8** | Finish has none of the pre-checks Tab enforces: no unmerged-path refusal, no marker refusal, no drift | **M6** | `src/model/session.ts` | dogfood | **Partial** (unmerged + markers; drift still open) |
| **P0-A5-F9** | `IsolationHandle.token` mutable outside the graph; Finish is now a third writer (review 002 M6, still open) | **M7 / 002 M6** | `src/git/isolate.ts`, `src/model/{steps,session}.ts` | dogfood | Open |
| **P0-A5-F10** | A crash mid-carry (`finishing-keep`) recovers as Cancel, and the prompt says "did not finish restoring your work" to a user who asked to keep. Special-case the stage in `describeRecoveryPrompt`; first row of Phase 10's matrix | **M5** | `src/ui/recovery-prompt.ts`, crash matrix | P0-A6 | Open |
| **P0-A5-F11** | §9.2 test rows: Finish after conflict; apply `deactivate`; user-authored file survives Cancel/deactivate; `finishKeepFromToken` blocked branch (fix F1 is unasserted); incomplete walk; WT-entry Finish; Start / `restoreBackup` after `done-kept`; Finish with an unsaved buffer; assert no commit is created | **T1, m5** | `test/integration/apply-commit.test.ts` | P0-A5 ship (rows 1–4) | **Partial** (rows 1–3 landed; blocked-Finish / incomplete / WT / done-kept Start / unsaved / no-commit still open) |
| **P0-A5-F12** | Minors: two unused `LEGAL_TRANSITIONS` edges (`restoring→active`, `blocked→active`); duplicated applied-checkpoint implementation; Finish saves only step paths; "Finish Review" palette title in apply mode | **m1–m4** | see review | P1 | **Partial** (m1 edges dropped; Finish uses `writeAppliedCheckpoint`) |

### Track G — Finer guide steps / authoring quality

| ID | Item | Acceptance hint | Depends | Status |
|----|------|-----------------|--------|--------|
| P0-G1 | **Tighten agent skill + authoring guide** — force understand-the-patch; one thought/step; split distinct edits (helper vs consumer anti-pattern) | Checklist gate + worked example; dogfood sample yields ≥2 steps | — (docs only) | **Done** (skill + long-form + mirror; dogfood = P0-G3) |
| P0-G2 | **Golden fixture: mixed helper + refactor** — one change that must not be a single panel | Fixture + expected step count/ids for skill dogfood | P0-G1 | **Done** (`helper-consumer-refactor.diff` + split/merged guides; `test/unit/helper-consumer-fixture.test.ts`) |
| P0-G3 | **P1-2 dogfood re-gated on granularity** — agent guide for a real PR; reviewer reads only the guide **and** confirms no multi-thought panels | Replaces “any guide exists” as P1-2 pass | P0-G1, P0-G2 | **Done** (PASS — `helper-consumer.dogfood.guide.json`; ≥2 steps, helper→consumer, ranges; see iteration-log) |

**v0.2 milestone (PO):** P0-A1–A6 + P0-G1–G3; read-only mode remains supported.

---

## P1 — Fast follow (remainder of v0.2 / v0.3)

| ID | Item | Notes |
|----|------|-------|
| P1-1 | **`.guide.json` schema v1 + docs** — portable contract for agents | Described in [architecture/guide-schema.md](../architecture/guide-schema.md) and published as [`schema/guide-v1.json`](../../schema/guide-v1.json), which the reader is now diffed against on every run. **Remaining:** serve it at its `$id`, `https://tabthrough.dev/schema/guide-v1.json` — a DNS and hosting task, not a code one. The raw GitHub URL resolves in the meantime |
| P1-2 | **Agent skill / prompt** — emit guide sidecar when producing PRs | Draft landed. **Pass criteria upgraded:** P0-G3 (granularity), not merely “a guide exists” |
| P1-3 | **Stale guide merge** — partial sidecar + heuristic fill + one warning | Per-file interleaving of the heuristic remainder, which MVP appends wholesale; `scope.diffDigest` detection already exists |
| P1-4 | **LLM guide generator (BYOK)** — opt-in per session; provider config | Product brief: [guides/llm-guide-generation.md](../guides/llm-guide-generation.md). Off by default, per-session consent, key in `SecretStorage`, output is `.guide.json` v1 through the same validator and merge — no second format. Sequenced **after** P1-1/P1-2 (PO note below) |
| P1-5 | **PR entry via `gh`** — optional; fallback instructions without CLI | |
| P1-6 | **Peek-ahead decoration** — dim next related hunk | No rationale spoil |
| P1-7 | **Large diff compact mode** — file-level steps above LOC threshold | User setting; must not fight apply-mode “one thought” bar — compact is for *scale*, not for bundling thoughts |
| P1-8 | **Drift detection** — warn if files change on disk during session | Critical for apply mode; pull earlier once P0-A3 starts |
| P1-9 | **Rename-aware diff steps** | |
| P1-10 | **Settings panel** — keybinding hint, rationale toggle, LLM keys, **reveal/apply mode default** | |
| P1-11 | **Heuristic soft-split** — when cheap signals suggest definition + first use in one group, prefer separate steps | Does not replace skill; softens coarse offline guides |
| P1-12 | **Apply mode — commit range** | After single-commit + working-tree apply are solid |
| P1-13 | **Shift+Tab / Previous in apply mode** — safe revert of last applied step | **Designed** in ADR 0004 D5; **folded into P0-A3 / Phase 7** — do not schedule separately |


### PO order within P1 (2026-08-07, revised)

**Parallel with v0.2 P0 tracks:** P0-G* **Done**; P0-A1–A2 **Done** → P0-A3 **fixes for G1/G2/G4/G5 landed** ([review 004](./reviews/004.md); G3 still open) → A4 blocked until re-approved; A5 **F2–F5 landed** ([review 003](./reviews/003.md)). Dual re-review next.

**Then:** **P1-1 → P1-2 (re-gated by G3) → P1-3 → P1-8 (warn landed early in A3) → P1-5 → P1-7 → P1-11 → P1-4 → P1-6 → P1-9 → P1-10 → P1-12.** P1-13 folded into P0-A3.

Rationale unchanged on portable contract vs LLM. Guide granularity and apply-mode safety outrank peek-ahead and LLM. Drift detection (P1-8) starts as warn-only in Phase 7.

---

## P2 — Later

| ID | Item | Notes |
|----|------|-------|
| P2-1 | Multi-root workspace support | |
| P2-2 | GitLab/Bitbucket remote helpers | |
| P2-3 | Export/share guide (markdown) | Onboarder persona |
| P2-4 | Opt-in telemetry — session completion, no code content | |
| P2-5 | Team guide cache / shared sidecars | |
| P2-6 | Step annotations / personal notes | |
| P2-7 | Semantic dependency order (language-aware) | |
| P2-8 | Review resume without full restore (advanced) | High risk; needs design |

---

## Edge-case budget (summary)

| Tier | Count | Rule |
|------|-------|------|
| **P0 (v0.1)** | 10 cases | Must implement + test; blocks release |
| **P0 (v0.2 apply)** | +3 cases | Crash mid-apply, abort after edits, conflict on user-edit — see product.md |
| **P1** | 7+ cases | Target v0.2; don't slip into MVP unless trivial |
| **P2** | 6 cases | README “known limitations” only |

Full matrix: [specs/product.md](../specs/product.md#edge-case-budget)

---

## Recommended implementation sequence (Planner input)

Phased in detail — with exit criteria, test gates, risks, and module layout — in **[plan.md](./plan.md)**.

0. P0-0 (toolchain: deps, Reatom, generated meta, vitest)  
1. P0-1, P0-8 (foundation)  
2. P0-5, P0-6, P0-7 (safety)  
3. P0-9, P0-10, P0-15 (guide engine)  
4. P0-2, P0-3, P0-4 (entry points) — parallel with phase 3  
5. P0-11, P0-12, P0-13, P0-14 (UX loop)  
6. P0-16 (edge hardening)  
7. P1 docs-only track parallel after phase 3 green  
8. **v0.2:** Architect P0-A1 **Done** ∥ P0-G* **Done** → Planner P0-A2 **Done** → Implementer Phase 7 (P0-A3) **reopened: G1–G4** ∥ Phase 9 (P0-A5) **reopened: F2–F5** → A4 → A6; v0.1 manual drills stay on Marketplace path, and **P0-A3-G1 regresses that path** — fix before any v0.1 drill is re-run
