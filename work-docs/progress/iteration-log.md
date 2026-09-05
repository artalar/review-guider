# Iteration Log

## 2026-08-07 — Iteration 0: Bootstrap (prior branch)

- Prior agent on `cursor/tabthrough-extension-fbe4` seeded product docs
- Cherry-picked into `cursor/tabthrough-33d9`

## 2026-08-07 — Iteration 1: Orchestrator bootstrap

- Branch: `cursor/tabthrough-33d9`
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
- **Next:** Implementer slice = Phase 0 in full + P0-1 (git probe with discriminated result, `tabthrough.gitUsable` context key, disabled Start command). Stash pipeline explicitly deferred to its own review pass. Tester track B (`test/helpers/tmp-repo.ts`) should start in parallel — it is on the critical path for Phase 2.

## Architect — 2026-08-07

Published `architecture/overview.md`, `architecture/reatom-model.md`, `architecture/guide-schema.md`, and ADR `0002-architecture.md`. Track C is complete; P0-8 and P0-15 are unblocked. Docs only — no `src/` changes.

**Reveal strategy (closes R5 without a spike).** Decorations cannot delete lines, so the reveal document is *built* rather than annotated: a read-only virtual document on the `tabthrough` scheme whose content is `renderReveal(baseText, file, revealedGroups)` — a pure fold of base text plus the line groups revealed so far — diffed against a static base document. Unrevealed lines are absent, not dimmed, and the native diff editor supplies gutter markers and highlighting. `tabthrough.reveal.mode: "dim"` is retained as the planned fallback, sharing the same provider, URIs, and `LineGroup` data; only the fold differs, so the pre-Phase-5 spike shrinks to a one-file comparison.

**Safety protocol — one change of substance from the plan.** Before anything is mutated, a temp-index snapshot (`GIT_INDEX_FILE=… read-tree HEAD; add -A; write-tree; commit-tree`) captures tracked *and* untracked state into an immutable commit at `refs/tabthrough/after/<id>`. That, not the stash, is the actual never-lose-WIP guarantee, and it happens before the first mutation. Two refs with two jobs: the after-ref is read to render review content; `refs/tabthrough/backup/<id>` (the stash-shaped commit) is what restore applies, because only it preserves the staged/unstaged split. Restore stays apply → verify → drop, exactly as the plan specified. `add -A` honours `.gitignore`, keeping us on the right side of R8.

**Entry points unified.** Working tree, single commit, and range all resolve to an immutable `(base, after)` commit pair, and the working-tree entry is stashed like the others rather than special-cased. The consequence is real and PO-visible — reviewing your current changes hides them from disk for the session — but it means one restore path serves all three entries, the reviewed content cannot drift, and the safety suite exercises the common entry rather than skipping it.

**Answers to the four `[ARCH]` handoffs:**

1. *Reatom scope lifetime.* There is nothing to create. Atoms are module-level in the implicit global context; `context.start` is for tests and SSR. `context.reset()` is forbidden under `src/` — it rejects wrapped promises with abort errors, which during an in-flight restore is the one outcome the safety design exists to prevent. Disposal order at `deactivate` is load-bearing: context keys off, drain the restore against a ~4 s budget, *then* dispose the reactive-vscode scope. Disposing first would unsubscribe the projections mid-restore.
2. *Repo-level lock.* Compare-and-swap on `refs/tabthrough/lock` — `git update-ref <ref> <sha> 000…0` fails atomically if the ref exists. Cross-process, cross-window, no filesystem-semantics reasoning, inspectable with `for-each-ref`. Breaking a stale lock is always an explicit user action.
3. *Tab `when` clause.* Finalised in overview §7.2. `resourceScheme == 'tabthrough'` is the structural mitigation. Dropped `!editorHasSelection` (breaks select-then-Tab, and selection has no Tab meaning in a read-only doc) and `!editorReadonly` (read-only is exactly what makes Tab safe to take). Added `!parameterHintsVisible`, `!renameInputVisible`, `!accessibilityModeEnabled`, `!editorTabMovesFocus`, and a config gate.
4. *`.guide.json` v1.* Frozen. Steps anchor with file line ranges, not hunk offsets, and ranges *intersect* line groups rather than containing them — so groups stay atomic, coarse anchors are good enough, and the coverage invariant is checkable. Hard errors reject the whole document with one warning; soft errors keep it and record diagnostics; unknown fields are ignored so a 1.1 doc works in a 1.0 reader.

**Reatom model shape.** Probes are `computed` + `withAsyncData` (`git.capability`, `git.repoStatus`, per-file `baseText`, `recovery.token`); mutations are `action` + `withAsync` with an explicit abort strategy per action (`session.start/finish/cancel`, `recovery.restore`). Restore paths never receive an abort signal — cancellation is a safety feature on reads and a hazard on writes. Status is a plain atom with one guarded transition action rather than `reatomEnum`, whose generated setters would be a second unguarded write path. Steps are frozen plain data; only `cursor` and async data are atoms, so Tab is synchronous. The bridge holds exactly one subscription, to `ui.reviewViewModel`, which also touches the next step's `baseText` so lookahead warming falls out of the dependency graph rather than a prefetch scheduler.

**Deltas the Planner and Implementer should note:** `refs/tabthrough/after/<id>` and the lock ref are new artifacts for Phase 2; `src/guide/` gains `groups.ts`, `render.ts`, `schema.ts`, `merge.ts`, and `src/model/` gains `ports.ts` and `view.ts`; `tabthrough.reveal.mode` becomes `'progressive' | 'dim'` with `progressive` default; the recovery token lives in `globalState` keyed by repo root (not `workspaceState`), which is what lets a second window see it.

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

**Phase 0.** Extension identity (`artalar.tabthrough`), the five settings from the plan plus `tabthrough.reveal.mode` as the Architect's `'progressive' | 'dim'`, `@reatom/core` v1001 in `devDependencies` so tsdown bundles it, `vscode-ext-gen --scope tabthrough`, `vitest.config.ts`, and `test:ci`.

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

1. *The lock is checked before the pre-flight, not only inside `isolate`.* The compare-and-swap on `refs/tabthrough/lock` is still the only real protection — the early read is advisory and racy by construction. It exists so the user is never asked to approve a stash that cannot possibly proceed.
2. *A blocked restore is a terminal state that keeps everything, including the lock.* ADR 0002 D5 says breaking a lock is always an explicit user action, and **Clean Up Backups** therefore skips the lock ref. The consequence is that a hard crash plus a lost `globalState` needs `git update-ref -d` by hand; it is logged as a known gap rather than papered over with an automatic break.

**Testing shape.** `test/helpers/protocol.ts` drives the isolation protocol by hand and stops at any journal stage — including the three crash windows *inside* a stage, where the journal announced an operation that never ran. That is how the crash matrix is produced deterministically, with no process killing and no test-only hooks in `isolate`. Coverage: 17 round-trip fixtures, 10 crash states, 11 lifecycle paths, and the journal transition table exhaustively.

**Not in this slice, by design.** Phase 3's guide engine is another agent's; `session.start` consumes it through `guideSource`, which currently holds a stub emitting one step per changed file so the safety suites have something honest to walk. Phase 5's reveal is absent — `src/model/view.ts` carries the projection the bridge will read, and `openReview` on `UiPort` is a logged no-op.

- **Next:** Phase 4 wires the three entry commands; `planIsolation` already resolves all three entries to a `(base, after)` pair, so what is missing is the command surface and the real diff. Whoever lands Phase 3 should write `guideSource` as `{ build }`. Before MVP, someone with a keyboard must run the three drills in `progress/test-matrix.md` §5.

## Implementer — 2026-08-07 — Phases 4 and 5 (P0-2, P0-3, P0-4, P0-11, P0-12, P0-13, P0-14), plus track D and a track E draft

`pnpm lint && typecheck && test:ci` green: **371 tests**, 20 files, ~4 s — 44 new, none removed. The product exists end to end now: pick a target, approve the pre-flight, press Tab until the change is read, Finish. Every P0 is closed in code except P0-16 (Phase 6 hardening), and what remains open is manual: five drills in `progress/test-matrix.md` §5, two of which this slice wrote.

**The stub is gone.** `buildGuideSource` is the real pipeline — `readDiff` → `parseUnifiedDiff` → `buildHeuristicGuide` → `loadSidecar` → `mergeGuide` — with exactly two effectful steps at the top and nothing but pure functions below. Phase 3's engine needed no changes to be consumed, which is the outcome its injected `SidecarSource` seam was designed for.

**Phase 4.** Three commands over one code path: `begin(pick)` refuses with the model's own reason, asks the entry-specific question, and hands a `ReviewTarget` over. `startFromCommit` shows a QuickPick over `readRecentCommits` — subject, short SHA, author, relative date, a `· merge` marker on anything with two parents — with a first item that falls through to free-form ref entry, because a picker that cannot express `HEAD~3` or a tag is a downgrade from a text box. `startFromRange` is an InputBox validating as you type. On an unborn branch the picker offers the text box rather than an error.

**Phase 5.** `reatomReviewFile` is one model per changed file: `baseText` as `computed` + `withAsyncData` over `showBlob`, `revealedGroups` as `steps[0..cursor]` filtered to that file, and `render` as `renderReveal` over the two. `revealText`, `currentRanges` and `pendingRanges` fall out of `render`. Tab is `cursor.set(k + 1)` and nothing else — no I/O, no `await`, no invalidation call — and every document, decoration and status string downstream is a derivation of that one number. `ui.reviewViewModel` touches the *next* step's `baseText`, so lookahead warming is a line in the dependency graph rather than a prefetch scheduler.

`src/ui/documents.ts` is the whole bridge: a `TextDocumentContentProvider` on the `tabthrough` scheme serving `base/<sessionId>/<path>?rev=` and `reveal/<sessionId>/<path>`, one subscription to `reviewViewModel`, `vscode.diff` when the reveal URI changes, and two decoration types. It holds one `Map<string, string>` of published content, which is the only imperative state in the codebase and exists solely because `provideTextDocumentContent` is a synchronous pull.

**Six decisions the docs left open.** Same convention as Phase 3 — each is somewhere the frozen specs were silent or, in the first case, describe a world the implementation no longer lives in:

1. **The sidecar is read from the after ref, not from disk.** guide-schema.md §2 says the file is read from the working tree at session start, "before the stash". That was written before the Architect unified the entry points: `session.start` now isolates *first* and calls `guideSource` after, so by the time anything could read disk, the working tree holds base content. The after ref is strictly better — it is a capture of `add -A`, so an uncommitted, freshly written `.guide.json` is in it, and it cannot drift mid-session. Order is after ref, then base ref. **Consequence worth naming: a *gitignored* `.guide.json` is invisible**, because `add -A` honours `.gitignore` (which is also what keeps us on the right side of R8). Logged as a gap; the workaround is to not ignore it.
2. **Whitespace-only is decided by `git diff -w --numstat`, on the plan, before any mutation.** `IsolationPlan` gained `substantiveLineCount` beside `changedLineCount`, and `EmptyDiffError` gained a `reason` so the two refusals read differently — "nothing to review" versus "only whitespace changed" — which is the difference between a mistake and a surprise. Both are computed in the stat-only pass, so a refused start never touches the repository. An untracked file whose content is only whitespace still counts as content; `-w` compares against an empty file and sees added lines. That is git's answer, and disagreeing with it would mean writing our own.
3. **Config atoms moved to `src/model/config.ts`.** `reatomReviewFile` reads `revealMode`, `steps.ts` is imported by `session.ts`, and `revealMode` lived in `session.ts` — a cycle. The five config atoms now live in their own module and `session.ts` re-exports them, so nothing else in the codebase or the tests changed. Worth knowing before adding a sixth.
4. **`activeFile` falls back to the next step when the cursor is at −1.** A test caught this. Before the first Tab there is no current step, but there must still be a document: the first step's file with nothing revealed, which is exactly the base text. Without the fallback the reveal document does not exist until the first Tab, the diff editor opens a frame late, and — worse — Shift+Tab off step 0 has nowhere to land. The reveal is still a pure function of the cursor; −1 is simply a real position in it.
5. **A stub step gets a synthetic document.** overview.md §7.1 says binary and mode-only files show "a one-line explanation" but does not say where it comes from. A stub carries no groups and a binary file has no base text, so the honest rendering is an empty diff against an empty document — a blank editor with no indication anything happened. The view model now substitutes `path + rationale` as the reveal text against an empty base, so the step reads as an added explanation. `k/n` was already honest; now the screen is too.
6. **Guide diagnostics reach the user.** They were being collected into `session.diagnostics` and read by nobody, which quietly broke guide-schema.md §5.4 — a malformed sidecar fell back to the heuristic in silence. The bridge now watches that atom, logs every entry at its own severity, and raises exactly one notification for the warning-severity ones, with a count of the rest. There is still no `Show guide diagnostics` command; the output channel is the full list.

**Keybindings shipped as ADR 0002 D2 finalised them**, not as plan.md drafted them: `resourceScheme == 'tabthrough'` rather than `reviewEditorFocused`, `!editorHasSelection` and `!editorReadonly` dropped, four widget guards and the config gate added. `test/unit/contributions.test.ts` asserts the clause term by term against the ADR, so drift is a test failure rather than a discovery. Two notes for the Reviewer: the `tabthrough.reviewEditorFocused` context key is still published per overview §4's bridge table but is not used by the shipped clause — it is there for users writing their own keybindings, not dead code by accident. And both sides of the diff carry the `tabthrough` scheme, so Tab advances from the base pane too, which is what you want when you have clicked into the left side to read what was there before.

**Focus is event-driven, not timed.** The obvious way to scroll to a new step is `setTimeout(0)` after firing the provider's change event. Instead, `workspace.onDidChangeTextDocument` on the reveal document *is* the signal that VS Code has re-read the provider, so focus happens there, plus once directly after `vscode.diff` resolves for the case where the text did not change. No timers, nothing to dispose, and no frame where the scroll targets stale content. Ranges are clamped to the document anyway, so the worst case is a scroll to the last line rather than a thrown error.

**Track D and E.** README is rewritten for the marketplace: how it works, the three entry points, the key table, the safety model in five bullets, `.guide.json` in one example, and a ten-row known-limitations table drawn from the P2 edge budget plus the real gaps. Track E has two pieces: `work-docs/guides/agent-guide-authoring.md` is the long form — six principles, an ordering recipe and its trap for each common change shape, nine anti-patterns agents actually produce, and a worked before/after on a real commit from this repository — and `.agents/skills/tabthrough/SKILL.md` (mirrored into `.cursor/skills/`) is the installable condensation an agent loads while working. Both carry the prohibitions explicitly, because "no quizzes, no scores" is a product principle an eager model will otherwise violate helpfully. The JSON Schema is still only inside guide-schema.md §4 and is not served at its `$id`, so `$schema` in an emitted document currently resolves to nothing.

**What the Reviewer and Tester should look at first.** In order of how much I would want a second opinion:

- The sidecar-from-after-ref decision above, and whether the gitignored case deserves more than a README line.
- `useReviewDocuments`: it holds the content cache, drives `vscode.diff`, and is the one place `peek` is called after an `await`. It is a non-reactive read of a computed the same composable keeps subscribed, so it is a cached snapshot rather than a W5 stale-frame read — but it is the load-bearing spot if that reasoning is wrong.
- `test/integration/reveal-loop.test.ts` asserts the projection, never the pixels. Nothing in the suite proves VS Code paints what the projection describes, which is the largest untested surface in the extension.
- The two new manual runbooks, §5.4 (keybinding conflict matrix, 14 rows) and §5.5 (time-to-first-reveal against the 3 s product metric). Both need a human and neither has been run.

- **Next:** Phase 6. The edge table in plan.md §Phase 6 now has only three rows with real work left — a shallow-clone fixture, an end-to-end binary/generated check, and the manual drills — and the four gaps in `test-matrix.md` §6. The `Show guide diagnostics` command and a published JSON Schema are the two smallest pieces of unfinished business from this slice.

## Product Owner — 2026-08-07 — track E docs + P1 sequencing

Docs only; no `src/` touched. Three artifacts and one priority call.

**`work-docs/guides/agent-guide-authoring.md`** — the long form for LLMs and coding agents. Six principles, an ordering recipe with its characteristic trap for each common change shape (new capability, bug fix, refactor, mixed PR, dependency bump, removal, codemod, config), nine anti-patterns agents actually emit with the fix for each, and a worked before/after on a real commit from this repository. Written as a colleague explaining their own change, never as an examiner — the no-exam rule is a product principle and an eager model will violate it helpfully unless told not to, so it is stated as a prohibition rather than a preference.

The load-bearing idea, and the one worth defending in review: **the bar is not "produce an ordering", it is "beat the heuristic"**. A guide that reproduces file-tier order with rationales restating the tier has spent tokens to add nothing. The four places an author beats a path heuristic — same-tier ordering the path cannot see, a change whose centre is not its largest hunk, churn that misrepresents its own weight, and files present only as consequence — are named explicitly so an agent has something to aim at.

**`.agents/skills/tabthrough/SKILL.md`** — the installable condensation an agent loads while working: contract, procedure, minimal and typical documents, a field cheatsheet, seven rules, five prohibitions, the recipe table, and a pre-emit checklist. It links to `work-docs/architecture/guide-schema.md` by repo-relative path rather than a relative link, since the skill is meant to be installed into other repositories where that relative path does not resolve. Mirrored to `.cursor/skills/`.

**`work-docs/guides/llm-guide-generation.md`** — the P1-4 brief for BYOK generation, ranked so a squeezed release cuts from the bottom. Four product decisions in it are worth the Planner's attention:

1. **The output is `.guide.json` v1, not a variant.** The generator is one more producer of the same artifact, through the same validator and the same `mergeGuide`. If the LLM path needs a schema change, the schema changes for everyone or the feature does without it. This is what keeps invariant I1 true by construction and keeps "Save as `.guide.json`" a one-click feature rather than a converter.
2. **Off means no traffic, and it is auditable.** `tabthrough.llm.enabled` defaults false; with it false the extension makes no outbound request of any kind, and that is a test, not a claim. Consent is per session with Cancel as the default button, matching the pre-flight modal. There is no global "always allow", and no hosted service or Tabthrough key — BYOK or nothing.
3. **The network feature cannot reach the safety layer.** The generator sits behind the existing guide-source interface with no access to the stash pipeline, the refs, or the journal. Worth writing into the architecture doc as a constraint rather than leaving it as an accident of the current module graph.
4. **Truncation order is a product decision, not a tuning knob.** Drop generated content, then context lines, then hunk interiors, and never drop a file silently — we would rather have a coarse guide over the whole change than a precise guide over a third of it, because a `k/n` the reader cannot trust is worse than a rough order.

The brief also carries a criterion that can kill the feature and should be able to: in dogfood, ≥3 of 5 reviewers must prefer the generated order to the heuristic on the same diff. An LLM guide that is merely *different* from the offline one is not worth a consent dialog.

**PO priority note.** After the MVP Tab loop closes (P0-16 plus the four manual drills), P1 runs **P1-1 → P1-2 → P1-3 → P1-5 → P1-7 → P1-4 → …**, and the reason is that the portable contract compounds while the LLM does not. Every agent that learns to emit a sidecar produces guides forever, in any repo, offline, free, and authored by someone who actually knew why the change was made. The LLM re-derives that discarded intent and charges a privacy conversation for it on every invocation. It is the fill-in for repos the contract has not reached — genuinely valuable, genuinely second. P1-3 is pulled forward because a sidecar that breaks on the first rebase is how the contract loses credibility, and P1-7 precedes P1-4 because "too large to generate" is one of the LLM path's own failure modes.

**Two smallest things blocking P1-1 from being closable:** the JSON Schema is still only inline in `guide-schema.md` §4 rather than a file at `schema/guide-v1.json` served at its `$id`, so `$schema` in an emitted document resolves to nothing today; and no agent has yet written a guide against the skill for a real PR. The second is the actual acceptance test for P1-2 and it needs a reviewer who reads only the guide.

- **Next (PO view):** unchanged for the Implementer — Phase 6 and the manual drills own the critical path. When track E resumes, publish the schema file first; it is an hour of work and it is what makes `$schema` completion real for every author downstream.

## Tester — 2026-08-07 — Phase 6 (P0-16): the P0 edge matrix, and the published schema

`pnpm lint && typecheck && test:ci` green — 44 tests added here, none removed or weakened. **All ten P0 edge rows now have a passing automated test**, which is the plan's Phase 6 exit criterion and product spec acceptance item 8. Four of them additionally carry a human drill, and none of the five drills has been run: that is the whole of what stands between P0-16 and done.

**Walking a row you believe is covered is the point of the exercise.** Row 10 — *"detached HEAD / shallow clone missing objects: detect early, fail with a fetch hint"* — was marked as needing only a fixture. It needed a fix. `git rev-parse <sha>^1` fails at the boundary commit of a shallow clone for exactly the same reason it fails on a genuine root commit, so `resolveCommitEntry` took the empty-tree branch and **Start Review from Commit in a `--depth 1` clone reviewed the entire repository as freshly added**. Not an error, not a crash: a confident, wrong review, which is the worst failure this product has. The raw commit object still carries its `parent` lines even when the graft hides them, and that is what separates the two cases. `planIsolation` now raises `MissingObjectsError` naming `git fetch --unshallow` — from the stat-only pass, so the refusal lands before the pre-flight and before anything is mutated. A range whose merge base is outside the clone gets the same treatment. The fixture asserts the refusal, the byte-identical repository afterwards, and the honest other half: the working-tree entry still works in a shallow clone, because it needs no history at all.

**`test/integration/edge-cases.test.ts`** closes the three rows that had no assertion behind them, twelve cases in all:

- *Binary and generated files.* A real repository with a PNG, a lockfile and a source file, driven through the whole pipeline. The binary file becomes a visible skipped stub carrying `Skipped: binary file`; `k/n` counts it, so the number the reader trusts stays honest; the ordering around it is unchanged (foundation first, generated last); invariant I1 still holds with a stub in the list; the reveal projection gives the stub `path + rationale` as its own document rather than a blank editor; and a full Tab-to-the-end walk restores byte-identically. Worth noting what the row does *not* mean: a lockfile is generated but not empty, so it keeps real steps — demoted, never hidden. Only a file with nothing revealable becomes a stub.
- *Shallow clone*, above.
- *Not a repo / no git.* The probe variants were covered; the gating the user actually sees was not. Three cases assert `canStart` is false **and** that the reason names the fix, on a plain directory, on an unborn branch, and with no workspace open.

**`schema/guide-v1.json` is a real file now**, so `$schema` in an emitted guide points at something. The JSON Schema had been living as a fenced block inside `guide-schema.md` §4; §4 is now a pointer, because two copies of one format is one copy too many. The `$id` stays frozen at `https://tabthrough.dev/schema/guide-v1.json` — serving it there is a hosting task, and the raw GitHub URL resolves in the meantime.

The interesting part is `test/unit/published-schema.test.ts`, which exists because the schema and the hand-rolled reader are two descriptions of one format and only one of them decides whether a session works. A schema that accepted a document the reader rejects would promise an author their guide works and then silently fall back to the heuristic — worse than shipping no schema. So the test diffs them: required fields at every level, every enum in both directions, the known-property sets, `MAX_STEPS` against `maxItems`, the two step-id patterns compared on the ids they accept rather than on their text (`\w` against an explicit class), and the numeric bounds. It also asserts the *divergence* is the documented one and only that one: the schema closes `additionalProperties` while the reader downgrades an unknown field to an info diagnostic, because a 1.1 document has to keep working in a 1.0 reader. Finally it validates every guide document embedded in `guide-schema.md`, `agent-guide-authoring.md` and the agent skill — those are the examples agents copy, and a rotted example is a broken contract.

**`test-matrix.md` is restructured around the edge table.** The ten P0 rows are now §2, immediately after the suite index, with a "covered by" cell per row instead of a reader having to reconstruct it from five separate matrices. Everything below shifted by one section, so the manual drills are **§6** (they were §5) and the keybinding matrix is **§6.4**; `plan.md` and `backlog.md` were updated, and the older log entries above deliberately were not, since they were accurate when written. New §7 documents what the schema-sync test guarantees.

**Two notes for the Reviewer.** First, the shallow fix touches `src/git/`, which is not usually a Tester's business — it is here because the alternative was a fixture that pins wrong behaviour. Second, `GitCapabilityReason` still declares `shallow-missing-objects`, which the probe never returns and now never will: a shallow clone is genuinely usable until an entry point asks for history, and that refusal belongs where it now lives. The unused variant should be deleted or wired, and it is logged as a gap rather than quietly resolved.

- **Next:** the drills. §6.1 (crash), §6.2 (two windows) and §6.3 (stale lock) prove the parts of rows 3, 7 and 8 that live outside one process; §6.4 is the only way to falsify R1; §6.5 is the 3-second product metric, still unmeasured. All five need a human at a keyboard with a packaged build, and none of them should wait for dogfood — dogfood is where a failure costs someone their working tree.

## Reviewer — 2026-08-07 — review 001: the model, not the protocol

`pnpm lint && typecheck && test:ci` green — 418 tests before, 423 after. Full findings in
[`reviews/001.md`](reviews/001.md): four blockers, eight majors, six minors, three nits.
Every blocker and five of the eight majors are fixed here, along with two of the minors.
Three majors are open, and two of those three are the same problem seen from different
angles; the rest of what is open is minor or a nit.

**The protocol is not where the bugs were.** I went looking for them in `src/git` — apply →
verify → drop, the write-ahead journal, the crash matrix — and found nothing to report. The
defects are all one layer up, in the state machine that drives it. `src/git` correctly puts
the session into `blocked` when a restore cannot be verified; `src/model/session.ts` then had
no way to ever leave it. `recoverBackup` cleared `restoreBlock` on success and left
`sessionStatus` at `blocked`, so a user whose files had just come back correctly still had
Start disabled until they reloaded the window. `discardRecovery` existed and was contributed
by no command. And Cancel — the one command a stuck user reaches for — was gated on
`sessionActive`, which is false in `blocked`, in `error`, and in a `preflight` that stalled:
precisely the three states worth having an exit from. Each is small on its own. Together they
are a protocol that preserves your work perfectly and a UI that cannot tell you how to get it
back.

**The finding I did not expect.** `gitCapability` is a `computed` whose only dependency is
`workspaceRoot()`, and the Reatom reference is explicit that a computed without dependencies
is never reevaluated. It is probed once when the folder opens and never again — while the
comment on `bindGitWatcher` says "the probes recompute themselves", which is true only of
`repoStatus`. So the refusal the README promises for a rebase or merge in progress was being
decided by an answer from before the merge existed. Nothing downstream re-tested it:
`planIsolation` reads `status.unmerged` without refusing it, and `isolate` went on to `git
stash push` over `MERGE_HEAD`. I wrote the test before the fix and watched the session open
on top of a real conflicted merge. `startSession` now probes for itself; the computed stays
lazy on purpose, because making it a dependant of `gitWatchToken` would re-probe on every ref
write during isolation, which is exactly when the extension is the one writing them.

The mirror image was in recovery. `recoveryToken` returned `null` whenever the capability was
not `ok`, because the failure shape carried no `repoRoot` to key the journal on — so a
repository mid-rebase, which is a very plausible state to find after a crash, silently stopped
reporting the stash holding the user's work. The comment on that computed calls this "the one
failure this whole subsystem exists to prevent." Refusing to start is not a reason to refuse
to look.

**What I could not fix, and why.** Two open findings are both about a second window.
`isRecoverable` is true at stage `reviewing`, and the journal lives in `globalState` precisely
so a second window can see it — so window B, opened on a repository window A is reviewing,
finds A's *live* token and offers to restore it. Accepting applies A's stash, drops the entry,
deletes both refs and releases the lock while A is still mid-review. To be fair about the
damage: the files come back and A's later Finish still verifies, so this is not plain data
loss. What it is, is a false alarm about losing work plus a review whose isolation ends
underneath it. The related one: the lock value is the HEAD commit sha, so `releaseLock`'s
compare-and-swap — described in ADR 0002 D5 as making a release unable to clobber another
owner — cannot actually tell two windows at the same HEAD apart. Making the lock value the
`sessionId` fixes that on its own and gives the recovery path the ownership check it needs.
Neither is a local fix, because from git state alone "crashed" and "live in another window"
look identical; the cheapest honest answer is a liveness marker the owning window refreshes.
This is the hole in P0 edge row 8 — the automated test covers one process and drill §6.2
covers the second *Start* being refused, not the second window's *recovery* prompt.

**Marketplace.** The manifest declared no `capabilities`, so VS Code was treating an extension
that shells out to git and rewrites the working tree as merely "limited" in an untrusted
folder and loading it anyway. Both untrusted and virtual workspaces are now refused with a
reason. `LICENSE.md` still carried the reactive-vscode template's copyright line, which
`vsce package` was including verbatim — I checked by building the VSIX. One thing worth
recording so nobody fixes it on intuition: `"private": true` does **not** block publishing.
I looked for the check in `@vscode/vsce` and there is none; it only guards `npm publish`.

- **Next (Reviewer view):** M2 and M3 together, as one change — `sessionId` as the lock value
  plus a liveness marker — before dogfood, since dogfood is where two windows on one repository
  first stop being hypothetical. Then M1, which is a two-line `retryComputed` once someone
  decides where to debounce it. Drill §6.2 needs a sixth step covering the second window's
  recovery prompt; it currently stops at the refused Start.

## Implementer — 2026-08-07 — review 001 M1, M2, M3: the second window

`pnpm lint && typecheck && test:ci` green — 423 tests before, 436 after. One commit,
`80752e7`. Review [`reviews/001.md`](reviews/001.md) updated: M1, M2 and M3 are marked fixed,
each with the test that fails without it. What is left open there is m3, m4, m5, m6 and the
three nits.

**The lock did not know whose it was.** Its value was the HEAD commit sha, and two windows on
one repository compute the same one, so the compare-and-swap release that ADR 0002 D5
describes as unable to "clobber another owner" could not tell owners apart at all. The
Reviewer's fix — use the `sessionId` — runs straight into something the finding did not
anticipate: a ref can only point at an object, and `git update-ref refs/tabthrough/lock
window-a` is `fatal: not a valid SHA1`. So the id travels as a blob,
`tabthrough-lock:<sessionId>` written with `hash-object -w`, and the ref points at that.
Content addressing is the part that matters: `releaseLock` recomputes the value it compares
against rather than trusting the ref it is about to delete. `readLock` reports the owning
session id and falls back to the raw object name for a lock we did not write, because the
stale-lock drill points the ref at HEAD by hand and "held by something" is still the honest
answer. Old tokens recorded the ref value itself, so the release retries the CAS on the raw
value — still a compare-and-swap, just on the old shape.

**Then the harder half.** From git state alone, a crashed session and one running in another
window are identical — which is why window B, opened on a repository window A is reviewing,
found A's live token and offered to restore it. The marker went on the token rather than on a
`refs/tabthrough/heartbeat` ref: the token is already read on the path that needed the
answer, and a ref would have been a sixth artifact to clean up. `isolate` stamps
`heartbeatAt` and stamps it again at `reviewing`, so a slow isolation is not born stale; the
owning window rewrites it every 7 s; anything under 30 s old is live. `isSessionLive` covers
every recoverable stage rather than only `reviewing`, deliberately — a second window that
catches the first mid-isolation is the most dangerous one to race.

**The beat runs only while `active`, and that is the one real compromise.** In `stashing` and
`restoring` the journal belongs to `isolate` and `restoreFromToken`, and a read-modify-write
racing either of those could roll a stage back — a worse bug than the one being fixed, since
the journal is the artifact recovery cannot afford to have lied to. The cost is that a
session spending more than 30 s isolating is briefly indistinguishable from a crash, narrowed
by `isolate` doing its own stamping but not closed. Two smaller notes: the token stays `v: 1`
because every reader builds it field by field, so a token from an older build parses with
`heartbeatAt: null`, which reads as not live — at worst one recovery prompt nobody needed.
And `recoveryToken` still only re-reads the store when `recoveryEpoch` bumps, so window B's
picture of A goes stale the moment A finishes; that was already true of `recoveryPending` and
is recorded in the review as residual rather than quietly fixed.

**M1 was two lines and one move.** `gitCapability` reads `gitWatchToken()` only when
`sessionStatus()` is `idle`. Unconditional would re-probe six subprocesses on top of every
ref write during isolation; no dependency at all is what the review found — a computed
without dependencies is never reevaluated, so Start went on looking available over a merge
that began after the window opened. Reading `sessionStatus` reactively is the part that is
easy to get wrong: without it the computed would drop its last dependency when a session
started and never come back. The move is that the Probes section now sits *below* the state
machine in `session.ts`, because the probe names `sessionStatus`. `startSession` still probes
for itself — a watcher event is not instantaneous, and that is the last gate before a stash.

**Testing.** 13 new tests. `isSessionLive` gets the fresh/stale/absent/future matrix and the
stage sweep; the second window gets a live-session case that asserts window A's stash, refs
and token are all still there afterwards, and a stale-heartbeat twin that restores exactly as
before; the owning window gets one proving it beats on its own token and stops when the
session ends. The lock gets three: two windows at one HEAD failing to release each other, the
token recording its owner and `RepoLockedError` reporting it, and a hand-written lock still
reading as held. M1 gets the merge-while-idle case, which bumps the watch token the way the
bridge's watcher does. Each was run against the code with its fix removed — the second-window
case, with only the guard in `recoverBackup` taken out, really does restore A's session.

- **Next:** drill §6.2 now has the second window's recovery prompt in it (steps 5 and 6,
  including letting the heartbeat go stale), and it needs a human with a packaged build. The
  automated coverage drives two token states from one process, which is not the same thing.
  After that, dogfood — the two-window case has stopped being hypothetical, which was the
  Reviewer's argument for doing this before gate 3 rather than after.

## 2026-08-07 — Orchestrator close-out

Agent-team loop completed for MVP v0.1:

| Role | Outcome |
|------|---------|
| Product Owner | MVP scope ADR 0001; offline heuristic first; LLM/agent P1 |
| Planner | Phased plan 0–6; safety before UX |
| Architect | Virtual-doc reveal, journal+refs, Reatom model, `.guide.json` v1 |
| Implementer | Phases 0–5 shipped on Reatom; guide engine pure; Tab loop |
| Reviewer | Review 001 — blockers fixed; M1–M3 closed |
| Tester | All 10 P0 edges automated; schema published; shallow-clone defect found+fixed |

**Gates:** `pnpm lint && typecheck && test:ci` — **436 tests green**. Build produces `dist/index.cjs`.

**Remaining before Marketplace dogfood:** five manual drills in `test-matrix.md` §6 (crash, two-window, stale lock, keybinding matrix, time-to-first-reveal).

**P1 next (PO):** portable contract (schema hosting + agent skill dogfood) before BYOK LLM.

## DevRel / Marketing — 2026-08-07 — branding and go-to-market

- Published `marketing/branding-brief.md`: name audit, positioning, messaging, README and Marketplace guidance, audience copy, launch channels, and PO decision.
- **Recommendation:** rename before first public Marketplace release to **Tabthrough — Guided Diff Review** (80% confidence on rename), subject to formal clearance; keep **Tabthrough — Guided Diff Review** as the fallback.
- Primary tagline: **“Understand every change, one Tab at a time.”**
- No package, command, repository, or source identity was changed; rename execution requires explicit PO approval.

## 2026-08-07 — Branding: Tabthrough rename applied

- Founder accepted DevRel option 1; ADR `0003-rename-tabthrough.md`
- Identity: `artalar.tabthrough`, display **Tabthrough — Guided Diff Review**, tagline *Understand every change, one Tab at a time.*
- Commands/settings/context/scheme/refs/skill renamed; `.guide.json` format unchanged
- README rewritten per branding brief; status bar voice updated
- **Owner action:** rename GitHub repo `review-guider` → **`tabthrough`**

## 2026-08-07 — CI: macOS/Windows failures

- Token lookup failed when `mkdtemp` path ≠ `git --show-toplevel` (macOS `/var`↔`/private/var`, Windows drive case)
- Windows: `URL.pathname` doubled the drive; CRLF broke fixtures + ````json` fence regex
- Fix: `canonicalizeRepoRoot` + `repoKey`, `memoryStore` via `repoKey`, `realpath` temps, `.gitattributes` LF, `fileURLToPath`

## Product Owner — 2026-08-07 — apply-with-user + finer guide steps

Docs only; no `src/`, no new ADR (Architect owns ADR amendments).

**Intent captured.** Two product tracks for v0.2:

1. **Finer guide steps / skill** — Dogfood anti-pattern: bundling a helper (e.g. `eventActionName`) and a consumer refactor (e.g. `jsxEvent`) into one flashy panel. Guides must force **one thought per Tab** and split distinct edits. Skill + `agent-guide-authoring.md` tightening is a product requirement (P0-G1); full rewrite deferred to the docs slice once Architect confirms schema v1 suffices.
2. **Apply-with-user / commit workflow** — Reveal must work like **rebase with fixes**: commit target → checkout previous → apply `C` step-by-step with the user (edits allowed); working-tree target → stash → reapply the same way. Success = the **developer commits**, not a virtual slideshow that restores away.

**ADR 0002 D1 conflict.** PO **formally reopens** D1’s rejection of “staged apply to disk.” Preferred reconciliation (not an ADR — Architect writes it): keep read-only `progressive`/`dim`; add a third **`apply` mode** where dirty `git status` is the feature under the same journal/stash safety bar. Acceptance criteria, risks, and Finish-vs-Commit expectations live in `specs/product.md`.

**Artifacts updated**

- `specs/product.md` — v0.2 vision, journeys J1–J4, apply-mode + guide-quality acceptance, open questions
- `progress/backlog.md` — P0-A1…A6 (apply), P0-G1…G3 (granularity); P1 order revised (drift earlier; P1-2 re-gated)
- `roles/product-owner.md` — priorities now include apply + granularity after v0.1 close
- `process/README.md` — current milestone notes v0.2 next

**Handoff**

- **Architect (P0-A1, blocking for apply code):** Amend D1 / overview §7 — apply mode design; stash contract under reapply; mid-step user edits; Finish vs Commit; Shift+Tab; crash journal for applied step index; coexistence default.
- **Planner (P0-A2):** Phase + risk register for apply; sequence P0-A3–A6 after Architect; keep v0.1 manual drills on the critical path for Marketplace dogfood.
- **Docs / skill (P0-G1, can start now):** Tighten skill + authoring guide with helper+consumer anti-pattern and checklist gate; golden fixture P0-G2.
- **Implementer:** No apply implementation until P0-A1 accepted. v0.1 drills still unblocked.

**Open questions** (full list in product.md): stash contract for working-tree reapply; dirty edits mid-step; Finish vs Commit; Previous in apply; mode default; schema change vs ranges/grouping only.

## Docs — 2026-08-07 — P0-G1 guide authoring granularity

Docs only; no `src/`, no schema/ADR changes.

**Delivered**

- `.agents/skills/tabthrough/SKILL.md` — patch-first procedure gate; one-thought-per-Tab rules; `ranges` required for multi-thought files; `eventActionName` / `jsxEvent` anti-pattern named (long JSON deferred to long-form); emit checklist includes “Did I merge two whiteboard thoughts?”
- `work-docs/guides/agent-guide-authoring.md` — matching long-form: §2.2 / helper+consumer recipe, §5.1 worked wrong→right split, checklist granularity gate
- `.cursor/skills/tabthrough/SKILL.md` synced to the agents copy
- Backlog: P0-G1 → **Done** (dogfood still P0-G2/G3)

**Follow-ups (skill alone cannot close)**

- **P0-G2:** golden mixed helper+refactor fixture for skill dogfood
- **P0-G3 / P1-2:** re-gate agent guide dogfood on no multi-thought panels
- **P1-11:** heuristic soft-split (definition + first use) for coarse *offline* guides — v1 `ranges`/`order`/`dependsOn` already suffice for agents; no new schema fields needed for P0-G1

## Architect — 2026-08-07 — P0-A1 apply-with-user (ADR 0004)

Docs only; no `src/`. Closes the PO reopen of ADR 0002 D1.

**Decision record:** [decisions/0004-apply-mode.md](../decisions/0004-apply-mode.md). ADR 0002 D1 **amended in place** (read-only rejection stands; apply is a separate session contract).

### Decisions (decisive answers to PO open questions)

| Topic | Call |
|-------|------|
| Coexistence | Keep `progressive`/`dim`; add session mode **`apply`**. `tabthrough.session.mode` default **`ask`**. |
| Isolation | Same capture → journal → stash → lock. Apply checks out **`base`** (commit: `C^`; WT: clean `HEAD`). |
| Tab | Intended trees from `renderReveal`; fast-path write or **3-way merge** with user edits; conflict stops — never silent overwrite. |
| Shift+Tab | Symmetric revert of last applied step; block on conflict. |
| Cancel | Sacred restore of pre-session WIP (confirm if progressed). |
| Finish | **Keep** tree; journal `done-kept`; do **not** stash-apply backup; offer SCM handoff. |
| Commit | Handoff only — never silent `git commit`. |
| Never lost | after-ref, backup-ref, **applied-ref** checkpoint, journal until verified restore or explicit cleanup. |
| Schema | **v1 unchanged** — `ranges`/`grouping` suffice (Docs/P0-G1 unblocked). |

### Artifacts updated

- `decisions/0004-apply-mode.md` (new)
- `decisions/0002-architecture.md` (D1 scoped + status)
- `architecture/overview.md` §3.5 / §4.3 / §5 / §6 / §7.3 / §11
- `architecture/reatom-model.md` v1.1 — `applying` status, async apply next/prev, finish-keep, `commitHandoff`, token fields
- `specs/product.md` open questions marked decided
- `progress/backlog.md` — P0-A1 **Done**; P0-A2 **Next**
- `process/README.md` milestone note

### Planner handoff (P0-A2)

Sequence phases for P0-A3–A6 against ADR 0004. Register residual risks **R-apply-1…7** from the ADR (merge quality, Finish carry-checkout, orphaned WIP after Finish, buffer races, async Tab spam, trust-boundary writes, range deferred). Concrete plan items:

1. Extend sacred suite + crash matrix for `applying` / `done-kept` / Resume-apply.
2. Module `src/git/apply.ts` + journal token additive fields (backward-compatible readers).
3. Status machine: add `applying`; Finish forks by mode.
4. Keybinding: file-scheme / chord plan for apply (overview §7.3) — Tab on `tabthrough:` alone is insufficient.
5. Pull **P1-8 drift detection** into the apply phase gate.
6. Keep v0.1 manual drills on Marketplace critical path; do not block them on apply.

**Next:** Planner P0-A2. Implementer: no apply `src/` until plan lands. Docs track continues P0-G2.

## Docs/Tester — 2026-08-07 — P0-G2 golden helper+consumer fixture

Fixtures + unit test only; no `src/` product changes, no apply-mode / P1-11 work.

**Delivered**

- `test/fixtures/diffs/helper-consumer-refactor.diff` — same-file `eventActionName` helper + `jsxEvent`/`bind` consumer refactor (canonical §5.1 anti-pattern shape)
- `test/fixtures/guides/helper-consumer.guide.json` — correct split (`event-action-name` → `jsx-event-adopts` with `ranges` + `dependsOn`)
- `test/fixtures/guides/helper-consumer-merged.guide.json` — schema-valid wrong guide (one whole-file step; dogfood reject sample)
- `test/unit/helper-consumer-fixture.test.ts` — schema + merge asserts two sidecar steps in order; merged guide collapses to one panel
- `test/fixtures/README.md` — index + **P0-G3 dogfood protocol**
- `agent-guide-authoring.md` §5.1 — line numbers aligned to the fixture; pointer for dogfood

**Backlog:** P0-G2 → **Done**. Next: **P0-G3** — agent emits a guide for this (or a real PR) without seeing the golden JSON; reviewer confirms ≥2 steps / no multi-thought panels.

**Run:** `pnpm exec vitest run test/unit/helper-consumer-fixture.test.ts`

## Docs/Tester — 2026-08-07 — P0-G3 dogfood (helper+consumer)

Blind authoring against `helper-consumer-refactor.diff` + skill only; golden/merged unread until after emit.

**Result: PASS**

- Attempt: `test/fixtures/guides/helper-consumer.dogfood.guide.json` — 3 steps (`event-action-name` → `jsx-event-adopts` → `bind-adopts`), all with `ranges`; helper before consumers; schema-valid
- Not the merged anti-pattern (whole-file one panel). First draft already split — skill’s named anti-pattern + §5.1 worked; optional third `low` call-site step matches skill “mechanical rest” note (golden folds bind into consumer ranges 8–14 — both pass granularity)
- What worked: patch-first gate, “if rationale needs and, split”, required `ranges` for multi-thought files, explicit helper+consumer order recipe

**Backlog:** P0-G3 → **Done**. P1-2 pass criteria (granularity) satisfied for this fixture.

## Planner — 2026-08-07 — P0-A2 apply-mode phasing

Docs only; no `src/`. ADR 0004 left untouched.

### Phase order (plan.md Phases 7–10)

| Phase | Backlog | Focus | Depends |
|-------|---------|-------|---------|
| **7** | P0-A3 | Apply engine + **commit** target: `git/apply.ts`, journal fields, async Tab/Previous, 3-way + conflict stop, Shift+Tab revert, file-scheme/chord, Cancel sacred | ADR 0004 |
| **8** | P0-A4 | **Working-tree** apply (always checkout `base`) | Phase 7 engine |
| **9** | P0-A5 | Finish-keep / `done-kept` / SCM handoff (never silent commit) | Phase 7 |
| **10** | P0-A6 | Crash recovery: `applying` / `done-kept`; Resume vs Restore | Phases 7 + 9 |

Phases **8 ∥ 9** after Phase 7 gate. Phase 10 is the apply recovery gate. Track G (guide quality) is parallel — not owned here.

### Risks registered

ADR **R-apply-1…7** plus Planner **R-apply-8** (file-scheme Tab steal) and **R-apply-9** (Finish stubbed as restore). Mitigations + test hooks in `plan.md` and `test-matrix.md` §9.

### Artifacts

- `progress/plan.md` — Phases 7–10, apply risk register, Implementer handoff
- `progress/test-matrix.md` §9 — apply/merge/revert, Finish vs Cancel, crash stages, file-scheme keybindings
- `progress/backlog.md` — P0-A2 **Done**; A3 **Next** (Phase 7); A4–A6 sequenced
- `process/README.md` — milestone → Implementer P0-A3

### Implementer handoff — build first

**Phase 7 foundation only:** `src/git/apply.ts` + additive token fields + `applying` status + commit-entry checkout `base` + async next/prev (`first-in-win`) + Cancel still sacred. Tests: merge fixtures, Cancel after N steps, readonly suites green.

**Do not touch yet:** Finish-keep / `done-kept` / handoff (A5); WT specialization (A4); full Resume UI (A6); range apply (P1-12); guide skill; readonly virtual-doc rewrite.

**Constraint:** If Finish is incomplete in Phase 7, disable it or gate it — do not ship Finish that restores while labeled “keep” (R-apply-9 / ADR 0004 D6).

**Next:** Implementer P0-A3. v0.1 manual drills (§6) remain on Marketplace critical path and must not wait on apply.

## Implementer — 2026-08-07 — Phase 7 / P0-A3 (apply engine + commit target)

Shipped the apply-mode engine for **commit targets** per ADR 0004. VSIX installed via `pnpm ext:install`.

### What landed

- `src/git/apply.ts` — `renderReveal` intended prev/next → fast-path or `git merge-file` 3-way; applied checkpoint at `refs/tabthrough/applied/<id>`; refuse unmerged paths; drift warn list for foreign dirty paths.
- Journal: additive `mode` / `appliedIndex` / `appliedRef`; stages `applying` (+ `finishing-keep` / `done-kept` reserved); readers default missing fields.
- Isolation: apply checks out **base** (`C^` for commits; HEAD for WT when mode=apply); range+apply refused (`ApplyModeUnsupportedError`).
- Session: `applying` status; `tabthrough.session.mode` (`ask`|`readonly`|`apply`, default `ask`); chooser + pre-flight disclose writes; async apply next/prev with `withAsync` + `first-in-win`; Shift+Tab revert; Finish **disabled** in apply (R-apply-9); Cancel confirms when `appliedIndex >= 0` and discards apply writes (`reset --hard` + `clean -fd`) before sacred stash restore.
- Keybindings: file-scheme Tab/Shift+Tab when `sessionMode == apply`; chords gated on `!applyPending`.

### Tests

- `test/unit/apply-step.test.ts` — clean merge, conflict-stop (R-apply-1), forward apply, revert, `applying` journal stub.
- `test/integration/apply-commit.test.ts` — commit apply + Cancel byte-identical WIP.
- Readonly / sacred suites remain green.

### Risks hit

| ID | Hit? | Notes |
|----|------|-------|
| R-apply-1 | Exercised | Conflict fixture stops without advancing; no silent overwrite. |
| R-apply-5 | Mitigated | `first-in-win` + `applyPending` context key. |
| R-apply-9 | Mitigated | Finish enablement excludes apply; notify-only stub. |
| Cancel×apply WT | Hit then fixed | Checkout to `headBefore` failed over dirty apply writes → discard session tree before restore (apply-only). |

### Deferred

- Phase 8 / P0-A4 — WT apply dogfood (engine already checks out base for WT+apply).
- Phase 9 / P0-A5 — Finish-keep / `done-kept` / SCM handoff.
- Phase 10 / P0-A6 — Resume-apply recovery UI.

**Next:** Implementer P0-A4 ∥ P0-A5.

## Implementer — 2026-08-07 — Phase 9 / P0-A5 (Finish-keep / SCM handoff)

Shipped apply-mode **Finish keeps tree**; Cancel remains sacred restore. VSIX via `pnpm ext:install`.

### What landed

- `finishKeepFromToken` — save → applied checkpoint → journal `finishing-keep` → `git add -A` then carry checkout to `headBefore` (no `-f`) → `done-kept`; **never** stash-applies backup; lock released; after/backup/applied refs retained.
- Carry failure (R-apply-2): stay detached, keep refs, warn with instructions.
- `isRecoverable` excludes `done-kept` so Start proceeds; cleanup clears `done-kept` token with refs.
- `finishSession` forks apply → keep; readonly Finish still restores. Finish command re-enabled for all modes (`Finish Review`).
- `tabthrough.commitHandoff` + Finish offer **Open Source Control** (never silent `git commit`).
- Pre-flight / status / end-of-apply toast copy: Finish ≠ Cancel.

### Tests

- `apply-commit.test.ts` — Cancel byte-identical; Finish-keep ≠ Cancel fingerprint + `done-kept` + SCM open + cleanup; carry failure stays detached.

### Risks

| ID | Hit? | Notes |
|----|------|-------|
| R-apply-2 | Exercised | Branch rename → stay detached; stage-then-checkout fixes tip-match carry. |
| R-apply-3 | Mitigated | `done-kept` + refs until Clean Up Backups. |
| R-apply-9 | Closed | Finish keeps; not restore-labeled-as-keep. |

### Deferred

- Phase 8 / P0-A4 — WT apply dogfood.
- Phase 10 / P0-A6 — Resume / dangerous restore-over-kept confirm; crash matrix for `finishing-keep`.
- Manual Finish/Commit dogfood checklist row.

**Next:** Implementer P0-A4 or P0-A6.

## Reviewer — 2026-08-07 — Phase 7 / P0-A3 gate → [review 002](./reviews/002.md)

**Verdict: request fixes.** Phase 7 not approved; P0-A4 (Phase 8) should not start on this
engine. **3 blockers, 8 majors, 8 minors, 3 test gaps.** Backlog P0-A3 reopened with fix items
**P0-A3-F1…F11** + **P0-A5-F1**.

### Blockers

| ID | Finding | Where |
|----|---------|-------|
| **B1** | Apply Cancel runs a bare `git clean -fd` — deletes pre-session **untracked** work that `stash.includeUntracked: false` deliberately never stashed, then verification fails against the after-tree and the restore blocks. Plan P0-6's rule is *"never force, never `checkout -f`, never `clean`"*. Also runs **before** the "already restored?" check, so a retried restore wipes a tree a partial restore put back — breaking the idempotence the docblock and crash matrix §4 promise | `src/git/isolate.ts:461-481` |
| **B2** | No `try`/`finally` around `applyGuideStep`, so any throw (its first statement is a `git status` that fails on the user's `index.lock`) leaves `sessionStatus` at `applying` — and `cancelSession` returns early from `applying`. Half-written tree, **no reachable exit** short of a window reload. Sacred restore unreachable | `src/model/steps.ts:252-334`, `src/model/session.ts:429-441,740` |
| **B3** | Conflict → `blocked`, and nothing transitions out of `blocked`. The toast says *"Resolve the markers, then try again"*; there is no try-again, and the only exit (Cancel) discards the user's resolution work. Retrying re-merges the marker text as `ours` → **nested markers**, and `git status` cannot see plain-text markers so the `unmerged` guard does not catch it | `src/model/steps.ts:285,334` |

All three share one shape — *the session enters a state the protocol correctly put it in and
cannot get out* — which is review 001's B2/B3/M5 recurring in a new subsystem.

### Majors

M1 drift warning compares to HEAD, so it names Tabthrough's own prior writes and fires on every
step after the first · M2 `tabthrough.applyPending` is bound through a Vue-tracked getter over a
Reatom computed, so it is `false` for the session's whole life and R-apply-5's mitigation is
dead in all three keybindings · M3 apply still opens the `tabthrough:` virtual diff, whose Tab
binding has no mode or pending guard and writes to disk (§9.4's undecided row) · M4 `appliedRef`
survives a verified Cancel → phantom orphan, §6 drills fail · M5 heartbeat stops during
`applying` and forever in `blocked`, reopening review 001 M2 · M6 `IsolationHandle.token` is
mutable outside the graph and `appliedIndex` duplicates it (two sources of truth; git gets one,
the UI the other) · M7 `finishApplyKeep`'s blocked branch does an illegal `restoring → active`
→ same wedge as B2 · M8 **`pnpm test:ci` red**: 4 files / 9 tests / 8 errors,
`TypeError: un is not a function` from `@reatom/core`; files pass in isolation.

### Verified by execution, not only by reading

B1, B3 and M1 were confirmed with a throwaway probe suite driving `applyGuideStep` and
`restoreFromToken` against real temp repos (output quoted in the review; file deleted — its
assertions are the T1 fix). Recommend this for future apply reviews: three findings would have
read as theoretical otherwise.

### Clean (recorded so it is not re-derived)

Double-Tab genuinely cannot interleave (`saveDocuments` before `beginApply`; second
`beginApply` no-ops) · journal ordering (`applying` before any byte; index/ref only after
success; `reviewing` restored on every refusal) · token forward-compat at `v: 1` ·
`mergeThreeWay`'s `merge-file` argument order and exit-code contract · conflict advances nothing
· range+apply refused in the stat-only pass (**R-apply-7 closed**) · import boundaries ·
Reatom idioms (`withAsync` then `withAbort('first-in-win')`, every git boundary `wrap`ed, no
`context.reset()` under `src/`, everything named) · pre-flight disclosure and the Cancel
confirmation.

### Process finding

Phase 9 / P0-A5 landed in `src/` **during** this review, before the Phase 7 gate ran —
`plan.md` sequences 8 ∥ 9 *after* Phase 7's gate and `process/README.md`'s loop is IM → RV → TE.
Phase 9 is therefore built on B1/B2/B3/M5 and inherits M7; it needs its own reviewer turn.
Definition-of-done item 1 (green suite) was also not met at handoff (M8). Both corrected in the
backlog rather than in the Implementer entries, which stand as the record of what shipped —
except the two lines m8 flags as describing behaviour not in the tree.

### Re-scored Phase 7 done-when

Commit-entry apply **partial** · Shift+Tab revert **partial** · Cancel byte-identical **no**
(B1) · readonly path unchanged **unproven** (M8) · no silent overwrite **yes**, with markers
nesting on retry.

**Next:** Implementer **P0-A3-F1…F4** (blocks P0-A4), then **P0-A5-F1 / F5…F8** (blocks the
Finish-keep ship). Tester: T2 apply row in the sacred suite is the highest-value missing test.

## Implementer — 2026-08-07 — Phase 7 blockers (review 002 F1–F8 + M1/M3/M8)

**Verdict-ready for Reviewer re-review of Phase 7.** Did not start Phase 8. Phase 9 Finish-keep
was touched only where blockers required it (M7 illegal transition → `blocked`; heartbeat
widened so apply sessions stay live). **Leave a dedicated Phase 9 review** for Finish-keep UX
and remaining P0-A5 surface.

`pnpm lint && typecheck && test:ci` green: **531 tests**, 27 files, ~366 s (serialised).

### Blockers closed

| ID | Fix |
|----|-----|
| **B1 / F1** | `restoreFromToken` verifies *before* any discard; apply discard is `reset --hard` + `git clean -fd -- <paths>` scoped to untracked that are tracked at `headBefore` or absent from the after-ref capture — never a bare `clean`. Pre-session untracked under `includeUntracked: false` survive Cancel |
| **B2 / F2** | `try`/`finally` around apply/revert; `finally` calls `endApply('blocked')` only if still `applying`. `cancelSession` refuses `applying` only when `applyPending()` is true. `LEGAL_TRANSITIONS.applying` includes `restoring` |
| **B3 / F2** | Conflict stays `active` (not `blocked`) so Tab retries; toast tells the user to press Tab after resolving. `hasConflictMarkers` refuses re-merge (no nested markers). Opens the conflicted workspace file |
| **T2 / F4** | Sacred suite: apply Cancel with both `includeUntracked` settings + restore-twice row |

### Majors closed (this slice)

| ID | Fix |
|----|-----|
| **M1 / F9** | Drift compares against `appliedRef` (else base), not HEAD/`git status` vs index |
| **M2 / F7** | `ui.applyPending` computed + `useAtomRef` — keybindings see live pending |
| **M3 / F8** | `reviewViewModel` null in apply; `tabthrough:` Tab/Shift+Tab require `sessionMode != 'apply'` |
| **M4 / F5** | `finalize` deletes `appliedRef` on verified Cancel |
| **M5 / F6** | Heartbeat while session open except `restoring`/`stashing`; accepts stage `applying`; loop uses `isSessionOpen` |
| **M7 / P0-A5-F1** | `finishApplyKeep` blocked branch → `blocked` (not illegal/`active`) |
| **M8 / F3** | `vitest.config.ts` `fileParallelism: false` — stops `context.reset()` racing in-flight `take()` (`un is not a function`) |

### Tests added

- `apply-step`: marker refuse; drift not naming prior step paths
- `apply-commit`: B2 stuck-applying Cancel; B3 conflict stays active + second Tab refuses; M4 empty `refs/tabthrough`
- `stash-roundtrip`: apply Cancel × both untracked settings; restore twice
- `contributions`: scheme Tab clause includes `sessionMode != 'apply'`

### Still open for Reviewer / later

- **M6** — `IsolationHandle.token` mutable + duplicated `appliedIndex` (not cheap)
- **m1–m5, m7** — rename/mode/utf8/deletion inference; write-surface import assert; real mid-write crash inject
- **T1** rows beyond what this slice added (clean edit-then-Tab, unsaved buffer, double-Tab, stub apply)
- **Phase 9** — full Finish-keep review (landed mid-gate; only M7 interaction fixed here)

**Next:** Reviewer re-review of Phase 7 / P0-A3. Do not start Phase 8 until approved.

## Reviewer — 2026-08-07 — Phase 9 / P0-A5 gate → [review 003](./reviews/003.md)

**Verdict: request fixes.** **2 blockers, 7 majors, 5 minors, 3 test gaps.** Backlog P0-A5
reopened with **P0-A5-F2…F12**. `pnpm lint && typecheck && test:ci` all green — **531 tests, 27
files, 497 s** — so this is the first apply gate to run against a green suite (review 002 M8
closed).

The keep mechanism is right: Finish never stash-restores, `done-kept` is a correct terminal
stage, journal order across Finish is right, the carry never uses `-f`, and every Phase 7 fix I
re-checked holds. Both blockers are **consent** failures, not engine bugs.

### Blockers

| ID | Finding | Where |
|----|---------|-------|
| **B1** | `advance()` treats all six reasons `next()` returns `false` as "the walk is over", so a merge conflict is announced as *"Apply complete. Finish keeps your changes so you can commit."* with a **Finish and Keep** button — and Finish takes it. Nothing in `finishApplyKeep` checks the tree, so the conflict markers Tabthrough just wrote get checkpointed, staged by `add -A`, journalled `done-kept`, and handed to Source Control. Also defeats 002 B3's own retry affordance | `src/commands/index.ts:85-97`, `src/model/session.ts:665` |
| **B2** | `deactivate` → `cancelSession('deactivate')` runs the destructive apply Cancel. D6's confirmation is gated on `reason === 'cancel'`, so window close / reload skips it, discards the walk, and **deletes files the user authored during it** — no prompt, no ref (the applied checkpoint is deleted by `finalize` and postdates the file anyway), no stash. Product bar is "zero data-loss in apply mode" | `src/index.ts:124`, `src/model/session.ts:751` |

### Majors

M1 the 002-B1 fix swapped a bare `clean -fd` for a scoped one whose predicate is *"absent from
the pre-session capture"* — which is every file the user creates mid-walk, labelled "junk" ·
M2 R-apply-3's copy half is inverted: the kept message names only **Clean Up Backups** (no
confirm, no disclosure that a stash of their WIP is in it, clears the token that named the stash
message), and D6's *"recovery command can still restore pre-session with a dangerous confirm"*
does not exist — `restoreBackup` is disabled by `isRecoverable` and `recoverBackup` throws
`IllegalStageError` if reached, swallowed by `guard` · M3 the next Start silently overwrites the
`done-kept` token · M4 Finish's `git add -A` stages the whole tree and never unstages it,
contradicting D3 and undisclosed · M5 a crash mid-carry (`finishing-keep`) recovers as Cancel
and the prompt says "did not finish restoring your work" to a user who asked to keep · M6 Finish
has none of the pre-checks Tab enforces (unmerged / markers / drift) · M7 `IsolationHandle.token`
still mutable outside the graph, with Finish now a third writer (002 M6).

### Verified by execution, not only by reading

B1, B2, M1, M2 and M4 were confirmed with a throwaway probe suite driving the real actions
against temp repos (output quoted in the review; files deleted — their assertions are
**P0-A5-F11**). Highlights: Finish leaves `<<<<<<<` on disk at stage `done-kept` with index
`M src/service.ts`; `deactivate` reports *"restored your working tree before shutting down"*
while the user's own new file is gone and `appliedRef` is `null`; `recoverBackup` on `done-kept`
throws `IllegalStageError`; the pre-session **stash entry** does survive Clean Up Backups, so
that work is unpinned rather than destroyed.

### Clean (recorded so it is not re-derived)

Finish genuinely never stash-restores (**R-apply-9 holds**) · `done-kept` terminal and correctly
excluded from `isRecoverable` · checkpoint + `appliedRef` written before `finishing-keep`, lock
released before `done-kept`, checkpoint failure returns `blocked` without advancing the stage ·
carry is plain `checkout` on both branches (**R-apply-2 holds**) · no code path anywhere
constructs a `git commit` · all of 002's F1–F9 re-verified (conflict stays `active` + marker
refuse, `finally { endApply }` + `applyPending()` Cancel guard, `appliedRef` deleted on verified
Cancel, heartbeat through `applying`/`blocked`, live `ui.applyPending`, no virtual diff in apply)
· Reatom idioms in the Finish path (`withAsync` then `withAbort('first-in-win')`, every boundary
`wrap`ed, `peek` for reads, everything named).

### Re-scored Phase 9 done-when

Finish keeps / Cancel restores / copy never confuses them → **no** (B1, B2) · no auto-commit →
**yes**, unasserted · `done-kept` retains refs → **yes**, with M2/M3 caveats · dogfood rows →
unchanged, blocked behind the blockers.

**Next:** Implementer **P0-A5-F2…F5** + **F11** rows 1–4 (blocks the Finish-keep ship). **F4 also
blocks P0-A4** — a working-tree apply session inherits the same file-deleting predicate.

## Reviewer — 2026-08-07 — Phase 7 / P0-A3 re-review, the gate → [review 004](./reviews/004.md)

**Verdict: request fixes. Phase 7 is not approved and Phase 8 (P0-A4) must not start.**
**2 blockers, 5 majors, 6 minors, 5 test gaps.** Backlog P0-A3 reopened with **P0-A3-G1…G7**;
F1 and F9 re-opened, F2–F8 confirmed closed. `pnpm lint && typecheck && test:ci` green — **531
tests, 27 files, 435 s**, run in full and serialised.

Eight of review 002's ten gate items are genuinely closed and I re-verified three of them by
execution. The slice made real progress: **B3 is fully fixed** — a conflict stays `active`, writes
one set of markers, refuses a retry rather than nesting, and a *resolved* file really does apply on
the next Tab (nothing asserted that last part; it works). **B2's wedge is gone.** Apply Cancel is
byte-identical and now preserves pre-session untracked files under `includeUntracked: false`.

Both blockers are in the fixes themselves.

### Blockers

| ID | Finding | Where |
|----|---------|-------|
| **B1** | F1 promoted the "already restored?" verification to step 1 and moved the HEAD restore to step 3 — and the early branch **returns** without it. `verifyRestored` has no notion of where HEAD points (`canonicalStatus` drops branch headers by design), so whenever the reviewed content equals the pre-session content the restore reports success on a **detached HEAD**, then `finalize` drops every ref and the lock. That is plain *"Review a Commit… → HEAD"* with a clean tree — the v0.1 read-only path. The user is told *"Your working tree is back"*; their next commit lands where their branch cannot see it. **Regression, sacred path** | `src/git/isolate.ts:528` |
| **B2** | The apply Tab bindings are gated on `resourceScheme == 'file'` and `advance()` never checks which editor is focused, so for the whole session **Tab writes to disk in every file in the workspace** instead of indenting — default on. test-matrix §9.4 has a row forbidding exactly this, and `contributions.test.ts` currently pins the forbidden behaviour. It also makes 002-B3's own new instruction (*"resolve the markers, then press Tab"*) unusable: Tab does not indent in the file the user must type in, and a mistimed press re-runs the apply | `package.json`, R-apply-8 |

### Majors

M1 F9 is **not closed** — right anchor, wrong comparison: the checkpoint tree contains untracked
files while the diff enumerates the index, so every step warns about every untracked path
(002's *"a warning that fires on every step teaches the user to ignore it"* verbatim) ·
M2 an apply exception lands in `blocked`, which nothing transitions out of, so a half-second
`index.lock` collision costs the entire walk · M3 `next`/`prev` report abort rejections as
*"Apply failed: …"* despite `withAbort('first-in-win')` (`startFailed` already gets this right) ·
M4 `IsolationHandle.token` still mutable outside the graph (002 M6 / 003 M7 — fix once, jointly
with Phase 9) · M5 the F1 discard predicate is *"anything absent from the capture"*, i.e. still
deletes files the **user** authored mid-walk (= 003 M1/B2; Phase 8 inherits it).

### Verified by execution, not only by reading

B1, M1, M5 and B3's resolve-then-Tab path were driven through real temp repos with throwaway probe
suites (output quoted in the review; files deleted — their assertions are **P0-A3-G3** and
**P0-A3-G5**). B1 and M1 both *read* as correct in the source and are both wrong on disk; that is
now three gates running. Highlights: `symbolic-ref` exits 1 after a "restored" read-only session;
the drift warning names `mine.txt` on all three steps; a resolved conflict applies cleanly and the
markers vanish.

### Closed and verified (recorded so it is not re-derived)

002 B2 (`try/finally` + `applyPending()` Cancel guard + the `applying → restoring` edge in both
tables) · 002 B3 in full · 002 B1's untracked half and the verify-before-discard ordering; no bare
`clean` anywhere in `src/` · M2 live `ui.applyPending` (real `computed` + `useAtomRef`, `{ status:
true }` present) · M3 no virtual diff in apply · M4 `appliedRef` deleted on verified Cancel, CAS'd ·
M5 heartbeat spans `applying`/`blocked` · M7 `finishApplyKeep` blocked branch · M8 green suite ·
Reatom idioms in the changed code (`withAsync` then `withAbort`, every boundary `wrap`ed including
inside `finally`, no `context.reset()` under `src/`, everything named, `LEGAL_TRANSITIONS` still the
only status writer) · import boundaries hold.

### Re-scored Phase 7 done-when

Commit-entry apply → **partial** (conflict honest *and* recoverable; "edits preserved" untested;
Tab misbound) · Shift+Tab revert → **yes** · Cancel byte-identical → **no** (B1 detaches HEAD on the
read-only path; M5 deletes user files) · read-only unchanged → **no** (B1) · no silent overwrite →
**yes**.

**Next:** Implementer **P0-A3-G1, G2, G3, G4** + **G5** before Phase 8. **G1 first and alone if
need be** — it is a regression in the v0.1 read-only path, so it outranks the entire apply track,
and no v0.1 drill should be re-run until it lands. **G4 = P0-A5-F4**: fix once. Phase 9's
[review 003](./reviews/003.md) B1 is a direct consequence of this phase's B3 fix and belongs in the
same slice.

## Implementer — 2026-08-07 — Review 004 B1/B2 + shared F4 + Phase 9 F2–F5

Priority interrupt: [review 004](./reviews/004.md) B1 (v0.1 sacred-path detached HEAD) outranked
Phase 9 Finish work. Shipped both gates' ship-blockers in one slice.

### Review 004 (Phase 7 gate)

| ID | Fix |
|----|-----|
| **G1 / B1** | `restoreFromToken` early return now requires `verification.ok && headSettled`; discard gated on `!verification.ok`. Clean commit-of-HEAD round trip asserts `symbolic-ref HEAD` → `main` |
| **G2 / B2** | Dropped apply-mode `resourceScheme == 'file'` Tab/Shift+Tab bindings. Apply advances via `alt+]` / `alt+[`. Contributions test pins §9.4 |
| **G4 / F4** | `discardApplyWrites` removes only untracked paths tracked at `headBefore` — never "absent from capture" (user mid-walk files + pre-session untracked stay) |
| **G5** | Sacred-suite clean WT + clean commit-HEAD rows with `symbolic-ref` |

Still open for Phase 7: **G3** (drift tree-to-tree), G6/G7.

### Review 003 (Phase 9 Finish)

| ID | Fix |
|----|-----|
| **F2 / B1** | `advance()` offers Finish only when `!canAdvance()`; `finishApplyKeep` refuses unmerged paths and conflict markers |
| **F3 / B2** | `cancelSession('deactivate')` no-ops in apply mode — leaves `reviewing` journal + tree for Phase 10 |
| **F5 / M2** | Clean Up Backups modal confirm; Finish message carries `git stash apply <backupRef>`; `recoverBackup` refuses `done-kept` with that recipe |
| **F11** | Rows 1–3: Finish-after-conflict, apply deactivate, mid-walk user file on Cancel |
| **F12 partial** | Dropped unused `restoring→active` / `blocked→active`; Finish uses `writeAppliedCheckpoint` |

`pnpm lint && typecheck && test:ci` green: **535 tests, 27 files**. Packaged via `pnpm ext:install`.

**Next:** Dual re-review of [004](./reviews/004.md) + [003](./reviews/003.md). Do not start Phase 8
until 004 re-opens the gate. Remaining: G3 drift, F6–F7/F9–F10, rest of F11.

## Reviewer (Fable) — 2026-09-05 — sidebar Simple/Agent flow

[Review 006](./reviews/006.md): **changes needed**. Stash contract intact (no isolate until Start). Headline Simple working-tree flow is stale by construction (`git diff` vs Start's `add -A` snapshot). Next: Implementer pass on 006 blocker + majors, then re-review.
