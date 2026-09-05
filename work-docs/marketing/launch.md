# Tabthrough launch kit

Status: draft copy for the local release candidate; nothing has been posted.

## Positioning

**Name:** Tabthrough

**Tagline:** Understand code changes, one Tab at a time

**Description:** Turn local changes and commits into guided walkthroughs in VS Code and Cursor. Reveal code in explanation order, with the author's notes beside every step. Works offline, with no account or API key. Bring a .guide.json or start with automatic ordering.

**Audience:** Developers reviewing unfamiliar or agent-written changes; maintainers explaining a refactor; teams onboarding someone to a patch.

**Launch promise:** Understand the shape of a change before reading the entire diff. Avoid promises of bug detection, perfect automatic ordering, remote PR support or zero-risk workspace mutation.

## Maker comment draft

I built Tabthrough because file order rarely matches explanation order. A type may need to come before its caller; a fix may need context from another file.

Tabthrough turns local changes or commits into a walkthrough. Press Tab to reveal the next thought while its explanation stays in the sidebar. A small .guide.json lets the author or coding agent supply the intended reading order; without one, Tabthrough uses offline heuristics.

Start with read-only review. There is also an Apply with me mode for walking supported text changes into real files. The UI tells you what Finish and Cancel do before the session begins.

I'd love examples of changes where the default ordering feels wrong, and feedback on the first-run experience. Please include the editor version and a minimal reproducible patch when reporting a bug.

## Demo storyboard

Run `node scripts/create-demo.mjs` and open the printed temporary folder.

1. Show the three changed files. Explain that file order alone misses the shared contract.
2. Start Review Working Changes, select Read-only review and show the isolation confirmation.
3. Show the Order type with its sidebar note. Press Tab to pricing, then to checkout.
4. Press Shift+Tab to revisit the calculation and show the matching note.
5. Return to the final step; show that notes remain visible beside Finish.
6. Finish. Show the restored changes in Source Control.

Record with a clean profile, readable code and no unrelated chat panes. Suggested gallery frames: opening view; code plus current explanation; final notes plus explicit Finish behavior. Avoid confidential source code.

## Distribution handoff

Use the packaged VSIX after choosing the public version. Update installation text with a verified release download or Marketplace URL before posting. The current repository documents sideloading; do not present an unpublished listing as available.

For support, use the repository issue tracker. Ask for editor/OS versions, review mode, entry type, reproduction steps and sanitized extension logs. Do not ask users to upload private repositories or backup contents.
