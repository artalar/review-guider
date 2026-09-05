---
name: tabthrough
description: Emits a Tabthrough `.tabthrough-guide.json` v1 sidecar alongside a PR, commit, or working-tree change, so a human can unfold the diff step by step in order that builds understanding. Use whenever you finish producing a code change that another person will review, or when asked to write, fix, or validate a `.tabthrough-guide.json`.
---

# Tabthrough sidecar

A `.tabthrough-guide.json` tells Tabthrough **the order in which your change should be read, and one line per step explaining why it comes there**. The reader presses Tab to unfold **one thought at a time**. It is not a review, a summary, or a quiz.

Write one whenever you hand a non-trivial change to a human. Skip it for a one-file, one-hunk, one-thought change — there is no order to convey.

## Contract

- **Schema:** `$schema` is `https://tabthrough.dev/schema/guide-v1.json`. Validate the document against that schema before handing it over.
- **Location:** `.tabthrough-guide.json` at repo root (or `tabthrough.guideFile`). Legacy `.guide.json` is still read.
- **Guarantee:** a broken guide never breaks a session — heuristic fallback + one warning. Validate yourself; nobody else will catch your merges.

## Procedure (gates — do not skip)

1. Make the change.
2. **Study the real patch** before writing any step. Never emit from your plan or memory of the edit:

   ```bash
   git status --porcelain=v1 --untracked-files=all
   git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after>
   ```

   For a working-tree review, include untracked files. Start captures with `git add -A`. **Omit `scope.diffDigest`** on working-tree guides — the sidecar is written into the tree it describes.
3. List the **whiteboard thoughts** in the patch (helper vs consumer, type vs caller, failure vs fix, contract vs wiring). Distinct thoughts → distinct steps.
4. Decide order: *what would I draw first at a whiteboard?* Prefer more, smaller steps when a hunk mixes thoughts.
5. Write `.tabthrough-guide.json`. Use **`ranges` whenever one file has more than one thought** — a whole-file claim is only correct when the whole file is one thought.
6. Run **Before you emit**.

## One thought per Tab

A step is one unit of understanding the reader can absorb, then press Tab. **If the rationale needs "and", split.** Textual proximity in a hunk is not a meaning boundary.

| Distinct thoughts (always split) | One thought (may stay together) |
|---|---|
| New helper / contract, then its consumer refactor | Mechanical rename across many call sites (`low` bundle after one pattern step) |
| Type / invariant, then first caller | Long uniform table or similar edits (`grouping: "split"`) |
| Failing test / bug statement, then the fix | Import reordering + lockfile (`skip` via `files`) |

Never optimize for an impressive single panel. Optimize for Tab navigation that builds a mental model. Coarse multi-thought steps are a **defect**, not author preference.

## Minimal valid document

```json
{
  "$schema": "https://tabthrough.dev/schema/guide-v1.json",
  "version": 1,
  "steps": [
    { "id": "a", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "b", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

No `ranges` → claims every unclaimed change in that file. Reach for this only when the file is one thought.

## Field cheatsheet

| Field | Notes |
|---|---|
| `version` | Must be `1`. Anything else → whole document ignored |
| `steps[].id` | Unique, `^[A-Za-z0-9._:-]{1,64}$` |
| `steps[].path` | Repo-relative POSIX, post-image. Must exist in the patch |
| `steps[].rationale` | Required, ≤ 120 chars, one line, about **position** |
| `steps[].order` | Sparse: 10, 20, 30 |
| `steps[].ranges` | File line numbers (not hunk offsets). Intersect changed groups; coarse is fine. `"side": "old"` for pure deletions. **Required when one file has multiple thoughts** |
| `steps[].significance` | `critical` / `high` / `normal` / `low` / `skip` |
| `steps[].grouping` | `atomic` (default) / `split` (long *uniform* region) / `mergeWithNext` (genuinely inseparable adjacent hunks — never to glue two thoughts) |
| `steps[].notes` | Markdown ≤ 2000 chars, on demand |
| `steps[].dependsOn` | Earlier step ids; refines `order`; cycle drops all edges |
| `files` | Lockfiles, generated, snapshots → `significance: "skip"` |
| `scope` | `workingTree` / `commit` / `range`. Omit `diffDigest` for working-tree guides |

## Rules

- **Study the patch first.** Steps come from the diff you just read, not the plan.
- **One step is one thought.** Split helper vs consumer, type vs caller, failure vs fix, contract vs wiring.
- **`ranges` for multi-thought files.** Whole-file claims hide splits.
- **Rationale explains position, not content.** "Types before callers" — good. "Adds a significance field" — the reader is looking at it.
- **8–25 steps** typical. Above 40 → demote with `significance` / `files`, never hide. Prefer more small steps over one multi-thought panel.
- **At most ~3 `critical`.**
- **Order across files** is the main value vs the path-tier heuristic.
- **Nothing may reference a later step.**
- **Anchor coarsely.** Point at the enclosing function.

## Never

- **No exam.** No questions, "make sure you understand", scores, difficulty, reading-time, or gates.
- **No restating the diff.**
- **No multi-thought panels** (helper+consumer in one step is the named anti-pattern).
- **No steps for files not in the patch.**
- **No secrets, tokens, or absolute paths.**
- **No session-private codenames.**

## Order recipes

| Change shape | Order | Trap |
|---|---|---|
| New capability | model → core → wiring → entry → tests | Call site of something not introduced yet |
| Bug fix | failure (often regression test) → fix → fallout | One-line fix with no context |
| Refactor | new shape → one representative call site → rest `low` | Walking all forty call sites |
| Helper + consumer (same file OK) | helper/contract → consumer refactor (`ranges` each) | One panel for both |
| Mixed refactor + feature | refactor block, then feature; name both in `summary` | Interleaving by file |
| Dependency upgrade | manifest → adaptations by breakage kind | Lockfile as content |
| Removal / revert | what goes → callers → cleanup | Deletions need `"side": "old"` or whole-file |
| Codemod / rename | pattern step → `low` rest | Hand-fixes hiding in noise |
| Config / CI | behaviour change → file expressing it | Assuming small = unimportant |

## Before you emit

- Studied the real patch; steps match it, not the plan. Working-tree walks include untracked files.
- **Did I merge two whiteboard thoughts into one step?** If yes, split (ranges + order).
- Rationales read as a story; none references a later step; each would be false if moved.
- Multi-thought files use `ranges`; `mergeWithNext` is not used to glue distinct thoughts.
- 8–25 steps; ≤3 `critical`; generated demoted.
- Paths in the patch; ids unique; order sparse; `dependsOn` acyclic.
- Validates against `https://tabthrough.dev/schema/guide-v1.json`.
- Working-tree scope has no `diffDigest`.
- **Real test:** could someone who read only this guide explain the change correctly without scrolling the diff — **one thought per Tab**?
