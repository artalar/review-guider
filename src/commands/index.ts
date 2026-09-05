import type { ReviewTarget } from '../git/types'
import { isAbort, peek, wrap } from '@reatom/core'
import { useCommands } from 'reactive-vscode'
import { Uri, commands as VscodeCommands, window } from 'vscode'
import { commands as Commands } from '../generated/meta'
import {
  cancelSession,
  canStart,
  cleanupBackups,
  commitHandoff,
  discardRecovery,
  finishSession,
  recoverBackup,
  session,
  startBlockedReason,
  startSession,
} from '../model/session'
import { beginFromActiveGuide } from '../ui/active-guide'
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
    [Commands.start]: wrap(() => guard('start', () => begin(async () => ({ kind: 'workingTree' })))),
    [Commands.startFromCommit]: wrap(() => guard('startFromCommit', () => begin(pickCommitEntry))),
    [Commands.startFromRange]: wrap(() => guard('startFromRange', () => begin(promptRangeEntry))),
    [Commands.startFromGuide]: wrap((resource?: unknown) => guard(
      'startFromGuide',
      () => beginFromActiveGuide(resource instanceof Uri ? resource : undefined),
    )),
    [Commands.next]: wrap(() => guard('next', advance)),
    [Commands.previous]: wrap(() => guard('previous', retreat)),
    [Commands.showStepDetail]: wrap(() => guard('showStepDetail', revealCurrentStep)),
    [Commands.showWalkthrough]: wrap(() => guard('showWalkthrough', async () => {
      await wrap(VscodeCommands.executeCommand('workbench.view.extension.tabthrough', { preserveFocus: true }))
    })),
    [Commands.finish]: wrap(() => guard('finish', () => finishSession())),
    [Commands.cancel]: wrap(() => guard('cancel', () => cancelSession('cancel'))),
    [Commands.commitHandoff]: wrap(() => guard('commitHandoff', () => commitHandoff())),
    [Commands.restoreBackup]: wrap(() => guard('restoreBackup', () => recoverBackup())),
    // The only way out of a restore that can never be made to verify. It
    // forgets the reminder; the stash entry and the refs stay in git.
    [Commands.discardRecovery]: wrap(() => guard('discardRecovery', () => discardRecovery())),
    [Commands.cleanupBackups]: wrap(() => guard('cleanupBackups', async () => {
      const removed = await wrap(cleanupBackups())
      await window.showInformationMessage(
        removed.length === 0
          ? 'No Tabthrough backups to clean up.'
          : `Removed ${removed.length} Tabthrough backup ref${removed.length === 1 ? '' : 's'}.`,
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
    await window.showWarningMessage(peek(startBlockedReason) ?? 'Tabthrough cannot start right now.')
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
 *
 * `next()` returns false for conflict / refuse / save failure as well as
 * completion. Only offer Finish when the cursor cannot advance (review 003 B1).
 */
async function advance(): Promise<void> {
  const model = peek(session)
  if (model === null)
    return
  if (model.applyPending())
    return

  const moved = await wrap(Promise.resolve(model.next()))
  if (moved)
    return
  if (model.canAdvance())
    return

  if (model.mode === 'apply') {
    const answer = await wrap(window.showInformationMessage(
      'Apply complete. Finish keeps your changes so you can commit.',
      'Finish and Keep',
    ))
    if (answer === 'Finish and Keep')
      await wrap(finishSession())
    return
  }

  const answer = await wrap(window.showInformationMessage('Review complete.', 'Finish Review'))
  if (answer === 'Finish Review')
    await wrap(finishSession())
}

async function retreat(): Promise<void> {
  const model = peek(session)
  if (model === null || model.applyPending())
    return
  await wrap(Promise.resolve(model.prev()))
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
    if (isAbort(error))
      return
    logger.error(`tabthrough.${name} failed`, error)
    if (!name.startsWith('start'))
      await window.showErrorMessage(`Tabthrough could not ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
