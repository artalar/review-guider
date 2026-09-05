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
  ports,
  recoverBackup,
  session,
  startBlockedReason,
} from '../model/session'
import {
  generateAgentGuide,
  generateSimpleGuide,
  installWorkspaceSkill,
  loadCommits,
  openTargetPicker,
  pickRange,
  pickWorkingTree,
  resetSetup,
  selectCommit,
  setupBack,
  skillInstalled,
  submitRange,
} from '../model/setup'
import { beginFromActiveGuide } from '../ui/active-guide'
import { revealCurrentStep } from '../ui/documents'
import { logger } from '../utils'

/**
 * Handlers read with `peek` and write only by calling actions. There is no
 * branching logic here — every decision lives in the model, which is exactly
 * why the model is testable without an extension host.
 */
export function useGuideCommands(): void {
  useCommands({
    [Commands.review]: wrap(() => guard('review', async () => {
      await wrap(VscodeCommands.executeCommand('tabthrough.sidebar.focus'))
      openTargetPicker()
    })),
    [Commands.start]: wrap(() => guard('start', () => beginWorkingTree())),
    [Commands.startFromCommit]: wrap(() => guard('startFromCommit', () => beginCommitPicker())),
    [Commands.startFromRange]: wrap(() => guard('startFromRange', () => beginRangePicker())),
    [Commands.startFromGuide]: wrap((resource?: unknown) => guard(
      'startFromGuide',
      () => beginFromActiveGuide(resource instanceof Uri ? resource : undefined),
    )),
    [Commands.installSkill]: wrap(() => guard('installSkill', () => installWorkspaceSkill())),
    [Commands.pickWorkingTree]: wrap(() => guard('pickWorkingTree', async () => pickWorkingTree())),
    [Commands.pickCommit]: wrap(() => guard('pickCommit', () => loadCommits())),
    [Commands.pickRange]: wrap(() => guard('pickRange', async () => pickRange())),
    [Commands.selectCommit]: wrap((rev?: unknown) => guard('selectCommit', async () => {
      if (typeof rev === 'string')
        selectCommit(rev)
    })),
    [Commands.submitRange]: wrap((raw?: unknown) => guard('submitRange', async () => {
      if (typeof raw === 'string')
        submitRange(raw)
    })),
    [Commands.generateSimple]: wrap(() => guard('generateSimple', () => generateSimpleGuide())),
    [Commands.generateAgent]: wrap(() => guard('generateAgent', async () => {
      if (peek(skillInstalled.data) === false) {
        const answer = await wrap(peek(ports).ui.notify(
          'info',
          'Agent needs the /tabthrough skill in this workspace. Install it and continue?',
          ['Install and continue', 'Cancel'],
        ))
        if (answer !== 'Install and continue')
          return
        await wrap(installWorkspaceSkill())
      }
      await wrap(generateAgentGuide())
    })),
    [Commands.setupBack]: wrap(() => guard('setupBack', async () => setupBack())),
    [Commands.next]: wrap(() => guard('next', advance)),
    [Commands.previous]: wrap(() => guard('previous', retreat)),
    [Commands.showStepDetail]: wrap(() => guard('showStepDetail', revealCurrentStep)),
    [Commands.showWalkthrough]: wrap(() => guard('showWalkthrough', async () => {
      await wrap(VscodeCommands.executeCommand('workbench.view.extension.tabthrough', { preserveFocus: true }))
    })),
    [Commands.finish]: wrap(() => guard('finish', () => finishSession())),
    [Commands.cancel]: wrap(() => guard('cancel', async () => {
      resetSetup()
      await wrap(cancelSession('cancel'))
    })),
    [Commands.commitHandoff]: wrap(() => guard('commitHandoff', () => commitHandoff())),
    [Commands.restoreBackup]: wrap(() => guard('restoreBackup', () => recoverBackup())),
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

async function refuseIfBlocked(): Promise<boolean> {
  if (peek(canStart))
    return true
  await window.showWarningMessage(peek(startBlockedReason) ?? 'Tabthrough cannot start right now.')
  return false
}

async function beginWorkingTree(): Promise<void> {
  if (!await refuseIfBlocked())
    return
  await wrap(VscodeCommands.executeCommand('tabthrough.sidebar.focus'))
  pickWorkingTree()
}

async function beginCommitPicker(): Promise<void> {
  if (!await refuseIfBlocked())
    return
  await wrap(VscodeCommands.executeCommand('tabthrough.sidebar.focus'))
  await wrap(loadCommits())
}

async function beginRangePicker(): Promise<void> {
  if (!await refuseIfBlocked())
    return
  await wrap(VscodeCommands.executeCommand('tabthrough.sidebar.focus'))
  pickRange()
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
