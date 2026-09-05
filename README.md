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

Open the printed folder in your editor, run **Tabthrough: Review Working Changes**, choose **Read-only review**, approve isolation, and press **Tab**. The demo walks from an order type to its calculation and caller. The script creates a new temporary repository each time; it does not change your project.

## Why ordinary diffs are hard

Git sorts by path. Explanation order is different: types before callers, schema before migration, the fix before the test that proves it. Skimming the file list is fast; finishing with a mental model is not. Tabthrough is a **guided diff reader** — it sequences the source so you form the explanation yourself. It does not find bugs, post review comments, or replace PR tools.

## Review or apply

1. Open the sidebar and choose working changes, a commit, or a commit range.
2. Choose **Read-only review** or **Apply with me**. Dirty file buffers in the repository are saved before planning; a failed save stops the review. Review the isolation confirmation before Git changes the workspace.
3. Read each explanation in the sidebar and move through the change.

| Mode | Navigation | Finish | Cancel |
|------|------------|--------|--------|
| Read-only | Tab / Shift+Tab in the review editor; sidebar buttons | Restores the pre-session workspace | Restores the pre-session workspace |
| Apply with me | Alt+] / Alt+[; sidebar buttons | Keeps the walked changes and offers Source Control | Asks before discarding walkthrough edits and restoring the pre-session workspace |

Alt+] and Alt+[ work in either mode. Ordinary Tab still indents in real file editors. Turn off `tabthrough.keybinding.useTab` to use only the alternate shortcuts in read-only reviews.

Apply mode lets you edit real files as you walk. Conflicting edits stop the next step and show a message; resolve them and use **Next step** again. Tabthrough never creates a commit for you. Finishing early keeps a partial walk, so check Source Control before committing.

## What you can review

| Command | Target |
|---------|--------|
| **Tabthrough: Review Working Changes** | Staged + unstaged (+ optional untracked) |
| **Tabthrough: Review a Commit…** | One commit vs its parent (pick from recent history or type a ref) |
| **Tabthrough: Review a Commit Range…** | `main..HEAD` style ranges, resolved through the merge base |

Native one-click GitHub/GitLab PR entry is planned; today you review the local commits that make up the change.

## Designed to restore your workspace exactly

Review isolation temporarily stashes saved working changes. Tabthrough is built around that being safe and reversible:

- Capture tracked and untracked state into an immutable ref **before** the first mutation
- Journal every stage before it runs, so a crash is a lookup rather than a guess
- Restore with apply → verify → drop; backup refs survive until verification succeeds
- One session per repository; a live session in another window will not be “restored” over

In read-only mode, Finish and Cancel restore. In apply mode, Finish keeps the walked tree and retains backups; Cancel restores after confirmation. If the editor exits mid-session, the next window offers recovery before another review. Details: [`work-docs/architecture/overview.md`](work-docs/architecture/overview.md).

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

| Key                                 | Description                                                                                                                  | Type      | Default                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------- |
| `tabthrough.showRationale`          | Show the one-line reason each step was ordered where it is (for example "types before callers") in the status bar.           | `boolean` | `true`                     |
| `tabthrough.reveal.mode`            | How the reviewed change is revealed as you advance through steps. Ignored in apply mode.                                     | `string`  | `"progressive"`            |
| `tabthrough.session.mode`           | Session contract: read-only review, apply-with-user, or ask each time.                                                       | `string`  | `"ask"`                    |
| `tabthrough.guideFile`              | Repository-relative path of the optional guide sidecar that overrides the heuristic step order.                              | `string`  | `".tabthrough-guide.json"` |
| `tabthrough.keybinding.useTab`      | Bind Tab to the next review step while a review document is focused. Alt+] and Alt+[ always work regardless of this setting. | `boolean` | `true`                     |
| `tabthrough.maxLinesPerStep`        | Upper bound on how many low-significance changed lines are coalesced into a single step.                                     | `number`  | `24`                       |
| `tabthrough.hideFormattingSteps`    | Drop steps whose changes are whitespace or comments only.                                                                    | `boolean` | `false`                    |
| `tabthrough.stash.includeUntracked` | Include untracked files when isolating the workspace. Ignored files are never included.                                      | `boolean` | `true`                     |

<!-- configs -->

## Commands

<!-- commands -->

| Command                      | Title                                     |
| ---------------------------- | ----------------------------------------- |
| `tabthrough.review`          | Tabthrough: Review…                       |
| `tabthrough.start`           | Tabthrough: Review Working Changes        |
| `tabthrough.startFromCommit` | Tabthrough: Review a Commit...            |
| `tabthrough.startFromRange`  | Tabthrough: Review a Commit Range...      |
| `tabthrough.startFromGuide`  | Tabthrough: Start Review from This Guide  |
| `tabthrough.installSkill`    | Tabthrough: Install /tabthrough Skill     |
| `tabthrough.pickWorkingTree` | Tabthrough: Pick Working Changes          |
| `tabthrough.pickCommit`      | Tabthrough: Pick a Commit                 |
| `tabthrough.pickRange`       | Tabthrough: Pick a Commit Range           |
| `tabthrough.selectCommit`    | Tabthrough: Select Commit                 |
| `tabthrough.submitRange`     | Tabthrough: Use Commit Range              |
| `tabthrough.generateSimple`  | Tabthrough: Generate Simple Guide         |
| `tabthrough.generateAgent`   | Tabthrough: Generate Agent Guide          |
| `tabthrough.setupBack`       | Tabthrough: Back                          |
| `tabthrough.next`            | Tabthrough: Reveal Next Change            |
| `tabthrough.previous`        | Tabthrough: Go Back One Change            |
| `tabthrough.showStepDetail`  | Tabthrough: Go to Current Step            |
| `tabthrough.showWalkthrough` | Tabthrough: Show Walkthrough              |
| `tabthrough.finish`          | Tabthrough: Finish Review                 |
| `tabthrough.cancel`          | Tabthrough: Cancel and Restore Workspace  |
| `tabthrough.commitHandoff`   | Tabthrough: Open Source Control to Commit |
| `tabthrough.restoreBackup`   | Tabthrough: Restore from Backup           |
| `tabthrough.discardRecovery` | Tabthrough: Dismiss Pending Restore...    |
| `tabthrough.clearStaleLock`  | Tabthrough: Clear Leftover Lock           |
| `tabthrough.cleanupBackups`  | Tabthrough: Clean Up Backups              |

<!-- commands -->

## Known limitations

| Limitation | Behaviour today |
|------------|-----------------|
| **Multi-root workspaces** | First folder’s repository only |
| **Rebase / merge / cherry-pick in progress** | Start refused |
| **Shallow clones missing parents** | Refused with a fetch hint |
| **One-click remote PR URLs** | Planned — use commit/range locally for now |
| **LLM-generated guides** | Planned (BYOK); default path is offline |
| **Binary / rename / mode / symlink / generated changes** | Read-only review supports explanation steps; apply refuses targets it cannot reproduce safely |
| **Whitespace-only diffs** | Start refused |
| **Apply ranges** | Use read-only review; apply supports working changes and single commits |

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test:ci
```

The git, guide, and model layers never import `vscode`, so safety and ordering suites run under plain vitest. Design docs live under [`work-docs/`](work-docs/). Built on [Reatom](https://v1001.reatom.dev) and [reactive-vscode](https://kermanx.github.io/reactive-vscode/).

## License

[MIT](./LICENSE.md) License © 2026 [artalar](https://github.com/artalar)
