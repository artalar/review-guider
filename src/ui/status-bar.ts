import { useActiveTextEditor, useStatusBarItem, useVscodeContext } from 'reactive-vscode'
import { StatusBarAlignment } from 'vscode'
import { commands as Commands } from '../generated/meta'
import { canStart, gitUsable, isSessionActive, isSessionOpen, recoveryPending, session } from '../model/session'
import { applyPending, REVIEW_SCHEME, statusText, statusTooltip } from '../model/view'
import { useAtomRef } from './binding'

export function useGuideStatusBar(): void {
  const text = useAtomRef(statusText)
  const tooltip = useAtomRef(statusTooltip)

  useStatusBarItem({
    id: 'tabthrough.session',
    alignment: StatusBarAlignment.Left,
    priority: 100,
    text: () => text.value ?? '',
    tooltip: () => tooltip.value ?? undefined,
    // Clicking jumps to the current step rather than ending the review: the
    // status bar is the one always-visible way back into the reveal editor.
    command: Commands.showStepDetail,
    visible: () => text.value !== null,
  })
}

/**
 * Context keys mirror the model's gating computeds, so command `enablement` in
 * package.json disables an action *with a reason* rather than failing on click.
 */
export function useGuideContextKeys(): void {
  const usable = useAtomRef(gitUsable)
  const start = useAtomRef(canStart)
  const active = useAtomRef(isSessionActive)
  const open = useAtomRef(isSessionOpen)
  const recovery = useAtomRef(recoveryPending)
  const model = useAtomRef(session)
  const pending = useAtomRef(applyPending)
  const editor = useActiveTextEditor()

  useVscodeContext('tabthrough.gitUsable', () => usable.value)
  useVscodeContext('tabthrough.canStart', () => start.value)
  useVscodeContext('tabthrough.sessionActive', () => active.value)
  // Distinct from `sessionActive`: Cancel has to survive `blocked` and a
  // pre-flight that stalled, which are precisely the states `active` excludes.
  useVscodeContext('tabthrough.sessionOpen', () => open.value)
  useVscodeContext('tabthrough.recoveryPending', () => recovery.value)
  useVscodeContext('tabthrough.sessionMode', () => model.value?.mode ?? '')
  useVscodeContext('tabthrough.applyPending', () => pending.value)
  useVscodeContext(
    'tabthrough.reviewEditorFocused',
    () => editor.value?.document.uri.scheme === REVIEW_SCHEME,
  )
}
