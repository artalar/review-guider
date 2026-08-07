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

## Implementer — 2026-08-07 — Phase 3: guide engine (P0-9, P0-10, P0-15)

Shipped `src/guide/` as twelve pure modules and 184 unit tests. The layer imports nothing but itself — no `vscode`, no `@reatom/core`, no node builtin — and `test/unit/guide-purity.test.ts` asserts that rather than trusting it, alongside a no-`any` check. `pnpm lint && typecheck && test:ci` are green.

**What landed.** `types.ts`, `parse-diff.ts`, `groups.ts`, `render.ts` (P0-9); `heuristic.ts`, `steps.ts` (P0-10); `schema.ts`, `sidecar.ts`, `merge.ts` (P0-15); plus `sha256.ts` and `text.ts`, which exist only because the pure layer may not import `node:crypto` and the digest recipe in guide-schema.md §7 has to reproduce a shell pipeline byte for byte.

**Exit criteria.** The parser handles every awkward case the plan lists and never throws on malformed input. The foundation-before-consumer fixture orders `types.ts` → `service.ts` → `Component.tsx` → `service.test.ts`. Ordering is stable across runs *and* independent of the order files arrive in. A binary file yields a visible stub step that keeps `k/n` honest. The valid `.guide.json` fixture reorders steps and `dependsOn` refines that order further. An invalid one falls back to the heuristic with exactly one warning.

**Five decisions the docs left open, and how they were resolved.** Each is a place the frozen specs were silent or self-contradictory, so the Architect should confirm or overrule:

1. **Significance is per-signal, not per-line.** overview.md §3.2 calls the score "additive over the changed lines". Read literally, a twenty-line body edit scores 20 and every large hunk is `critical`, which makes the bucket boundaries meaningless. Each signal now contributes its weight at most once per group, so the score says *what kinds of change* a group contains and a three-line signature change outranks a thirty-line body edit. Buckets are unchanged.
2. **A generated file with content is not a stub.** The tier table maps tier 6 to a stub step with rationale "Skipped: generated", but a stub carries no groups, and dropping a lockfile's groups would violate I1 — the lines would be revealed by nothing. Stub steps are now produced only for files with no revealable content at all (binary, mode-only). A generated *text* file keeps its lines and is ordered last with rationale "Generated output — skim only"; `files: { "pnpm-lock.yaml": { "significance": "skip" } }` remains the way to spend no attention on it, which is what §3.6 intends.
3. **`LineGroup` gained `oldAnchor` and `newAnchor`.** Purely additive to the frozen §3.1 shape. Without them, a pure addition and a pure deletion cannot be totally ordered against each other inside a hunk (their only ranges live on different sides), and `renderReveal` cannot place an insertion. The id format is unchanged and now literally derives from the two anchors.
4. **A bad enum value is a hard error.** §8 lists "a required step field is missing or the wrong type" as `invalid-document` but says nothing about an optional field carrying an unknown enum value. Silently defaulting `significance: "urgent"` to `"normal"` would misrepresent the author's intent, so it rejects the document. Length limits (`title`, `notes`, `summary`) go the other way and are accepted: the published JSON Schema is the author's lint, and the reader is deliberately lenient so a 1.1 document works in a 1.0 reader.
5. **`renderReveal` gives a pure deletion an empty range.** `RevealRender.groupRanges` has no way to say "these lines are gone"; a revealed deletion occupies nothing in the reveal document. It now returns `end === start - 1` anchored where the lines used to be, so the decoration layer can distinguish "nothing to highlight" from "not revealed" — the latter is simply absent from the map.

Two smaller notes for whoever wires this up: `mergeWithNext` folds a step into its successor *in the same file*, and reports `merge-no-successor` when the next step is in a different file, because v1 steps never span files. And `mergeGuide` enforces I1 rather than asserting it — anything the anchor and fallback passes leave unclaimed is appended as a trailing per-file step, so a malformed guide can cost the reader an ordering opinion but never a line.

**Not in this slice, by design:** reading the sidecar off disk (the reader is injected as `SidecarSource`), and anything that needs a `ReviewDiff` from a real repository. Phase 4 supplies both; `parseNameStatusZ` is here ready for it.

- **Next:** Phase 4 can consume `parseUnifiedDiff(patch, nameStatus)` directly. Phase 5's document provider needs only `renderReveal(baseText, file, revealedGroups)` and the `groupRanges` map. Track E is unblocked — the v1 reader now exists and its behaviour matches `architecture/guide-schema.md` section by section.

## Implementer — 2026-08-07 — Phases 0, 1, 2 (P0-0, P0-1, P0-5, P0-6, P0-7, P0-8)

`pnpm lint && typecheck && test:ci` green: **320 tests**, 15 files, ~6s. Phase 2's exit criteria are met in code and in automation; three manual drills are written but not yet run against a packaged build.

**Phase 0.** Extension identity (`artalar.guide-reviewer`), the five settings from the plan plus `guideReviewer.reveal.mode` as the Architect's `'progressive' | 'dim'`, `@reatom/core` v1001 in `devDependencies` so tsdown bundles it, `vscode-ext-gen --scope guideReviewer`, `vitest.config.ts`, and `test:ci`.

**Phase 1.** `src/git/exec.ts` is one injectable `spawn` wrapper — arg arrays, never `shell: true`, explicit `cwd`, timeout, `AbortSignal`, and a locale-stable non-interactive environment — and every git call in the codebase goes through it, which is what makes the unit probe tests possible against recorded output. `probe.ts` returns the discriminated capability. `src/model/` holds the status machine with one guarded transition action, and `ports.ts` defines Store/Ui/Clock so the model never imports `vscode`. The boundary is enforced twice: ESLint `no-restricted-imports` per directory, and `test/unit/import-boundaries.test.ts`, which reads the source rather than trusting the config.

**Phase 2.** The protocol is capture → journal → mutate, and restore is apply → verify → drop, as specified. Notable in the implementation: the journal stage is written *before* the operation it names, so a token found at stage X means at most X happened, and that single property is what makes recovery a lookup rather than a guess.

**Nine bugs the suites caught, all of them in code that read correctly.** Listing them because each one is a place where the tests were load-bearing rather than confirmatory:

1. `throwAbort()` inside a `take` selector means *"not this value, keep waiting"*, not *"cancel"*. A declined pre-flight hung forever. The abort now happens after the take resolves.
2. `atom(fn)` is the `computed` overload, so `guideSource` was calling the guide source as a derivation instead of holding it. It is boxed in an object now — worth knowing before Phase 3 writes to that atom.
3. A second Start while a review was running rejected correctly and *then* unwound the first session's isolation. Failure handling now only undoes isolation the failed frame itself created.
4. A clean tree skips the stash, so the journal has to allow `captured → checkedout`. It only allowed `captured → stashed`.
5. `git status --porcelain=v2` collapses an untracked directory to a single `? dir/` record, which made the restore digest blind to *which* files inside came back. Status now runs with `--untracked-files=all`, and the round-trip fingerprint is genuinely sensitive to untracked content.
6. Restore keyed its "nothing was captured" shortcut on the journal stage, so a restore interrupted after writing `restoring` was permanently blocked on retry. It keys on the token payload now, and `finalize` deletes the after-ref unconditionally so the ref cannot outlive a crash in the window before the journal names its commit.
7. The recovery gate in `startSession` read `recoveryPending`, a `computed` + `withAsyncData` whose cached value is only as fresh as its last subscriber. A gate standing between the user and unrestored work cannot depend on someone being subscribed, so it reads the journal directly.
8. **The worst of the nine.** The recovery token is *written* keyed on the repository root and was *read* keyed on the workspace folder. Open `packages/app` inside a monorepo, or reach the repo through a symlink — which is every macOS temp path — and the two differ, so recovery silently never fired. Both sides now use the probed root. There is a regression test that opens a subdirectory.
9. `hash-object -t tree /dev/null` resolved the empty tree for a root-commit entry. There is no `/dev/null` on Windows, and the well-known SHA-1 constant it fell back to is wrong in a SHA-256 repository. It hashes empty stdin now.

One piece of dead code went with them: `session#<id>.trace` was an atom nothing subscribed to, so its connect hook never fired and the `effect` inside it never ran. `connectLogger` already traces named atoms, which is all it was trying to add.

**Two deliberate deviations from the frozen docs**, both for the Architect to confirm or overrule:

1. *The lock is checked before the pre-flight, not only inside `isolate`.* The compare-and-swap on `refs/guide-reviewer/lock` is still the only real protection — the early read is advisory and racy by construction. It exists so the user is never asked to approve a stash that cannot possibly proceed.
2. *A blocked restore is a terminal state that keeps everything, including the lock.* ADR 0002 D5 says breaking a lock is always an explicit user action, and **Clean Up Backups** therefore skips the lock ref. The consequence is that a hard crash plus a lost `globalState` needs `git update-ref -d` by hand; it is logged as a known gap rather than papered over with an automatic break.

**Testing shape.** `test/helpers/protocol.ts` drives the isolation protocol by hand and stops at any journal stage — including the three crash windows *inside* a stage, where the journal announced an operation that never ran. That is how the crash matrix is produced deterministically, with no process killing and no test-only hooks in `isolate`. Coverage: 17 round-trip fixtures, 10 crash states, 11 lifecycle paths, and the journal transition table exhaustively.

**Not in this slice, by design.** Phase 3's guide engine is another agent's; `session.start` consumes it through `guideSource`, which currently holds a stub emitting one step per changed file so the safety suites have something honest to walk. Phase 5's reveal is absent — `src/model/view.ts` carries the projection the bridge will read, and `openReview` on `UiPort` is a logged no-op.

- **Next:** Phase 4 wires the three entry commands; `planIsolation` already resolves all three entries to a `(base, after)` pair, so what is missing is the command surface and the real diff. Whoever lands Phase 3 should write `guideSource` as `{ build }`. Before MVP, someone with a keyboard must run the three drills in `progress/test-matrix.md` §5.
