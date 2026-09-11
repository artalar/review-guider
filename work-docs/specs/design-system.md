# Tabthrough design system

Status: proposed design specification · 11 September 2026

This document defines the visual language, components, interaction rules, and content standards for Tabthrough’s current and future UI. It is a design deliverable only: it does not implement changes or authorize new product capabilities. “Current” describes the working tree inspected on this date, including changes not yet committed; “proposed” describes the system to adopt in later implementation work.

## 1. Product direction

Tabthrough is a guided diff reader for VS Code and Cursor. Its defining experience is reading one coherent change at a time, in an order that builds understanding. The code is the primary content; the sidebar provides orientation, explanation, and control.

The visual direction is **quiet, precise, and native to the editor**. Use the host’s typography and semantic colors, restrained borders, compact controls, and generous space around explanations. Establish identity through the repeated rhythm of **position → thought → reason → next step**, rather than a separate branded dashboard.

The system follows five principles:

1. **One step, one thought.** Make the current thought the strongest content element. Keep supporting context available without making every item equally prominent.
2. **The reader controls pace.** Navigation is reversible, completion is explicit, and there are no scores, streaks, timers, or implied comprehension grades.
3. **Consequences are visible.** Reading, editing a real file, amending a commit, and aborting a rebase must be distinguishable before activation.
4. **The editor stays familiar.** Preserve native diff rendering, normal focus traversal, theme preferences, and command-palette access.
5. **Capability claims are exact.** An offline guide, an editor-agent handoff, and a future integrated generation service must have different descriptions.

## 2. Current UI audit

The inspected sources are listed at the end. This is a source-based audit, not a rendered accessibility or visual conformance assessment.

| Surface | Current foundation | Design response |
| --- | --- | --- |
| Walkthrough sidebar | Plain HTML webview; theme variables; sticky Previous / count / Next header; summaries, reasons, notes, setup and Git state | Retain the compact sidebar. Introduce explicit component roles and separate reading context from repository operations. |
| Visual hierarchy | 12/16/20px outer spacing; 32px minimum buttons; 3–4px radii; 22px session count and 16px step title | Consolidate spacing and radii. Show the count once in navigation and make the step title dominant. |
| Commit and range picker | Flat list buttons, metadata, selected backgrounds, start/end shape badges and colored rails | Keep list density and shapes. Add visible endpoint words and a resolved range summary; stop borrowing added/modified colors for endpoints. |
| Native diff | Virtual base/reveal documents, progressive reveal or dim mode, current-step highlight and overview marker | Keep native Git colors. Ensure current-step emphasis does not obscure additions, deletions, selection, or diagnostics. |
| Status bar | Book icon, position, file and optional reason; click returns to current step | Retain as a compact secondary orientation surface. Completion means reading ended, not code approved. |
| Feedback | Native notifications and output channel; broken guide warnings fall back to heuristic ordering | Keep one notice per failure event; give persistent context and a relevant recovery action in the sidebar. |
| Mode and completion | Read-only and rebase paths; worktree choice disabled; generic Finish/Cancel text | Use mode-specific consequences and action labels. Do not advertise a disabled future feature as a recovery path. |
| Branding | Existing icon assets; established Tabthrough name and tagline | Preserve the identity. Use host monochrome icon treatment in editor chrome; avoid decorative branding in the reading loop. |

Specific gaps to address in future UI work:

- The session block repeats the navigation count and gives it more visual weight than the thought being reviewed.
- Primary styling is inferred from command names, so repository Continue and walkthrough Next can compete. Emphasis should express the immediate task and context.
- Completion uses a testing-success color, which can imply a verdict about the code.
- Disabled controls use blanket opacity; explanatory hints use transparency. Neither establishes readability across themes.
- Inputs have visible labels without explicit input association. Refresh logic preserves some button focus and page scroll, but does not preserve an in-progress input value or its selection.
- Guide text is escaped and bounded, which is a useful security foundation; silently truncating long notes needs an explicit continuation affordance.
- The model contains mode-choice rows, while the webview command allowlist currently omits `chooseMode`. This is an interaction gap to verify when implementing the proposed mode selector.

Some older product and branding text describes stash restoration, apply-per-step behavior, or a sidebar without a webview. The current code and Git-first decision take precedence for this proposal. Read-only working changes also save buffers and create a snapshot ref: “Will run: nothing” must not become a blanket promise that nothing is saved or written.

## 3. Surface and information hierarchy

Use each surface for one main purpose:

| Surface | Responsibility |
| --- | --- |
| Native diff editor | Read source, see the active change, select and copy revealed code. |
| Walkthrough sidebar | Select a target, prepare a guide, understand the current thought, navigate, and inspect session consequences. |
| Status bar | Locate the session and return to the current change. |
| Native picker or dialog | Choose refs or untracked files when a native interaction suits the task; collect a bounded decision. |
| Notification | Announce an unexpected outcome requiring awareness or action. |
| Output channel | Preserve full command output and diagnostic details. |

The active sidebar order is: sticky navigation; a blocking notice if needed; compact mode and target context; current step title and path; reason; notes; optional next-step preview; guide summary disclosure; secondary actions; repository details. An informational Git state must not push the explanation far below the fold. A blocking conflict must remain obvious.

During setup, order content as: target → guide source → session mode → consequence summary → Start walkthrough. Existing valid guides get a direct start path. Generating another guide is secondary to reading one already available.

## 4. Design tokens

Token names below are proposed semantic aliases, not existing exports. Future UI should consume these roles rather than selecting colors or measurements ad hoc. Values are CSS pixels at default editor zoom; typography scales with the host font setting.

### Color

The host theme is the palette. Do not introduce a fixed light/dark brand palette into the extension. Resolve optional theme values to a tested compatible fallback; an absent border token must not make focus or selection disappear.

| Proposed role | Host theme source | Use |
| --- | --- | --- |
| `surface.canvas` | `sideBar.background` | Sidebar and sticky navigation background. |
| `surface.hover` | `list.hoverBackground` | Hovered list row; never the sole selection signal. |
| `surface.selected` | `list.inactiveSelectionBackground` | Persistent selection, paired with its matching foreground. |
| `text.primary` | `foreground` | Titles, reasons, notes and essential instructions. |
| `text.secondary` | `descriptionForeground` | Paths, metadata and supporting copy. No extra opacity. |
| `text.disabled` | `disabledForeground` | Unavailable actions; keep the reason outside the disabled treatment. |
| `border.subtle` | `panel.border` | Section divisions where spacing alone is insufficient. |
| `border.focus` | `focusBorder` | Keyboard focus; distinct from selection. |
| `border.contrast` | `contrastBorder` | Additional outlines in contrast themes where supplied. |
| `action.primary` | `button.background`, `button.foreground`, `button.hoverBackground` | The immediate next action. |
| `action.secondary` | `button.secondaryBackground`, `button.secondaryForeground`, `button.secondaryHoverBackground` | Supporting actions. |
| `link` | `textLink.foreground`, `textLink.activeForeground` | Navigation to details or source. |
| `input` | `input.background`, `input.foreground`, `input.border`, `input.placeholderForeground` | Ref and range entry. |
| `notice.info` | `editorInfo.foreground` | Information icon or leading rule; body uses normal text. |
| `notice.warning` | `editorWarning.foreground` | Recoverable attention state. |
| `notice.error` | `errorForeground` | Failed operation or invalid input. |
| `step.current` | `editor.wordHighlightBackground` | Existing editor highlight candidate; retain only if it remains distinct over diff backgrounds. |

Reserve Git addition/deletion colors for actual source changes. Range start/end, progress, and completion use neutral selection treatment plus text and shape. Do not use testing-pass green for “all steps revealed.” Warning and error colors communicate state, not reading quality.

### Typography and geometry

| Token | Proposed value | Purpose |
| --- | --- | --- |
| `font.ui` | Host UI font family and size | All interface prose; baseline nominally 13px. |
| `font.code` | Host editor font family, falling back to monospace | Refs, hashes and command previews. Keep prose in the UI font. |
| `type.meta` | 0.92 × host size, floor 12px; line height 1.4 | Metadata and keyboard hints. |
| `type.body` | 1 × host size; line height 1.5 | Reasons and explanation text. |
| `type.title` | 1.23 × host size; weight 600; line height 1.4 | Current thought; approximately 16px at baseline. |
| `type.label` | Host size; weight 600 | Form and section labels. Sentence case. |
| `space` | 4, 8, 12, 16, 24, 32px | Respectively micro-gap, control gap, row padding, panel gutter, section gap, major separation. |
| `radius.control` | 4px | Buttons, fields and list selections. |
| `border.width` | 1px | Controls and separators. |
| `focus.width` | 2px with 2px offset | Visible focus without layout shift. |
| `control.height` | Minimum 32px; grows with content | Desktop controls, never clipped by a fixed height. |
| `icon.size` | 16px | Standard action/status icons; larger only outside dense chrome. |
| `motion.feedback` | 100–150ms | Optional color transitions. No layout or code-reveal animation. |

Use 16px horizontal and 12px vertical panel padding, with 24px between major sections. Avoid a card around every paragraph. Use borders only for distinct control groups, notices, and sticky navigation. Avoid shadows, gradients, ornamental backgrounds, and all-caps labels in the reading surface.

## 5. Component contracts

### Action

Variants are primary, secondary, quiet, and consequential. Primary is reserved for one immediate workflow action in a visible region: Start walkthrough, Next, or the final mode-specific action. Choices such as Simple and Agent use equivalent emphasis until selected. Repository actions stay secondary during normal reading; a blocking recovery state can make its recovery action primary.

Every action supports default, hover, keyboard focus, pressed, disabled, and busy states. Busy text describes work (“Starting walkthrough…”); disable repeat activation and keep the label’s footprint stable. An icon supplements a text label. Icon-only buttons require an accessible name and tooltip.

Consequential actions such as Abort rebase and Remove worktree carry explicit labels and adjacent consequences. They must not look like routine Previous/Next navigation. Use a neutral outlined treatment and warning context rather than inventing a red primary-button palette. Confirmation is appropriate when the immediate context has not already made a consequential action clear; do not add a modal to every reading action.

### Walkthrough navigation

Keep Previous on the left, `4 of 17` in the center, and Next on the right. Numbers use tabular numerals. At the first revealed step, Previous is disabled. Before the first step, use “Ready to begin” or `0 of 17`, never “Step 0” as a thought title.

At the last step, keep the thought visible and replace Next with the mode-specific finish action. Changing the button label must not cause an accidental finish from a queued repeat keypress. Advancing past the final step does not amend a commit or dismiss the session. Completion is announced once without celebration or a persistent success toast.

### Step explanation

Present title, repository-relative path, “Why here,” and optional “Notes.” Missing title falls back to the path. Missing reason or notes removes that section without a fabricated explanation. Notes remain plain text unless a separately reviewed rich-text design is introduced.

Wrap long paths and prose; do not horizontally scroll the sidebar. A title can span multiple lines. If a path duplicates the fallback title, show it once. Label disk changes as “Edited on disk” and explain that the review still shows the captured change. Do not imply that a later edit has been included in the walkthrough snapshot.

Keep notes readable by default. For content beyond a deliberate display limit, show “Show full notes” and expose the complete text through an accessible continuation. Never silently remove meaning. Preserve the existing escaping and prohibition on executable guide content.

### Guide context

Show the guide’s source as a neutral label: “Simple · offline,” “Repository guide,” or “Editor agent.” A guide source conveys provenance, not correctness. Keep the guide summary expanded during preparation; during reading, place it after the current explanation in a disclosure that remembers the reader’s choice for the session.

“Generate Simple guide” describes offline ordering. “Ask editor agent” describes the current agent handoff, including the copy-and-paste fallback when needed. Do not describe that handoff as completed generation or imply that the agent path is offline. Starting remains a separate action after a usable guide exists.

### Choice list and range selection

Target and mode choices have a label, one short description, and a selected indicator. Commit rows show subject first, then short hash, author and relative date. Hover, selection, and keyboard focus remain independently visible.

Range endpoints use both a shape and visible words: “Start” and “End.” Keep the current triangle/square distinction if useful, but replace Git-colored rails with a shared selection accent. Shade intervening history lightly as context; do not suggest that every highlighted row is necessarily in the resolved diff. State the comparison rule: “Review the end against its merge base with the start.”

Show the chosen refs above Use range. User-entered refs may be outside the loaded history; their validity must not depend on a visible list row. Preserve typed values after validation errors. For two-endpoint selection, provide a clear way to revise either endpoint and an instruction indicating which endpoint the next selection sets.

### Input

Use a persistent label associated with its field, a short example placeholder, and a named submit action such as Use range. Enter submits the field; Tab moves focus. Validation appears directly below the field, is programmatically associated with it, and describes how to correct the value. Loading history must not erase manually entered refs.

### Consequence summary

Before Start, show mode, target, and a short account of what happens to the workspace. Keep applicable risks such as rewritten commits and signing behavior visible. Put the exact Git command in a copyable disclosure for readers who need it; never substitute raw command syntax for the explanation.

For read-only working changes, suggested copy is: “Saves open changes and captures a review snapshot. No checkout or stash. Later edits do not update this walkthrough.” For a read-only commit/range: “Reads committed objects without checking out the target.” Guide generation separately explains that it writes the configured guide file.

### Notice and repository operation

A notice consists of severity, short title, consequence, and a relevant action. Use text plus an icon or rule; color alone is insufficient. A missing optional guide is informational; fallback after an invalid guide is a warning; a failed required save is a blocking error.

Group Git state into an operation section with explicit actions such as Continue rebase, Abort rebase, Open Source Control, Show stash, and Pop stash. Keep conflict paths individually openable. Repository state and reading progress are separate: ending a walkthrough must not visually claim that an independently remaining Git conflict is resolved.

## 6. State and behavior specification

| State | Content and action | Interaction requirement |
| --- | --- | --- |
| No usable repository | Explain the missing prerequisite; show an applicable next step | Avoid an unexplained bank of disabled controls. |
| Ready | Review target choices or direct Start for a usable guide | Offline path is visible without installing an agent skill. |
| Loading history / preparing | Describe the operation; show indeterminate activity | No invented percentage; preserve existing selection and input. |
| Empty or whitespace-only diff | “No reviewable changes” with target context | Return to target selection; do not create a zero-step success state. |
| Invalid ref / range | Inline error and retained input | Focus remains in the field; correction is possible immediately. |
| Guide fallback | Explain that Simple ordering is being used; offer details | Continue reading; one warning event, full diagnostics in output. |
| Starting | Mode and target plus operation status | Prevent duplicate start; expose cancellation only when supported. |
| Reading | Current thought and stable navigation | Advancing reveals source; it does not apply a patch to disk. |
| Edited on disk | Path-level label and snapshot explanation | Going back changes reveal position, not the reader’s edits. |
| All steps revealed | “All 17 steps revealed” and finish consequence | Last thought remains; no claim that the code is correct or approved. |
| Finishing | Name the actual operation, such as “Amending and continuing rebase…” | Prevent conflicting actions; report completion only after the operation result. |
| Failure / Git conflict | Persistent explanation, actual affected files and recovery actions | Preserve useful reading context where possible; no fabricated restoration promise. |
| External rebase change | Explain that the review ended because Git state changed elsewhere | Show the current Git state; do not automatically undo another window’s action. |

Mode-specific completion language:

| Mode | Proposed finish label and consequence | Proposed exit label and consequence |
| --- | --- | --- |
| Read-only | **Finish walkthrough** — closes the review and removes its temporary snapshot ref, if any | **End walkthrough** — same cleanup; edits made to real files remain |
| Rebase | **Amend and continue** — stages tracked changes, optionally includes selected untracked files, amends when needed, then continues rebase | **Abort rebase** — runs Git abort; edits made during the rebase may be discarded; autostash restoration can conflict |
| Worktree, future | Define with the shipped worktree lifecycle before enabling | Separate closing a view/window from removing a worktree; removal must expose its target and dirty state |

For Rebase Finish, retain the untracked-file picker with none selected initially; canceling that picker returns to the review. Show hook/signing policy and any bypass action honestly. A replay conflict means further Git work remains, even when all reading steps were revealed. Generic command identifiers may remain internally, but visible labels and accessible descriptions must communicate the mode’s effect.

## 7. Keyboard, accessibility, and adaptive layout

Treat these as proposed acceptance requirements, not claims about the current implementation:

- All actions are reachable without a mouse. Use native buttons, inputs, and disclosure semantics. Mode selection exposes its selected state; commit/range selection exposes endpoint roles in accessible names. Do not assign listbox semantics without implementing its keyboard behavior.
- Preserve current shortcut scope: Tab/Shift+Tab navigate steps only in focused review documents when completion, snippet, rename, accessibility and focus-traversal contexts permit. In the sidebar and real file editors, Tab retains its normal purpose. Alternate Next/Previous shortcuts and the command palette remain available.
- Display shortcut hints from the effective binding when available. When using documented defaults, identify them as defaults; do not promise they are unchanged on every installation.
- Keep focus on the initiating control after an ordinary update. Preserve input text, caret, selection, expanded disclosures and scroll. If Next becomes Finish, move focus to the corresponding replacement without activating it. If a control disappears, place focus on the nearest meaningful heading or action.
- Announce step position and title through a concise polite live region. Do not announce the entire notes section on every change. Announce actionable errors once. Moving the diff viewport must not steal focus from sidebar input.
- Target text contrast of at least 4.5:1 and meaningful control boundaries/focus indicators of at least 3:1. Check actual rendered theme combinations. Avoid opacity as the only state treatment. In contrast themes, selection and current-step boundaries remain distinguishable by outlines and labels.
- Keep essential target areas at least 32px high in the desktop sidebar. For a future touch-oriented surface, use at least 44px. Labels may wrap and controls may grow.
- Validate the sidebar at 220, 320 and 480px widths and at 200% editor zoom. Below roughly 280px, reduce horizontal gutters to 12px and place progress above navigation if necessary. Stack field/action pairs when their labels cannot fit. Do not hide Next, finish consequences, or validation to force a single row.
- Use one main vertical scroll area. Sticky navigation must not cover focused content; long notes and command previews must not create nested vertical scroll traps. Long command examples may scroll horizontally inside their own labeled region.
- Follow reduced-motion preferences. Disable optional transitions; code reveal is immediate. Loading text must communicate activity even with animation disabled.

In dim mode, the existing 0.4 opacity is not a guaranteed accessible treatment. Prefer a theme-aware pending style that leaves code legible, with a clear current-step marker. Retain progressive mode as an alternative. In either mode, avoid overwriting native diff foreground colors.

## 8. Composition examples

These text layouts define hierarchy, not pixel-perfect mockups or implemented screens.

```text
ACTIVE READ-ONLY WALKTHROUGH
[Previous]          4 of 17          [Next]

Read-only · Working changes

Define the order total
src/orders/total.ts

Why here
The caller needs this contract before it can use the result.

Notes
Rounding happens once, after all line items are summed.

Next: Use the total in checkout
▸ Guide summary

[Go to current change]  [Edit here]
[Finish walkthrough]   [End walkthrough]
▸ Repository details
```

```text
REBASE: LAST STEP
[Previous]              17 of 17
[Amend and continue]

Rebase · selected commit
All 17 steps revealed

Verify the rounding boundary
test/orders/total.test.ts
...reason and notes remain visible...

Finish stages tracked changes and amends this commit
when needed, then replays later commits. New files
are included only if selected.
▸ Command details and hook/signing policy

[Abort rebase]
Abort may discard edits made during this rebase.
```

## 9. Content and iconography

Use sentence case and concrete verbs. “Walkthrough” names the reading experience, “guide” names its ordering and explanations, “step” names one thought, and “target” names the working changes/commit/range being read. Use “review” in established commands and product descriptions without implying approval.

Prefer “All steps revealed” to “Passed”; “Could not resolve this ref” to “Invalid”; “Use Simple ordering” to “Ignore errors”; and “Open real file” as the explanation for Edit here. Error copy states what happened, what remains true, and what the reader can do. Avoid “safe,” “restored exactly,” or “nothing changed” unless the specific operation justifies the claim.

Use a small consistent icon vocabulary: book for walkthrough, arrows for navigation, Git symbols for refs/operations, file for source, information/warning/error for notices. Match the host’s icon style and use `currentColor` in monochrome UI assets. Do not invent a new logo in this system. Avoid sparkles for offline ordering and shields or approval checks as product promises. Completion can be expressed entirely in words.

## 10. Extension rules for future UI

New features reuse semantic roles and component contracts before introducing new styles. A new component proposal must name its user task, states, keyboard behavior, content limits, theme behavior, and relationship to the current reading flow.

| Future area | System rule |
| --- | --- |
| Worktree sessions | Add lifecycle and location context using the existing mode, consequence and operation components. Do not enable the current placeholder until behavior and recovery copy are defined. |
| Remote PR entry | Add another target source. Identify repository, base and head; show any fetch/network requirement before it occurs. Keep the local reading experience consistent. |
| Integrated guide generation | Reuse guide provenance, busy, error and retry patterns. Identify provider, data transfer and cost implications when relevant; preserve an offline route. |
| Step outline / jump / peek | Use the choice-list language with current and unrevealed states. Keep explicit position and reversible reading behavior; do not add completion scoring. |
| Guide authoring | Reuse explanation typography, input validation and preview states. Separate editing guide text from viewing source changes. |
| Standalone web or marketing surface | Carry over typography hierarchy, restrained spacing, terminology and the progression motif. Define a separate tested color adapter; do not assume editor theme variables exist outside the host. |

These are compatibility constraints, not roadmap commitments. A future UI should not acquire a dashboard, chat panel, or account requirement merely because the component system can support one.

## 11. Adoption and review criteria

Adopt in three future implementation slices: first token consolidation and text hierarchy; then reusable components and focus/input preservation; then mode-specific consequences, exceptional states and new surfaces. Each slice must preserve behavior while clearly identifying intentional interaction changes. The mode selector wiring gap should be verified before relying on its visual redesign.

A later implementation is ready for review when:

- Light, dark, high-contrast dark and high-contrast light themes have been visually checked, including selected lists, errors, disabled hints, and diff highlights.
- Keyboard-only traversal completes target selection, range correction, start, reading, Edit here, and ending. Focus and entered text survive updates.
- Screen-reader checks cover field labels, endpoint selection, current step, final-step replacement and error announcements.
- Long titles, deep paths, multiline notes, missing optional guide fields, empty history, invalid refs, guide fallback, and the narrow/zoomed layouts remain usable.
- Read-only and rebase finish/exit copy matches the actual commands and their outcomes, including untracked selection, save failures, conflicts and externally changed Git state.
- No completion treatment implies code approval, and no unavailable feature is presented as a working recovery action.

Record any exceptions in the implementing change with the affected component, user impact, and reason. Keep this document as the single design-system reference rather than duplicating token tables across feature specs. No UI implementation or additional artifact is part of this document’s delivery.

## 12. Project references

- [Sidebar rendering and styles](../../src/ui/sidebar-html.ts): current visual values, markup, input and focus handling.
- [Sidebar content](../../src/model/sidebar.ts): setup, range choices, step explanations, actions and Git notices.
- [Sidebar host adapter](../../src/ui/sidebar.ts): webview lifecycle and supported command messages.
- [Native review documents](../../src/ui/documents.ts): progressive/dim reveal and editor decorations.
- [Status bar](../../src/ui/status-bar.ts) and [view projection](../../src/model/view.ts): progress and current-change navigation.
- [UI ports](../../src/ui/ports.ts) and [session lifecycle](../../src/model/session.ts): agent handoff, untracked picker and mode consequences.
- [Extension manifest](../../package.json): commands, shortcut scope, theme-hosted surfaces and settings.
- [Git-first sessions decision](../decisions/0005-git-first-sessions.md): current architectural direction; worktree remains future in the inspected UI.
- [Branding brief](../marketing/branding-brief.md) and [product specification](product.md): identity and product intent; historical workflow descriptions require reconciliation with current code.

No external design research or live-editor visual testing was performed for this proposal. Numerical values and interaction requirements above are design decisions to validate during implementation, not assertions of current compliance.
