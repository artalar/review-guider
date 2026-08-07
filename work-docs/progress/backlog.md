# Guide Reviewer — Prioritized Backlog

**Last updated:** 2026-08-07 (Product Owner, track E + P1 sequencing)  
**Ordering principle:** Safety → core Tab loop → offline guide → polish → LLM/agents → nice-to-have

Legend: **P0** MVP ship blocker · **P1** fast follow (v0.2) · **P2** later

---

## P0 — MVP (ship blockers)

Status legend: **Next** = in the current Implementer slice · **Not started** = planned, phase assigned · **In progress** / **Done** set by Implementer.
Phases are defined in [plan.md](./plan.md).

| ID | Item | Acceptance hint | Depends | Phase | Status |
|----|------|-----------------|--------|-------|--------|
| P0-0 | **Toolchain foundation** (Planner-added prerequisite) — deps, `@reatom/core`, extension identity, generated meta, vitest config | `pnpm lint && typecheck && test:ci` green on clean clone | — | 0 | **Done** |
| P0-1 | **Git capability probe** — repo detection, dirty state, HEAD, shallow/missing objects | Commands disabled with clear message when git unusable | — | 1 | **Done** (`src/git/{exec,probe}.ts`) |
| P0-2 | **Session entry: working tree** — diff staged+unstaged vs HEAD | Command produces step list; empty diff blocked | P0-1 | 4 | **Done** (`guide-reviewer.start`; whitespace-only now refused too) |
| P0-3 | **Session entry: single commit** — show commit vs first parent | Works on linear history sample | P0-1 | 4 | **Done** (`guide-reviewer.startFromCommit`, QuickPick over `readRecentCommits` + free-form ref; root and merge commits covered) |
| P0-4 | **Session entry: commit range** — `A..B` merge-base aware | Range diff matches `git diff A..B` | P0-1 | 4 | **Done** (`guide-reviewer.startFromRange`; `A..B` and `A...B` both resolve through merge-base) |
| P0-5 | **Stash pipeline** — scoped message, backup ref, pre-flight summary | Automated test: stash → mutate → restore byte-identical | P0-1 | 2 | **Done** (`src/git/{snapshot,stash,refs,journal,isolate}.ts`; 17-case sacred suite) |
| P0-6 | **Restore on all exit paths** — Finish, Cancel, deactivate, crash recovery command | Matrix test for Finish/Cancel; manual crash drill | P0-5 | 2 | **Done** for code + automated matrix; crash drill written in `test-matrix.md` §6.1 but **not yet run** |
| P0-7 | **Single-session lock** — reject second start while active | Error toast if session already running | P0-5 | 2 | **Done** (CAS on `refs/guide-reviewer/lock`); two-window drill §5.2 not yet run |
| P0-8 | **Reatom session model** — session, stashHandle, steps, cursor, status | All UI/commands read/write one model | — | 1 | **Done** (`src/model/{session,steps,ports,view,guide-source}.ts`) |
| P0-9 | **Diff → step graph** — parse unified diff into hunks/lines | Fixture tests for split/join | P0-8 | 3 | **Done** (`src/guide/{types,parse-diff,groups,render}.ts`) |
| P0-10 | **Heuristic orderer** — file tier + hunk significance + line groups | Foundation-before-consumer fixture passes | P0-9 | 3 | **Done** (`src/guide/{heuristic,steps}.ts`) |
| P0-11 | **Tab / Shift+Tab advance** — configurable keybinding, default avoids IntelliSense conflict | Step k→k+1 reveals new regions; Shift+Tab undoes | P0-10 | 5 | **Done** in code (ADR 0002 D2 `when` clause + unconditional `alt+]`/`alt+[`); the conflict matrix in `test-matrix.md` §6.4 still needs a human |
| P0-12 | **Reveal rendering** — decorations or staged apply in diff editor | Prior steps stay visible; binary skip stub | P0-11 | 5 | **Done** (`src/ui/documents.ts`; R5 closed by the Architect's built-document design, no spike needed. `dim` shares the provider) |
| P0-13 | **Status bar UI** — `step k/n`, file, one-line rationale | Updates synchronously with model | P0-8 | 5 | **Done** (`src/ui/status-bar.ts`; click runs `showStepDetail`) |
| P0-14 | **Commands** — Start, Next, Previous, Finish, Cancel | Palette + keybindings registered | P0-6, P0-11 | 5 | **Done** (ten commands, all with `enablement`; asserted by `test/unit/contributions.test.ts`) |
| P0-15 | **Sidecar guide read (minimal)** — load `.guide.json` if present; validate or fallback | Override step order for fixture guide | P0-10 | 3 | **Done** and wired (`buildGuideSource` reads the blob from the after ref, then the base ref) |
| P0-16 | **P0 edge cases** — see product.md table | Each row has test or runbook | P0-5–P0-12 | 6 | **Done** for the automated half: all ten rows in [test-matrix.md §2](./test-matrix.md), the last three closed by `test/integration/edge-cases.test.ts`. Walking row 10 found a real defect — a shallow boundary commit was reviewed against the empty tree — now refused with a fetch hint. **Open:** the five human drills in §6, none of which has been run |

**MVP milestone:** P0-1 through P0-16 complete + dogfood sign-off.

### Non-P0 tracks running in parallel

| Track | Work | Owner | Status |
|-------|------|-------|--------|
| B | `test/helpers/tmp-repo.ts`, diff fixtures, `progress/test-matrix.md` | Tester | **Done** (helper + `test/helpers/protocol.ts` crash driver + the matrix, now led by the ten-row P0 edge table in §2; the five manual drills in §6 still need a human) |
| C | `architecture/overview.md`, `reatom-model.md`, `guide-schema.md` | Architect | **Done** |
| D | README, marketplace metadata, settings docs | Implementer | **Done** (usage, safety model, settings, known-limitations table; marketplace fields were set in Phase 0) |
| E | `.guide.json` schema publication + agent skill draft (docs only, no `src/`) | — | **Done for the schema** (`schema/guide-v1.json` is a real file, kept in step with the reader by `test/unit/published-schema.test.ts`; docs and the skill point at it). The long form and the skill remain a draft until an agent authors a guide for a real PR against them |

---

## P1 — Fast follow (v0.2)

| ID | Item | Notes |
|----|------|-------|
| P1-1 | **`.guide.json` schema v1 + docs** — portable contract for agents | Described in [architecture/guide-schema.md](../architecture/guide-schema.md) and published as [`schema/guide-v1.json`](../../schema/guide-v1.json), which the reader is now diffed against on every run. **Remaining:** serve it at its `$id`, `https://guide-reviewer.dev/schema/guide-v1.json` — a DNS and hosting task, not a code one. The raw GitHub URL resolves in the meantime |
| P1-2 | **Agent skill / prompt** — emit guide sidecar when producing PRs | Draft landed ([guides/agent-guide-authoring.md](../guides/agent-guide-authoring.md) long form + `.agents/skills/guide-reviewer/`). **Acceptance is dogfood, not docs:** an agent writes a guide for a real PR against the skill, and a reviewer reads only that guide |
| P1-3 | **Stale guide merge** — partial sidecar + heuristic fill + one warning | Per-file interleaving of the heuristic remainder, which MVP appends wholesale; `scope.diffDigest` detection already exists |
| P1-4 | **LLM guide generator (BYOK)** — opt-in per session; provider config | Product brief: [guides/llm-guide-generation.md](../guides/llm-guide-generation.md). Off by default, per-session consent, key in `SecretStorage`, output is `.guide.json` v1 through the same validator and merge — no second format. Sequenced **after** P1-1/P1-2 (PO note below) |
| P1-5 | **PR entry via `gh`** — optional; fallback instructions without CLI | |
| P1-6 | **Peek-ahead decoration** — dim next related hunk | No rationale spoil |
| P1-7 | **Large diff compact mode** — file-level steps above LOC threshold | User setting |
| P1-8 | **Drift detection** — warn if files change on disk during session | |
| P1-9 | **Rename-aware diff steps** | |
| P1-10 | **Settings panel** — keybinding hint, rationale toggle, LLM keys | |

### PO order within P1 (2026-08-07)

**P1-1 → P1-2 → P1-3 → P1-5 → P1-7 → P1-4 → P1-6 → P1-8 → P1-9 → P1-10.**

The portable contract compounds: every agent that learns to emit `.guide.json` produces guides forever, in any repo, with no key, no latency, and no consent dialog — and each is better than a generated one because the author knew why they made the change. The LLM path does not compound; it re-derives discarded intent and bills for it every time. So it stays the fill-in for repos the contract has not reached, and it ships after the contract is real. P1-3 comes early because a sidecar that goes stale on the first rebase is how the contract loses its credibility. P1-7 precedes P1-4 because "too large to generate" is one of the LLM path's own failure modes.

---

## P2 — Later

| ID | Item | Notes |
|----|------|-------|
| P2-1 | Multi-root workspace support | |
| P2-2 | GitLab/Bitbucket remote helpers | |
| P2-3 | Export/share guide (markdown) | Onboarder persona |
| P2-4 | Opt-in telemetry — session completion, no code content | |
| P2-5 | Team guide cache / shared sidecars | |
| P2-6 | Step annotations / personal notes | |
| P2-7 | Semantic dependency order (language-aware) | |
| P2-8 | Review resume without full restore (advanced) | High risk; needs design |

---

## Edge-case budget (summary)

| Tier | Count | Rule |
|------|-------|------|
| **P0** | 10 cases | Must implement + test; blocks release |
| **P1** | 7 cases | Target v0.2; don't slip into MVP unless trivial |
| **P2** | 6 cases | README “known limitations” only |

Full matrix: [specs/product.md](../specs/product.md#edge-case-budget)

---

## Recommended implementation sequence (Planner input)

Phased in detail — with exit criteria, test gates, risks, and module layout — in **[plan.md](./plan.md)**.

0. P0-0 (toolchain: deps, Reatom, generated meta, vitest)  
1. P0-1, P0-8 (foundation)  
2. P0-5, P0-6, P0-7 (safety)  
3. P0-9, P0-10, P0-15 (guide engine)  
4. P0-2, P0-3, P0-4 (entry points) — parallel with phase 3  
5. P0-11, P0-12, P0-13, P0-14 (UX loop)  
6. P0-16 (edge hardening)  
7. P1 docs-only track parallel after phase 3 green
