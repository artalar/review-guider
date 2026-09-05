# Writing a guide an agent produced, for a human who has to own the code

**Audience:** LLMs and coding agents that emit `.guide.json` alongside a change
**Owner:** Product
**Status:** Published (track E) — P0-G1 granularity bar
**Last updated:** 2026-08-07
**Normative companion:** [architecture/guide-schema.md](../architecture/guide-schema.md) — field types, validation, and merge semantics live there and win any conflict with this document
**Installable form:** [`.agents/skills/tabthrough/SKILL.md`](../../.agents/skills/tabthrough/SKILL.md)

---

## 1. What you are actually writing

You produced a change. Someone now has to *own* it: extend it next month, debug it at 2am, or decide whether it belongs in their product. They will read it through Tabthrough, which hides the whole diff and reveals it **one thought at a time** as they press Tab.

Your `.guide.json` decides two things, and only two:

1. **The order** in which those pieces arrive.
2. **One line per piece explaining why it arrives there.**

That is the entire job. You are not writing a review, a changelog, a summary, or a quiz. The reader can see the code — they are looking at it. What they cannot see is the path you took through it, and that path is the thing that took you a hundred tool calls to find and costs them an hour to reconstruct.

A useful test before you write anything: *if I had to explain this change to a competent colleague at a whiteboard, what would I draw first?* Draw that first. The rest of this document is that instinct, made explicit and made checkable.

### Study the patch before you emit

The single most common authoring failure is emitting steps from the **plan** or from memory of the edit, then mapping files onto that story. The guide must come from the **real patch**:

```bash
git -c core.quotepath=false diff --no-color --no-ext-diff -M -U3 --patch <base> <after>
```

Read it. List the whiteboard thoughts that are actually in the text. Only then decide order and write JSON. Phantom steps (files you planned but did not change) are dropped with `path-unknown`; multi-thought merges survive validation and fail the reader — worse.

### The floor you are building on

Tabthrough already has an offline heuristic that orders files by tier (types → domain → services → UI → tests → config) and weights hunks by significance. It is decent. Your guide replaces it only where you know something it cannot infer.

So the bar is not "produce an ordering." It is **"produce an ordering that beats a competent file-tier heuristic"** — and that **splits thoughts the heuristic would leave glued**. If your guide reproduces tier order with rationales that restate the tier, or collapses a helper and its consumer into one panel, you have spent tokens to add nothing or to hurt understanding.

The places you beat the heuristic:

- Two files in the same tier where one must be read first for a reason that lives in your head, not in the path.
- **Two thoughts in one file or one hunk** (helper then consumer; type then caller; failure then fix).
- A change whose *center* is not its largest hunk.
- Churn that looks significant and is not, or looks trivial and is not.
- A file that is only in the diff as a consequence of something else.

---

## 2. Six principles

### 2.1 Foundation before consumer — but say which foundation

Read order follows dependency of *understanding*, not dependency of compilation. A type before its callers. A new invariant before the code that maintains it. The bug before the fix, when the fix is only comprehensible as a response.

The heuristic already knows "types before callers" as a path rule. You know it as a fact about this change. When they agree, keep it and say something more specific than the heuristic would. When they disagree — a util file that is really the entry point, a test that is the clearest statement of the new contract — that disagreement is the most valuable thing in your guide.

### 2.2 One step is one thought

A step should be a single unit of understanding: something the reader can absorb, nod at, and press Tab. The reliable signal is the rationale itself. If you need "and" to write it, you have two steps. If you need a semicolon, you probably have two steps and are hiding one.

**Product rule (v0.2):** coarse multi-thought steps are a **defect in the guide**, not a viewer limitation or author preference. Never optimize for an impressive single panel.

Two thoughts in one step is the common failure, because it is how diffs are shaped — a hunk is a unit of *text proximity*, not a unit of meaning. A single function may contain two ideas; two functions in different files may be one.

| Always split (distinct thoughts) | May stay together (one thought) |
|---|---|
| New helper / named contract, then call-site refactor | Mechanical rename across many sites (one pattern step + `low` rest) |
| Type or invariant, then first consumer | Long uniform table (`grouping: "split"`) |
| Failing test / bug statement, then the fix | Pure formatting / lockfile (`significance: "skip"`) |
| Behaviour change, then wiring that only makes sense after it | Adjacent hunks that are genuinely one idea (`mergeWithNext` sparingly) |

Going the other way is also possible: twelve steps that are each one line of a mechanical rename is not twelve thoughts, it is one thought and eleven confirmations. Collapse those. Prefer **more, smaller steps** when in doubt on *mixed* hunks; collapse only mechanical uniformity.

**Use `ranges` whenever one file has more than one thought.** A whole-file claim (`path` + `rationale` only) is correct only when the whole file is one thought. Omitting ranges on a mixed file silently bundles every unclaimed group into one Tab — the flashy-panel failure mode.

### 2.3 The rationale is about position, not content

This is the rule agents break most, so it gets the most words.

The reader is looking at the code while they read your line. A rationale that describes the code is a caption on a photograph the reader is already holding. A rationale that describes *position* tells them something the picture cannot.

| Restating the diff (useless) | Explaining position (useful) |
|---|---|
| "Adds a `significance` field to `GuideStep`" | "The new field every later change is about" |
| "Updates `parseConfig` to accept a timeout" | "Where the timeout you just saw enters the runtime" |
| "Adds tests for the retry path" | "Confirms the boundary conditions from the previous step" |
| "Refactors `useUser` into a hook" | "Same behaviour, new shape — skim unless the hook signature surprises you" |
| "Bumps `zod` to 4.0" | "The dependency that forced every change below" |
| "Adds `eventActionName` and updates `jsxEvent`" | Split into two steps — see §5.1 |

Notice what the right-hand column does: each line positions the step relative to *other steps*. "Every later change", "you just saw", "the previous step", "every change below". Position is inherently relational, and relational language is the tell that you got it right.

There is one respectable exception. When the code is genuinely non-obvious — a subtle concurrency argument, a workaround for an upstream bug — the *why it is like that* belongs in `notes`, not `rationale`. Keep the one-liner about order; put the explanation one keystroke away.

### 2.4 Spend attention like it is finite, because it is

A reader has roughly twenty units of real attention in a session. Every step spends one whether it deserves it or not. So the budget is the design:

- **8–25 steps** on a typical PR.
- **Above 40**, the reader is skimming again and you have rebuilt the problem you were solving.
- **Below 5** on a large diff, you are probably file-claiming everything and adding no order — or merging thoughts.

You get under budget by *demoting*, never by hiding, and never by gluing two thoughts into one step to shorten `k/n`. `significance: "skip"` still reveals the lines; it just declines to spend a step on them and keeps them out of the `k/n` count. Lockfiles, generated clients, snapshot updates, and import reordering are what it is for, and the `files` map is the cheap way to say it:

```json
"files": {
  "pnpm-lock.yaml": { "significance": "skip", "rationale": "Lockfile churn from the same install" }
}
```

Grading a step `critical` is a promise that it repays full attention. Two or three per PR. If everything is critical, nothing is.

### 2.5 A guide is written for someone who has not read the code

You have the whole change loaded. They have step one. Everything you write must make sense to a reader who has seen only the steps before it — which means:

- Do not reference a symbol before the step that introduces it. If step 5 says "the new `RetryPolicy`", `RetryPolicy` had better appear at or before step 5.
- Do not open with the most subtle thing. Open with the thing that makes the subtle thing legible.
- Do not use the codenames you invented while working. "The v2 path", "the new orchestrator" — the reader was not in the room.
- `summary` is the one place to set up context before step one. Use it for the *shape* of the change, in a few sentences, not a bullet list of what you did.

### 2.6 No exams, no grading, no gates

This one is a product rule, not a style preference, and it is checked. Tabthrough exists because review-as-a-test makes people skim faster. A guide that reintroduces the test is a bug.

Never emit: questions to the reader, "make sure you understand X before continuing", difficulty labels, estimated reading times, checklists of things they should have noticed, scores, streaks, or anything that implies a pass/fail. `significance` is a hint about where *you* think the weight is, not a demand.

The tone that works is a colleague walking you through their change: matter-of-fact, occasionally opinionated about their own code, never testing you.

---

## 3. Ordering recipes by change shape

Most changes fall into a handful of shapes. Each has an order that works and a trap.

### New capability

**Order:** data model / types → core logic → wiring → entry point / UI → tests → config and docs.

**Trap:** starting at the entry point because that is where the user story starts. The reader hits the call site of a function that does not exist yet and has to hold it open until step six.

### Bug fix

**Order:** the failing case first (a test, a reproduction, or the line where the wrong assumption lives) → the fix → the fallout.

**Trap:** leading with the fix. A one-line fix with no context is unreviewable — the only interesting question is *why that line*, and the answer lives in the bug. If the diff contains a regression test, that test is usually your best step one even though the heuristic will sort tests last. This is a case where you should absolutely override it, and say why: `"rationale": "The failure, stated as a test — read this before the fix"`.

### Refactor with no behaviour change

**Order:** the new shape first, then one representative call site, then the rest as a low-significance group.

**Trap:** walking all forty call sites. Say once that the remaining sites are mechanical, mark them `low`, and let the reader spend their attention on the shape. Also: if the refactor really has no behaviour change, say so in `summary` — it changes how the reader reads everything below.

### Helper then consumer (often same file)

**Order:** introduce the helper / named contract first; then the consumer that adopts it. Separate steps with `ranges`, even when both edits sit in one hunk.

**Trap:** one panel that flashes both. Named in dogfood as `eventActionName` + `jsxEvent` — see §5.1. The reader never forms the contract before seeing the refactor that depends on it.

### Mixed change (refactor plus feature, the common real PR)

**Order:** separate the strands explicitly. Refactor first as a block, then the feature on top of the new shape. Use the `summary` to name the two strands so the reader knows a boundary is coming. Inside each strand, still split helper vs consumer when both appear.

**Trap:** interleaving them by file. The reader cannot tell which lines are "the same thing, moved" and which are new behaviour, so they read everything at feature intensity and run out of attention halfway.

### Dependency or framework upgrade

**Order:** the manifest change first (it is the cause), then the adaptations grouped by *kind* of breakage, not by directory.

**Trap:** treating the lockfile as content. `skip` it. Also, adaptations sorted by path look random; sorted by "these are all the `.parse()` call sites, these are all the error-type changes" they read as two steps instead of thirty.

### Revert or removal

**Order:** what is being removed and why, then the callers that lose it, then the cleanup.

**Trap:** deletions have no `new` side, so a range must anchor with `"side": "old"`. Easy to get wrong and it silently unmatches. Prefer a whole-file claim when the whole file goes.

### Wide mechanical change (rename, codemod, formatting)

**Order:** one step showing the pattern, one `low` step for the rest, done.

**Trap:** letting a real change hide inside the mechanical noise. If the codemod touched forty files and you hand-fixed two, those two are their own steps with a rationale that says exactly that: `"Hand-corrected — the codemod got this one wrong"`. That single line is worth more than everything else in the guide.

### Configuration, CI, and infrastructure

**Order:** what changes about the system's behaviour first, then the file that expresses it.

**Trap:** these often *look* trivial and carry the most risk. A one-line timeout change deserves `critical` more often than a two-hundred-line component does.

---

## 4. Sizing, anchoring, and the mechanics that matter

The normative rules are in [guide-schema.md](../architecture/guide-schema.md). Three consequences are worth internalising because they change how you write.

**Anchor coarsely.** Ranges *intersect* line groups rather than containing them, so pointing at the enclosing function is enough. Being two lines off costs nothing; being ten lines off may claim a neighbouring change. Precision here buys you nothing and costs you robustness across a rebase.

**Omit `ranges` only when a whole file is one thought.** A step with just `id`, `path`, and `rationale` claims every unclaimed group in that file. It cannot go stale, and it is the right default for single-thought files. **If the file has two thoughts, omit ranges and you have authored the anti-pattern.**

**Leave gaps in `order`.** 10, 20, 30. A human will want to insert a step, and renumbering a document is how mistakes get in.

Two grouping tools, used sparingly:

- `grouping: "split"` hands sizing back to the engine for a large *uniform* region — a big table, a long list of similar edits. All sub-steps share your rationale. Use it when the region is one thought that happens to be long. **Do not use `split` to paper over two different thoughts** — write two steps with two rationales instead.
- `grouping: "mergeWithNext"` folds this step into the following one in the same file. Use it when two adjacent hunks are genuinely inseparable, not to work around having written the order badly or to reunite a helper with its consumer after you correctly split them.

And one honesty mechanism: set `scope`, including `diffDigest`. Without it, the reader cannot be told their guide is stale, and a stale guide that looks fresh is worse than no guide. The digest recipe is exact and reproducible — [guide-schema.md §7](../architecture/guide-schema.md).

**Schema note:** v1 already expresses forced splits via `steps` + `ranges` + `order` / `dependsOn`. Do not invent fields. Soft heuristic split assist for offline guides is a separate backlog item (P1-11 / P0-G*), not a schema change.

---

## 5. Anti-patterns

Each of these is something agents actually produce. The fix matters more than the label.

### 5.1 The flashy one-panel reveal (canonical)

**Wrong:** one step that introduces a helper and immediately shows the consumer refactor — e.g. `eventActionName` **and** a `jsxEvent` rewrite in a single Tab. The panel looks dramatic; the reader never owns either thought.

```json
{
  "id": "events",
  "path": "src/jsx/events.ts",
  "rationale": "Adds eventActionName and refactors jsxEvent to use it"
}
```

Two telltales: the rationale needs "and", and a whole-file (or whole-hunk) claim covers two whiteboard drawings.

**Right:** two steps, same file, separate `ranges`, helper/contract before consumer.

```json
{
  "version": 1,
  "summary": "Extract a shared action-name helper, then adopt it in jsxEvent. Two thoughts — do not read them as one flash.",
  "steps": [
    {
      "id": "event-action-name",
      "order": 10,
      "path": "src/jsx/events.ts",
      "ranges": [{ "side": "new", "start": 1, "end": 4 }],
      "significance": "high",
      "title": "Named action helper",
      "rationale": "The contract every later event call site will share",
      "notes": "`eventActionName` is the naming rule. Read it alone before any call site changes, or the refactor looks like noise."
    },
    {
      "id": "jsx-event-adopts",
      "order": 20,
      "path": "src/jsx/events.ts",
      "ranges": [{ "side": "new", "start": 8, "end": 14 }],
      "significance": "high",
      "title": "jsxEvent adopts the helper",
      "rationale": "First consumer — only makes sense after the helper above",
      "dependsOn": ["event-action-name"]
    }
  ]
}
```

Same file, same PR, two Tabs. Line numbers match the golden fixture below — always re-anchor to the enclosing functions in a real patch. If other call sites remain, add a third `low` step for the mechanical rest rather than folding them into either thought.

**Golden fixture (P0-G2 / P0-G3 dogfood):** `test/fixtures/diffs/helper-consumer-refactor.diff` plus the correct guide `test/fixtures/guides/helper-consumer.guide.json`. The anti-pattern whole-file claim is `helper-consumer-merged.guide.json`. Dogfood protocol and expected step ids: `test/fixtures/README.md`.

### The diff, renumbered

```json
{ "id": "s1", "path": "src/user.ts", "rationale": "Modified getUser to add caching" }
```

Every rationale restates its hunk, and the order is whatever the diff was in. The reader gets no information they did not already have from scrolling.

**Fix:** for each step, delete the rationale and ask "why here?" If the answer is "because that is where it was in the diff," the step has no position and the guide has no order. Reorder, then write.

### The essay in the rationale

```json
{ "rationale": "This change updates the retry logic because the previous implementation would retry on 4xx errors which is incorrect since those are not transient, and also we needed to add jitter" }
```

Over the 120-character limit, so it is rejected or truncated, and it was doing `notes`' job anyway.

**Fix:** rationale is the one-line reason for position. `"The retry rule the rest of this change follows from"`. The reasoning goes in `notes`, which the reader opens when they want it.

### Everything is critical

Nine steps, seven of them `critical`, one `high`.

**Fix:** rank them honestly against each other. Which one, if the reader read only one, would they most need? That one is critical. Now do it again for the runner-up. Stop at three.

### Exam smuggling

```json
{ "rationale": "Can you spot why this needs a null check?" }
{ "notes": "Before continuing, make sure you understand the lifecycle above." }
```

**Fix:** answer your own question. `"The null case the previous step introduced"`. Tabthrough will treat the interrogative form as a bug in your guide, not a feature.

### The phantom step

A step for a file that is not in the diff — usually because you planned an edit, described it, and then took a different approach. It is dropped with a `path-unknown` warning, and the reader is told their guide is partly broken.

**Fix:** generate steps from the actual patch, never from your plan. If you did not diff before emitting, you are guessing.

### Lockfile as literature

A step, sometimes several, for `pnpm-lock.yaml`.

**Fix:** the `files` map with `significance: "skip"`. Same for generated clients, snapshots, and build output.

### Alphabetical or directory order

`src/a/...`, `src/b/...`, `src/c/...`. Real, and it happens when a model iterates over changed files rather than thinking about the change.

**Fix:** the file list is an input, not an outline. Decide the order first, on paper, then attach files to it.

### Order that contradicts itself

Step 3 says "as we saw in the validator", but the validator is step 7. `dependsOn` exists to prevent exactly this, and a cycle in it gets all your edges dropped.

**Fix:** read the rationales in order, as a sequence, before emitting. Every backward reference must point at a lower `order`.

### One step, one file, forever

Thirty files, thirty steps, no `ranges`, no grouping, no significance. Technically valid, pedagogically the same as `git diff --stat` — and it also **forces multi-thought files into one Tab each**.

**Fix:** mark the two or three steps that carry the change, demote the supporting cast, and **split multi-thought files with `ranges`**.

---

## 6. A worked example (bug fix, cross-file)

A PR that fixes a bug: the session lock was keyed on the workspace folder while it was written keyed on the repo root, so recovery silently never fired inside a monorepo subdirectory. The diff touches `src/model/recovery.ts`, `src/git/probe.ts`, `test/unit/recovery.test.ts`, and `README.md`.

### First attempt (what an agent usually emits)

```json
{
  "version": 1,
  "steps": [
    { "id": "s1", "path": "src/git/probe.ts", "rationale": "Adds repoRoot to the probe result" },
    { "id": "s2", "path": "src/model/recovery.ts", "rationale": "Changes the token key to use repoRoot" },
    { "id": "s3", "path": "test/unit/recovery.test.ts", "rationale": "Adds a test" },
    { "id": "s4", "path": "README.md", "rationale": "Updates docs" }
  ]
}
```

Valid, and worth almost nothing. It is tier order with the tiers spelled out, every rationale restates its hunk, and the single most important fact about this change — that the two keys disagreed — appears nowhere.

### Second attempt

```json
{
  "version": 1,
  "scope": { "kind": "commit", "base": "7d1ecb6", "head": "5b0caa3" },
  "summary": "Crash recovery never fired when the workspace folder was not the repository root. The token was written under one key and read under another; the two only coincide when you open the repo root directly, which is why every test passed. The fix is one line in each place plus a regression test that opens a subdirectory.",
  "steps": [
    {
      "id": "the-bug",
      "order": 10,
      "path": "test/unit/recovery.test.ts",
      "significance": "critical",
      "title": "The bug, as a test",
      "rationale": "Start here — it names the failure the rest of the diff answers",
      "notes": "The test opens `packages/app` inside a temp monorepo. On the old code the token is written under the repo root and looked up under the workspace folder, so `recoveryPending` is false and unrestored work stays hidden. Symlinked temp paths on macOS hit the same divergence."
    },
    {
      "id": "probe-root",
      "order": 20,
      "path": "src/git/probe.ts",
      "ranges": [{ "side": "new", "start": 41, "end": 58 }],
      "significance": "high",
      "title": "One source of truth for the root",
      "rationale": "The value both sides of the bug must agree on",
      "dependsOn": ["the-bug"]
    },
    {
      "id": "recovery-key",
      "order": 30,
      "path": "src/model/recovery.ts",
      "significance": "high",
      "rationale": "The read side, now keyed the same way the write side always was",
      "dependsOn": ["probe-root"]
    },
    {
      "id": "readme-gap",
      "order": 40,
      "path": "README.md",
      "significance": "low",
      "rationale": "Known-gap note this fix retires"
    }
  ]
}
```

Four steps for four files again, but the guide now carries information the diff does not:

- **The test leads.** The heuristic would have put it last. It goes first because the bug is the only thing that makes a one-line key change interesting, and the rationale says so in the reader's terms rather than announcing an override.
- **The reason lives in `notes`.** The mechanism — two keys, coinciding only in the common case, which is why tests passed — is exactly the sort of thing that does not survive in a commit message and is invisible in the diff. It is one keystroke away, not in the reader's face.
- **`summary` sets up the shape** before step one: what broke, why it hid, and how big the fix is. The reader knows to expect small.
- **Significance is ranked, not sprayed.** One `critical`, two `high`, one `low`. The README genuinely is a footnote and is labelled as one.
- **`dependsOn` encodes the argument**, so if a future tool reorders on `order` alone the chain still holds.

What it deliberately does *not* do: quiz the reader, estimate reading time, restate any line of code, or claim more confidence than it has.

For the same-file helper+consumer split, see §5.1.

---

## 7. Before you emit

Run these against your own document. They are the checks a reviewer would run, and they are cheap.

**Patch gate**

- Did I read the real patch before writing steps?
- Does every step correspond to something in that patch (not the plan)?

**Granularity (fail the guide if any is "no")**

- Did I merge two whiteboard thoughts into one step?
- Would any rationale need "and" or a semicolon to stay honest?
- Does every multi-thought file use `ranges` (not a whole-file claim)?
- Is `mergeWithNext` unused as a way to glue a helper to its consumer?

**Order**

- Read the rationales top to bottom as prose. Does it tell a story, or is it a list?
- Does any step reference something a later step introduces?
- Would a reader who stopped at step 3 have learned something coherent?

**Rationales**

- Does every one explain *position*? Delete any that would still be true if the step were moved.
- Any questions, gates, or grading language?

**Budget**

- Between 8 and 25 steps for a typical PR? Prefer more small steps over one multi-thought panel when those are the alternatives.
- At most three `critical`?
- Lockfiles, generated files, and snapshots demoted via `files`?

**Correctness**

- Every `path` present in the actual patch?
- Deletions anchored with `"side": "old"`, or claimed whole-file?
- `id`s unique, `order` sparse, `dependsOn` acyclic and pointing backwards?
- `scope.diffDigest` computed with the exact recipe?
- Validates against the published JSON Schema, [`schema/guide-v1.json`](../../schema/guide-v1.json)?

**The last one, which subsumes the rest**

> If a colleague read only your guide and never scrolled the diff, would they be able to explain this change — **one thought per Tab** — and would they be right?

If yes, ship it. If no, the fix is almost always fewer *merged* thoughts and a better order, not more words in one panel.
