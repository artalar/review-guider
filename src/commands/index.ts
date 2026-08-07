import { peek, wrap } from '@reatom/core'
import { useCommands } from 'reactive-vscode'
import { window } from 'vscode'
import { commands as Commands } from '../generated/meta'
import {
  cancelSession,
  canStart,
  cleanupBackups,
  finishSession,
  recoverBackup,
  startBlockedReason,
  startSession,
} from '../model/session'
import { logger } from '../utils'

/**
 * Handlers read with `peek` and write only by calling actions. There is no
 * branching logic here — every decision lives in the model, which is exactly
 * why the model is testable without an extension host.
 */
export function useGuideCommands(): void {
  useCommands({
    [Commands.guideReviewerStart]: wrap(() => guard('start', async () => {
      if (!peek(canStart)) {
        await window.showWarningMessage(peek(startBlockedReason) ?? 'Guide Reviewer cannot start right now.')
        return
      }
      await wrap(startSession({ entry: { kind: 'workingTree' } }))
    })),
    [Commands.guideReviewerFinish]: wrap(() => guard('finish', () => finishSession())),
    [Commands.guideReviewerCancel]: wrap(() => guard('cancel', () => cancelSession('cancel'))),
    [Commands.guideReviewerRestoreBackup]: wrap(() => guard('restoreBackup', () => recoverBackup())),
    [Commands.guideReviewerCleanupBackups]: wrap(() => guard('cleanupBackups', async () => {
      const removed = await wrap(cleanupBackups())
      await window.showInformationMessage(
        removed.length === 0
          ? 'No Guide Reviewer backups to clean up.'
          : `Removed ${removed.length} Guide Reviewer backup ref${removed.length === 1 ? '' : 's'}.`,
      )
    })),
  })
}

/**
 * The model already reports failures through the UI port; this only keeps a
 * rejected command from surfacing as an unhandled rejection.
 */
async function guard(name: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run()
  }
  catch (error) {
    logger.error(`guide-reviewer.${name} failed`, error)
  }
}
