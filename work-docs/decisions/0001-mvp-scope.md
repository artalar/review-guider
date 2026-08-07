# ADR 0001: MVP Scope for Guide Reviewer

**Status:** Accepted  
**Date:** 2026-08-07  
**Deciders:** Product Owner  
**Consulted:** Founder vision, Planner, Architect (pending)

---

## Context

Guide Reviewer helps developers *own* reviewed code via Tab-stepped reveal of changes in pedagogical order. The founder specified:

- Two guide sources: (1) agent-emitted guides, (2) LLM-generated guides from raw diffs
- Hard technical constraint: **Reatom** state mental model
- Non-negotiable: **stash safety** — never lose developer work
- UX: Tab must not feel like an exam

We need a market-ready MVP scope that validates the core hypothesis without boiling the ocean.

---

## Decision

### Ship in MVP (v0.1)

| Area | In MVP | Detail |
|------|--------|--------|
| **Entry points** | Working tree, single commit, commit range | Git-native only; no hosting API required |
| **Stash lifecycle** | Full pipeline + recovery | Backup ref, pre-flight summary, restore on all exit paths |
| **Tab reveal loop** | Yes | Configurable binding; heuristic step sizing |
| **Guide ordering** | **Heuristic + optional `.guide.json` read** | Offline-first; no API key required |
| **Guide schema** | Read path + stub validation | Full agent docs/skill deferred to P1 but schema shape fixed early |
| **UI** | Status bar + commands | No webview dashboard |
| **State** | Reatom model owns session | reactive-vscode binds UI/commands to model |
| **LLM generation** | **Out of MVP** | P1 fast follow |
| **Agent prompt/skill** | **Out of MVP** (contract only) | P1; MVP accepts pre-existing sidecar files |
| **PR/MR integration** | **Out of MVP** | P1 via optional `gh` |

### Guide source sequencing (explicit)

1. **MVP (P0):** Heuristic orderer + read `.guide.json` when present  
2. **P1a:** Publish agent skill + schema docs so coding agents emit sidecars  
3. **P1b:** LLM BYOK generator when no sidecar exists  

Rationale: Heuristic path proves Tab UX and stash safety **without network, cost, or prompt iteration**. Agent sidecar is the **portable contract** between humans, agents, and the extension. LLM fills gaps for legacy diffs.

---

## Alternatives considered

### A — LLM-first MVP

Generate every guide via API at session start.

**Rejected:** Requires API key for first-run; latency blocks “try it now”; failure modes (rate limits, privacy) undermine trust before core loop is proven.

### B — Agent-only (no heuristic)

Require `.guide.json` for every session.

**Rejected:** Empty experience on existing repos; blocks dogfood and marketplace demos offline.

### C — Normal diff viewer + optional guide

No stash isolation; overlay on current tree.

**Rejected:** Violates founder flow; dirty-tree context switching remains unsolved; harder to guarantee reveal semantics.

### D — Exam mode with comprehension checks

Quiz after each step.

**Rejected:** Conflicts with “no exam” UX principle; increases abandon rate.

---

## Consequences

### Positive

- MVP shippable to VS Code Marketplace with zero external services  
- Stash safety and Tab loop get maximum test attention  
- `.guide.json` shape stabilizes early for parallel agent work in P1  
- Clear upgrade path: heuristic → sidecar → LLM

### Negative / accepted debt

- Heuristic order will be wrong on complex refactors → mitigated by P1 LLM and sidecar  
- No one-click “review this PR URL” until P1  
- Multi-root and exotic git states documented as limitations (P2)

---

## MVP acceptance gates

Before marking v0.1 done:

1. Automated stash round-trip test passes on CI  
2. Manual crash-recovery drill documented  
3. Dogfood: 5 sessions, zero restore failures  
4. No exam-like UI (PO checklist)  
5. At least one `.guide.json` fixture overrides heuristic order

---

## Related

- [Product spec](../specs/product.md)  
- [Backlog](../progress/backlog.md)  
- Future ADR: guide schema v1 (Architect)
