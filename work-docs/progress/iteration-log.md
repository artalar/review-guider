# Iteration Log

## 2026-08-07 — Iteration 0: Bootstrap (prior branch)

- Prior agent on `cursor/guide-reviewer-extension-fbe4` seeded product docs
- Cherry-picked into `cursor/guide-reviewer-33d9`

## 2026-08-07 — Iteration 1: Orchestrator bootstrap

- Branch: `cursor/guide-reviewer-33d9`
- Installed Reatom skills (`reatom`, `reatom-async`, `reatom-jsx`, `reatom-review`) via `npx skills add reatom/reatom`
- Synced skills to `.agents/skills/` and `.cursor/skills/`
- Process + role docs under `work-docs/process` and `work-docs/roles`
- Product docs already approved (PO Iteration 0): MVP = stash-safe Tab + heuristic/sidecar; LLM/agent P1
- Next: Planner + Architect (strong models) in parallel

## Product Owner — 2026-08-07 (accepted)

- Published `specs/product.md`, `progress/backlog.md`, ADR `0001-mvp-scope.md`
- **PO recommendation:** P0-1 → P0-8 → P0-5 (safety) before entry points; freeze `.guide.json` shape early

## Planner — 2026-08-07

- Published `progress/plan.md`: 7 phases (0 toolchain → 1 foundation → 2 safety → 3 guide engine → 4 entry points → 5 UX loop → 6 edge hardening), each with exit criteria and a test gate. Every P0 maps to exactly one phase.
- Added **P0-0 (toolchain)** as a Planner-identified prerequisite: the template does not currently typecheck (`src/config.ts` and `src/utils.ts` import `src/generated/meta`, which `vscode-ext-gen` has not produced), and `@reatom/core` is not a dependency yet. No feature phase has a working gate until this lands.
- Backlog now carries **Phase** and **Status** columns plus a parallel-track table.
- Risk register (9 entries, ordered by expected cost). Top three: **R2 stash conflict/data loss** (round-trip suite is a merge blocker for all later phases), **R5 reveal rendering** — VS Code decorations cannot hide lines, so a spike is required before P0-12 commits and `dim` is the default fallback — and **R1 Tab keybinding conflicts**, structurally mitigated by rendering into a read-only virtual document on its own URI scheme.
- Load-bearing architectural constraint proposed for the Implementer: nothing under `src/git/`, `src/guide/`, or `src/model/` imports `vscode`, so the safety and ordering suites run under plain vitest with no extension host.
- Handed **[ARCH]** markers to the Architect: Reatom scope lifetime vs `defineExtension` and disposal ordering, the repo-level session lock mechanism, the final Tab `when` clause, and `.guide.json` v1 shape (blocks P0-15).
- **Next:** Implementer slice = Phase 0 in full + P0-1 (git probe with discriminated result, `guideReviewer.gitUsable` context key, disabled Start command). Stash pipeline explicitly deferred to its own review pass. Tester track B (`test/helpers/tmp-repo.ts`) should start in parallel — it is on the critical path for Phase 2.
