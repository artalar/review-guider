---
name: guide-reviewer
description: Emit a `.guide.json` sidecar so a human can read your change in the order you wrote it. Use after producing a multi-file change, a PR, or a commit that someone else will have to understand — especially when the pedagogically correct reading order differs from the alphabetical file list a diff produces.
---

# Emitting a `.guide.json`

A `.guide.json` is a portable description of **the order in which a change should be understood, and why**. The [Guide Reviewer](https://github.com/artalar/review-guider) extension reads it and walks a human through your change one step at a time.

It is not a review, a summary, a changelog, or a test. Every step answers exactly one question: *why should you read this before that?*

Full normative contract: [`work-docs/architecture/guide-schema.md`](../../../work-docs/architecture/guide-schema.md). This skill is the write path.

## When to write one

Write a guide when your change spans more than two or three files and the order matters — a new type and its consumers, a schema and its migration, a fix and the test that proves it, a refactor whose mechanical edits only make sense after the one edit that motivated them.

Skip it for a single-file change, a pure revert, or a mechanical rename across the repo. The heuristic already orders those correctly, and a guide that says what the reader can see is worse than no guide.

## Procedure

1. Make the change.
2. Write `.guide.json` at the repository root (or update the existing one).
3. Compute `scope.diffDigest` so the reader can detect staleness — the recipe is below.
4. Validate against the published schema. The extension surfaces at most one warning to the user, so a broken guide fails quietly. The check is yours to run.

## Minimal valid document

Reach for this shape by default. Two file claims, no ranges, no scope — everything else is filled in by the heuristic.

```json
{
  "version": 1,
  "steps": [
    { "id": "types", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "service", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

A step with no `ranges` claims every changed line in its file that no other step claimed. That is the low-effort, hard-to-get-wrong case, and it is enough for most changes.

## Full shape

```json
{
  "$schema": "https://guide-reviewer.dev/schema/guide-v1.json",
  "version": 1,
  "createdAt": "2026-08-07T09:12:44Z",
  "generator": { "name": "my-agent", "version": "2.4.0", "model": "some-model" },
  "scope": {
    "kind": "commit",
    "base": "9f2c1ab",
    "head": "4d81e30",
    "diffDigest": "sha256:2b7f0c31e9a54d8f6c1b0a5d3e2f47c980ab13de5f6072849bcd1e3f5a7c9048"
  },
  "summary": "Guides gain an explicit significance weight. The type changes first, then the builder learns to compute it, then the status bar shows it.",
  "defaults": { "mergeStrategy": "merge", "maxLinesPerStep": 24 },
  "files": {
    "pnpm-lock.yaml": { "significance": "skip", "rationale": "Lockfile churn from the same install" }
  },
  "steps": [
    {
      "id": "types-significance",
      "order": 10,
      "path": "src/guide/types.ts",
      "ranges": [{ "side": "new", "start": 18, "end": 27 }],
      "significance": "critical",
      "title": "Significance weight",
      "rationale": "The new field every later change is about",
      "notes": "A teaching weight, not a severity. Nothing below makes sense until you have read this union."
    },
    {
      "id": "builder-scoring",
      "order": 20,
      "path": "src/guide/heuristic.ts",
      "ranges": [{ "side": "new", "start": 64, "end": 118 }],
      "significance": "high",
      "grouping": "split",
      "rationale": "Where the new field gets its value",
      "dependsOn": ["types-significance"]
    },
    {
      "id": "old-weight-removed",
      "order": 30,
      "path": "src/guide/heuristic.ts",
      "ranges": [{ "side": "old", "start": 58, "end": 62 }],
      "significance": "low",
      "rationale": "The flat weight this replaces"
    },
    {
      "id": "tests",
      "order": 40,
      "path": "test/unit/heuristic.test.ts",
      "rationale": "Confirms the bucket boundaries you just read"
    }
  ]
}
```

### Fields

| Field | Required | Notes |
|-------|----------|-------|
| `version` | **yes** | Must be `1`. Any other value and the whole document is ignored |
| `steps[].id` | **yes** | Unique in the document, `^[A-Za-z0-9._:-]{1,64}$` |
| `steps[].path` | **yes** | Repo-relative POSIX path, post-image (for a deletion, the path that was deleted) |
| `steps[].rationale` | **yes** | One line, ≤ 120 chars, about *order* |
| `steps[].order` | no | Sparse sort key, ascending. Defaults to index × 10 |
| `steps[].ranges` | no | `{ start, end?, side? }`, 1-based inclusive **file** line numbers. Omit to claim the whole file |
| `steps[].significance` | no | `critical` \| `high` \| `normal` \| `low` \| `skip`. Default `normal` |
| `steps[].grouping` | no | `atomic` (default) \| `split` \| `mergeWithNext` |
| `steps[].dependsOn` | no | Step ids that must come earlier. Refines `order` |
| `steps[].title` / `notes` | no | ≤ 60 / ≤ 2000 chars |
| `files` | no | Path → `{ significance, rationale }`. Defaults for heuristic steps in that file |
| `defaults.mergeStrategy` | no | `merge` (default) lets the heuristic fill gaps; `replace` gives each file one trailing step instead |
| `scope` | no | `{ kind, base, head, diffDigest }`. Set it, so staleness is detectable |

`side: "old"` exists for one purpose: anchoring a pure deletion, whose lines have no position in the new file.

### `significance`

A teaching weight, not a severity — it answers "how much of the reader's attention does this deserve?"

- `critical`, `high` — never merged with a neighbour, emphasised in the status bar.
- `normal` — the default.
- `low` — may be coalesced with adjacent `low` steps in the same file.
- `skip` — the lines are still revealed, but they never own a step and are not counted in `k/n`. This is how you say "formatting churn" without hiding anything.

### `grouping`

- `atomic` (default) — one press reveals the whole step. A step is one thought.
- `split` — the engine subdivides using `maxLinesPerStep`. Use for a large but uniform region: a table, a generated block, a long run of similar edits.
- `mergeWithNext` — reveal together with the following step. Chains are allowed; on the last step it is ignored.

## Rules of thumb

- **One step is one thought.** If the rationale needs "and", it is two steps.
- **The rationale is about order, not content.** "Types before callers" is a rationale. "Adds a significance field" restates the diff, which the reader can already see.
- **Aim for 8–25 steps** on a typical PR. Past 40 the reader is skimming again and the guide has failed. Use `files` overrides and `skip` to spend attention where it matters.
- **Anchor coarsely.** Ranges *intersect* changed-line groups rather than containing them, so pointing at the enclosing function is enough. Being a line or two off costs nothing; being ten lines off may claim a neighbouring change.
- **Order across files, not just within them.** This is the single thing a guide adds that no path heuristic can infer. Encode it with `order`, and with `dependsOn` when the reason is a real dependency.
- **Leave gaps in `order`** (10, 20, 30) so a human can insert a step without renumbering.
- **Omit `ranges` when a whole file is one thought.** Less to get wrong.

## Never

- **No questions, scores, quizzes, timers, or "did you understand?" gates.** The product's UX principles forbid an exam; a guide that smuggles one in is a bug.
- **No secrets, tokens, or absolute filesystem paths.**
- **No restating the diff.** The reader can see the code. Supply the order and the reason.
- **No steps for files outside the diff.** They are dropped with a `path-unknown` warning.
- **No paths that are absolute or contain `..`.** A guide is untrusted input; those steps are dropped as unsafe.

## Diff digest

```bash
git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after> \
  | grep -v '^index [0-9a-f]\{7,\}\.\.[0-9a-f]\{7,\}' \
  | sha256sum
```

Drop the `index <hex>..<hex>` lines (abbreviated object ids vary by repository), normalize CRLF to LF, ensure exactly one trailing newline, then SHA-256 the UTF-8 bytes and prefix `sha256:`. The revision pair is the one the guide was authored against: `HEAD` and the working tree, `<sha>~1` and `<sha>`, or `merge-base(A, B)` and `B`.

A mismatch is advisory — the guide is still used, and the reader is told it may be stale.

## Failure modes

A guide is an enhancement; the offline heuristic is the floor. Every failure degrades, and none of them can block a review or lose a line.

| Problem | Result |
|---------|--------|
| Invalid JSON, `version` ≠ 1, missing required field, duplicate id, malformed range | Whole document ignored, heuristic used, one warning |
| A step's ranges matched no changed lines | That step is dropped |
| Two steps claim the same lines | Larger overlap wins, the other is warned about |
| `dependsOn` cycle or unknown id | Edges dropped, `order` sort kept |
| More than 500 steps | Remainder ignored |
| Unknown field | Ignored — this is the forward-compatibility path, so a 1.1 document works in a 1.0 reader |

Anything no step claims is appended by the heuristic. Lines are never hidden by omission.
