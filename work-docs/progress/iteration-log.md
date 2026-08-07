# Iteration Log

## 2026-08-07 — Iteration 0: Bootstrap

- Orchestrator created branch `cursor/guide-reviewer-extension-fbe4`
- Installed Reatom skills from `reatom/reatom` via skills CLI
- Seeded `work-docs` roles and process
- Launching PO, Planner, Architect agents next

## Product Owner — 2026-08-07

- Published `specs/product.md`: personas, success metrics, MVP/P1/P2 scope, UX principles, edge-case budget (10 P0 / 7 P1 / 6 P2)
- Refined `progress/backlog.md`: 16 P0 items with dependency order; P1 LLM + agent contract sequenced after offline heuristic path
- ADR `decisions/0001-mvp-scope.md`: MVP = stash-safe Tab loop + heuristic/sidecar guides; LLM and agent skill are P1; exam-like UX rejected
- **PO recommendation to Planner/Architect:** implement P0-1→P0-8→P0-5 (safety) before entry points; freeze `.guide.json` shape early for P1 agent work
