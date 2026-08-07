# ADR 0003: Rename product to Tabthrough

**Status:** Accepted  
**Date:** 2026-08-07  
**Deciders:** Founder (apply branding recommendations)  
**Consulted:** DevRel branding brief (`work-docs/marketing/branding-brief.md`)

---

## Context

Launch identity was fragmented: product **Guide Reviewer**, package `guide-reviewer`, repository `review-guider`. DevRel audit found the name weak for Marketplace search, easy to confuse with automated “code reviewer” tools, and grammatically inverted (“guide reviewer” vs guiding a reviewer).

## Decision

Adopt **Tabthrough** as the public brand before Marketplace publication:

| Surface | Value |
|---------|--------|
| Display name | `Tabthrough — Guided Diff Review` |
| Extension id | `artalar.tabthrough` |
| Commands / settings / context keys | `tabthrough.*` |
| Virtual document scheme | `tabthrough` |
| Git ref namespace | `refs/tabthrough/**` |
| Schema `$id` | `https://tabthrough.dev/schema/guide-v1.json` |
| Proposed GitHub repository | **`tabthrough`** (owner renames when ready; links already point there) |
| Format name | **`.guide.json` unchanged** (frozen v1 contract) |

Primary tagline: **Understand every change, one Tab at a time.**

Command titles follow outcome-first verbing (Review Working Changes, Finish and Restore Workspace, …). Status bar uses calm `k of n` voice and “Walkthrough complete · Finish and restore”.

Categories: **Visualization**, **Other** (drop SCM Providers).

## Consequences

- Pre-publication rename; no installed-base aliases required.
- GitHub repo rename is a separate owner action; first-party URLs already use `https://github.com/artalar/tabthrough`.
- Schema hosting at `tabthrough.dev` may need a redirect from any interim raw GitHub URL.
- Historical docs/reviews may still mention the old name as prior identity.

## Related

- [Branding brief](../marketing/branding-brief.md)
- ADR 0001 (MVP scope), ADR 0002 (architecture)
