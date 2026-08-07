# ext-name

<a href="https://marketplace.visualstudio.com/items?itemName=antfu.ext-name" target="__blank"><img src="https://badgen.net/vs-marketplace/v/antfu.ext-name?color=333&label=VS%20Code%20Marketplace" alt="Visual Studio Marketplace Version" /></a>
<a href="https://kermanx.github.io/reactive-vscode/" target="__blank"><img src="https://img.shields.io/badge/made_with-reactive--vscode-%23007ACC?style=flat&labelColor=%23229863"  alt="Made with reactive-vscode" /></a>

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
| `guide-reviewer.cleanupBackups`  | Guide Reviewer: Clean Up Backups                  |

<!-- commands -->

## Sponsors

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/antfu/static/sponsors.svg">
    <img src='https://cdn.jsdelivr.net/gh/antfu/static/sponsors.png'/>
  </a>
</p>

## License

[MIT](./LICENSE.md) License © 2022 [Anthony Fu](https://github.com/antfu)
