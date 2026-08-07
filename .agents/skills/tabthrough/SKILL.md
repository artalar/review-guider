---
name: tabthrough
description: Emits a Tabthrough `.guide.json` v1 sidecar alongside a PR, commit, or working-tree change, so a human can unfold the diff step by step in order that builds understanding. Use whenever you finish producing a code change that another person will review, or when asked to write, fix, or validate a `.guide.json`.
---

# Tabthrough sidecar

A `.guide.json` tells Tabthrough **the order in which your change should be read, and one line per step explaining why it comes there**. The reader presses Tab to unfold it. It is not a review, a summary, or a quiz.

Write one whenever you hand a non-trivial change to a human. Skip it for a one-file, one-hunk change — there is no order to convey.

## Contract

- **Schema (normative):** `schema/guide-v1.json` in this repo — JSON Schema draft 2020-12, validate against it directly. Prose and merge semantics: `work-docs/architecture/guide-schema.md`. Canonical `$schema` URL is `https://tabthrough.dev/schema/guide-v1.json`; the copy that resolves today is `https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json`.
- **Pedagogy and worked examples:** `work-docs/guides/agent-guide-authoring.md`.
- **Location:** `.guide.json` at the repo root (or the path in `tabthrough.guideFile`).
- **Guarantee you rely on:** a broken guide never breaks a session — the extension falls back to its offline heuristic and shows one warning. Which means nobody will tell the user your guide was wrong. Validate it yourself.

## Procedure

1. Make the change.
2. Get the real patch — never generate steps from your plan:

   ```bash
   git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after>
   ```

3. Decide the order before writing JSON. Ask: *what would I draw first at a whiteboard?*
4. Write `.guide.json` at the repo root.
5. Optionally set `scope.diffDigest` so the reader can be warned when the guide goes stale:

   ```bash
   git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after> \
     | grep -v '^index [0-9a-f]\{7,\}\.\.[0-9a-f]\{7,\}' \
     | sha256sum
   ```

   Prefix with `sha256:`. Normalize CRLF to LF and exactly one trailing newline first.
6. Validate against `schema/guide-v1.json` and run the checklist at the bottom.

## Minimal valid document

```json
{
  "version": 1,
  "steps": [
    { "id": "a", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "b", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

A step with no `ranges` claims every unclaimed change in its file. This is the default shape to reach for.

## Typical document

```json
{
  "$schema": "https://tabthrough.dev/schema/guide-v1.json",
  "version": 1,
  "scope": { "kind": "commit", "base": "9f2c1ab", "head": "4d81e30" },
  "summary": "One paragraph on the shape of the change, read once before step one.",
  "files": {
    "pnpm-lock.yaml": { "significance": "skip", "rationale": "Lockfile churn from the same install" }
  },
  "steps": [
    {
      "id": "the-contract",
      "order": 10,
      "path": "src/guide/types.ts",
      "ranges": [{ "side": "new", "start": 18, "end": 27 }],
      "significance": "critical",
      "title": "New weight field",
      "rationale": "The field every later step is about",
      "notes": "Longer explanation, markdown, shown on demand."
    },
    {
      "id": "producer",
      "order": 20,
      "path": "src/guide/heuristic.ts",
      "significance": "high",
      "rationale": "Where that field gets its value",
      "dependsOn": ["the-contract"]
    },
    {
      "id": "consumer",
      "order": 30,
      "path": "src/ui/status-bar.ts",
      "rationale": "First consumer — what the reader will actually see"
    }
  ]
}
```

## Field cheatsheet

| Field | Notes |
|---|---|
| `version` | Must be `1`. Anything else and the whole document is ignored |
| `steps[].id` | Unique, `^[A-Za-z0-9._:-]{1,64}$` |
| `steps[].path` | Repo-relative POSIX, post-image path. Must exist in the patch |
| `steps[].rationale` | Required, ≤ 120 chars, one line, about **position** |
| `steps[].order` | Sparse: 10, 20, 30 — leave room for a human to insert |
| `steps[].ranges` | File line numbers, not hunk offsets. Ranges *intersect* changed regions, so coarse is fine. `"side": "old"` for pure deletions |
| `steps[].significance` | `critical` / `high` / `normal` / `low` / `skip`. `skip` still reveals lines, just spends no step on them |
| `steps[].grouping` | `atomic` (default) / `split` (long uniform region) / `mergeWithNext` |
| `steps[].notes` | Markdown, ≤ 2000 chars, shown on demand. The place for real explanation |
| `steps[].dependsOn` | Step ids that must come earlier. Refines `order`; a cycle drops all edges |
| `files` | Per-file defaults. The idiom for lockfiles, generated code, snapshots |
| `scope` | `kind` is `workingTree` / `commit` / `range`. Add `diffDigest` for staleness detection |

## Rules

- **One step is one thought.** If the rationale needs "and", split it.
- **Rationale explains position, not content.** "Types before callers" — good. "Adds a significance field" — the reader is looking right at it.
- **8–25 steps** on a typical PR. Above 40 the reader is skimming again; demote with `significance` and `files`, never hide.
- **At most ~3 `critical`.** If everything is critical, nothing is.
- **Order across files is the value you add.** The extension's heuristic already knows path tiers; encode what it cannot infer.
- **Nothing may reference a later step.** Read your rationales as prose, in order, before emitting.
- **Anchor coarsely.** Point at the enclosing function; exact line numbers buy nothing and break on rebase.

## Never

- **No exam.** No questions to the reader, no "make sure you understand", no scores, difficulty labels, reading-time estimates, or comprehension gates. This is a product rule and a guide that smuggles one in is treated as a bug.
- **No restating the diff.** The reader can see the code.
- **No steps for files not in the patch.** They are dropped with a warning.
- **No secrets, tokens, credentials, or absolute filesystem paths.**
- **No codenames from your own working session.** The reader was not in the room.

## Order recipes

| Change shape | Order | Trap |
|---|---|---|
| New capability | model → core logic → wiring → entry point → tests | Starting at the call site of something that does not exist yet |
| Bug fix | the failure (often the regression test) → the fix → fallout | Leading with a one-line fix nobody can evaluate |
| Refactor | new shape → one representative call site → the rest as `low` | Walking all forty call sites |
| Mixed refactor + feature | refactor block, then feature on top; name both in `summary` | Interleaving by file, so the reader cannot tell moved from new |
| Dependency upgrade | manifest → adaptations grouped by kind of breakage | Treating the lockfile as content |
| Removal / revert | what goes and why → callers → cleanup | Deletions need `"side": "old"` or a whole-file claim |
| Codemod / rename | one step showing the pattern → one `low` step for the rest | Letting the two hand-fixed files hide in the noise |
| Config / CI | the behaviour change → the file expressing it | Assuming small means unimportant |

## Before you emit

- Rationales read as a story, not a list, and none references a later step.
- Every rationale would become false if its step moved. (If not, it describes content, not position.)
- 8–25 steps; at most three `critical`; generated files demoted.
- Every `path` appears in the actual patch; `id`s unique; `order` sparse; `dependsOn` acyclic.
- Validates against `schema/guide-v1.json`.
- **The real test:** could someone who read only your guide explain this change correctly, without scrolling the diff?
