# Test Matrix

**Last updated:** 2026-08-07 · **Owner:** Implementer + Tester
**Scope:** what is covered automatically, what needs a human, and what is still open.

Sources: [plan.md](./plan.md) test gates · [specs/product.md](../specs/product.md#edge-case-budget) edge rows · [architecture/overview.md](../architecture/overview.md) §3.5.

> Phase 2 rule from the plan: **no phase after 2 may merge while the stash round-trip suite is red.**

---

## 1. Automated coverage

Run everything with `pnpm test:ci`. Integration suites shell out to the real `git` binary and build throwaway repositories under the OS temp directory; they need no VS Code host.

| Suite | Type | What it protects |
|-------|------|------------------|
| `test/unit/toolchain.test.ts` | unit | Reatom and the runner actually work (Phase 0 gate) |
| `test/unit/probe.test.ts` | unit, injected exec | Every capability variant, parsed from recorded git output |
| `test/unit/session-status.test.ts` | unit | Session status machine: all 49 ordered pairs |
| `test/unit/journal.test.ts` | unit | Journal stage table: all 49 ordered pairs, plus token parsing |
| `test/unit/import-boundaries.test.ts` | unit | `src/guide`, `src/git`, `src/model` import no `vscode` |
| `test/unit/guide-purity.test.ts` | unit | The pure layer stays pure, and carries no `any` |
| `test/unit/{parse-diff,heuristic,render,schema,merge}.test.ts` | unit | Phase 3 guide engine |
| `test/integration/probe.test.ts` | integration | Probe against real repos: clean, dirty, bare, unborn, merging, detached, subdirectory |
| **`test/integration/stash-roundtrip.test.ts`** | **integration** | **The sacred suite — see §2** |
| `test/integration/crash-matrix.test.ts` | integration | Recovery from every journal state — see §3 |
| `test/integration/session-lifecycle.test.ts` | integration | The Reatom lifecycle driving the real protocol — see §4 |

---

## 2. The sacred suite — fixture matrix

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
| Commit entry from a detached HEAD | HEAD returns to the same detached sha | Pass |
| Apply conflict (tree edited mid-session) | Blocked, nothing discarded, retry succeeds | Pass |
| Restore run twice | Second run is a verified no-op | Pass |
| Journal write fails mid-start | Start unwinds; tree, stash, refs and lock all clean | Pass |
| Second session on the same repo | `RepoLockedError`; first session untouched | Pass |

---

## 3. Crash matrix

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

## 4. Lifecycle matrix

`test/integration/session-lifecycle.test.ts` drives the Reatom actions against real repositories with in-memory ports, so the five exit paths from plan P0-6 are covered by the same restore code the bridge calls.

| Exit path | Asserted | Status |
|-----------|----------|--------|
| Finish | Restore, verify, drop, delete refs, clear token | Pass |
| Cancel | Byte-identical to Finish; only the message differs | Pass |
| `deactivate()` | Same restore, "shutting down" message | Pass |
| Window close / crash | Covered by §3 plus the drill in §5.1 | Pass + manual |
| Recovery command with no session | `recoverBackup()` restores standalone | Pass |
| Pre-flight declined | Nothing mutated, no error toast | Pass |
| Empty diff | Start refused before any mutation | Pass |
| Second Start in one window | Refused; the running session is left completely alone | Pass |
| Blocked recovery | Stash, backup ref and token all survive; warning names the commands | Pass |
| Orphan ref cleanup | Removes stray refs, refuses while a token is outstanding | Pass |
| Lock held by another window | Refused *before* the pre-flight is shown | Pass |

---

## 5. Manual drills

These cannot be automated without a VS Code host, and two of them require killing a process. Run all three before the MVP ships, and re-run §5.1 and §5.3 whenever the safety protocol changes.

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
git for-each-ref refs/guide-reviewer     # must print nothing
git stash list                           # must contain no guide-reviewer: entry
```

### 5.1 Crash drill — extension host killed mid-session

Covers the product edge rows *"extension crash during review"* and *"user closes VS Code mid-session"*.

1. Open `/tmp/drill` in VS Code and run **Guide Reviewer: Start Review (Working Tree)**. Approve the pre-flight.
2. Confirm the isolation is real: the working tree is clean (`git status`), `git stash list` shows one `guide-reviewer:<id>` entry, and `git for-each-ref refs/guide-reviewer` shows `after/<id>`, `backup/<id>` and `lock`.
3. Advance two or three steps.
4. **Kill the extension host without letting `deactivate` run:**
   - Command Palette → *Developer: Open Process Explorer*, right-click the `extensionHost` process → **Kill Process**.
   - Or from a terminal: `pkill -f 'extensionHost'` (macOS/Linux), `taskkill /F /IM Code.exe` (Windows, kills the window too — that is the harsher variant, run it at least once).
5. Verify the crash left the safe state: the tree is still clean, and the stash entry, both refs and the lock are all still present. **Nothing should have been restored yet** — that is the point of the durable token.
6. Reload the window (*Developer: Reload Window*), or reopen VS Code.
7. Guide Reviewer must prompt **before any other git operation**: *"Guide Reviewer did not finish restoring your work last time."* naming the session id and the stage it stopped at.
8. Choose **Restore now**. Run the four verification commands above.
9. Repeat once choosing **Later**: Start must stay disabled with the reason *"Guide Reviewer has work to restore from a previous session"*, and **Guide Reviewer: Restore from Backup** must then complete the job.

**Fail conditions:** any hash differs; the prompt does not appear; Start is enabled while a token is outstanding; a stash entry or ref is left behind after a successful restore.

**Status:** ☐ not yet run against a packaged build.

### 5.2 Two-window drill — concurrent sessions

Covers the product edge row *"multiple concurrent sessions"* and plan P0-7. The automated lock test covers one process; this covers two.

1. Open `/tmp/drill` in two VS Code windows (*File → New Window*, open the same folder).
2. Start a review in window A. Approve.
3. In window B, run **Start Review**. It must refuse with *"Another window is already reviewing this repository."* and must not create a second stash entry, a second after-ref, or move HEAD.
4. `git for-each-ref refs/guide-reviewer` must show exactly one `after/` and one `backup/` ref.
5. Finish in window A. Verify with the commands above.
6. Start in window B. It must now succeed.

**Fail conditions:** two stash entries; the lock ref is present after A finishes; B's refusal leaves any artifact behind; B's refusal disturbs A's session in any way.

**Status:** ☐ not yet run.

### 5.3 Stale lock drill

Not a product edge row, but a direct consequence of the compare-and-swap lock (ADR 0002 D5). Breaking a lock is always an explicit user action, so the escape hatch has to work.

1. Simulate an abandoned lock with no token: `git update-ref refs/guide-reviewer/lock HEAD`.
2. Run **Start Review**. It must refuse with the "another window" message *without showing the pre-flight* — the user is never asked to approve a stash that cannot happen.
3. `git update-ref -d refs/guide-reviewer/lock`, then Start again — it must succeed.

**Known gap:** there is no in-product command to break a stale lock. **Guide Reviewer: Clean Up Backups** deliberately skips the lock ref so it cannot yank the rug out from under a live session. Tracked below.

**Status:** ☐ not yet run.

---

## 6. Known gaps

| Gap | Consequence | Where it belongs |
|-----|-------------|------------------|
| No command breaks a stale lock | A lock left by a hard crash *and* a lost `globalState` needs `git update-ref -d` by hand | Phase 6 |
| A foreign edit during a session blocks the restore | Conservative and safe — nothing is dropped — but the user must undo the edit or recover by hand. The alternative is dropping a stash we cannot verify, which is not on the table | Phase 6 / P1-8 drift detection |
| Shallow-clone fixture | The probe reports `shallow`, but no fixture proves a missing-object failure | Phase 6 |
| Keybinding conflict matrix | Phase 5 has not landed | Phase 5 |
| Time-to-first-reveal benchmark | Phase 5 has not landed | Phase 5 |
| `git.path` / non-PATH git | The probe reports `git-missing`; the setting is not read yet | Phase 6 |
