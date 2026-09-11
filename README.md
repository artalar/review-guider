# Tabthrough

**Understand every change, one Tab at a time.**

Tabthrough turns local changes, a commit, or a commit range into an ordered walkthrough in VS Code and Cursor. Reveal the code one step at a time while the sidebar keeps the author's explanation in view. It works offline, without an account or API key.

The **Walkthrough sidebar** shows progress, the guide summary, each step's reason and full notes, and navigation and completion controls. Open it from the activity bar or **Tabthrough: Show Walkthrough**. The final step stays visible until you finish.

### Install and try

Build and sideload this release candidate:

```bash
pnpm install --frozen-lockfile
pnpm build
# Node 24 is required for the packaging toolchain.
# If you use mise: mise exec node@24 -- pnpm ext:package
pnpm ext:package
code --install-extension tabthrough-0.0.0.vsix
# Cursor users: pnpm ext:install
```

For a small, disposable example with authored notes:

```bash
node scripts/create-demo.mjs
```

Open the printed folder in your editor, run **Tabthrough: Review Working Changes**, generate or start the walkthrough, and press **Tab**. The demo walks from an order type to its calculation and caller. The script creates a new temporary repository each time; it does not change your project.

## Why ordinary diffs are hard

Git sorts by path. Explanation order is different: types before callers, schema before migration, the fix before the test that proves it. Skimming the file list is fast; finishing with a mental model is not. Tabthrough is a **guided diff reader** — it sequences the source so you form the explanation yourself. It does not find bugs, post review comments, or replace PR tools.

## Walk a change

1. Open the sidebar and choose working changes, a commit, or a commit range.
2. Generate a Simple or Agent guide, or start from a sidecar already on disk. Dirty file buffers are saved before a working-tree snapshot; a failed save stops the review. The sidebar shows **Will run: nothing** — read-only does not check out or stash.
3. Read each explanation and press **Tab** (or use the sidebar) to reveal the next step.

| Mode | What it does | Landed |
|------|----------------|--------|
| Read-only | Virtual documents. Working changes get a snapshot ref; commit and range touch nothing. **Edit here** opens the real file for a working-tree review. | Yes |
| Rebase | Interactive rebase stopped at the reviewed commit. **Edit here** opens the real file. Finish amends and `--continue`; Cancel is `--abort`. | Yes |
| Worktree | Detached worktree in a new window | Later |

Alt+] and Alt+[ always advance. Ordinary Tab still indents in real file editors. Turn off `tabthrough.keybinding.useTab` to use only the alternate shortcuts. **Alt+Enter** is Edit here while a review document is focused.

Tabthrough never creates a commit for you.

## What you can review

| Command | Target |
|---------|--------|
| **Tabthrough: Review Working Changes** | Staged + unstaged + untracked (ignored files stay ignored) |
| **Tabthrough: Review a Commit…** | One commit vs its parent (pick from recent history or type a ref) |
| **Tabthrough: Review a Commit Range…** | `main..HEAD` style ranges, resolved through the merge base |

Native one-click GitHub/GitLab PR entry is planned; today you review the local commits that make up the change.

## Plain git underneath

Every action is a git command you could type. Read-only review does not move HEAD, stash, or lock the repository:

- Working changes: temp-index snapshot (`read-tree` / `add -A` / `write-tree` / `commit-tree`) at `refs/tabthrough/after/<id>`. Finish and Cancel delete that ref. Activation sweeps refs older than 24 hours.
- Commit and range: no write. The diff is `base..after` from objects already in the repository.
- Two windows can review the same repository at once.
- A rebase, merge, or leftover autostash started in a terminal shows in the sidebar with **Continue**, **Abort**, **Pop**, and the other named git buttons. Their stdout and stderr go to the Tabthrough output channel.

Rebase mode runs `git rebase -i --autostash` stopped at the reviewed commit. Finish is `add -u`, optional `add` of ticked untracked files, `commit --amend --no-edit`, then `rebase --continue`. Cancel is `git rebase --abort`. Worktree mode lands later. Details: [`work-docs/architecture/overview.md`](work-docs/architecture/overview.md).

## Bring the author’s intent with `.guide.json`

If a repository (or the agent that wrote the change) ships a `.guide.json`, its order and reasons replace the offline heuristic. Minimal example:

```json
{
  "$schema": "https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json",
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

| Key                              | Description                                                                                                                  | Type      | Default                    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------- |
| `tabthrough.showRationale`       | Show the one-line reason each step was ordered where it is (for example "types before callers") in the status bar.           | `boolean` | `true`                     |
| `tabthrough.reveal.mode`         | How the reviewed change is revealed as you advance through steps.                                                            | `string`  | `"progressive"`            |
| `tabthrough.session.mode`        | Which git primitive a session uses. Read-only and rebase are landed; worktree comes later.                                   | `string`  | `"ask"`                    |
| `tabthrough.finish.hooks`        | Run git hooks (pre-rebase, pre-commit, commit-msg) when starting and finishing a rebase review. Off by default.              | `boolean` | `false`                    |
| `tabthrough.finish.sign`         | GPG-sign the amended commit and replayed commits. Off by default; replayed commits stay unsigned unless this is on.          | `boolean` | `false`                    |
| `tabthrough.guideFile`           | Repository-relative path of the optional guide sidecar that overrides the heuristic step order.                              | `string`  | `".tabthrough-guide.json"` |
| `tabthrough.keybinding.useTab`   | Bind Tab to the next review step while a review document is focused. Alt+] and Alt+[ always work regardless of this setting. | `boolean` | `true`                     |
| `tabthrough.maxLinesPerStep`     | Upper bound on how many low-significance changed lines are coalesced into a single step.                                     | `number`  | `24`                       |
| `tabthrough.hideFormattingSteps` | Drop steps whose changes are whitespace or comments only.                                                                    | `boolean` | `false`                    |
| `tabthrough.worktree.dir`        | Root directory for Tabthrough worktrees. Empty uses the OS temp directory under tabthrough/.                                 | `string`  | `""`                       |

<!-- configs -->

## Commands

<!-- commands -->

| Command                      | Title                                    |
| ---------------------------- | ---------------------------------------- |
| `tabthrough.review`          | Tabthrough: Review…                      |
| `tabthrough.start`           | Tabthrough: Review Working Changes       |
| `tabthrough.startFromCommit` | Tabthrough: Review a Commit...           |
| `tabthrough.startFromRange`  | Tabthrough: Review a Commit Range...     |
| `tabthrough.startFromGuide`  | Tabthrough: Start Review from This Guide |
| `tabthrough.installSkill`    | Tabthrough: Install /tabthrough Skill    |
| `tabthrough.pickWorkingTree` | Tabthrough: Pick Working Changes         |
| `tabthrough.pickCommit`      | Tabthrough: Pick a Commit                |
| `tabthrough.pickRange`       | Tabthrough: Pick a Commit Range          |
| `tabthrough.selectCommit`    | Tabthrough: Select Commit                |
| `tabthrough.submitRange`     | Tabthrough: Use Commit Range             |
| `tabthrough.generateSimple`  | Tabthrough: Generate Simple Guide        |
| `tabthrough.generateAgent`   | Tabthrough: Generate Agent Guide         |
| `tabthrough.setupBack`       | Tabthrough: Back                         |
| `tabthrough.chooseMode`      | Tabthrough: Choose Session Mode          |
| `tabthrough.next`            | Tabthrough: Reveal Next Change           |
| `tabthrough.previous`        | Tabthrough: Go Back One Change           |
| `tabthrough.showStepDetail`  | Tabthrough: Go to Current Step           |
| `tabthrough.showWalkthrough` | Tabthrough: Show Walkthrough             |
| `tabthrough.finish`          | Tabthrough: Finish Review                |
| `tabthrough.cancel`          | Tabthrough: Cancel Review                |
| `tabthrough.commitHandoff`   | Tabthrough: Open Source Control          |
| `tabthrough.editHere`        | Tabthrough: Edit Here                    |
| `tabthrough.continueRebase`  | Tabthrough: Continue Rebase              |
| `tabthrough.abortRebase`     | Tabthrough: Abort Rebase                 |
| `tabthrough.popAutostash`    | Tabthrough: Pop Autostash                |
| `tabthrough.showAutostash`   | Tabthrough: Show Autostash               |
| `tabthrough.openWorktree`    | Tabthrough: Open Worktree                |
| `tabthrough.removeWorktree`  | Tabthrough: Remove Worktree              |
| `tabthrough.pruneWorktrees`  | Tabthrough: Prune Worktrees              |
| `tabthrough.openConflict`    | Tabthrough: Open Conflicted File         |

<!-- commands -->

## Known limitations

| Limitation | Behaviour today |
|------------|-----------------|
| **Multi-root workspaces** | First folder’s repository only |
| **Rebase / merge / cherry-pick in progress** | Start still works; the sidebar shows git's state and the native buttons |
| **Shallow clones missing parents** | Refused with a fetch hint |
| **One-click remote PR URLs** | Planned — use commit/range locally for now |
| **LLM-generated guides** | Planned (BYOK); default path is offline |
| **Binary / rename / mode / symlink / generated changes** | Explanation stub steps; Edit here is for text files |
| **Whitespace-only diffs** | Start refused |
| **Rebase and worktree modes** | Settings exist; Start still lands on read-only until those phases ship |

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test:ci
```

The git, guide, and model layers never import `vscode`, so safety and ordering suites run under plain vitest. Design docs live under [`work-docs/`](work-docs/). Built on [Reatom](https://v1001.reatom.dev) and [reactive-vscode](https://kermanx.github.io/reactive-vscode/).

## License

[MIT](./LICENSE.md) License © 2026 [artalar](https://github.com/artalar)
