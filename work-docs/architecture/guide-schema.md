# `.guide.json` — Guide Schema v1

**Version:** 1.0 — **frozen**
**Owner:** Architect
**Status:** Proposed for implementation
**Last updated:** 2026-08-07
**Companions:** [overview.md](overview.md) · [reatom-model.md](reatom-model.md) · [ADR 0002](../decisions/0002-architecture.md)
**Unblocks:** plan P0-15 (read path) and track E (agent-facing publication)

---

## 1. What this is, and the promise attached to it

A `.guide.json` is a **portable, human- and agent-authorable description of the order in which a change should be understood.** It is not a review, not a summary, and not a test. It answers one question per step: *why should you read this before that?*

ADR 0001 freezes the shape early so agent-facing work (track E) can proceed in parallel with the extension. That promise is only worth something if it is specific, so:

| Promise | Meaning |
|---------|---------|
| **v1 fields never change meaning** | A document valid today stays valid and behaves identically in every 1.x reader |
| **Additions are optional** | New fields may appear in later 1.x readers; they must have a defined default that reproduces current behaviour |
| **Unknown fields are ignored** | A v1 reader ignores fields it does not know and continues, emitting an informational diagnostic |
| **`version` gates hard** | A document with `version` other than `1` is ignored wholesale by a v1 reader — no partial interpretation |
| **A sidecar never breaks a session** | Every failure mode degrades to the heuristic guide plus one warning. A malformed guide can never block a review or lose a line |

The last row is the load-bearing one. A guide is an *enhancement*; the offline heuristic is the floor.

---

## 2. Location and resolution

Resolution order, first hit wins:

1. The `tabthrough.guideFile` setting, if non-empty, resolved relative to the repo root.
2. `.guide.json` at the repo root.
3. No sidecar → pure heuristic.

The file is read **from the base revision's working state**, i.e. the file as it exists on disk at session start, not from a git object. Rationale: an agent that just produced a change writes the guide alongside it, and the working tree is where it lands. For the working-tree entry the file is read before the stash, so a freshly written, uncommitted guide still works.

MVP reads a single document. Multi-document layouts (`.guide/*.json` keyed by revision range) are reserved for P1 and deliberately not specified here.

---

## 3. Document shape

### 3.1 Top level

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `$schema` | string | no | — | Ignored by the reader; present so editors offer completion |
| `version` | integer | **yes** | — | Must be `1` |
| `steps` | array of Step | **yes** | — | May be empty (a document that only carries `files` overrides is legal) |
| `scope` | Scope | no | — | What diff this guide was written for. Used for staleness detection |
| `summary` | string | no | — | One paragraph of narrative, shown in the sidebar on every step. ≤ 600 chars |
| `defaults` | Defaults | no | `{}` | Document-wide knobs |
| `files` | object, path → FileOverride | no | `{}` | Per-file defaults applied to heuristic steps |
| `generator` | Generator | no | — | Provenance. Never affects behaviour |
| `createdAt` | string (ISO 8601) | no | — | Provenance |

### 3.2 `scope`

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `kind` | `"workingTree" \| "commit" \| "range"` | yes | Entry point the guide was authored against |
| `base` | string | no | Ref or SHA. Informational |
| `head` | string | no | Ref or SHA. Informational |
| `diffDigest` | string | no | `sha256:<hex>` over the normalized patch (§7). A mismatch marks the guide stale |

### 3.3 `defaults`

| Field | Type | Default | Meaning |
|-------|------|---------|---------|
| `mergeStrategy` | `"merge" \| "replace"` | `"merge"` | `merge`: heuristic fills whatever the guide does not cover. `replace`: heuristic contributes no ordering, and uncovered groups become one trailing step per file |
| `maxLinesPerStep` | integer 1–500 | reader setting (`24`) | Sizing bound used when a step is `grouping: "split"` |

`replace` never means "hide the rest". Uncovered lines are always revealed; `replace` only says "do not let the heuristic interleave its own ordering with mine".

### 3.4 Step

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `id` | string | **yes** | — | Unique within the document. `^[A-Za-z0-9._:-]{1,64}$` |
| `path` | string | **yes** | — | Repo-relative POSIX path, post-image (the path after the change; for a deletion, the path that was deleted) |
| `rationale` | string | **yes** | — | One line, ≤ 120 chars. *Why this position in the order*, not what the code does |
| `order` | integer | no | index × 10 | Sparse sort key. Ascending |
| `ranges` | array of Range | no | — | Which lines this step claims. Omitted → the step claims every line group in `path` not claimed by another step |
| `significance` | `"critical" \| "high" \| "normal" \| "low" \| "skip"` | no | `"normal"` | §6.1 |
| `grouping` | `"atomic" \| "split" \| "mergeWithNext"` | no | `"atomic"` | §6.2 |
| `title` | string | no | — | Short label, ≤ 60 chars |
| `notes` | string | no | — | Longer explanation, plain text, shown in the sidebar whenever present. ≤ 2000 chars |
| `dependsOn` | array of string | no | `[]` | Step ids that must come earlier. Refines `order`, never contradicts it silently (§5.3) |
| `tags` | array of string | no | `[]` | Free-form labels. Reserved for future filtering; ignored in v1 |

### 3.5 Range

| Field | Type | Required | Default | Meaning |
|-------|------|----------|---------|---------|
| `start` | integer ≥ 1 | **yes** | — | 1-based, inclusive |
| `end` | integer ≥ `start` | no | `start` | 1-based, inclusive |
| `side` | `"new" \| "old"` | no | `"new"` | Which side of the diff the numbers refer to. Use `"old"` only to anchor a pure deletion |

Line numbers are **file line numbers**, not diff-hunk offsets. That is the only representation an author can produce without reading the patch format, and it is what an agent that just edited the file already knows.

### 3.6 FileOverride

| Field | Type | Meaning |
|-------|------|---------|
| `significance` | same enum as Step | Default significance for heuristic steps in this file |
| `rationale` | string | Overrides the heuristic rationale for this file's steps |

`files: { "pnpm-lock.yaml": { "significance": "skip" } }` is the intended idiom for lockfiles, generated code, and snapshots.

### 3.7 Generator

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | e.g. `"cursor-agent"` |
| `version` | string | Tool version |
| `model` | string | Model identifier, when applicable |

Purely informational. The reader must never branch on it.

---

## 4. JSON Schema

**The schema is a file: [`schema/guide-v1.json`](../../schema/guide-v1.json).** Draft 2020-12, published for editors and agent self-validation. It is not reproduced here, because a second copy is a copy that goes stale; §3 above is the prose description and the file is the machine-readable one.

| Where | Value |
|-------|-------|
| Canonical `$id` | `https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json` |
| In this repo | `schema/guide-v1.json` |

The `$id` is the URL editors and agents fetch. The reader ignores `$schema` (§3.1), so a session never depends on the fetch succeeding.

Two properties are enforced by `test/unit/published-schema.test.ts` rather than by review:

- **The schema and the hand-rolled reader agree** on required fields, on every enum, and on the set of known properties at each level. The reader is the one that decides whether a session works, so a schema that accepted something the reader rejects would be worse than no schema at all.
- **`additionalProperties: false` is deliberately stricter than the reader**, which ignores unknown fields (§8). The schema is a linting aid for authors, and telling an author about a typo is its whole job; the reader is lenient on purpose so that a 1.1 document still works in a 1.0 reader.

---

## 5. Merge algorithm

Input: the parsed `ReviewDiff` (a list of files, each with `LineGroup`s), the heuristic `Guide`, and an optional validated `GuideDoc`. Output: one merged `Guide` plus diagnostics.

The controlling invariant, restated from overview §3.3:

> **I1** — every `LineGroup` in the diff belongs to exactly one *reveal* step. Stub steps carry zero groups and exist only for files that have no revealable content (binary, mode-only, or generated-and-hidden).

Nothing in this algorithm may violate I1. Every branch below either assigns a group or leaves it for the fallback pass, and the final assertion checks it.

### 5.1 Anchor resolution

For each sidecar step, in document order:

1. If `ranges` is absent, the step is a **file claim**: it claims every group in `path` not already claimed. Record it and continue.
2. Otherwise, for each range, select the groups in `path` whose corresponding side range intersects it. `side: "new"` compares against `group.newRange`; `side: "old"` against `group.oldRange`. A group with no range on that side cannot match.
3. If two steps' ranges intersect the same group, it is claimed by the step with the larger overlap; ties break by lower `order`, then earlier document position. The loser emits `range-overlap` (warning).
4. A step whose ranges matched **no** group is dropped, emitting `anchor-unmatched` (warning). The most common cause is a guide written against a different revision — which is also why `scope.diffDigest` exists.

File claims are resolved last, after all range-anchored steps, so an explicit range always wins over a whole-file claim.

### 5.2 Fallback pass

Groups still unclaimed after §5.1 are covered by the heuristic:

- **`mergeStrategy: "merge"` (default).** Take the heuristic guide, drop every group it assigns that a sidecar step already claimed, drop steps left empty, and keep the rest in heuristic order. **In MVP these steps are appended after all sidecar steps** — this is the plan's P0-15 rule and it is deliberately blunt. Per-file interleaving (inserting the heuristic remainder for `foo.ts` directly after the last sidecar step that touches `foo.ts`) is P1-3.
- **`mergeStrategy: "replace"`.** The heuristic contributes no ordering. Each file with unclaimed groups gets exactly one trailing step, `source: 'heuristic'`, rationale `"Remaining changes in <file>"`. Lines are still revealed; only the ordering opinion is discarded.

### 5.3 Ordering

1. Sort sidecar steps by `(order ?? index × 10, document index)`.
2. Apply `dependsOn` as a **refinement**: run a stable topological sort over the already-sorted list. An edge that would move a step earlier than its `order` neighbours is honoured; a cycle emits `depends-cycle` (warning) and all `dependsOn` edges are dropped, leaving the `order` sort intact. A `dependsOn` id that does not exist emits `depends-unknown` (warning) and is ignored.
3. Append the fallback steps from §5.2.
4. Apply `grouping: "mergeWithNext"` (§6.2) over the final sequence.
5. Renumber. Step ids are preserved; the cursor index is positional.

Result is deterministic for a given (diff, sidecar) pair — invariant I4, and a fixture test.

### 5.4 Failure handling

| Situation | Result |
|-----------|--------|
| File absent | Pure heuristic. No diagnostic |
| Not valid JSON | Pure heuristic. One warning `parse-error` |
| `version` ≠ 1 | Pure heuristic. One warning `unsupported-version` |
| Structural error (see §8 hard errors) | Pure heuristic. One warning `invalid-document`, listing at most the first three problems |
| Soft errors only | Guide is used; diagnostics recorded and surfaced once, not per step |
| `scope.diffDigest` mismatch | Guide is used, `Guide.stale = true`, one warning `stale-guide`. MVP does nothing more; P1-3 refines |
| Valid guide, zero steps survive anchoring | Pure heuristic. One warning `anchor-unmatched` |

"One warning" means literally one notification per session, however many diagnostics are behind it. The full list is available in the output channel and through `Tabthrough: Show guide diagnostics`.

---

## 6. Step significance and line grouping

### 6.1 `significance`

Significance is a **teaching weight**, not a severity. It answers "how much of the reader's attention does this deserve?"

| Value | Reveal behaviour | Presentation |
|-------|------------------|--------------|
| `critical` | Never merged with a neighbouring step; never coalesced by compact mode (P1) | Status bar emphasis |
| `high` | Never merged; `split` produces one group per step | Status bar emphasis |
| `normal` | Default. `split` respects `maxLinesPerStep` | Plain |
| `low` | May be coalesced with adjacent `low` steps in the same file up to `maxLinesPerStep` | Plain |
| `skip` | Lines are still revealed, but they never own a step: they are merged into the following step in the same file, or into the preceding one if they are last | Not counted in `k/n` |

`skip` is how you say "this is formatting churn" without hiding it. It is the only value with an interaction with a user setting: when `tabthrough.hideFormattingSteps` is `false` (default), the heuristic will not *produce* `skip`, but an authored `skip` is always honoured.

### 6.2 `grouping`

Grouping controls how a step's claimed lines are distributed over Tab presses.

| Value | Behaviour |
|-------|-----------|
| `atomic` (default) | All claimed groups revealed in one press. A step is one thought |
| `split` | The engine subdivides using `defaults.maxLinesPerStep` and `significance`. Sub-steps get ids `"<id>#1"`, `"<id>#2"`, …, share the rationale, and get `title` suffixed ` (k/n)`. Use for a large but uniform change — a big table, a generated block, a long list of similar edits |
| `mergeWithNext` | This step's groups are revealed together with the following step in the final order. Chains are allowed. On the last step it is ignored, with diagnostic `merge-no-successor` |

`split` is the only place a sidecar hands sizing back to the engine, which is deliberate: an author knows the *meaning* boundaries, and the engine knows the reader's configured pace.

### 6.3 How ranges become groups

Authors write file line numbers; the engine works in `LineGroup`s, which are contiguous runs of changed lines produced by the diff parser. The mapping is intersection, not containment:

- A range `{ start: 10, end: 40 }` claims every group that overlaps lines 10–40, even a group that starts at 8 and ends at 12.
- A range therefore never splits a group. Groups are atomic; that is what makes I1 checkable.
- Consequence for authors: **you do not need exact line numbers.** Point at the function you mean and the engine claims the changed lines inside it. Being one or two lines off costs nothing; being ten lines off may claim a neighbouring change.

---

## 7. Diff digest

The digest lets an author record which diff a guide was written for, and lets the reader detect drift. It must be reproducible outside the extension, so the recipe is exact.

```bash
git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after> \
  | grep -v '^index [0-9a-f]\{7,\}\.\.[0-9a-f]\{7,\}' \
  | sha256sum
```

Precisely:

1. Produce the patch with exactly those flags and that revision pair. The revision pair per entry kind is in [overview §3.5.2](overview.md).
2. Drop every line matching `^index <hex>..<hex>( \d+)?$`. Abbreviated object ids vary with repository size and git configuration, and they carry no semantic content.
3. Normalize CRLF to LF, and ensure exactly one trailing newline.
4. SHA-256 the resulting bytes as UTF-8; lowercase hex; prefix `sha256:`.

The digest is **advisory in MVP**: a mismatch produces `stale-guide` and nothing else. Blocking on it would make guides brittle in exactly the situation they help most — a rebase that did not touch the reviewed code.

---

## 8. Validation rules

The reader's validator is hand-rolled, total, and never throws. It returns either a document or a list of errors.

**Hard errors** — the whole document is rejected, heuristic fallback, one warning:

| Code | Condition |
|------|-----------|
| `parse-error` | Not valid JSON, or the root is not an object |
| `unsupported-version` | `version` missing, not a number, or ≠ 1 |
| `invalid-document` | `steps` is not an array; a step is not an object; a required step field is missing or the wrong type; `id` fails its pattern; duplicate `id`; `ranges` malformed (`start < 1`, `end < start`, non-integer) |

**Soft errors** — the document is used, diagnostics recorded:

| Code | Severity | Condition |
|------|----------|-----------|
| `unknown-field` | info | A field the reader does not recognise. Ignored — this is the forward-compatibility path |
| `anchor-unmatched` | warning | A step's ranges matched no group |
| `range-overlap` | warning | Two steps claimed the same group |
| `depends-unknown` | warning | `dependsOn` references a missing id |
| `depends-cycle` | warning | `dependsOn` edges form a cycle; all edges dropped |
| `merge-no-successor` | info | `mergeWithNext` on the final step |
| `path-unknown` | warning | `path` is not in the diff |
| `path-unsafe` | warning | `path` is absolute, contains `..`, or escapes the repo root. The step is dropped |
| `stale-guide` | warning | `scope.diffDigest` does not match |
| `too-many-steps` | warning | More than 500 steps; the remainder is ignored |

`path-unsafe` is a security rule, not a hygiene rule: a guide is untrusted input, and a path is the only field that could otherwise reach outside the repository.

---

## 9. Example

A change that adds a `Guide` type, a builder that produces it, a caller, and a test. The pedagogically correct order is types → builder → caller → test, which happens to be what the heuristic would also choose; the guide's value here is the *reasons*, the split of the builder into two thoughts, and the lockfile suppression.

```json
{
  "$schema": "https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json",
  "version": 1,
  "createdAt": "2026-08-07T09:12:44Z",
  "generator": { "name": "cursor-agent", "version": "2.4.0", "model": "claude-sonnet-4.6" },
  "scope": {
    "kind": "commit",
    "base": "9f2c1ab",
    "head": "4d81e30",
    "diffDigest": "sha256:2b7f0c31e9a54d8f6c1b0a5d3e2f47c980ab13de5f6072849bcd1e3f5a7c9048"
  },
  "summary": "Guides gain an explicit significance weight. The type changes first, then the builder learns to compute it, then the status bar starts showing it. The lockfile change is unrelated churn from the same install.",
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
      "notes": "`significance` is a teaching weight, not a severity. Nothing below makes sense until you have read this union."
    },
    {
      "id": "builder-scoring",
      "order": 20,
      "path": "src/guide/heuristic.ts",
      "ranges": [{ "side": "new", "start": 64, "end": 118 }],
      "significance": "high",
      "grouping": "split",
      "title": "Scoring table",
      "rationale": "Where the new field gets its value",
      "dependsOn": ["types-significance"]
    },
    {
      "id": "builder-bucketing",
      "order": 30,
      "path": "src/guide/heuristic.ts",
      "ranges": [{ "side": "new", "start": 120, "end": 133 }],
      "significance": "normal",
      "rationale": "Scores become buckets — the boundary the UI reads"
    },
    {
      "id": "status-bar",
      "order": 40,
      "path": "src/ui/status-bar.ts",
      "significance": "normal",
      "rationale": "First consumer: emphasis for critical and high steps",
      "dependsOn": ["builder-bucketing"]
    },
    {
      "id": "old-weight-removed",
      "order": 50,
      "path": "src/guide/heuristic.ts",
      "ranges": [{ "side": "old", "start": 58, "end": 62 }],
      "significance": "low",
      "rationale": "The flat weight this replaces"
    },
    {
      "id": "tests",
      "order": 60,
      "path": "test/unit/heuristic.test.ts",
      "significance": "normal",
      "rationale": "Confirms the bucket boundaries you just read"
    }
  ]
}
```

Reading of this document:

- `status-bar` and `tests` omit `ranges`, so they claim every unclaimed group in their files — the common, low-effort case.
- `builder-scoring` uses `split`, so a 54-line region becomes several Tab presses sized by `maxLinesPerStep`, all sharing one rationale.
- `old-weight-removed` anchors on the `old` side because the lines no longer exist in the new file.
- `pnpm-lock.yaml` never appears in `steps`; the `files` override collapses it into one `skip`-weighted step so the count stays honest without spending attention on it.
- Any group in these files that no step claimed is appended by the heuristic after step `tests`, in heuristic order.

---

## 10. Notes for agents (P1 write path)

MVP ships the read path only. This section is the contract track E publishes as a skill or prompt, and it is normative for what the reader will accept.

### 10.1 Procedure

1. Make the change.
2. Produce the patch with the exact command in §7 and compute the digest.
3. Emit `.guide.json` at the repo root, or update an existing one.
4. Self-validate against [`schema/guide-v1.json`](../../schema/guide-v1.json). The extension will not tell the user your guide was broken beyond a single warning, so the check is yours to run.

### 10.2 Rules of thumb

- **One step is one thought.** If the rationale needs "and", it is two steps.
- **Rationale is about order, not content.** "Types before callers" is a rationale. "Adds a significance field" is a restatement of the diff, which the reader can already see.
- **Aim for 8–25 steps** on a typical PR. Above 40, the reader is skimming again and the guide has failed at its job. Use `files` overrides and `significance: "skip"` to spend attention where it matters.
- **Anchor coarsely.** Ranges intersect groups, so pointing at the enclosing function is enough and is more robust across rebases than exact line numbers.
- **Order across files, not just within them.** The single most valuable thing a guide adds over the heuristic is knowing that `A` must be read before `B` for a reason no path heuristic can infer. Encode it with `order`, and with `dependsOn` when the reason is a genuine dependency.
- **Leave gaps in `order`** (10, 20, 30) so a human can insert a step without renumbering.
- **Omit `ranges` when a whole file is one thought.** It is less to get wrong.
- **Set `scope`.** Without `diffDigest` the reader cannot tell the user their guide is stale.

### 10.3 Prohibited

- No questions, scores, quizzes, timers, or "did you understand?" gates. The product's UX principles forbid an exam, and a guide that smuggles one in will be treated as a bug.
- No secrets, tokens, or absolute filesystem paths.
- No restating the diff. The reader can see the code; the guide supplies the order and the reason.
- No steps for files that are not in the diff. They are dropped with a `path-unknown` warning.

### 10.4 Minimal valid document

```json
{
  "version": 1,
  "steps": [
    { "id": "a", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "b", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

Two file claims, no ranges, no scope. Everything else is heuristic. This is a perfectly good guide, and it is the shape an agent should reach for by default.

---

## 11. Reserved for v2 (do not use in v1)

Named here so nobody spends a v1 field on them, and so a future reader knows what to expect.

| Reserved key | Intended meaning |
|--------------|------------------|
| `steps[].parts` | Cross-file steps: `[{ path, ranges }]`. v1 keeps one step to one file so the status bar and `k/n` stay unambiguous |
| `steps[].symbol` | Symbol-based anchoring (`{ kind: "function", name: "buildGuide" }`) as a rebase-proof alternative to line ranges |
| `guides` (top level) | Multiple named guides in one document, selected by scope |
| `steps[].audience` | Different orders for different readers (onboarder vs. maintainer) |
| `checks` | Machine-verifiable assertions about the change. Deliberately out — it is the exam pattern in disguise |

A v1 reader ignores all of these with an `unknown-field` diagnostic, which is exactly the forward-compatibility behaviour the promise in §1 describes.
