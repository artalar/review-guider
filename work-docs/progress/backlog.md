# Guide Reviewer — Prioritized Backlog

**Last updated:** 2026-08-07 (Implementer, Phases 4–5)  
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
| P0-6 | **Restore on all exit paths** — Finish, Cancel, deactivate, crash recovery command | Matrix test for Finish/Cancel; manual crash drill | P0-5 | 2 | **Done** for code + automated matrix; crash drill written in `test-matrix.md` §5.1 but **not yet run** |
| P0-7 | **Single-session lock** — reject second start while active | Error toast if session already running | P0-5 | 2 | **Done** (CAS on `refs/guide-reviewer/lock`); two-window drill §5.2 not yet run |
| P0-8 | **Reatom session model** — session, stashHandle, steps, cursor, status | All UI/commands read/write one model | — | 1 | **Done** (`src/model/{session,steps,ports,view,guide-source}.ts`) |
| P0-9 | **Diff → step graph** — parse unified diff into hunks/lines | Fixture tests for split/join | P0-8 | 3 | **Done** (`src/guide/{types,parse-diff,groups,render}.ts`) |
| P0-10 | **Heuristic orderer** — file tier + hunk significance + line groups | Foundation-before-consumer fixture passes | P0-9 | 3 | **Done** (`src/guide/{heuristic,steps}.ts`) |
| P0-11 | **Tab / Shift+Tab advance** — configurable keybinding, default avoids IntelliSense conflict | Step k→k+1 reveals new regions; Shift+Tab undoes | P0-10 | 5 | **Done** in code (ADR 0002 D2 `when` clause + unconditional `alt+]`/`alt+[`); the conflict matrix in `test-matrix.md` §4 still needs a human |
| P0-12 | **Reveal rendering** — decorations or staged apply in diff editor | Prior steps stay visible; binary skip stub | P0-11 | 5 | **Done** (`src/ui/documents.ts`; R5 closed by the Architect's built-document design, no spike needed. `dim` shares the provider) |
| P0-13 | **Status bar UI** — `step k/n`, file, one-line rationale | Updates synchronously with model | P0-8 | 5 | **Done** (`src/ui/status-bar.ts`; click runs `showStepDetail`) |
| P0-14 | **Commands** — Start, Next, Previous, Finish, Cancel | Palette + keybindings registered | P0-6, P0-11 | 5 | **Done** (ten commands, all with `enablement`; asserted by `test/unit/contributions.test.ts`) |
| P0-15 | **Sidecar guide read (minimal)** — load `.guide.json` if present; validate or fallback | Override step order for fixture guide | P0-10 | 3 | **Done** and wired (`buildGuideSource` reads the blob from the after ref, then the base ref) |
| P0-16 | **P0 edge cases** — see product.md table | Each row has test or runbook | P0-5–P0-12 | 6 | Not started |

**MVP milestone:** P0-1 through P0-16 complete + dogfood sign-off.

### Non-P0 tracks running in parallel

| Track | Work | Owner | Status |
|-------|------|-------|--------|
| B | `test/helpers/tmp-repo.ts`, diff fixtures, `progress/test-matrix.md` | Tester | **Done** (helper + `test/helpers/protocol.ts` crash driver + matrix published; the three manual drills in §5 still need a human) |
| C | `architecture/overview.md`, `reatom-model.md`, `guide-schema.md` | Architect | **Done** |
| D | README, marketplace metadata, settings docs | Implementer | **Done** (usage, safety model, settings, known-limitations table; marketplace fields were set in Phase 0) |
| E | `.guide.json` schema publication + agent skill draft (docs only, no `src/`) | — | **Draft** (`work-docs/guides/agent-guide-authoring.md` long form + `.agents/skills/guide-reviewer/SKILL.md`, mirrored to `.cursor/skills/`; the JSON Schema itself is still only inside `guide-schema.md` §4, not served at its `$id`) |

---

## P1 — Fast follow (v0.2)

| ID | Item | Notes |
|----|------|-------|
| P1-1 | **`.guide.json` schema v1 + docs** — portable contract for agents | JSON Schema + example in repo |
| P1-2 | **Agent skill / prompt** — emit guide sidecar when producing PRs | Draft landed (`work-docs/guides/agent-guide-authoring.md` + `.agents/skills/guide-reviewer/`); needs a real agent to write a guide against it before it is called done |
| P1-3 | **Stale guide merge** — partial sidecar + heuristic fill + one warning | |
| P1-4 | **LLM guide generator (BYOK)** — opt-in per session; provider config | OpenAI-compatible first; offline still default |
| P1-5 | **PR entry via `gh`** — optional; fallback instructions without CLI | |
| P1-6 | **Peek-ahead decoration** — dim next related hunk | No rationale spoil |
| P1-7 | **Large diff compact mode** — file-level steps above LOC threshold | User setting |
| P1-8 | **Drift detection** — warn if files change on disk during session | |
| P1-9 | **Rename-aware diff steps** | |
| P1-10 | **Settings panel** — keybinding hint, rationale toggle, LLM keys | |

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
