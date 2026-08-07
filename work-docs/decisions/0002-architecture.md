# ADR 0002: Architecture for the Tabthrough MVP

**Status:** Proposed
**Date:** 2026-08-07
**Deciders:** Architect
**Consulted:** ADR 0001 (MVP scope), product spec, implementation plan (risk register + `[ARCH]` handoffs), Reatom v1001 skills
**Supersedes:** nothing
**Detailed design:** [architecture/overview.md](../architecture/overview.md) · [architecture/reatom-model.md](../architecture/reatom-model.md) · [architecture/guide-schema.md](../architecture/guide-schema.md)

---

## Context

ADR 0001 fixed *what* the MVP ships: stash-safe isolation, a Tab-to-reveal loop, an offline heuristic order with an optional `.guide.json`, a Reatom model as the single source of truth, and no webview. It deliberately left the *how* open.

The plan then sequenced the work and handed four questions to this ADR, plus two risks it could not close without an architectural answer:

- **R5** — VS Code decorations cannot delete lines, so "reveal" might degrade to "dim", which is a materially weaker product than the pitch.
- **R6** — VS Code does not reliably await async work in `deactivate()`, so a restore started there can be cut off.
- **[ARCH]** Reatom scope lifetime and disposal ordering; the repo-level session lock; the final Tab `when` clause; the `.guide.json` v1 shape.

Nine decisions follow. D1–D3 are the ones the product lives or dies on.

---

## D1 — Reveal by progressively rendering a virtual document

**Decision.** Each reviewed file is shown as a native diff between two read-only virtual documents on the `tabthrough` scheme: a static *base* document holding the file at the base revision, and a *reveal* document whose content is `renderReveal(baseText, file, revealedGroups)` — a pure fold of the base text plus exactly the line groups revealed so far. Advancing the cursor changes the fold's input; the provider fires `onDidChange` and VS Code re-renders. When the last step is revealed, the reveal document equals the file at the after revision.

**Why.** It gives real hiding, not dimming, without writing to disk. Unrevealed lines are absent from the document, so they cannot be read, selected, or copied ahead of time. Because both sides are real documents, the native diff editor supplies gutter markers, syntax highlighting, and navigation for free, and prior-steps-stay-visible is a property of an append-only fold rather than bookkeeping we maintain.

**Alternatives considered.**

*Decorations over the final file (the plan's "dim" default).* Rejected as the primary mechanism because the content is still there — a user can select it, copy it, or simply read the dimmed text. It also fights the diff editor's own colouring. Retained as `tabthrough.reveal.mode: "dim"`, sharing the same provider, URIs, and `LineGroup` data; only the fold differs. The reversibility the plan asked for is preserved, and the pre-Phase-5 spike shrinks from an architectural fork to a one-file comparison.

*Applying patches progressively to real files.* Rejected. It writes to the working tree during a session whose entire premise is that the working tree is under our protection: it pollutes `git status`, races the user's editor and undo stack, and couples the reveal loop to the stash contract. This is the highest-risk option in the plan's own table, and the virtual-document approach obtains the same "genuinely absent" property without any of it.

**Consequences.** Positive: R5 is retired without a spike; Tab is synchronous because the fold is pure and the base blobs are cached; Shift+Tab is correct by construction. Negative: very large files re-render a whole string per step (mitigated by memoization and, if needed, the P1 compact mode); the reveal document is not a real file, so features keyed to filesystem paths behave differently — acceptable, since the checked-out workspace still holds the real files.

---

## D2 — Tab as the default binding, narrowly scoped, with an unconditional chord

**Decision.** Bind `Tab` to `tabthrough.next` with:

```
tabthrough.sessionActive
  && resourceScheme == 'tabthrough'
  && editorTextFocus
  && !suggestWidgetVisible && !inlineSuggestionVisible && !inSnippetMode
  && !renameInputVisible && !parameterHintsVisible
  && !accessibilityModeEnabled && !editorTabMovesFocus
  && config.tabthrough.keybinding.useTab
```

`Alt+]` / `Alt+[` are registered unconditionally, gated only on `tabthrough.sessionActive`. `tabthrough.keybinding.useTab` turns the Tab binding off entirely.

**Why.** The `resourceScheme` clause is the structural mitigation: the reveal document is read-only, so Tab has no competing indent, completion, or snippet meaning there, and the binding cannot leak into a normal editor even while a session is active. The remaining clauses cover the widgets that can float above a read-only editor.

Two clauses from the plan's draft were dropped deliberately. `!editorHasSelection` would break the ordinary gesture of selecting a line to read it and then pressing Tab, and a selection carries no Tab semantics in a read-only document. `!editorReadonly` inverts the actual reasoning — read-only is precisely the condition that makes Tab safe to take, so the clause would have disabled the binding everywhere it is appropriate.

Two clauses were added for accessibility: `!accessibilityModeEnabled` and `!editorTabMovesFocus` are the two signals a user gives when they need Tab to move focus. Both are honoured rather than overridden.

**Alternatives considered.** *Chord-only by default.* Rejected for the MVP: the product's pitch is explicitly the familiar AI-tab gesture, and the scheme restriction removes the conflict class that would justify the downgrade. It remains the documented fallback position if the conflict matrix cannot be made clean. *Rebinding Tab globally while a session is active.* Rejected outright — it would break typing in every other editor.

**Consequences.** The keybinding conflict matrix (plan Phase 5, manual runbook) is now a verification exercise rather than a design exercise. A user in accessibility mode gets the chord and never loses focus navigation.

---

## D3 — Crash recovery through a write-ahead journal pointing at real git refs

**Decision.** Three cooperating pieces:

1. **Capture before mutate.** Before any mutating git command, a temp-index snapshot (`GIT_INDEX_FILE=… read-tree HEAD; add -A; write-tree; commit-tree`) captures tracked modifications *and* untracked files into one immutable commit, anchored at `refs/tabthrough/after/<id>`. `add -A` honours `.gitignore`, so ignored files are never swept — the same boundary as `--include-untracked`, and the reason we never approach `git stash --all`.
2. **Journal before act.** A `SessionToken` carrying a `stage` field (`planned → captured → stashed → checkedout → reviewing → restoring → done`) is persisted to `globalState`, keyed by a hash of the repo root, and the stage is always written *before* the operation it names.
3. **Restore is apply → verify → drop.** Locate the stash entry by message, fall back to `refs/tabthrough/backup/<id>` (the stash-shaped commit, which preserves the staged/unstaged split), `git stash apply`, verify against the after-ref tree, and only then `drop` and delete refs. On any mismatch, stop and keep everything.

`globalState` rather than `workspaceState` because a second window on the same repository must be able to see the token, and because it must survive the folder being reopened by a different path.

**Why two refs.** Restore fidelity and content reading are different jobs. A flat tree is the right shape for reading review content (it makes the working-tree entry read exactly like a commit entry), and it is the wrong shape for restoring, because it loses the staged/unstaged distinction and the untracked set. Rather than compromise either, each job gets its own artifact — both ordinary git commits behind ordinary refs, so a user can always recover by hand with `git stash list` and `git for-each-ref refs/tabthrough`.

**Alternatives considered.** *Reatom persistence (`reatomPersist` with a `globalState` adapter).* Rejected: recovery must be readable and actionable *before* the model is meaningfully initialised, and it must not depend on the health of the very state machine that may have crashed. The architect rule "persist a durable token outside Reatom" exists for this reason. *A lockfile or temp directory holding copies.* Rejected: invisible to the user, unrecoverable by hand, and a second thing to keep consistent with git. *`git stash pop`.* Rejected outright — `pop` drops the entry on partial success, which is exactly the case where we most need it to survive.

**Consequences.** Positive: every crash point maps to a defined recovery step, and the crash matrix is testable without killing a process by injecting a `StorePort` that stops accepting writes after a chosen stage. R6 is contained: a truncated `deactivate` is indistinguishable from a crash, and both are handled by the same path. Negative: refs accumulate after a conflicted restore — mitigated by an explicit `Clean up backups` command and a passive notice on activation. We never garbage-collect them automatically.

---

## D4 — Every entry point resolves to the same immutable (base, after) commit pair

**Decision.** Working tree → `(HEAD, refs/tabthrough/after/<id>)`; single commit `C` → `(C^, C)`; range `A..B` → `(merge-base(A,B), B)`. The working-tree entry is stashed like every other entry when the tree is dirty; its reviewed content is read from the captured after-commit rather than from disk.

**Why.** Downstream code never branches on entry kind: the diff is `base..after`, base blobs come from `cat-file`, and reveal is a fold. It also makes the reviewed content immutable for the session's duration, which removes content drift as a failure mode entirely.

**Alternatives considered.** *Skip the stash for the working-tree entry, since the dirty tree is the subject of review.* Tempting and initially attractive — it is faster and touches nothing. Rejected: the product spec lists "dirty working tree at session start → stash" as a P0 edge case with no entry-point exception; the founder's flow is explicitly about isolating the workspace; and special-casing the most common entry point would leave the stash pipeline least exercised precisely where it matters most. Capturing the after-commit first means the content is safe *before* the stash runs, so nothing is lost by being uniform.

**Consequences.** Reviewing "my current changes" makes them temporarily disappear from disk. This is a real, user-visible consequence and the pre-flight must say so plainly; Cancel restores instantly. In exchange, one code path serves all three entries and the safety suite covers all three at once.

---

## D5 — Repo-level session lock via compare-and-swap on a ref

**Decision.** Acquire `refs/tabthrough/lock` with `git update-ref refs/tabthrough/lock <sha> 0000000000000000000000000000000000000000`. Passing the zero oid as the expected old value makes this an atomic create-if-absent inside git's own ref transaction. Release with `git update-ref -d refs/tabthrough/lock <sha>`. Breaking a stale lock is an explicit user action in the recovery UI, never automatic.

**Why.** It is atomic across processes, windows, and even other tools, needs no reasoning about filesystem semantics, works on every supported git version, is inspectable with `git for-each-ref`, and is cleaned by the same command that cleans backups.

**Alternatives considered.** *A lockfile under `.git/`.* Rejected: requires `wx` plus stale-PID reasoning, and PIDs are meaningless across containers and remote/WSL splits. *Backup-ref existence as the signal.* Rejected as ambiguous — a surviving backup ref is the normal state after a conflicted restore, so it cannot also mean "in use". *The in-window status atom alone.* Insufficient by construction, as the plan already noted; it is retained as the fast path with a good error message.

---

## D6 — Reatom primitive selection, and no scope to create

**Decision.** Probes and reads are `computed(async …).extend(withAsyncData(...))`; commands and mutations are `action(async …).extend(withAsync(...))` with an explicit abort strategy per action. Atoms are module-level in Reatom's implicit global context — there is no application scope to construct, because `context.start` exists for tests and SSR, not for bootstrapping. `context.reset()` is forbidden under `src/`: the reference states it rejects wrapped promises with abort errors, which during an in-flight restore is precisely the outcome the safety design exists to prevent.

Disposal order at `deactivate` is load-bearing: flip context keys off, drain the restore (`Promise.race` against a ~4 s budget), *then* dispose the reactive-vscode scope, which unsubscribes the Reatom projections. Disposing first would tear down subscriptions while a restore is running.

The status machine is a plain atom with a single guarded transition action rather than `reatomEnum`, because `reatomEnum`'s generated `setActive()` / `setIdle()` actions would be a second, unguarded write path — the exact drift the single-source-of-truth rule forbids, and incompatible with the plan's "illegal transitions are rejected" exit criterion.

**Consequences.** R4 (two reactivity systems in one process) is reduced to one adapter, `useAtomRef`, plus a rule that every VS Code callback touching the model is passed through `wrap`. The Reviewer's checklist in `reatom-model.md §12` is the enforcement mechanism.

---

## D7 — Restore paths never receive an abort signal

**Decision.** `git/exec.ts` accepts `{ signal }`, and every read path passes one so stale probes die with their frames. No mutation on the restore path is ever given a signal, and `finish` / `cancel` / `recovery.restore` use `withAbort('first-in-win')` so a second invocation is ignored rather than allowed to interrupt the first.

**Why.** Cancellation is a safety feature when reading and a hazard when writing. An aborted `git stash apply` is the one outcome the product cannot survive, and it would be trivially reachable if the frame's signal were threaded through by habit.

---

## D8 — Layering enforced by lint, not convention

**Decision.** `vscode` may be imported only under `src/ui/**`, `src/commands/**`, and `src/index.ts`; `node:child_process` only under `src/git/**`; `@reatom/core` is forbidden under `src/git/**` and `src/guide/**`. Enforced with `no-restricted-imports` per directory plus a test over the module graph.

**Why.** It is what makes the safety suite and the ordering suite runnable under plain vitest with no extension host, which in turn is what makes them cheap enough to run on every commit. The plan identified this as the load-bearing rule; making it lint rather than culture is what keeps it true after the third contributor.

---

## D9 — `.guide.json` v1 frozen, with a lenient reader

**Decision.** The schema in [guide-schema.md](../architecture/guide-schema.md) is frozen for 1.x. Steps anchor with *file line ranges* rather than hunk offsets, and ranges *intersect* line groups rather than containing them. The reader is lenient in one direction only: hard errors reject the whole document and fall back to the heuristic with a single warning; soft errors keep the document and record diagnostics; unknown fields are ignored so a 1.1 document still works in a 1.0 reader, while a non-1 `version` is refused outright.

**Why line ranges.** They are the only anchor an author can produce without parsing the patch format, and they are what an agent that just edited a file already knows. Intersection semantics mean an author does not need exact numbers — point at the enclosing function and the changed lines inside it are claimed — which is what makes a guide survive a rebase that shifts line numbers.

**Why a lenient reader.** A guide is an enhancement over a working offline path. Any failure mode that blocks a review, or that loses a changed line, would make the feature a liability. The coverage invariant (every changed line group belongs to exactly one reveal step) is asserted after every merge, in every mode, including `mergeStrategy: "replace"`.

**Consequences.** Track E can publish the agent skill against a stable target immediately. MVP implements read plus merge only; the stale/partial merge refinement stays P1-3, and the digest is advisory rather than blocking so that a rebase which did not touch the reviewed code does not invalidate a good guide.

---

## Consequences overall

### Positive

- R5 (reveal feasibility) and R6 (deactivate) are closed by design rather than deferred to a spike.
- All four `[ARCH]` questions from the plan are answered, so Phases 1, 2, 3, and 5 are unblocked simultaneously.
- One `(base, after)` pair and one restore path serve all three entry points, which concentrates the safety testing where ADR 0001 wants it.
- The pure layer — parse, group, order, merge, render — is the majority of the logic and runs with no host and no repo.

### Negative / accepted debt

- Reviewing the working tree hides the user's changes from disk for the duration of the session. Deliberate (D4), disclosed in the pre-flight, instantly reversible.
- Backup and after refs accumulate after a conflicted restore, by design. Cleanup is explicit and never automatic.
- Progressive rendering re-folds a whole file string per step. Fine at MVP diff sizes; the P1 compact mode is the escape hatch.
- Two reveal modes (`progressive`, `dim`) must both keep working. Mitigated by sharing everything except the fold.

---

## Related

- [ADR 0001 — MVP scope](0001-mvp-scope.md)
- [Product spec](../specs/product.md)
- [Implementation plan](../progress/plan.md)
- [Architecture overview](../architecture/overview.md) · [Reatom model](../architecture/reatom-model.md) · [Guide schema](../architecture/guide-schema.md)
