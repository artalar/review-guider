import type { ReviewTarget } from '../git/types'
import { peek, wrap } from '@reatom/core'
import { useCommands } from 'reactive-vscode'
import { window } from 'vscode'
import { commands as Commands } from '../generated/meta'
import {
  cancelSession,
  canStart,
  cleanupBackups,
  discardRecovery,
  finishSession,
  recoverBackup,
  session,
  startBlockedReason,
  startSession,
} from '../model/session'
import { revealCurrentStep } from '../ui/documents'
import { pickCommitEntry, promptRangeEntry } from '../ui/entry'
import { logger } from '../utils'

/**
 * Handlers read with `peek` and write only by calling actions. There is no
 * branching logic here — every decision lives in the model, which is exactly
 * why the model is testable without an extension host.
 */
export function useGuideCommands(): void {
  useCommands({
    [Commands.guideReviewerStart]: wrap(() => guard('start', () => begin(async () => ({ kind: 'workingTree' })))),
    [Commands.guideReviewerStartFromCommit]: wrap(() => guard('startFromCommit', () => begin(pickCommitEntry))),
    [Commands.guideReviewerStartFromRange]: wrap(() => guard('startFromRange', () => begin(promptRangeEntry))),
    [Commands.guideReviewerNext]: wrap(() => guard('next', advance)),
    [Commands.guideReviewerPrevious]: wrap(() => guard('previous', retreat)),
    [Commands.guideReviewerShowStepDetail]: wrap(() => guard('showStepDetail', revealCurrentStep)),
    [Commands.guideReviewerFinish]: wrap(() => guard('finish', () => finishSession())),
    [Commands.guideReviewerCancel]: wrap(() => guard('cancel', () => cancelSession('cancel'))),
    [Commands.guideReviewerRestoreBackup]: wrap(() => guard('restoreBackup', () => recoverBackup())),
    // The only way out of a restore that can never be made to verify. It
    // forgets the reminder; the stash entry and the refs stay in git.
    [Commands.guideReviewerDiscardRecovery]: wrap(() => guard('discardRecovery', () => discardRecovery())),
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
 * Every entry point shares one shape: refuse with the model's own reason, ask
 * the user what to review, then hand the target over. The three differ only in
 * the question.
 */
async function begin(pick: () => Promise<ReviewTarget | null>): Promise<void> {
  if (!peek(canStart)) {
    await window.showWarningMessage(peek(startBlockedReason) ?? 'Guide Reviewer cannot start right now.')
    return
  }
  const entry = await wrap(pick())
  if (entry === null)
    return
  await wrap(startSession({ entry }))
}

/**
 * Tab past the last step is a no-op plus a subtle offer to finish — no score,
 * no timer, no gate (the PO's UX guardrail for this phase).
 */
async function advance(): Promise<void> {
  const model = peek(session)
  if (model === null || model.next())
    return

  const answer = await wrap(window.showInformationMessage('Review complete.', 'Finish Review'))
  if (answer === 'Finish Review')
    await wrap(finishSession())
}

async function retreat(): Promise<void> {
  peek(session)?.prev()
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
