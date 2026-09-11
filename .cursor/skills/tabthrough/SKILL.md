---
name: tabthrough
description: Emits a Tabthrough `.tabthrough.{topic}.guide.json` v1 sidecar alongside a PR, commit, or working-tree change, so a human can unfold the diff step by step in order that builds understanding. Use whenever you finish producing a code change that another person will review, or when asked to write, fix, or validate a `.tabthrough.*.guide.json`.
---

# Tabthrough sidecar

`.tabthrough.{topic}.guide.json` is the script for a guided diff walk. The reviewer presses Tab; each press reveals **one thought** of your change in a diff editor and shows your words for it in a sidebar. You decide two things: **the order** and **the words for each step**. It is not a review, a changelog, or a quiz.

Write one whenever you hand a non-trivial change to a human. Skip it for a one-file, one-hunk, one-thought change — there is no order to convey.

## Contract

- **Schema:** `$schema` is `https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json`. `additionalProperties: false` — only the fields in the cheatsheet exist.
- **Location:** `.tabthrough.{topic}.guide.json` at repo root, kebab topic in the filename (`my-feature` → `.tabthrough.my-feature.guide.json`). Include `"topic"` to match. Legacy `.tabthrough-guide.json` and `.guide.json` are still read. Skill install adds `.tabthrough*` to `.gitignore`. The extension writes `"cursor"` as the reviewer walks — do not invent it.
- **Guarantee:** a broken guide never breaks a session — heuristic fallback + one warning. Nobody else will catch your merges or misplaced anchors; check them yourself.

## What the reviewer sees

Write for this surface. Nothing else exists.

```
Editor    Diff: before ⟷ file-so-far. Only the current step's lines are highlighted
          and scrolled into view; lines from later steps are not on screen yet.
Sidebar   k of n        ◀ Previous   Next ▶
          Guide summary  ← summary (visible on every step)
          TITLE          ← title (falls back to the path — a bad headline)
          path
          Why here       ← rationale
          Notes          ← notes, plain text (shown whenever present)
          Next: title · rationale
Status    k of n · file · rationale
```

Consequences:

- The reviewer is looking at the code. Never describe what the lines do; say what they **mean for the change** and **where they sit in the story**.
- Anything about unrevealed code is noise. Nothing may refer to a later step.
- `title` is the headline and the "Next" preview. Every step gets one.
- `notes` are always shown, as plain text. Markdown shows as raw characters. Every sentence costs the reviewer time.
- `summary` is always visible. It is a map the reviewer glances back at, not an introduction.

## Words: title, rationale, notes, summary

The code is the **figure**. `title` + `rationale` is the **caption**. `notes` is the **discussion**. Order is still *what would I draw first at a whiteboard*; the words are not whiteboard shorthand.

Write for a competent teammate who was **not in the room**. Graduate literacy in the stack; zero session vocabulary.

| Field | Job | Shape | Good | Bad |
|---|---|---|---|---|
| `title` ≤ 60 | Names the thought — the table-of-contents entry | Noun phrase or short claim in the reviewer's vocabulary | `Only stash@{0} counts` · `The bug, as a test` · `Range phase carries bounds` | `Update setup.ts` · `Changes` · `Fix` |
| `rationale` ≤ 120 | Why this step is **here**: what the highlighted lines establish and how they link to neighbours | One sentence, relational: "the contract the next two steps fill", "first consumer of the field above" | `The failure the rest of the diff answers` · `Back in setup.ts now that the accent exists` | `Adds a null check` · `Updates the picker` |
| `notes` ≤ 2000 | Discussion of the figure: invariant, trade-off, what would break, rejected alternative | 1–3 short sentences, plain text, blank line between points. Consequence first; then the name if needed | `Without the wait, a save during a checkout refresh can leave the sidebar on the old branch. The checkout tick is recorded first so the wait cannot drop it.` | `A repo-scoped bump sets a flag before the 200ms abortable sleep, so a following index event still promotes HEAD.` · Restating the diff · a paragraph on every step |
| `summary` ≤ 600, aim ≤ 350 | The map: what the change does, the strands in walk order, what is demoted to the end | 2–3 sentences | `Leftover autostash moves under the actions. The range flow reuses the commit list; two clicks become start and end. Tests are low at the end.` | A bullet list of everything you did |

**Notes in two beats.** (1) Consequence or invariant first — what stays true, or what breaks without this. (2) Then the name, if needed: the plain explanation first, then the identifier in backticks. A sentence that only narrates visible lines ("sets", "adds", "updates", then a chain of internals) is a methods paragraph. Delete it.

**Affirmative claims.** State what is true. Do not open by denying the alternative: "It's not A, it's B", "not X but Y", "this is no longer X". If the old behaviour matters, a second sentence may say what used to happen — the first sentence is the present claim.

**Speed is title + rationale in three seconds.** Spend words by significance:

| Significance | Words | When |
|---|---|---|
| `critical` (≤ 3) | title + rationale + notes | The one or two steps that make the rest legible |
| `high` | title + rationale, notes if non-obvious | Contracts, first consumers, the fix |
| `normal` | title + rationale | Everything the reviewer should still look at |
| `low` | title + short rationale; may bundle mechanical rest | Fallout, remaining call sites, docs |
| `skip` via `files` | rationale that says **why** it can be skipped | Lockfiles, generated, snapshots, formatting |

Voice: load-bearing journal prose — active, calm, precise. IEEE Software / Nature accessible, not conference-paper density, not telegram. Occasionally opinionated about your own code. Never testing the reader. Never pompous.

## Procedure (gates — do not skip)

1. Make the change.
2. **Study the real patch** before writing any step. Never emit from your plan or memory of the edit:

   ```bash
   git status --porcelain=v1 --untracked-files=all
   git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after>
   ```

   For a working-tree review, include untracked files — Start captures with `git add -A`. **Omit `scope.diffDigest`** on working-tree guides: the sidecar is written into the tree it describes, so also list it in `files` as `skip` or the walk will step through the guide itself.
3. List the **whiteboard thoughts** in the patch (helper vs consumer, type vs caller, failure vs fix, contract vs wiring). Distinct thoughts → distinct steps.
4. Decide order: *what would I draw first at a whiteboard?* Use the recipes below.
5. **Anchor with new-file line numbers.** `-U0` hunk headers give them directly:

   ```bash
   git -c core.quotepath=false diff --no-color --no-ext-diff -M -U0 <base> <after> | grep -E '^(\+\+\+ |@@ )'
   ```

   `@@ -a,b +c,d @@` → the changed new-side lines are `c..c+d-1` (a missing count means 1). `d = 0` is a pure deletion: anchor it with `"side": "old"` on `a..a+b-1`. Ranges **intersect** changed lines, so the enclosing function's span is enough — the hunk header is your check that the range hits something.

   A contiguous run of changed lines is **atomic**: a range cannot split it, and two runs separated by a single unchanged line count as one run. Two steps aimed at one run → the second is dropped as `range-overlap`. When two thoughts share a run, write one step: the title names the block, `notes` names the second thought.
6. Write `.tabthrough.{topic}.guide.json`. Use **`ranges` whenever one file has more than one thought**; a whole-file claim is only correct when the whole file is one thought.
7. Run **Before you emit**.

## One thought per Tab

A step is one unit of understanding the reader can absorb, then press Tab. **If the rationale needs "and", split.** Textual proximity in a hunk is not a meaning boundary.

| Distinct thoughts (always split) | One thought (may stay together) |
|---|---|
| New helper / contract, then its consumer refactor | Mechanical rename across many call sites (`low` bundle after one pattern step) |
| Type / invariant, then first caller | Long uniform table or similar edits (`grouping: "split"`) |
| Failing test / bug statement, then the fix | Import reordering + lockfile (`skip` via `files`) |

Canonical anti-pattern: a helper and its consumer in one panel. Two thoughts → two steps, even in one file or one hunk, whenever they are separate runs of changed lines — separate `ranges`, helper first, `dependsOn`.

**One screen per step.** The highlighted lines should fit one editor screen (~40 lines). Larger → it is two thoughts, or a uniform region that wants `grouping: "split"`.

**File switches cost attention.** Keep consecutive steps in one file when the story allows. When you must return to a file, say so in the rationale.

## Worked example

Bug fix: retries treated 4xx as transient. The test leads (the heuristic would sort it last), the rule follows, then its consumer; docs are a footnote.

```json
{
  "$schema": "https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json",
  "version": 1,
  "scope": { "kind": "commit", "base": "9f2c1ab", "head": "4d81e30" },
  "summary": "Retries stop treating 4xx as transient. The failing case first, then the rule, then the client loop that adopts it. Lockfile churn is skipped.",
  "files": {
    "pnpm-lock.yaml": { "significance": "skip", "rationale": "Lockfile churn from the same install" }
  },
  "steps": [
    {
      "id": "the-bug",
      "order": 10,
      "path": "test/http/retry.test.ts",
      "ranges": [{ "start": 41, "end": 58 }],
      "significance": "critical",
      "title": "429 then 404 must not retry",
      "rationale": "The failure the rest of the diff answers — read it before the fix",
      "notes": "On the old code this test loops three times and passes by timeout. Client errors cannot succeed on repeat, so retrying them only hid rate-limit bugs behind slow attempts."
    },
    {
      "id": "retry-rule",
      "order": 20,
      "path": "src/http/retry.ts",
      "ranges": [{ "start": 12, "end": 24 }],
      "significance": "high",
      "title": "Transient means 5xx or network",
      "rationale": "The single rule every caller below consults",
      "dependsOn": ["the-bug"]
    },
    {
      "id": "client-adopts",
      "order": 30,
      "path": "src/http/client.ts",
      "ranges": [{ "start": 88, "end": 101 }],
      "significance": "high",
      "title": "Retry loop asks the rule",
      "rationale": "First consumer — the loop that used to retry everything",
      "dependsOn": ["retry-rule"]
    },
    {
      "id": "readme",
      "order": 40,
      "path": "README.md",
      "significance": "low",
      "title": "Retry note in the docs",
      "rationale": "Footnote — the behaviour you just read, stated for users"
    }
  ]
}
```

Read the titles top to bottom: a table of contents. Read the rationales: a story. One `critical`, notes only where the code could not explain itself.

## Field cheatsheet

| Field | Notes |
|---|---|
| `version` | Must be `1`. Anything else → whole document ignored |
| `summary` | ≤ 600 chars, aim ≤ 350. Always visible |
| `files` | path → `{ significance, rationale }`. Lockfiles, generated, snapshots → `"skip"` |
| `steps[].id` | Unique, `^[A-Za-z0-9._:-]{1,64}$` |
| `steps[].path` | Repo-relative POSIX, post-image. Must exist in the patch |
| `steps[].title` | ≤ 60 chars. Names the thought. Every step |
| `steps[].rationale` | Required, ≤ 120 chars, one line, about **position** |
| `steps[].notes` | ≤ 2000 chars, plain text, only where needed |
| `steps[].order` | Sparse: 10, 20, 30 |
| `steps[].ranges` | New-file line numbers (not hunk offsets). Intersect changed lines; coarse is fine; a contiguous run cannot be split. `"side": "old"` for pure deletions. **Required when one file has multiple thoughts** |
| `steps[].significance` | `critical` / `high` / `normal` / `low` / `skip` |
| `steps[].grouping` | `atomic` (default) / `split` (long *uniform* region) / `mergeWithNext` (genuinely inseparable adjacent hunks — never to glue two thoughts) |
| `steps[].dependsOn` | Earlier step ids; refines `order`; a cycle drops all edges |
| `topic` | Kebab label matching the filename (`.tabthrough.{topic}.guide.json`) |
| `cursor` | Extension-owned walk position. Omit when writing; the reviewer’s Tab updates it |
| `scope` | `workingTree` / `commit` / `range` with `base` / `head`. Omit `diffDigest` for working-tree guides |

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

## Never

- **No exam.** No questions, "make sure you understand", scores, difficulty, reading-time, or gates.
- **No restating the diff.** The reviewer sees the code.
- **No telegram notes.** No stacked implementation tokens without a human-visible outcome.
- **No antithesis.** No "It's not A, it's B", "not X but Y", or a title that is a denial plus a correction.
- **No multi-thought panels.** Helper + consumer in one step is the named defect.
- **No forward references.** Nothing mentions a symbol or step not yet revealed.
- **No markdown in `notes`.** Plain sentences; backticks around identifiers only.
- **No steps for files not in the patch.**
- **No secrets, tokens, absolute paths, or session-private codenames.**

## Before you emit

**Patch gate**

- Studied the real patch; every step matches it, not the plan. Working-tree walks include untracked files.

**Words gate**

- Titles read top to bottom as a table of contents; rationales read as a story.
- Every rationale is about position and would be false if the step moved.
- No rationale or note mentions something a later step introduces.
- Notes only where the code cannot explain itself; plain text; consequence or invariant first.
- A teammate who was not in the room can read every note. No mechanism chains. No antithesis ("It's not A, it's B").
- `summary` names the strands in walk order and what is demoted.

**Granularity gate**

- No step merges two whiteboard thoughts; multi-thought files use `ranges`; `mergeWithNext` glues nothing distinct.
- Each step fits one screen or is `split`.
- ≤ 3 `critical`; noise demoted via `files`, never hidden.

**Mechanical gate**

- Every `path` is in `git diff --name-status`.
- Every range intersects a `-U0` hunk on its side; no two steps aim at one contiguous run; deletions use `"side": "old"`.
- Ids unique; `order` sparse; `dependsOn` acyclic and pointing backwards.
- Only schema fields; valid JSON; working-tree scope has no `diffDigest`.

**Real test:** could someone who read only this guide explain the change correctly without scrolling the diff — **one thought per Tab**?
