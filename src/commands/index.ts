import { isAbort, peek, wrap } from '@reatom/core'
import { useCommands } from 'reactive-vscode'
import { Uri, commands as VscodeCommands, window } from 'vscode'
import { commands as Commands } from '../generated/meta'
import {
  abortRebase,
  cancelSession,
  canStart,
  chooseMode,
  commitHandoff,
  continueRebase,
  editHere,
  finishSession,
  openConflict,
  openWorktree,
  popAutostash,
  ports,
  pruneWorktrees,
  removeWorktree,
  session,
  showAutostash,
  startBlockedReason,
} from '../model/session'
import {
  focusRangeBound,
  generateAgentGuide,
  generateSimpleGuide,
  installWorkspaceSkill,
  loadCommits,
  openTargetPicker,
  pickCommitRev,
  pickRange,
  pickWorkingTree,
  resetSetup,
  selectCommit,
  selectRangeRev,
  setRangeBound,
  setupBack,
  setupPhase,
  skillInstalled,
  submitRange,
} from '../model/setup'
import { beginFromActiveGuide } from '../ui/active-guide'
import { revealCurrentStep } from '../ui/documents'
import { logger } from '../utils'

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
    [Commands.pickRange]: wrap(() => guard('pickRange', () => pickRange())),
    [Commands.selectCommit]: wrap((rev?: unknown) => guard('selectCommit', async () => {
      if (typeof rev !== 'string')
        return
      if (rev === 'focus:from' || rev === 'focus:to') {
        focusRangeBound(rev === 'focus:from' ? 'from' : 'to')
        return
      }
      if (peek(setupPhase).kind === 'range') {
        if (rev.startsWith('from:'))
          setRangeBound('from', rev.slice(5))
        else if (rev.startsWith('to:'))
          setRangeBound('to', rev.slice(3))
        else
          selectRangeRev(rev)
        return
      }
      if (peek(setupPhase).kind === 'commits' && rev.startsWith('pick:')) {
        pickCommitRev(rev.slice(5))
        return
      }
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
    [Commands.chooseMode]: wrap((mode?: unknown) => guard('chooseMode', async () => {
      if (mode === 'readonly' || mode === 'rebase' || mode === 'worktree')
        chooseMode(mode)
    })),
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
    [Commands.editHere]: wrap(() => guard('editHere', () => editHere())),
    [Commands.continueRebase]: wrap(() => guard('continueRebase', () => continueRebase())),
    [Commands.abortRebase]: wrap(() => guard('abortRebase', () => abortRebase())),
    [Commands.popAutostash]: wrap((selector?: unknown) => guard('popAutostash', () =>
      popAutostash(typeof selector === 'string' ? selector : undefined))),
    [Commands.showAutostash]: wrap((selector?: unknown) => guard('showAutostash', () =>
      showAutostash(typeof selector === 'string' ? selector : undefined))),
    [Commands.openWorktree]: wrap((dir?: unknown) => guard('openWorktree', async () => {
      if (typeof dir === 'string')
        await wrap(openWorktree(dir))
    })),
    [Commands.removeWorktree]: wrap((dir?: unknown) => guard('removeWorktree', async () => {
      if (typeof dir === 'string')
        await wrap(removeWorktree(dir))
    })),
    [Commands.pruneWorktrees]: wrap(() => guard('pruneWorktrees', () => pruneWorktrees())),
    [Commands.openConflict]: wrap((path?: unknown) => guard('openConflict', async () => {
      if (typeof path === 'string')
        await wrap(openConflict(path))
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
  await wrap(pickRange())
}

async function advance(): Promise<void> {
  const model = peek(session)
  if (model === null)
    return

  model.next()
}

async function retreat(): Promise<void> {
  const model = peek(session)
  if (model === null)
    return
  model.prev()
}

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
