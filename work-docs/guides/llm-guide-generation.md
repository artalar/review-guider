# LLM guide generation (BYOK) — product brief

**Backlog item:** P1-4
**Target:** v0.2
**Owner:** Product
**Status:** Draft for Planner / Architect
**Last updated:** 2026-08-07
**Depends on:** P1-1 (`.guide.json` v1, frozen) · P1-2 (agent skill) · P0-15 (sidecar read path, shipped)
**Related:** [specs/product.md](../specs/product.md) · [architecture/guide-schema.md](../architecture/guide-schema.md) · [guides/agent-guide-authoring.md](agent-guide-authoring.md) · [ADR 0001](../decisions/0001-mvp-scope.md)

---

## 1. What this is for, and what it is not for

Tabthrough has three possible sources of ordering: the offline heuristic (shipped), a checked-in sidecar written by an agent or a human (shipped, read path), and an LLM asked to produce one from the raw diff (this document).

The LLM path is the **fill-in for repos with no sidecar** — an existing codebase, a PR from a teammate who does not run agents, a commit from 2023. That is its whole job. It is deliberately third in priority: the sidecar is a portable contract that any agent in any tool can honour, and every guide written that way is one a user does not pay for twice. The LLM covers the long tail the contract has not reached yet.

Two consequences follow, and they should survive contact with implementation:

- **The output is `.guide.json` v1. Not a variant, not a superset.** The generator is a producer of the same artifact an agent produces, and it goes through the same validator and the same merge. If the LLM path needs a schema change, the schema changes for everyone or the feature does without it. No second format.
- **The offline path stays the default, forever.** ADR 0001 rejected an LLM-first MVP because a network dependency at first run undermines trust before the core loop is proven. Nothing about v0.2 changes that reasoning; this feature is an enhancement the user reaches for, never a gate they pass through.

---

## 2. Scope for v0.2

Ranked. If the release is squeezed, cut from the bottom.

### Must ship

1. **Explicit per-session opt-in** with a consent screen that states exactly what leaves the machine (§5).
2. **BYOK credentials** in VS Code `SecretStorage`, never in settings JSON, never in the repo.
3. **One provider shape:** OpenAI-compatible chat completions with a configurable base URL. That covers OpenAI, Azure, OpenRouter, Together, vLLM, Ollama, and LM Studio in one code path.
4. **Diff-only input** with a hard token budget and a documented truncation strategy (§3).
5. **Self-validation before use:** parse, validate against v1, repair or discard. A model that returns prose gets us nothing and must cost the user nothing.
6. **Degrade to heuristic on every failure**, with one honest message. Never a blocked session, never a spinner that does not end.
7. **Cancel at any time**, including mid-request, with the session continuing on the heuristic guide.
8. **Local-only providers must work with no key**, because a user pointing at `localhost:11434` is the strongest possible answer to the privacy question.

### Should ship

9. **"Save as `.guide.json`"** after generation — one click converts a generated guide into a checked-in sidecar. This is the feature that makes the LLM path *feed* the contract instead of competing with it, and it is the cheapest adoption loop we have.
10. **Redaction pass** on the outbound patch: known secret patterns and a user-configurable deny-list of globs (§5.2).
11. **Per-session cost/token estimate** shown on the consent screen before the call.
12. **Response cache** keyed by diff digest, so re-opening the same review does not re-bill the user.

### Explicitly out of v0.2

- Any hosted service, proxy, or Tabthrough API key. BYOK or nothing.
- Sending file context beyond the patch (surrounding code, repo tree, README, git log). Tempting, materially better, and a much larger privacy surface — revisit with evidence.
- Multi-turn refinement, "regenerate this step", chat about the change. The product is not a tutor.
- Streaming partial guides into a live session.
- Automatic generation on session start under any setting. There is no "always allow".
- Embeddings, RAG, or any index of the user's code.

---

## 3. Input: the diff, and only the diff

**Sent:** the unified patch for `base..after`, produced with the frozen invocation in [guide-schema.md §7](../architecture/guide-schema.md), plus the `--name-status` file list, plus a short instruction prompt derived from [agent-guide-authoring.md](agent-guide-authoring.md).

**Not sent:** file contents outside the patch, the repository name or remote URL, absolute paths, branch names, commit messages, author identity, the user's other open editors, or anything from `globalState`.

### Budget and truncation

Real PRs exceed context windows, and *how* we shrink them determines whether the output is useful.

| Rule | Reason |
|---|---|
| Hard cap on outbound tokens, configurable, default sized for a ~50k-token window | Predictable cost; no surprise bill |
| Drop generated and lockfile content first, keeping the file entry with a line count | They are `skip` material anyway — see the `files` idiom in the schema |
| Then reduce context lines from 3 to 0 | Cheapest information loss per token |
| Then elide the interior of hunks over N lines, marking the elision | Preserves the *shape* of every file, which is what ordering needs |
| Never drop a file entirely without telling the model it exists | A guide that silently omits a file produces a `k/n` the user cannot trust |
| Above the cap even after all of that, refuse and say so | Better than a confidently wrong guide on a 10k-line diff. Compact mode (P1-7) is the right answer there |

The order of those rules is the product decision: we would rather have a coarse guide over the whole change than a precise guide over a third of it.

---

## 4. Output: a `.guide.json` v1 document

The model is asked for a JSON document matching the v1 schema, with the same pedagogical rules the agent skill carries — position-not-content rationales, 8–25 steps, at most three `critical`, no exam language.

Then we do not trust it:

1. **Parse.** Strip a markdown fence if present. Not JSON → discard.
2. **Validate** with the same hand-rolled total validator the sidecar path uses.
3. **Repair the cheap things** rather than discarding: drop steps whose `path` is not in the patch, drop unknown `dependsOn` edges, clamp over-long strings, deduplicate ids, renumber `order`. All repairs are recorded as diagnostics.
4. **Reject the expensive things:** wrong `version`, no surviving steps, or a document that fails validation after repair. Fall back to the heuristic.
5. **Enforce the tone rule.** A rationale ending in `?`, or matching the "make sure you understand / can you spot / try to" family, is stripped to nothing and the step keeps its heuristic rationale. We do not ship an exam because a model felt chatty.
6. **Merge** through the existing `mergeGuide`, exactly as a sidecar would, with `generator: { name: "tabthrough-llm", model: "<model>" }` for provenance.

Uncovered lines are still revealed by the heuristic fallback pass. Invariant I1 holds by construction because we reuse the merge, and that is the main reason the output must be the same format.

---

## 5. Privacy

This is the part that decides whether the feature is used or uninstalled. Get it wrong once and the trust the stash pipeline earned is gone.

### 5.1 Consent

- **Per session, every session, by default.** A "remember for this workspace" checkbox is acceptable; a global "always" is not.
- The consent screen names, in plain language: the provider host, the model, the number of files and lines going out, an estimated token count and cost, and the fact that the *code content of the diff* is included — not a summary of it.
- **Cancel is the default button**, matching the pre-flight stash modal.
- Nothing leaves the machine before that button.
- The consent screen links to this document.

### 5.2 Redaction

Redaction is a courtesy, not a guarantee, and the UI must say so in those terms. Before any request:

- Drop files matching `tabthrough.llm.excludeGlobs` (default includes `.env*`, `*.pem`, `*.key`, `**/secrets/**`).
- Mask high-confidence secret patterns in the remaining patch text.
- `.gitignore` is already honoured upstream — ignored files are never in the diff, because the snapshot uses `add -A`.
- Show the count of excluded files on the consent screen. Silent exclusion is its own trust problem.

### 5.3 Standing rules

- The API key lives in `SecretStorage`. It is never written to settings, never logged, never included in a diagnostics bundle.
- The output channel logs request metadata — host, model, token counts, latency, outcome — and never request or response bodies.
- No telemetry on this path in v0.2. Not even counts. P2-4 covers telemetry and it will be opt-in and content-free when it lands.
- `tabthrough.llm.enabled` defaults to `false`, and with it false the extension makes no network call of any kind. That is the auditable claim: "off means no traffic".
- Cached responses live in `globalState` keyed by diff digest, hold only the generated guide document, and are cleared by `Tabthrough: Clean up backups`.

---

## 6. UX

The whole flow, in the shape the product's principles demand:

1. Start a session as usual. **The heuristic guide is built first, always**, and the session is fully usable before any LLM question is asked.
2. If no sidecar was found and `tabthrough.llm.enabled` is true, the status bar offers a quiet affordance: *"Generate a guide with <model>"*. Not a modal. Not a blocker. The user may just start pressing Tab.
3. Clicking it opens the consent screen (§5.1).
4. On confirm: a cancellable progress notification. Tab still works on the heuristic guide the whole time — **the generation never freezes the review**.
5. On success the guide swaps in, the cursor resets to step one with a short explanation of why the order changed, and a "Save as `.guide.json`" action appears.
6. On failure, one message naming what happened, and the session continues on the heuristic. No stack traces, no retry loop, no red.

Two guardrails on the wording:

- Never phrase the LLM guide as better, smarter, or "AI-powered understanding". It is a different opinion about order, and sometimes a worse one.
- Never imply the user *should* have generated one. The heuristic path is a first-class way to review.

**Latency budget:** p95 under 15 s for a typical PR (the metric already in `specs/product.md`). Above 30 s we surface "still working" with cancel; above 60 s we cancel ourselves and fall back.

---

## 7. Failure modes

Every row degrades to the heuristic guide. That is the invariant.

| Failure | User sees | Notes |
|---|---|---|
| No key configured | Consent screen replaced by "Add an API key" with a link to settings | Not an error |
| Auth rejected (401/403) | "Provider rejected the key" + open settings | Never log the key |
| Rate limited (429) | "Rate limited — try again shortly", one retry with backoff, then stop | No retry storms |
| Timeout / offline | "Could not reach `<host>` — continuing with the offline guide" | Named host, so proxy problems are diagnosable |
| Model returns prose, not JSON | "Could not read the generated guide — continuing with the offline guide" | One retry with a stricter instruction, then give up |
| Document fails validation after repair | Same message; diagnostics in the output channel | Reuses the sidecar diagnostic surface |
| Guide references files not in the diff | Silent repair, one info diagnostic | Common; not worth a notification |
| Guide contains exam language | Stripped silently, info diagnostic | Product rule, enforced in code |
| Diff over budget after truncation | "This change is too large to generate a guide for" | Points at compact mode (P1-7) |
| User cancels | Nothing. Session continues | Cancel must be instant and leave no state |
| Provider returns a 200 with an empty body | Treated as prose failure | Seen with some local runtimes |

Nothing here can touch git. The generator sits behind the existing guide-source interface and has no access to the stash pipeline, the refs, or the journal. Worth stating explicitly in the architecture doc when this is designed: **a network feature must not be able to reach the safety-critical layer.**

---

## 8. Configuration

Proposed, for the Architect to finalise against the settings table in `architecture/overview.md`:

| Setting | Type | Default |
|---|---|---|
| `tabthrough.llm.enabled` | boolean | `false` |
| `tabthrough.llm.baseUrl` | string | `https://api.openai.com/v1` |
| `tabthrough.llm.model` | string | `""` (required when enabled) |
| `tabthrough.llm.maxInputTokens` | number | `40000` |
| `tabthrough.llm.timeoutMs` | number | `60000` |
| `tabthrough.llm.excludeGlobs` | string[] | `[".env*", "*.pem", "*.key", "**/secrets/**"]` |
| `tabthrough.llm.rememberConsentPerWorkspace` | boolean | `false` |

The key itself is not a setting. `Tabthrough: Set API key` writes to `SecretStorage`; `Tabthrough: Clear API key` removes it.

---

## 9. Success criteria for v0.2

| Criterion | Bar |
|---|---|
| Off means off | With `llm.enabled: false`, a network trace during a full session shows zero outbound requests. Automated |
| Consent is unskippable | No code path reaches the provider without a confirmed consent for that session. Test |
| Degradation is total | Every row of §7 leaves a usable session on the heuristic guide. Test matrix |
| Output is portable | Every generated guide validates against the published v1 schema, or is discarded. Property test over recorded responses |
| Latency | p95 < 15 s on a ≤500-line diff |
| Beats the floor | In dogfood, ≥3 of 5 reviewers prefer the generated order to the heuristic on the same diff. If it does not clear this, the feature is not worth its privacy cost |
| Feeds the contract | ≥1 dogfood session ends with "Save as `.guide.json`" committed to a repo |

The "beats the floor" row is the one that can kill the feature, and it should be able to. An LLM guide that is merely different from the heuristic is not worth a consent dialog.

---

## 10. Open questions

1. **Where does the generated guide live between sessions?** Cache keyed by digest is proposed; a user who never clicks "Save" may still expect it to persist. Leaning toward cache-only, with Save as the durable path.
2. **Does the prompt ship as a file agents can read?** Arguing yes — the same instructions the skill gives an agent should be the ones we give the model, and divergence between them is a bug we would rather catch in review than in output.
3. **`--first-parent` on merge commits** already limits what the model sees; whether to tell it so, in prompt, is untested.
4. **Local models produce worse JSON.** Whether the repair pass in §4.3 is generous enough for a 7B model is an empirical question, and the answer decides whether "point at Ollama" is a real recommendation or a talking point.
5. **Should a stale sidecar suppress the offer?** A guide that exists but does not match the diff (P1-3) is exactly the case where generation helps most, and also the case where the user has expressed a preference for their own ordering.

---

## 11. Priority note

Inside P1, this lands **after** P1-1 and P1-2. The reasoning is in the iteration log and is worth repeating here, because it is the kind of decision that gets quietly reversed by whoever finds the LLM feature more fun to build:

The sidecar contract compounds. Every agent that learns to emit `.guide.json` produces guides for free, forever, in any repo, with no key, no latency, and no consent screen — and each one is better than a generated guide because the author actually knew why they made the change. The LLM path does not compound: it costs money and a privacy conversation on every single invocation, and it is reconstructing intent that was thrown away.

So the LLM is the fill-in for repos the contract has not reached. Build the thing that spreads first.
