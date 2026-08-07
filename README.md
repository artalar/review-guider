# Tabthrough

<a href="https://marketplace.visualstudio.com/items?itemName=artalar.tabthrough" target="__blank"><img src="https://badgen.net/vs-marketplace/v/artalar.tabthrough?color=333&label=VS%20Code%20Marketplace" alt="Visual Studio Marketplace Version" /></a>
<a href="https://kermanx.github.io/reactive-vscode/" target="__blank"><img src="https://img.shields.io/badge/made_with-reactive--vscode-%23007ACC?style=flat&labelColor=%23229863"  alt="Made with reactive-vscode" /></a>

**Understand every change, one Tab at a time.**

Large diffs arrive as a list of files. Tabthrough turns your working changes, a commit, or a commit range into an ordered walkthrough: foundations before callers, schemas before migrations, implementation before proof. Press **Tab** to reveal one thought at a time in VS Code, at your pace. It works offline and restores your workspace when you are done.

**Install from the VS Code Marketplace → run “Tabthrough: Review Working Changes” → press Tab.**

## Why ordinary diffs are hard

Git sorts by path. Explanation order is different: types before callers, schema before migration, the fix before the test that proves it. Skimming the file list is fast; finishing with a mental model is not. Tabthrough is a **guided diff reader** — it sequences the source so you form the explanation yourself. It does not find bugs, post review comments, or replace PR tools.

## Try it in three steps

1. **Command Palette** → **Tabthrough: Review Working Changes** (or Review a Commit… / Review a Commit Range…).
2. **Approve the pre-flight.** Your current work is captured and isolated for the session; nothing is mutated until you confirm.
3. **Press Tab.** Each press reveals the next piece of the change. Shift+Tab goes back. Finish or Cancel restores the workspace.

| Key | Action |
|-----|--------|
| <kbd>Tab</kbd> | Reveal next change |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> | Go back one change |
| <kbd>Alt</kbd>+<kbd>]</kbd> / <kbd>Alt</kbd>+<kbd>[</kbd> | Next / previous from anywhere |

Tab is only bound inside the read-only review document (`tabthrough:` scheme), so it never competes with indent, snippets, or IntelliSense in your real files. Turn it off with `tabthrough.keybinding.useTab` if you prefer the alternate chord alone.

## What you can review

| Command | Target |
|---------|--------|
| **Tabthrough: Review Working Changes** | Staged + unstaged (+ optional untracked) |
| **Tabthrough: Review a Commit…** | One commit vs its parent (pick from recent history or type a ref) |
| **Tabthrough: Review a Commit Range…** | `main..HEAD` style ranges, resolved through the merge base |

Native one-click GitHub/GitLab PR entry is planned; today you review the local commits that make up the change.

## Designed to restore your workspace exactly

Reviewing uncommitted work means hiding it for a while. Tabthrough is built around that being safe and reversible:

- Capture tracked and untracked state into an immutable ref **before** the first mutation
- Journal every stage before it runs, so a crash is a lookup rather than a guess
- Restore with apply → verify → drop; backup refs survive until verification succeeds
- One session per repository; a live session in another window will not be “restored” over

Finish and Cancel both restore. If VS Code exits mid-session, the next window offers recovery before other git work. Details: [`work-docs/architecture/overview.md`](work-docs/architecture/overview.md).

## Bring the author’s intent with `.guide.json`

If a repository (or the agent that wrote the change) ships a `.guide.json`, its order and reasons replace the offline heuristic. Minimal example:

```json
{
  "$schema": "https://tabthrough.dev/schema/guide-v1.json",
  "version": 1,
  "steps": [
    { "id": "types", "path": "src/types.ts", "rationale": "Types before callers" },
    { "id": "service", "path": "src/service.ts", "rationale": "The first consumer of those types" }
  ]
}
```

Malformed guides never block a review: every failure falls back to the heuristic with one warning. Schema: [`schema/guide-v1.json`](schema/guide-v1.json). Authoring: [`work-docs/guides/agent-guide-authoring.md`](work-docs/guides/agent-guide-authoring.md). Agent skill: [`.agents/skills/tabthrough/SKILL.md`](.agents/skills/tabthrough/SKILL.md).

## Configurations

<!-- configs -->

| Key | Description | Type | Default |
| --- | --- | --- | --- |
| `tabthrough.showRationale` | Show the one-line reason each step was ordered where it is | `boolean` | `true` |
| `tabthrough.reveal.mode` | How the change is revealed (`progressive` hides unread lines; `dim` greys them) | `string` | `"progressive"` |
| `tabthrough.guideFile` | Path of the optional `.guide.json` sidecar | `string` | `".guide.json"` |
| `tabthrough.keybinding.useTab` | Bind Tab inside the review document | `boolean` | `true` |
| `tabthrough.maxLinesPerStep` | Cap on low-significance lines per step | `number` | `24` |
| `tabthrough.hideFormattingSteps` | Drop whitespace/comment-only steps | `boolean` | `false` |
| `tabthrough.stash.includeUntracked` | Include untracked files when isolating (ignored files never) | `boolean` | `true` |

<!-- configs -->

## Commands

<!-- commands -->

| Command | Title |
| --- | --- |
| `tabthrough.start` | Tabthrough: Review Working Changes |
| `tabthrough.startFromCommit` | Tabthrough: Review a Commit... |
| `tabthrough.startFromRange` | Tabthrough: Review a Commit Range... |
| `tabthrough.next` | Tabthrough: Reveal Next Change |
| `tabthrough.previous` | Tabthrough: Go Back One Change |
| `tabthrough.showStepDetail` | Tabthrough: Go to Current Step |
| `tabthrough.finish` | Tabthrough: Finish and Restore Workspace |
| `tabthrough.cancel` | Tabthrough: Cancel and Restore Workspace |
| `tabthrough.restoreBackup` | Tabthrough: Restore from Backup |
| `tabthrough.discardRecovery` | Tabthrough: Dismiss Pending Restore... |
| `tabthrough.cleanupBackups` | Tabthrough: Clean Up Backups |

<!-- commands -->

## Known limitations

| Limitation | Behaviour today |
|------------|-----------------|
| **Multi-root workspaces** | First folder’s repository only |
| **Rebase / merge / cherry-pick in progress** | Start refused |
| **Shallow clones missing parents** | Refused with a fetch hint |
| **One-click remote PR URLs** | Planned — use commit/range locally for now |
| **LLM-generated guides** | Planned (BYOK); default path is offline |
| **Binary / mode-only changes** | Visible skipped steps so the count stays honest |
| **Whitespace-only diffs** | Start refused |

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test:ci
```

The git, guide, and model layers never import `vscode`, so safety and ordering suites run under plain vitest. Design docs live under [`work-docs/`](work-docs/). Built on [Reatom](https://v1001.reatom.dev) and [reactive-vscode](https://kermanx.github.io/reactive-vscode/).

## License

[MIT](./LICENSE.md) License © 2026 [artalar](https://github.com/artalar)
