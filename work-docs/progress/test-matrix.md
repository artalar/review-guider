# Test Matrix

**Last updated:** 2026-08-07 · **Owner:** Tester (+ Planner §9 apply plan)
**Scope:** what is covered automatically, what needs a human, and what is still open.

Sources: [plan.md](./plan.md) test gates · [specs/product.md](../specs/product.md#edge-case-budget) edge rows · [architecture/overview.md](../architecture/overview.md) §3.5 · [ADR 0004](../decisions/0004-apply-mode.md).

> Phase 2 rule from the plan: **no phase after 2 may merge while the stash round-trip suite is red.**
> Apply rule (v0.2): **Phases 7–10 must keep the sacred suite green; apply Cancel remains byte-identical.**

---

## 1. Automated coverage

Run everything with `pnpm test:ci`. Integration suites shell out to the real `git` binary and build throwaway repositories under the OS temp directory; they need no VS Code host.

| Suite | Type | What it protects |
|-------|------|------------------|
| `test/unit/toolchain.test.ts` | unit | Reatom and the runner actually work (Phase 0 gate) |
| `test/unit/probe.test.ts` | unit, injected exec | Every capability variant, parsed from recorded git output |
| `test/unit/session-status.test.ts` | unit | Session status machine: all 49 ordered pairs |
| `test/unit/steps.test.ts` | unit | Cursor advance, retreat, clamp at both ends, empty guide |
| `test/unit/journal.test.ts` | unit | Journal stage table: all 49 ordered pairs, plus token parsing |
| `test/unit/import-boundaries.test.ts` | unit | `src/guide`, `src/git`, `src/model` import no `vscode` |
| `test/unit/guide-purity.test.ts` | unit | The pure layer stays pure, and carries no `any` |
| `test/unit/{parse-diff,heuristic,render,schema,merge}.test.ts` | unit | Phase 3 guide engine |
| `test/unit/published-schema.test.ts` | unit | `schema/guide-v1.json` and the hand-rolled reader agree — see §7 |
| `test/unit/view.test.ts` | unit | Review document URIs, status-bar composition, the stub-step projection |
| `test/unit/contributions.test.ts` | unit | `package.json` commands carry `enablement`; the Tab `when` clause matches ADR 0002 D2 term for term, and `alt+]`/`alt+[` stay unconditional |
| `test/integration/probe.test.ts` | integration | Probe against real repos: clean, dirty, bare, unborn, merging, detached, subdirectory |
| **`test/integration/stash-roundtrip.test.ts`** | **integration** | **The sacred suite — see §3** |
| `test/integration/crash-matrix.test.ts` | integration | Recovery from every journal state — see §4 |
| `test/integration/session-lifecycle.test.ts` | integration | The Reatom lifecycle driving the real protocol — see §5 |
| `test/integration/entry-points.test.ts` | integration | All three entries against real repos, plus the sidecar read — see §5.1 |
| `test/integration/reveal-loop.test.ts` | integration | Tab/Shift+Tab over a real diff: monotonic reveal, exact reversal, convergence to the after blob — see §5.2 |
| `test/integration/edge-cases.test.ts` | integration | The three P0 edge rows the earlier phases left to a fixture — see §2 |

---

## 2. P0 edge-case matrix

The ten rows of [specs/product.md → Edge-case budget → P0](../specs/product.md#edge-case-budget), which is the list plan Phase 6 (P0-16) has to close. **Every row now has a passing automated test.** Four of them additionally have a human drill, because the part a test cannot reach — a killed process, a second window, a keyboard — is exactly the part a user will hit.

| # | Edge case | Required handling | Covered by | Status |
|---|-----------|-------------------|------------|--------|
| 1 | Dirty working tree at start | Stash tracked + configured untracked, show a summary, refuse the start if the stash fails | §3, all eleven dirty fixtures; §5 "isolates the tree on start"; §3 "Journal write fails mid-start" for the refusal path | **Automated** |
| 2 | Stash pop conflict on restore | Never force; surface the conflict, keep the backup ref until the user dismisses | §3 "Apply conflict"; §4 "Capture unreproducible"; §5 "Blocked recovery". Note the product wording: the implementation never runs `stash pop` at all — it is apply → verify → *then* drop | **Automated** |
| 3 | User closes VS Code mid-session | Persist a token; offer "Resume restore" before any other git operation | §4, every reachable journal state; §5 `deactivate()`; the *prompt* is bridge code with no host test | **Automated + drill §6.1** |
| 4 | Tab when no steps remain | No-op plus a subtle "Review complete", offer Finish | §5.2 "Clamp"; `steps.test.ts`; §2 row 6's end-to-end walk presses past the last step. The toast itself is bridge code, seen in drill §6.4 | **Automated** |
| 5 | Empty diff / whitespace-only | Block the start with a clear message | §5.1, four refusal cases; §5 "Empty diff". Both refusals happen in the stat-only pass, so nothing is mutated | **Automated** |
| 6 | Binary / generated files in the diff | Skip with a visible stub step, without breaking the ordering | `edge-cases.test.ts` → "binary and generated files", four cases: the stub and its rationale, `k/n` honesty, the ordering around it, the stub's own document, invariant I1, and a full walk that restores byte-identically | **Automated — new in Phase 6** |
| 7 | Extension crash during review | Backup ref plus a recovery command | §4; §5 "Recovery command with no session" and "Orphan ref cleanup" | **Automated + drill §6.1** |
| 8 | Multiple concurrent sessions | Disallow — one active session, block the second start | §3 "Second session on the same repo" (`RepoLockedError`), "will not let one window release another window's lock"; §5 "Second Start in one window", "Lock held by another window", and the second window's *recovery* path — "does not offer to restore a session that is live in another window" plus its stale-heartbeat twin. One process only; two real windows are §6.2 | **Automated + drill §6.2** |
| 9 | Git not a repo / no git | Disable the commands with an explanation | `edge-cases.test.ts` → "git unusable": a plain directory, an unborn branch, and no workspace at all, each asserting `canStart` is false *and* that the reason names the fix; `probe.test.ts` (unit + integration) for every capability variant; `contributions.test.ts` for the `enablement` clauses | **Automated — new in Phase 6** |
| 10 | Detached HEAD / shallow clone missing objects | Detect early; fail with a fetch hint | Detached: `probe.test.ts` integration, §3 "Commit entry from a detached HEAD". Shallow: `edge-cases.test.ts` → "shallow clone with missing objects", five cases | **Automated — new in Phase 6** |

### 2.1 What row 10 turned up

Walking this row found a real defect rather than a missing fixture, which is the argument for walking rows you believe are already covered.

`git rev-parse <sha>^1` fails at the boundary commit of a shallow clone for the same reason it fails on a genuine root commit: the graft hides the parent. `resolveCommitEntry` read that as "root commit" and diffed against the empty tree, so **Start Review from Commit in a `--depth 1` clone showed the entire repository as freshly added** — a review that is confidently, silently wrong, which is worse than an error.

The raw commit object still carries its `parent` lines, and that is what separates the two cases. `planIsolation` now raises `MissingObjectsError` naming `git fetch --unshallow`, from the stat-only pass, before the pre-flight is shown and before anything is mutated. A range whose merge base is outside the clone gets the same treatment. The fixture asserts the refusal, that the repository is byte-identical afterwards, and — the honest other half — that the working-tree entry still works in a shallow clone, because it needs no history at all.

---

## 3. The sacred suite — fixture matrix

`test/integration/stash-roundtrip.test.ts`. Each case fingerprints the repository, runs the real isolation pipeline, restores, and asserts the fingerprint is unchanged.

**Fingerprint** = `git status --porcelain=v2 --untracked-files=all -z` (branch headers dropped, sorted) **+** SHA-256 of every tracked and untracked file **+** the executable bit.

| Fixture repo state | Asserted | Status |
|--------------------|----------|--------|
| Clean tree | No stash entry created at all | Pass |
| Unstaged edits only | Byte-identical restore | Pass |
| Staged + unstaged edits to one file | Both hunks **and** the index split restored | Pass |
| Untracked files present | Restored, still untracked | Pass |
| Untracked present, `stash.includeUntracked: false` | Left on disk, never stashed | Pass |
| File mode change (`chmod +x`) | Mode preserved | Pass (skipped on Windows) |
| CRLF / mixed line endings | No normalisation drift | Pass |
| Deleted-but-not-staged file | Still deleted after restore | Pass |
| Ignored file (`.env` behind `.gitignore`) | Never swept, never touched (R8) | Pass |
| Staged rename | Restored as a rename | Pass |
| Mixed subtree: edit + delete + staged add + untracked | All four restored | Pass |
| Commit entry from a branch | HEAD returns to the branch | Pass |
| Root commit entry | Base resolves to the empty tree | Pass |
| Commit entry from a detached HEAD | HEAD returns to the same detached sha | Pass |
| Apply conflict (tree edited mid-session) | Blocked, nothing discarded, retry succeeds | Pass |
| Restore run twice | Second run is a verified no-op | Pass |
| Journal write fails mid-start | Start unwinds; tree, stash, refs and lock all clean | Pass |
| Second session on the same repo | `RepoLockedError`; first session untouched | Pass |

---

## 4. Crash matrix

`test/integration/crash-matrix.test.ts`. A crash is indistinguishable from a token that stopped advancing, so every reachable journal state is constructed directly and handed to `restoreFromToken`. The journal records a stage *before* the operation it names, so a token at stage X means **at most** X happened.

| Journal state | What is on disk | Restore must | Status |
|---------------|-----------------|--------------|--------|
| `planned` | Lock only | Release the lock, clear the token | Pass |
| `captured` | Lock + after-ref; tree still dirty | Verify, delete the ref, release | Pass |
| `stashed` | Work in the stash and the backup ref | Apply, verify, drop | Pass |
| `checkedout` | As above, HEAD moved | Return HEAD, apply, verify, drop | Pass |
| `reviewing` | Steady state | Same as `checkedout` | Pass |
| `stashed`, push never ran | Tree still dirty | Notice the work never left, verify, tidy | Pass |
| `reviewing`, backup ref never written | Only the scoped stash message survives | Find the entry by message, restore | Pass |
| `reviewing`, checkout never ran | HEAD never moved | Skip the checkout, restore | Pass |
| Any state, restore interrupted and retried | — | Idempotent; the second run is a no-op | Pass |
| Capture unreproducible (foreign edit) | — | **Refuse**: block, drop nothing, delete nothing | Pass |

---

## 5. Lifecycle matrix

`test/integration/session-lifecycle.test.ts` drives the Reatom actions against real repositories with in-memory ports, so the five exit paths from plan P0-6 are covered by the same restore code the bridge calls.

| Exit path | Asserted | Status |
|-----------|----------|--------|
| Finish | Restore, verify, drop, delete refs, clear token | Pass |
| Cancel | Byte-identical to Finish; only the message differs | Pass |
| `deactivate()` | Same restore, "shutting down" message | Pass |
| Window close / crash | Covered by §4 plus the drill in §6.1 | Pass + manual |
| Recovery command with no session | `recoverBackup()` restores standalone | Pass |
| Pre-flight declined | Nothing mutated, no error toast | Pass |
| Empty diff | Start refused before any mutation | Pass |
| Second Start in one window | Refused; the running session is left completely alone | Pass |
| Blocked recovery | Stash, backup ref and token all survive; warning names the commands | Pass |
| Orphan ref cleanup | Removes stray refs, refuses while a token is outstanding | Pass |
| Lock held by another window | Refused *before* the pre-flight is shown | Pass |
| Workspace folder is a subdirectory of the repo | The token is still found — it is keyed on the probed repo root | Pass |

### 5.1 Entry points

`test/integration/entry-points.test.ts` scripts a repository per case and drives the real pipeline — isolate, diff the capture commit, parse, order, merge — so these assert the diff a reviewer would actually walk, not a stub.

| Case | Asserted | Status |
|------|----------|--------|
| Working tree | Staged, unstaged and untracked work arrive as one diff | Pass |
| Working tree, post-stash | The diff comes from the capture commit; the stashed disk is not read | Pass |
| Single commit | Diffed against its first parent | Pass |
| Root commit | Diffed against the empty tree rather than erroring | Pass |
| Merge commit | Diffed against its first parent | Pass |
| Range `A..B` | Resolved through merge-base; commits only on `A` are excluded | Pass |
| Range patch text | Byte-identical to `git diff $(git merge-base A B) B` | Pass |
| Empty diff | Refused before any mutation | Pass |
| Whitespace-only working tree | Refused, with the whitespace reason rather than "nothing to review" | Pass |
| Whitespace-only commit | Same refusal on the commit entry | Pass |
| Revision that does not resolve | Refused, nothing mutated | Pass |
| Committed `.guide.json` | Step order comes from the sidecar | Pass |
| Malformed `.guide.json` | Heuristic order, exactly one warning | Pass |
| Commit picker source | Newest first, merge commits flagged, limit honoured, unborn branch yields an empty list rather than an error | Pass |
| Range input parsing | `..` and `...` alike; `v1.0..v2.0` keeps its dots; junk is rejected with an explanation | Pass |

### 5.2 Reveal loop

`test/integration/reveal-loop.test.ts` walks the cursor over a real diff and reads the same `ui.reviewViewModel` projection the bridge subscribes to.

| Case | Asserted | Status |
|------|----------|--------|
| Advance | Revealed group set grows monotonically; the final document equals the after blob | Pass |
| Retreat | Shift+Tab restores the previous document exactly, not by undo | Pass |
| Clamp | No-op at both ends; the end reports "nothing to advance to" so the command can offer Finish | Pass |
| Highlight | `currentRanges` point at lines the current step actually added | Pass |
| Multi-file | The active document switches with the step | Pass |
| Dim mode | Whole change rendered, everything past the cursor marked pending | Pass |
| Stub step | The binary file's step gets `path + rationale` as its document, empty base, no ranges (`edge-cases.test.ts`) | Pass |

Not covered here, by construction: that VS Code paints what the projection describes. That is §6.4.

---

## 6. Manual drills

These cannot be automated without a VS Code host, and two of them require killing a process. Run all five before the MVP ships, and re-run §6.1 and §6.3 whenever the safety protocol changes.

Setup for each drill:

```bash
git clone <any repo> /tmp/drill && cd /tmp/drill
printf 'edit\n' >> README.md          # unstaged
printf 'staged\n' > staged.txt && git add staged.txt
printf 'loose\n' > untracked.txt      # untracked
printf 'SECRET=1\n' > .env && echo .env >> .gitignore
git status --porcelain=v2 --untracked-files=all -z | tr '\0' '\n' > /tmp/drill-before.txt
find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum > /tmp/drill-hashes-before.txt
```

Every drill passes only if, at the end:

```bash
git status --porcelain=v2 --untracked-files=all -z | tr '\0' '\n' | diff - /tmp/drill-before.txt
find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | diff - /tmp/drill-hashes-before.txt
git for-each-ref refs/tabthrough     # must print nothing
git stash list                           # must contain no tabthrough: entry
```

### 6.1 Crash drill — extension host killed mid-session

Covers the product edge rows *"extension crash during review"* and *"user closes VS Code mid-session"* (§2 rows 3 and 7).

1. Open `/tmp/drill` in VS Code and run **Tabthrough: Start Review (Working Tree)**. Approve the pre-flight.
2. Confirm the isolation is real: the working tree is clean (`git status`), `git stash list` shows one `tabthrough:<id>` entry, and `git for-each-ref refs/tabthrough` shows `after/<id>`, `backup/<id>` and `lock`.
3. Advance two or three steps.
4. **Kill the extension host without letting `deactivate` run:**
   - Command Palette → *Developer: Open Process Explorer*, right-click the `extensionHost` process → **Kill Process**.
   - Or from a terminal: `pkill -f 'extensionHost'` (macOS/Linux), `taskkill /F /IM Code.exe` (Windows, kills the window too — that is the harsher variant, run it at least once).
5. Verify the crash left the safe state: the tree is still clean, and the stash entry, both refs and the lock are all still present. **Nothing should have been restored yet** — that is the point of the durable token.
6. Reload the window (*Developer: Reload Window*), or reopen VS Code.
7. Tabthrough must prompt **before any other git operation**: *"Tabthrough did not finish restoring your work last time."* naming the session id and the stage it stopped at.
8. Choose **Restore now**. Run the four verification commands above.
9. Repeat once choosing **Later**: Start must stay disabled with the reason *"Tabthrough has work to restore from a previous session"*, and **Tabthrough: Restore from Backup** must then complete the job.

**Fail conditions:** any hash differs; the prompt does not appear; Start is enabled while a token is outstanding; a stash entry or ref is left behind after a successful restore.

**Status:** ☐ not yet run against a packaged build.

### 6.2 Two-window drill — concurrent sessions

Covers the product edge row *"multiple concurrent sessions"* (§2 row 8) and plan P0-7. The automated lock test covers one process; this covers two.

1. Open `/tmp/drill` in two VS Code windows (*File → New Window*, open the same folder).
2. Start a review in window A. Approve.
3. In window B, Start and Review… are disabled; the sidebar shows **Review active in another window**. Nothing is written.
4. `git for-each-ref refs/tabthrough` must show exactly one `after/` and one `backup/` ref, and `git cat-file blob refs/tabthrough/lock` must print `tabthrough-lock:<A's session id>` — the lock names its owner (review 001 M3).
5. **Recovery must not fire in window B.** Reload window B (*Developer: Reload Window*) while A is still reviewing. B sees A's token in `globalState`, so this is the path that used to offer *"Tabthrough did not finish restoring your work last time."* and, if accepted, applied A's stash out from under it. B must instead show *"A Tabthrough session is active in another window."*, offer no restore, and leave A's stash entry, refs and token untouched — check A can still Tab and still finishes cleanly.
6. **Then let the heartbeat go stale.** Kill window A's extension host (§6.1 step 4) and wait 30 s. Reload window B: now it must raise the crash-recovery modal, and **Restore now** must complete the job.
7. Finish in window A (or restore from B, if step 6 was run). Verify with the commands above.
8. Start in window B. It must now succeed.

**Fail conditions:** two stash entries; the lock ref is present after A finishes; B's refusal leaves any artifact behind; B's refusal disturbs A's session in any way; **B offers to restore a live session, or fails to offer once A is really gone**.

**Status:** ☐ not yet run.

### 6.3 Stale lock drill

Not a product edge row, but a direct consequence of the compare-and-swap lock (ADR 0002 D5). Breaking a lock is always an explicit user action, so the escape hatch has to work.

1. Simulate an abandoned lock with no token: `git update-ref refs/tabthrough/lock HEAD`.
2. The Walkthrough sidebar must show **Leftover review lock** with **Clear leftover lock**. Start stays disabled and must not show the pre-flight.
3. Run **Clear leftover lock** and confirm. The lock ref is gone; leftover after/backup refs stay until **Clean Up Backups**. This drill creates only the lock, so `git for-each-ref refs/tabthrough` is empty.
4. Start again — it must succeed.

**Clean Up Backups** still skips the lock so it cannot yank the rug out from under a live session. Clear leftover lock refuses while this editor can see a live or recoverable token for the repository, re-checked after the confirmation.

**Status:** ☐ not yet run.

### 6.4 Keybinding conflict matrix

Plan P0-11's test gate, and the only way to falsify [R1](./plan.md#r1--tab-keybinding-conflicts). `test/unit/contributions.test.ts` asserts the `when` clause is *written* correctly; nothing but a keyboard can prove VS Code resolves it the way we read it.

Start any review, then for each row put the editor in that state and press <kbd>Tab</kbd>.

| Focus / state | Expected |
|---------------|----------|
| Review document, nothing else open | Advances one step |
| Review document, IntelliSense list open | Accepts the suggestion — Tabthrough does not advance |
| Review document, inline (ghost-text) suggestion showing | Accepts the suggestion |
| Review document, snippet placeholder active | Jumps to the next placeholder |
| Review document, rename box or parameter hints open | The widget consumes Tab |
| Review document, text selected | Advances one step (a read-only document has no indent semantics to protect) |
| Review document, `editor.tabMovesFocus` on | Moves focus — accessibility wins over the binding |
| Review document, screen-reader / accessibility mode on | Moves focus |
| A normal source file, session active | Inserts a tab or indents, exactly as usual |
| Terminal, session active | Terminal handles it |
| Any tree view, search box, or the Command Palette | The widget handles it |
| `tabthrough.keybinding.useTab: false`, review document | Nothing happens; <kbd>Alt</kbd>+<kbd>]</kbd> still advances |
| <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> from a normal editor, session active | Advances / retreats |
| <kbd>Alt</kbd>+<kbd>]</kbd> with no session | Nothing happens |

While you are here, the two toasts no test can see: pressing <kbd>Tab</kbd> past the last step must show the subtle "Review complete" offering Finish (§2 row 4), and a binary file's step must render as its own explanation document rather than a blank editor (§2 row 6, whose *content* is asserted in §5.2).

**Fail conditions:** any row where Tabthrough advances while a widget was open, or where a normal editor loses its ordinary Tab behaviour.

**Status:** ☐ not yet run.

### 6.5 Time-to-first-reveal

Product metric from plan Phase 5: **under 3 s on a 500-line diff.** Only the first step is timed — later steps are pure cursor moves and cost nothing.

1. Build a fixture: `git checkout -b bench && <script that touches ~15 files, ~500 changed lines> && git add -A && git commit -m bench`.
2. Run **Start Review from Commit…** and pick it.
3. Time from approving the pre-flight to the diff editor showing the first step.

Three of the four costs are git subprocesses — capture, checkout, `readDiff` — and one is `showBlob` for the first file. The parse and ordering pass is pure and small. If this misses, profile the subprocesses before touching the guide engine.

**Status:** ☐ not yet run.

---

## 7. The published schema

`schema/guide-v1.json` is what an author's editor validates against; the hand-rolled validator in `src/guide/schema.ts` is what decides whether their session works. Two artifacts describing one format is a drift risk, so `test/unit/published-schema.test.ts` holds them together instead of trusting review to.

| Asserted | Why it matters |
|----------|----------------|
| Required fields agree at every level — document, step, range, scope | A schema that accepted a document the reader rejects would promise a guide works and then silently fall back to the heuristic |
| Every enum agrees, in both directions: each declared value is accepted, an undeclared one is refused | The enums are the fields most likely to grow a value in one place only |
| The known-property sets agree at every level | Keeps the reader's `unknown-field` diagnostic and the schema's `additionalProperties` describing the same boundary |
| `steps.maxItems` equals `MAX_STEPS`; the two step-id patterns accept and reject the same sample ids; `maxLinesPerStep` and `range.start` bounds match | Written differently on each side (`\w` against an explicit class), so equality is asserted on behaviour rather than on text |
| `$id` is the frozen URL, and the fixtures and the agent skill point at it | The `$id` is a v1 promise; the resolvable copy is the raw GitHub URL until the domain serves it |
| The schema is *stricter* than the reader about unknown fields, deliberately | Forward compatibility: a 1.1 document must work in a 1.0 reader, so the reader downgrades to an info diagnostic while the schema still tells the author about their typo |
| Every guide document embedded in `guide-schema.md`, `agent-guide-authoring.md` and the agent skill validates | A doc example is the thing agents copy; it cannot be allowed to rot into something the reader rejects |

---

## 8. Known gaps

| Gap | Consequence | Where it belongs |
|-----|-------------|------------------|
| Keybinding conflict matrix | The clause is asserted as text, never as behaviour. Runbook is §6.4 | Phase 6 (human) |
| Time-to-first-reveal benchmark | Unmeasured. Runbook is §6.5 | Phase 6 (human) |
| The three safety drills | §6.1, §6.2 and §6.3 have never been run against a packaged build. They are the only evidence for the parts of rows 3, 7 and 8 that live outside one process | Phase 6 (human), before dogfood |
| Stale-lock drill is automated, not packaged | §6.3 is covered in `session-lifecycle.test.ts`; the packaged-build walk is still unrun | Phase 6 (human) |
| A foreign edit during a session blocks the restore | Conservative and safe — nothing is dropped — but the user must undo the edit or recover by hand. The alternative is dropping a stash we cannot verify, which is not on the table | P1-8 drift detection |
| Nothing exercises the VS Code bridge | `src/ui/documents.ts` and the status bar have no host-level test — the model projection they render is covered, the rendering is not | An `@vscode/test-electron` suite, if one is ever worth its weight |
| Gitignored `.guide.json` on the working-tree entry | `add -A` honours `.gitignore`, so an ignored sidecar is not in the capture commit and is never read. Committing it, or not ignoring it, is the workaround | Documented in the README's limitations |
| `git.path` / non-PATH git | The probe reports `git-missing` and says to install git or set `git.path`; the setting itself is not read yet | P1 |
| `shallow-missing-objects` is never returned by the probe | The reason exists in `GitCapabilityReason` but a shallow clone probes as usable, which is correct — the missing object only matters once an entry point asks for history, and that refusal now happens in `planIsolation` (§2.1). The unused variant is worth deleting or wiring | P1 tidy-up |
| Apply mode (Phases 7–10) | Planned coverage in §9; no automated apply suite until Implementer P0-A3 | v0.2 |

---

## 9. Apply mode (v0.2) — planned coverage

Normative: [ADR 0004](../decisions/0004-apply-mode.md). Product edges: [specs/product.md → P0 (v0.2 apply)](../specs/product.md#edge-case-budget). Risks: [plan.md R-apply-1…9](./plan.md#apply-mode-risk-register-v02).

**Status:** Planned (Planner P0-A2). Implementer fills Pass/Fail as Phases 7–10 land. Tester owns fixture authorship once code exists.

### 9.1 Apply step / merge / revert (Phase 7 — P0-A3)

| Case | Assert | Risk |
|------|--------|------|
| Fast-path Tab (`current === intendedPrev`) | Writes `intendedNext`; `appliedIndex` advances; applied-ref bumps | — |
| Edit-then-Tab clean 3-way | User edit preserved; step lands; advance | R-apply-1 |
| Edit-then-Tab conflict | **Stop**; no advance; conflict surfaced; no silent overwrite | R-apply-1 · product row |
| Shift+Tab / Previous clean | Reverts last step; `appliedIndex` decrements | P1-13 |
| Shift+Tab after messy edit → conflict | Block; explanation; index unchanged | R-apply-1 |
| Overlapping hunks / multi-hunk user edit | Conflict or clean merge per 3-way; never skip | R-apply-1 |
| Unsaved buffer cannot save | Apply refused; index unchanged | R-apply-4 |
| Double-Tab / spam while pending | Second apply does not interleave (`first-in-win`) | R-apply-5 |
| Stub / binary step | No file write; advance with status note | — |
| Drift outside step path | Warn (P1-8 early); do not auto-overwrite foreign files | R-apply-4 |
| Cancel after N applied steps (+ mid edits) | Pre-session fingerprint restored (sacred) | product “User edits then abort” |
| Readonly session regression | Existing reveal/lifecycle suites still Pass | additive constraint |

### 9.2 Finish vs Cancel (Phase 9 — P0-A5)

| Case | Assert | Risk |
|------|--------|------|
| Apply Cancel | Sacred restore; confirm when `appliedIndex >= 0` | — |
| Apply Finish | Tree **kept**; backup **not** stash-applied; journal `done-kept` | R-apply-3 |
| Finish vs Cancel fingerprints | Distinct outcomes; copy/UI never confuse them | R-apply-9 |
| Finish carry-checkout fails | Stay detached; refs kept; instructions; no `-f` | R-apply-2 |
| Commit handoff | SCM / commit UI focused; **no** extension `git commit` | — |
| Readonly Finish | Still restores (unchanged) | — |
| After Finish, cleanup | after/backup/applied refs retained until explicit cleanup | R-apply-3 |

Rows added by [review 003](./reviews/003.md) — none of §9.2 was implemented at the Phase 9 gate.
The first four block the ship; they are backlog **P0-A5-F11**.

| Case | Assert | Review ref |
|------|--------|-----------|
| Finish offered after a conflict | Completion message + Finish button **not** shown while `canAdvance()`; Finish refuses a tree holding markers | **B1** |
| Apply `deactivate` | Does not silently discard the walk; user-authored file survives; nothing destructive without consent | **B2** |
| User creates a file mid-walk, then Cancel | File survives, or is disclosed and stashed — never removed as "junk" | **M1** |
| `finishKeepFromToken` blocked branch | Carry failure → `blocked`, refs kept, detached, no `-f` (fix P0-A5-F1 is currently unasserted) | **M4, P0-A5-F1** |
| Finish mid-walk (incomplete) | Partial application kept, journal `done-kept`, no claim the walk finished | **T1** |
| WT-entry Finish (Phase 8) | Applied work kept; pre-session stash **not** re-applied over it | R-apply-9 |
| Start after `done-kept` | Prior kept-session backup pointer not lost; `restoreBackup` / `recoverBackup` give a usable message, not `IllegalStageError` | **M2, M3** |
| Finish with an unsaved buffer | Non-step dirty editors are saved or disclosed before the carry | **m3** |
| No commit, ever | No code path constructs `git commit` (currently true, unasserted) | — |

### 9.3 Crash / recovery stages (Phase 10 — P0-A6)

Extend `crash-matrix` / recovery protocol:

| Journal / state | On disk | Recovery must | Risk |
|-----------------|---------|---------------|------|
| `applying`, applied-ref not bumped | Partial or prior WT | Offer Restore \| Resume-from-previous index \| Inspect; **never** silent merge of half-write | product “Crash mid-apply” |
| `applying`, applied-ref bumped, index not yet written | Checkpoint ahead of token | Prefer Resume at checkpoint; show mismatch | — |
| `reviewing` apply, `appliedIndex = k` | Applied checkpoint | Resume apply at k | — |
| `finishing-keep` interrupted | WT may be mid-carry | Keep refs; offer complete keep or Restore with confirm | R-apply-2 |
| `done-kept` | Tree kept; refs present | Not a crash; Start may proceed; cleanup available; Restore pre-session over kept tree needs **dangerous confirm** | R-apply-3 |

### 9.4 Apply keybinding / file-scheme (Phase 7 + manual)

Readonly §6.4 still applies to `tabthrough:` docs. Apply adds:

| Focus / state | Expected |
|---------------|----------|
| Apply session, workspace `file` editor | <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> advance / revert |
| Apply + narrowed Tab when-clause (if shipped) | Tab advances only with widget guards; IntelliSense / snippet / inline suggestion still win |
| Apply session, normal editor, no chord | Ordinary Tab indent — must not be stolen globally |
| `tabthrough:` doc during apply | N/A if apply opens real files only; if both exist, document which binding wins |
| Pending apply (`applyPending`) | Next/Previous disabled or no-op |

**Manual drill §6.6 (apply crash)** — add when Phase 10 lands: kill host mid-Tab (`applying`); reload; choose Restore vs Resume; fingerprint / checkpoint asserts. Until then: ☐ not written as a full runbook.

### 9.5 P0 v0.2 product edge map

| Product row | Covered by |
|-------------|------------|
| Crash mid-apply | §9.3 |
| User edits then abort | §9.1 Cancel row · Phase 8 WT |
| Conflict applying next step onto user edits | §9.1 conflict rows |
