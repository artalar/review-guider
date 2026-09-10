import { watch } from 'reactive-vscode'
import { window } from 'vscode'
import { guideDiagnostics } from '../model/session'
import { logger } from '../utils'
import { useAtomRef } from './binding'

/**
 * A broken sidecar costs the reader exactly one notification, however many
 * diagnostics are behind it (guide-schema.md §5.4). The full list goes to the
 * output channel, and the review proceeds on the heuristic order.
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
      ? ` (+${warnings.length - 1} more in the Tabthrough output channel)`
      : ''
    void window.showWarningMessage(`${first.message}${more}`)
      .then(undefined, (error: unknown) => logger.error('guide diagnostics notice failed', error))
  })
}
