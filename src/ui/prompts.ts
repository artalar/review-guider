import { peek, wrap } from '@reatom/core'
import { watch } from 'reactive-vscode'
import { window } from 'vscode'
import { isRecoverable } from '../git/journal'
import {
  guideDiagnostics,
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

  let approved = false
  try {
    approved = await wrap(peek(ports).ui.confirm(request))
  }
  catch (error) {
    // `startSession` is parked on `take(preflightAnswer)`. An unanswered
    // pre-flight leaves the machine in `preflight` forever, which disables
    // Start with no way back, so a failed modal has to count as a decline.
    logger.error('pre-flight prompt failed; treating it as declined', error)
  }
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
    void answerPreflight().catch((error: unknown) => logger.error('pre-flight prompt failed', error))
  })
}

/**
 * Runs before any command is enabled and before any git mutation, per
 * architecture/overview.md §4.4. Recovery never guesses: it reports what is
 * missing rather than attempting a heuristic repair.
 */
export const checkRecoveryOnActivate = wrap(async (): Promise<void> => {
  const token = await wrap(recoveryToken())
  // `isRecoverable`, not `!== null`: a token still at `planned` never touched
  // the tree, and one at `done` was already restored. Opening a modal about
  // either is a false alarm about data loss, which is the one kind of noise
  // this extension cannot afford to make.
  if (!isRecoverable(token))
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

/**
 * A broken sidecar costs the reader exactly one notification, however many
 * diagnostics are behind it (guide-schema.md §5.4). The full list — including
 * the `info` entries that are pure forward-compatibility noise — goes to the
 * output channel, and the review itself proceeds on the heuristic order.
 */
export function useGuideDiagnostics(): void {
  const diagnostics = useAtomRef(guideDiagnostics)

  watch(diagnostics, (entries) => {
    for (const entry of entries) {
      const line = `guide (${entry.code}): ${entry.message}`
      if (entry.severity === 'info')
        logger.info(line)
      else
        logger.warn(line)
    }

    const warnings = entries.filter(entry => entry.severity === 'warning')
    const [first] = warnings
    if (first === undefined)
      return

    const more = warnings.length > 1
      ? ` (+${warnings.length - 1} more in the Guide Reviewer output channel)`
      : ''
    void window.showWarningMessage(`${first.message}${more}`)
      .then(undefined, (error: unknown) => logger.error('guide diagnostics notice failed', error))
  })
}

/**
 * A blocked restore is loud in the output channel, with the manual commands,
 * and the channel is revealed rather than merely written to: the toast the
 * model raises says "nothing was discarded", and this is where the user finds
 * out what to run next.
 */
export function useRestoreBlockNotice(): void {
  const blocked = useAtomRef(restoreBlock)

  watch(blocked, (outcome) => {
    if (outcome === null || outcome.kind !== 'blocked')
      return
    logger.error(`Restore blocked (${outcome.reason}): ${outcome.message}`)
    for (const command of outcome.commands)
      logger.error(`  ${command}`)
    logger.show(true)
  })
}
