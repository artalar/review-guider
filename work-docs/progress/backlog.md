# Guide Reviewer — Prioritized Backlog

**Last updated:** 2026-08-07  
**Ordering principle:** Safety → core Tab loop → offline guide → polish → LLM/agents → nice-to-have

Legend: **P0** MVP ship blocker · **P1** fast follow (v0.2) · **P2** later

---

## P0 — MVP (ship blockers)

| ID | Item | Acceptance hint | Depends |
|----|------|-----------------|--------|
| P0-1 | **Git capability probe** — repo detection, dirty state, HEAD, shallow/missing objects | Commands disabled with clear message when git unusable | — |
| P0-2 | **Session entry: working tree** — diff staged+unstaged vs HEAD | Command produces step list; empty diff blocked | P0-1 |
| P0-3 | **Session entry: single commit** — show commit vs first parent | Works on linear history sample | P0-1 |
| P0-4 | **Session entry: commit range** — `A..B` merge-base aware | Range diff matches `git diff A..B` | P0-1 |
| P0-5 | **Stash pipeline** — scoped message, backup ref, pre-flight summary | Automated test: stash → mutate → restore byte-identical | P0-1 |
| P0-6 | **Restore on all exit paths** — Finish, Cancel, deactivate, crash recovery command | Matrix test for Finish/Cancel; manual crash drill | P0-5 |
| P0-7 | **Single-session lock** — reject second start while active | Error toast if session already running | P0-5 |
| P0-8 | **Reatom session model** — session, stashHandle, steps, cursor, status | All UI/commands read/write one model | — |
| P0-9 | **Diff → step graph** — parse unified diff into hunks/lines | Fixture tests for split/join | P0-8 |
| P0-10 | **Heuristic orderer** — file tier + hunk significance + line groups | Foundation-before-consumer fixture passes | P0-9 |
| P0-11 | **Tab / Shift+Tab advance** — configurable keybinding, default avoids IntelliSense conflict | Step k→k+1 reveals new regions; Shift+Tab undoes | P0-10 |
| P0-12 | **Reveal rendering** — decorations or staged apply in diff editor | Prior steps stay visible; binary skip stub | P0-11 |
| P0-13 | **Status bar UI** — `step k/n`, file, one-line rationale | Updates synchronously with model | P0-8 |
| P0-14 | **Commands** — Start, Next, Previous, Finish, Cancel | Palette + keybindings registered | P0-6, P0-11 |
| P0-15 | **Sidecar guide read (minimal)** — load `.guide.json` if present; validate or fallback | Override step order for fixture guide | P0-10 |
| P0-16 | **P0 edge cases** — see product.md table | Each row has test or runbook | P0-5–P0-12 |

**MVP milestone:** P0-1 through P0-16 complete + dogfood sign-off.

---

## P1 — Fast follow (v0.2)

| ID | Item | Notes |
|----|------|-------|
| P1-1 | **`.guide.json` schema v1 + docs** — portable contract for agents | JSON Schema + example in repo |
| P1-2 | **Agent skill / prompt** — emit guide sidecar when producing PRs | Published under `.agents/skills/` or docs |
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

1. P0-1, P0-8 (foundation)  
2. P0-5, P0-6, P0-7 (safety)  
3. P0-9, P0-10, P0-15 (guide engine)  
4. P0-2, P0-3, P0-4 (entry points)  
5. P0-11, P0-12, P0-13, P0-14 (UX loop)  
6. P0-16 (edge hardening)  
7. P1 track parallel after P0-5 green
