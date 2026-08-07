# Guide Reviewer

<a href="https://marketplace.visualstudio.com/items?itemName=artalar.guide-reviewer" target="__blank"><img src="https://badgen.net/vs-marketplace/v/artalar.guide-reviewer?color=333&label=VS%20Code%20Marketplace" alt="Visual Studio Marketplace Version" /></a>
<a href="https://kermanx.github.io/reactive-vscode/" target="__blank"><img src="https://img.shields.io/badge/made_with-reactive--vscode-%23007ACC?style=flat&labelColor=%23229863"  alt="Made with reactive-vscode" /></a>

**Read a diff the way it was written, not the way git sorted it.**

A large change arrives as an alphabetical list of files. Guide Reviewer turns it into an ordered walk: the type before its callers, the schema before the migration, the fix before the test that proves it. You press <kbd>Tab</kbd>, the next piece of the change appears, and the status bar tells you why it comes next.

It works offline, with no API key and no account. The order comes from a heuristic that reads the diff; if the change ships a `.guide.json` sidecar, the author's order wins instead.

## How it works

1. **Pick what to review** — your working tree, one commit, or a commit range.
2. **Guide Reviewer isolates the workspace.** Before anything is touched, your tracked *and* untracked state is captured into an immutable commit, and only then is the tree made clean. Nothing is reviewed against a target that can drift underneath you.
3. **Press <kbd>Tab</kbd>.** Each press reveals the next step in a read-only diff editor. Everything you have already seen stays visible; nothing you have not reached yet is in the document at all.
4. **<kbd>Shift</kbd>+<kbd>Tab</kbd> goes back.** The revealed set is a pure function of your position, so retreating is exact rather than an undo.
5. **Finish or Cancel.** Both restore your working tree — staged and unstaged, tracked and untracked — to exactly what it was.

## Getting started

Open the Command Palette and run one of:

| Command | What it reviews |
|---------|-----------------|
| **Guide Reviewer: Start Review (Working Tree)** | Everything uncommitted, staged and unstaged together |
| **Guide Reviewer: Start Review from Commit…** | One commit against its parent. Pick from recent history or type any ref |
| **Guide Reviewer: Start Review from Commit Range…** | `main..HEAD` — the branch's own commits, resolved through the merge base |

You will see a pre-flight summary of what is about to be stashed before anything happens. Nothing is mutated until you approve it.

### Keys

| Key | Action |
|-----|--------|
| <kbd>Tab</kbd> | Next step |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Previous step |
| <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> | Next / previous, from anywhere |

<kbd>Tab</kbd> is only bound inside the review document, which is read-only and on its own URI scheme, so it never competes with indentation, snippets, IntelliSense, or inline suggestions in your real files. The alternate chord works regardless of focus, and `guideReviewer.keybinding.useTab` turns the <kbd>Tab</kbd> binding off entirely if you would rather it stayed out of the way.

Click the status bar item (`$(book) Step 4/17 · service.ts · types before callers`) to jump back to the current step at any time.

## Your work is never at risk

This is the part of the extension with the most tests behind it, because reviewing your own uncommitted work means hiding it for the duration.

- **Capture before mutate.** A temp-index snapshot commits your tracked and untracked state to an unreachable ref *before* the first mutation. That commit, not the stash, is the guarantee.
- **Journal before act.** Every stage is written down before it is attempted, so an interrupted session is a lookup rather than a guess.
- **Restore is apply → verify → drop.** The backup ref survives until the restored tree has been verified byte for byte.
- **One session per repository**, enforced by a compare-and-swap on a git ref, so a second window cannot start a review over the top of yours.
- **Crash recovery.** If VS Code exits mid-session, the next window offers to restore before touching git. **Guide Reviewer: Restore from Backup** does it on demand; **Clean Up Backups** removes refs once you are done with them.

Ignored files are never stashed, and `guideReviewer.stash.includeUntracked` controls whether untracked ones are.

## Guiding a change with `.guide.json`

If a repository (or the agent that wrote the change) ships a `.guide.json`, its order and its reasons replace the heuristic's. The minimal useful document is two file claims:

```json
{
  "version": 1,
  "steps": [
    { "id": "types", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "service", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

Steps can anchor to line ranges, declare dependencies, split a large region across several presses, and mark lockfile churn as `skip` so it stops costing attention without disappearing. A malformed guide can never block a review or hide a line: every failure degrades to the heuristic with one warning.

The JSON Schema is [`schema/guide-v1.json`](schema/guide-v1.json) — point `$schema` at it for editor completion — and the full contract, including the merge rules, is in [`work-docs/architecture/guide-schema.md`](work-docs/architecture/guide-schema.md). If you are writing one — or pointing a coding agent at it — [`work-docs/guides/agent-guide-authoring.md`](work-docs/guides/agent-guide-authoring.md) covers how to order a change well, and [`.agents/skills/guide-reviewer/SKILL.md`](.agents/skills/guide-reviewer/SKILL.md) is the installable short form.

## Configurations

<!-- configs -->

| Key                                    | Description                                                                                                                  | Type      | Default         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | --------------- |
| `guideReviewer.showRationale`          | Show the one-line reason each step was ordered where it is (for example "types before callers") in the status bar.           | `boolean` | `true`          |
| `guideReviewer.reveal.mode`            | How the reviewed change is revealed as you advance through steps.                                                            | `string`  | `"progressive"` |
| `guideReviewer.guideFile`              | Repository-relative path of the optional guide sidecar that overrides the heuristic step order.                              | `string`  | `".guide.json"` |
| `guideReviewer.keybinding.useTab`      | Bind Tab to the next review step while a review document is focused. Alt+] and Alt+[ always work regardless of this setting. | `boolean` | `true`          |
| `guideReviewer.maxLinesPerStep`        | Upper bound on how many low-significance changed lines are coalesced into a single step.                                     | `number`  | `24`            |
| `guideReviewer.hideFormattingSteps`    | Drop steps whose changes are whitespace or comments only.                                                                    | `boolean` | `false`         |
| `guideReviewer.stash.includeUntracked` | Include untracked files when isolating the workspace. Ignored files are never included.                                      | `boolean` | `true`          |

<!-- configs -->

`guideReviewer.reveal.mode` is worth knowing about: `progressive` (default) leaves unrevealed lines out of the document entirely, so they cannot be read ahead. `dim` renders the whole change and greys out what you have not reached — easier to orient in, easier to spoil.

## Commands

<!-- commands -->

| Command                          | Title                                             |
| -------------------------------- | ------------------------------------------------- |
| `guide-reviewer.start`           | Guide Reviewer: Start Review (Working Tree)       |
| `guide-reviewer.startFromCommit` | Guide Reviewer: Start Review from Commit...       |
| `guide-reviewer.startFromRange`  | Guide Reviewer: Start Review from Commit Range... |
| `guide-reviewer.next`            | Guide Reviewer: Next Step                         |
| `guide-reviewer.previous`        | Guide Reviewer: Previous Step                     |
| `guide-reviewer.showStepDetail`  | Guide Reviewer: Go to Current Step                |
| `guide-reviewer.finish`          | Guide Reviewer: Finish Review                     |
| `guide-reviewer.cancel`          | Guide Reviewer: Cancel Review                     |
| `guide-reviewer.restoreBackup`   | Guide Reviewer: Restore from Backup               |
| `guide-reviewer.discardRecovery` | Guide Reviewer: Forget Pending Restore            |
| `guide-reviewer.cleanupBackups`  | Guide Reviewer: Clean Up Backups                  |

<!-- commands -->

## Known limitations

Deliberate scope decisions, not bugs. Each is documented rather than silently degraded.

| Limitation | Behaviour today |
|------------|-----------------|
| **Multi-root workspaces** | Best effort on the first folder's repository only |
| **Rebase, merge, or cherry-pick in progress** | Start is refused with an explanation, rather than reviewing an ambiguous HEAD |
| **Shallow clones with missing objects** | Detected early; you are told to fetch instead of getting a partial diff |
| **Git LFS and external diff drivers** | Passed through to git, so an LFS pointer change may present as a binary step |
| **Remote-only commits** | Must be fetched first; a ref that does not resolve locally is rejected |
| **Non-UTF-8 encodings** | Best effort — text is decoded as UTF-8 and may render imperfectly |
| **Custom diff tools** | Out of scope; the review always uses the built-in diff editor |
| **Binary and mode-only changes** | Shown as a visible skipped step so the step count stays honest, with no content to reveal |
| **Whitespace-only changes** | Start is refused — `git diff -w` returning nothing means there is nothing to teach |
| **Editing during a review** | Your files are stashed for the duration, so edits made mid-session are outside the safety guarantee. Finish or Cancel first |

Rename-aware steps, a compact mode for very large diffs, drift detection, PR entry through `gh`, and an opt-in LLM guide generator are planned follow-ups.

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test:ci
```

The git, guide, and model layers never import `vscode`, which is what lets the safety and ordering suites run under plain vitest with no extension host — and it is asserted by a test rather than left to convention. Design docs, decisions, and the phase plan live under [`work-docs/`](work-docs/).

## License

[MIT](./LICENSE.md) License © 2022 [Anthony Fu](https://github.com/antfu)
