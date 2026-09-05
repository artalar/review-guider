# ADR 0004: Apply-with-user session mode

**Status:** Accepted  
**Date:** 2026-08-07  
**Deciders:** Architect  
**Consulted:** Product spec v0.2 (apply-with-user), ADR 0002 D1 (reopened), overview §3.5 / §7, sacred stash suite  
**Amends:** [ADR 0002 D1](0002-architecture.md) — scoped; does not discard virtual-document reveal  
**Detailed design:** [architecture/overview.md](../architecture/overview.md) §7.3 · [architecture/reatom-model.md](../architecture/reatom-model.md)

---

## Context

v0.1 reveal is read-only: progressive/dim virtual documents, Finish/Cancel both restore the pre-session tree. That matched ADR 0002 D1’s rejection of “staged apply to disk” under the premise that the session exists to *look* while the working tree stays protected.

v0.2 product reframes success as **ownership**: walk the change like interactive rebase-with-fixes, land steps on real files, allow mid-step edits, and let the developer **commit**. Dirty `git status` is then the feature. PO formally reopened D1 and preferred a third mode beside `progressive` / `dim`, with the same (or stricter) no-data-loss bar.

Open product questions this ADR closes: mode coexistence, stash contract under reapply, mid-step edits, Finish vs Commit vs Cancel, Shift+Tab, crash journal, default chooser, schema need.

---

## Decision summary

| Topic | Decision |
|-------|----------|
| Coexistence | Keep read-only `progressive` / `dim`. Add session mode **`apply`**. Reveal setting stays read-only-only. |
| Isolation | Same capture-first / journal-first / lock protocol. Apply checks out **`base`**, not `after`. |
| Tab | Writes real files via 3-way merge of `renderReveal` intended states vs on-disk (+ user edits). |
| Shift+Tab | Reverts last applied step the same way (intended 3-way); never silent overwrite on conflict. |
| Cancel | Always restore pre-session WIP (existing apply → verify → drop). Confirm if apply progressed. |
| Finish | **Keep** the applied tree; do **not** restore stash. Pre-session backup retained until explicit cleanup. Offer SCM commit handoff. |
| Commit | Assist / handoff only — never silent `git commit`. |
| Schema | `.guide.json` v1 unchanged; `ranges` + `grouping` suffice. |

---

## D1 — Amend ADR 0002 D1 (scoped reopen)

**ADR 0002 D1 stands for read-only review.** Virtual progressive/dim documents remain the only reveal path when the session mode is read-only. The clause that rejected “applying patches progressively to real files” is **narrowed**: that rejection applied to using disk writes as the *read-only* reveal mechanism under a restore-on-Finish contract.

**Apply mode is a separate session contract** defined in this ADR. It is allowed to mutate the working tree because Finish means “keep ownership outcome,” Cancel means “restore pre-session,” and every write is journaled against the same never-lose-WIP artifacts (after-ref + backup ref) plus apply checkpoints.

Virtual docs are **not** removed. Users choose mode at start (see D7).

---

## D2 — Session mode vs reveal mode

```ts
type SessionMode = 'readonly' | 'apply'
type RevealMode = 'progressive' | 'dim'   // only consulted when SessionMode === 'readonly'
```

| Mode | Disk | Editor | Finish | Cancel |
|------|------|--------|--------|--------|
| `readonly` + progressive/dim | Unchanged relative to isolation checkout (after / HEAD); reveal is virtual | `tabthrough:` docs | Restore pre-session | Restore pre-session |
| `apply` | Real files mutated per Tab | Ordinary file editors + git status | Keep tree; end isolation without stash-restore | Restore pre-session |

Setting: `tabthrough.session.mode`: `'ask' | 'readonly' | 'apply'` — **default `ask`**. When `ask`, pre-flight includes an explicit chooser (Cancel remains the default dismiss). Last non-`ask` choice may be remembered as a convenience write-back only when the user picks from the chooser with “Remember.”

`tabthrough.reveal.mode` is unchanged and ignored in apply sessions.

---

## D3 — Isolation under apply (commit and working tree)

Preserve ADR 0002 D3/D4 invariants: **capture before mutate**, **journal before act**, uniform `(base, after)` pair, lock CAS, heartbeat.

### Shared start (both entry kinds)

1. Resolve `(base, after)` exactly as today.  
2. Pre-flight discloses: mode, that apply **will write files**, Cancel restores, Finish keeps.  
3. Capture after-ref (temp-index snapshot) → journal `captured`.  
4. Stash dirty tree if needed → backup ref → journal `stashed`.  
5. **Checkout `base` (detach)** for every apply entry — including working-tree — so the tree starts clean at the pedagogical zero.  
   - Commit `C`: `base = C^` (existing rules for root / first-parent).  
   - Working tree: `base = HEAD` (post-stash clean tree).  
6. Journal `checkedout` → `reviewing` with `mode: 'apply'`, `appliedIndex: -1`.

Read-only working-tree entry may continue to skip checkout (already at HEAD after stash). Apply does **not** skip: it must be at `base` with an empty apply cursor even when `base === HEAD`.

### Why not “stash then read after from disk”

Reapply must be a function of the immutable `(base, after)` pair and the guide steps, not of a drifting dirty tree. The after-ref remains the content source for step intent; the working tree is the user’s editable projection.

### Staged / unstaged intent

Capture + backup still preserve staged/unstaged for **Cancel restore** (byte-identical pre-session). Apply mode **flattens** into the working tree as ordinary unstaged (and new) files while walking — disclosed in pre-flight. Restoring staged split mid-apply is out of v0.2; Cancel restores the original split via the backup stash commit.

---

## D4 — Applying a step (Tab) without silent overwrite

Guide steps and `renderReveal` stay the source of “intended tree after k steps.”

For each file touched by step `k` (0-based):

- `intendedPrev = renderReveal(baseText, file, groupsInSteps[0..k))`  
- `intendedNext = renderReveal(baseText, file, groupsInSteps[0..k])`  
- `current` = on-disk bytes after ensuring buffers for that path are saved (prompt if save fails)

Then:

- If `current === intendedPrev` → write `intendedNext` (fast path).  
- Else → **3-way merge** (`intendedPrev` base, `current` ours, `intendedNext` theirs).  
  - Clean merge → write result, advance.  
  - Conflict → **stop**: do not advance `appliedIndex` / cursor; surface conflict UI; never skip ahead; never overwrite.

Stub / binary steps: no file write; advance with a visible status note (same honesty as read-only stubs).

**One step → one Tab.** Multi-file steps (none in v1 guides) would apply all files in one transaction: all succeed or none advance. v1 steps are single-file, which matches PO’s “prefer single-file apply per step.”

Tab in apply mode is an **`action` + `withAsync`**, not synchronous cursor movement. No abort signal on the write path (same rule as restore). `withAbort('first-in-win')` so a double Tab cannot interleave two applies.

Before write: refuse if `git status` shows *unmerged* paths; warn if files outside the step’s path were externally dirty since last apply (drift — pull P1-8 forward for apply).

---

## D5 — Shift+Tab / Previous

**Allowed:** revert the last successfully applied step.

Symmetric to D4 with `k = appliedIndex`:

- `intendedCurr` / `intendedPrev` from `renderReveal`  
- Fast path when `current === intendedCurr`  
- Else 3-way merge toward `intendedPrev`; on conflict, **block** with explanation (no silent overwrite)

Also blocked when `appliedIndex < 0`, while an apply/revert is in flight, or when unsaved buffers for touched paths cannot be saved.

Jump-to-index in apply mode: **only backward/forward by walking** apply/revert one step at a time in v0.2 — no multi-step jump that would skip merges. (`jumpTo` disabled or implemented as repeated apply/revert with abort on first conflict.)

---

## D6 — Finish vs Commit vs Cancel (what must never be lost)

### Never lost (non-negotiable)

| Artifact | Role |
|----------|------|
| `refs/tabthrough/after/<id>` | Pre-session full tree capture (and apply content source) |
| `refs/tabthrough/backup/<id>` | Stash-shaped restore of pre-session staged/unstaged/untracked |
| `refs/tabthrough/applied/<id>` | Checkpoint commit of WT after each successful apply/revert (user edits included) |
| Journal token | `mode`, `appliedIndex`, stage, refs, `headBefore`, heartbeat |

Never `stash drop`, delete after/backup/applied, or clear the token unless:

- Cancel/recovery **verified** restore of pre-session, or  
- User explicitly confirms cleanup after Finish (or Clean up backups).

### Cancel

Same sacred restore as v0.1: return to `headBefore`, stash-apply backup, verify against after-ref, then drop. **Discards** applied work and mid-walk edits. If `appliedIndex >= 0` or the applied checkpoint differs from base, show a modal confirmation (default button = keep reviewing / dismiss = don’t cancel).

### Finish (apply mode)

1. Flush saves for dirty buffers in the session’s touched set (prompt on failure — do not Finish dirty-unknown).  
2. Update `applied` checkpoint.  
3. Journal stage `finishing-keep`.  
4. Return to `headBefore` **carrying local changes** (no `-f`). If checkout cannot carry changes, stay detached, keep refs, surface instructions — do not destroy the tree.  
5. **Do not** stash-apply the pre-session backup.  
6. Release session model to idle; **keep** after/backup/applied refs + token in a terminal stage `done-kept` (or equivalent) until cleanup.  
7. Notify: tree kept; offer **Open Source Control** / **Commit…** (handoff). If a pre-session backup exists, state that Cancel is no longer the path — recovery command can still restore pre-session *over* the kept tree only with an explicit dangerous confirm.

### Commit

- Command `tabthrough.commitHandoff` (and Finish offer): focus SCM / `git.commit` UI.  
- Optional message assist later; **never** create the final commit without an explicit user-facing git commit action.  
- Extension may write nothing to `COMMIT_EDITMSG` in v0.2 unless PO later asks for a suggested template the user still confirms.

### Read-only Finish

Unchanged: restore pre-session (Finish ≡ Cancel restore path; messaging differs only).

---

## D7 — Crash recovery under reapply

Extend `SessionToken` (v stays `1` with additive fields; readers default missing fields):

```ts
mode: 'readonly' | 'apply'
appliedIndex: number            // last successfully applied step; -1 = none
appliedRef: string | null       // refs/tabthrough/applied/<id>
```

Stages: existing isolation stages plus, while applying, stay on `reviewing` and treat in-flight Tab as recoverable via “journal write `applying` → write files → write applied ref → write `appliedIndex` → back to `reviewing`”. A crash mid-Tab leaves either the previous checkpoint or a partial write:

- Recovery UI offers: **Restore pre-session** (sacred path) | **Resume apply** (checkout base if needed; reset WT to `applied` checkpoint when present; set cursor to `appliedIndex`; continue) | **Inspect**.  
- Never silently invent a merge of half-written files: if `applying` without a matching applied-ref bump, prefer Restore or Resume-from-previous-index after showing the mismatch.

Heartbeat / lock / second-window rules unchanged.

---

## D8 — Guide schema

**No `.guide.json` v1 change.** Forced splits use existing `ranges` / `grouping: "split"`. Coarse multi-thought steps remain a product/authoring defect (P0-G*), not a schema gap. Apply mode consumes the same `Guide` / `LineGroup` pipeline as read-only.

---

## Consequences

### Positive

- D1 reopen is scoped: read-only safety story intact; ownership path explicit.  
- Reuses `renderReveal` as the intended-state oracle — apply and progressive stay one mental model.  
- Cancel keeps the sacred byte-identical bar.  
- Finish cannot “look like Cancel” — different journal terminal stage and copy.  
- Schema/docs track unblocked without waiting on apply code.

### Negative / residual risks (Planner)

| ID | Risk | Mitigation for plan |
|----|------|---------------------|
| R-apply-1 | 3-way merge quality on messy user edits | Fixture matrix: edit-then-Tab, edit-then-Previous, overlapping hunks; stop-on-conflict gate |
| R-apply-2 | Finish carry-checkout fails (branch tip ≠ base) | Explicit detached-keep UX + applied ref; test commit-entry when HEAD moved |
| R-apply-3 | Pre-session WIP orphaned after Finish | `done-kept` token + recovery/cleanup copy; never auto-drop backup |
| R-apply-4 | Unsaved buffer / multi-editor races | Save-before-apply; single-path steps; drift warn (P1-8 early) |
| R-apply-5 | Async Tab vs keybinding spam | `first-in-win`; disable next/prev while apply pending |
| R-apply-6 | Trust-boundary docs still said “read-only FS” | Overview §5 updated; writes only through apply module |
| R-apply-7 | Range apply | Out of v0.2 (P1-12); single commit + working tree only |

### Out of v0.2

- Apply for commit **ranges** (P1-12).  
- Preserving staged/unstaged split *during* the walk.  
- Multi-step jump.  
- Silent or extension-owned final commit.

---

## Related

- [ADR 0002 — Architecture](0002-architecture.md) (D1 amended by reference)  
- [Product spec](../specs/product.md) — apply acceptance  
- [overview §7.3](../architecture/overview.md) · [reatom-model](../architecture/reatom-model.md)  
- Backlog P0-A2…A6
