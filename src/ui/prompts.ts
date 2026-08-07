import { peek, wrap } from '@reatom/core'
import { watch } from 'reactive-vscode'
import { window } from 'vscode'
import {
  ports,
  preflightAnswer,
  preflightRequest,
  recoverBackup,
  recoveryToken,
  restoreBlock,
} from '../model/session'
import { logger } from '../utils'
import { useAtomRef } from './binding'

const answerPreflight = wrap(async (): Promise<void> => {
  const request = peek(preflightRequest)
  if (request === null)
    return
  const approved = await wrap(peek(ports).ui.confirm(request))
  preflightAnswer(approved)
})

/**
 * The pre-flight is modelled Reatom-natively as an action event: the model
 * publishes a request and awaits `preflightAnswer`. This is the only place that
 * turns that request into a modal, and the only place that answers it.
 */
export function usePreflightPrompt(): void {
  const request = useAtomRef(preflightRequest)

  watch(request, (next) => {
    if (next === null)
      return
    void answerPreflight()
  })
}

/**
 * Runs before any command is enabled and before any git mutation, per
 * architecture/overview.md §4.4. Recovery never guesses: it reports what is
 * missing rather than attempting a heuristic repair.
 */
export const checkRecoveryOnActivate = wrap(async (): Promise<void> => {
  const token = await wrap(recoveryToken())
  if (token === null)
    return

  logger.warn(`Guide Reviewer found an unfinished session (${token.stage}) for ${token.repoRoot}`)

  const answer = await wrap(window.showWarningMessage(
    'Guide Reviewer did not finish restoring your work last time.',
    { modal: true, detail: `Session ${token.sessionId} stopped at stage "${token.stage}". Nothing was discarded.` },
    'Restore now',
    'Later',
  ))

  if (answer === 'Restore now')
    await wrap(recoverBackup())
})

/** A blocked restore is loud in the output channel, with the manual commands. */
export function useRestoreBlockNotice(): void {
  const blocked = useAtomRef(restoreBlock)

  watch(blocked, (outcome) => {
    if (outcome === null || outcome.kind !== 'blocked')
      return
    logger.error(`Restore blocked (${outcome.reason}): ${outcome.message}`)
    for (const command of outcome.commands)
      logger.error(`  ${command}`)
  })
}
