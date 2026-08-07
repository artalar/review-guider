# Iteration Log

## 2026-08-07 — Iteration 0: Bootstrap (prior branch)

- Prior agent on `cursor/guide-reviewer-extension-fbe4` seeded product docs
- Cherry-picked into `cursor/guide-reviewer-33d9`

## 2026-08-07 — Iteration 1: Orchestrator bootstrap

- Branch: `cursor/guide-reviewer-33d9`
- Installed Reatom skills (`reatom`, `reatom-async`, `reatom-jsx`, `reatom-review`) via `npx skills add reatom/reatom`
- Synced skills to `.agents/skills/` and `.cursor/skills/`
- Process + role docs under `work-docs/process` and `work-docs/roles`
- Product docs already approved (PO Iteration 0): MVP = stash-safe Tab + heuristic/sidecar; LLM/agent P1
- Next: Planner + Architect (strong models) in parallel

## Product Owner — 2026-08-07 (accepted)

- Published `specs/product.md`, `progress/backlog.md`, ADR `0001-mvp-scope.md`
- **PO recommendation:** P0-1 → P0-8 → P0-5 (safety) before entry points; freeze `.guide.json` shape early

## Planner — 2026-08-07

- Published `progress/plan.md`: 7 phases (0 toolchain → 1 foundation → 2 safety → 3 guide engine → 4 entry points → 5 UX loop → 6 edge hardening), each with exit criteria and a test gate. Every P0 maps to exactly one phase.
- Added **P0-0 (toolchain)** as a Planner-identified prerequisite: the template does not currently typecheck (`src/config.ts` and `src/utils.ts` import `src/generated/meta`, which `vscode-ext-gen` has not produced), and `@reatom/core` is not a dependency yet. No feature phase has a working gate until this lands.
- Backlog now carries **Phase** and **Status** columns plus a parallel-track table.
- Risk register (9 entries, ordered by expected cost). Top three: **R2 stash conflict/data loss** (round-trip suite is a merge blocker for all later phases), **R5 reveal rendering** — VS Code decorations cannot hide lines, so a spike is required before P0-12 commits and `dim` is the default fallback — and **R1 Tab keybinding conflicts**, structurally mitigated by rendering into a read-only virtual document on its own URI scheme.
- Load-bearing architectural constraint proposed for the Implementer: nothing under `src/git/`, `src/guide/`, or `src/model/` imports `vscode`, so the safety and ordering suites run under plain vitest with no extension host.
- Handed **[ARCH]** markers to the Architect: Reatom scope lifetime vs `defineExtension` and disposal ordering, the repo-level session lock mechanism, the final Tab `when` clause, and `.guide.json` v1 shape (blocks P0-15).
- **Next:** Implementer slice = Phase 0 in full + P0-1 (git probe with discriminated result, `guideReviewer.gitUsable` context key, disabled Start command). Stash pipeline explicitly deferred to its own review pass. Tester track B (`test/helpers/tmp-repo.ts`) should start in parallel — it is on the critical path for Phase 2.

## Architect — 2026-08-07

Published `architecture/overview.md`, `architecture/reatom-model.md`, `architecture/guide-schema.md`, and ADR `0002-architecture.md`. Track C is complete; P0-8 and P0-15 are unblocked. Docs only — no `src/` changes.

**Reveal strategy (closes R5 without a spike).** Decorations cannot delete lines, so the reveal document is *built* rather than annotated: a read-only virtual document on the `guide-reviewer` scheme whose content is `renderReveal(baseText, file, revealedGroups)` — a pure fold of base text plus the line groups revealed so far — diffed against a static base document. Unrevealed lines are absent, not dimmed, and the native diff editor supplies gutter markers and highlighting. `guideReviewer.reveal.mode: "dim"` is retained as the planned fallback, sharing the same provider, URIs, and `LineGroup` data; only the fold differs, so the pre-Phase-5 spike shrinks to a one-file comparison.

**Safety protocol — one change of substance from the plan.** Before anything is mutated, a temp-index snapshot (`GIT_INDEX_FILE=… read-tree HEAD; add -A; write-tree; commit-tree`) captures tracked *and* untracked state into an immutable commit at `refs/guide-reviewer/after/<id>`. That, not the stash, is the actual never-lose-WIP guarantee, and it happens before the first mutation. Two refs with two jobs: the after-ref is read to render review content; `refs/guide-reviewer/backup/<id>` (the stash-shaped commit) is what restore applies, because only it preserves the staged/unstaged split. Restore stays apply → verify → drop, exactly as the plan specified. `add -A` honours `.gitignore`, keeping us on the right side of R8.

**Entry points unified.** Working tree, single commit, and range all resolve to an immutable `(base, after)` commit pair, and the working-tree entry is stashed like the others rather than special-cased. The consequence is real and PO-visible — reviewing your current changes hides them from disk for the session — but it means one restore path serves all three entries, the reviewed content cannot drift, and the safety suite exercises the common entry rather than skipping it.

**Answers to the four `[ARCH]` handoffs:**

1. *Reatom scope lifetime.* There is nothing to create. Atoms are module-level in the implicit global context; `context.start` is for tests and SSR. `context.reset()` is forbidden under `src/` — it rejects wrapped promises with abort errors, which during an in-flight restore is the one outcome the safety design exists to prevent. Disposal order at `deactivate` is load-bearing: context keys off, drain the restore against a ~4 s budget, *then* dispose the reactive-vscode scope. Disposing first would unsubscribe the projections mid-restore.
2. *Repo-level lock.* Compare-and-swap on `refs/guide-reviewer/lock` — `git update-ref <ref> <sha> 000…0` fails atomically if the ref exists. Cross-process, cross-window, no filesystem-semantics reasoning, inspectable with `for-each-ref`. Breaking a stale lock is always an explicit user action.
3. *Tab `when` clause.* Finalised in overview §7.2. `resourceScheme == 'guide-reviewer'` is the structural mitigation. Dropped `!editorHasSelection` (breaks select-then-Tab, and selection has no Tab meaning in a read-only doc) and `!editorReadonly` (read-only is exactly what makes Tab safe to take). Added `!parameterHintsVisible`, `!renameInputVisible`, `!accessibilityModeEnabled`, `!editorTabMovesFocus`, and a config gate.
4. *`.guide.json` v1.* Frozen. Steps anchor with file line ranges, not hunk offsets, and ranges *intersect* line groups rather than containing them — so groups stay atomic, coarse anchors are good enough, and the coverage invariant is checkable. Hard errors reject the whole document with one warning; soft errors keep it and record diagnostics; unknown fields are ignored so a 1.1 doc works in a 1.0 reader.

**Reatom model shape.** Probes are `computed` + `withAsyncData` (`git.capability`, `git.repoStatus`, per-file `baseText`, `recovery.token`); mutations are `action` + `withAsync` with an explicit abort strategy per action (`session.start/finish/cancel`, `recovery.restore`). Restore paths never receive an abort signal — cancellation is a safety feature on reads and a hazard on writes. Status is a plain atom with one guarded transition action rather than `reatomEnum`, whose generated setters would be a second unguarded write path. Steps are frozen plain data; only `cursor` and async data are atoms, so Tab is synchronous. The bridge holds exactly one subscription, to `ui.reviewViewModel`, which also touches the next step's `baseText` so lookahead warming falls out of the dependency graph rather than a prefetch scheduler.

**Deltas the Planner and Implementer should note:** `refs/guide-reviewer/after/<id>` and the lock ref are new artifacts for Phase 2; `src/guide/` gains `groups.ts`, `render.ts`, `schema.ts`, `merge.ts`, and `src/model/` gains `ports.ts` and `view.ts`; `guideReviewer.reveal.mode` becomes `'progressive' | 'dim'` with `progressive` default; the recovery token lives in `globalState` keyed by repo root (not `workspaceState`), which is what lets a second window see it.

- **Next:** unchanged — Implementer starts Phase 0 + P0-1. Reviewer should apply `reatom-model.md §12` (12-item anti-pattern checklist) from the first Reatom slice; the silent-failure item is W5, an atom read placed after an `await` inside a `computed`.
