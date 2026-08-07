import { useStatusBarItem, useVscodeContext } from 'reactive-vscode'
import { StatusBarAlignment } from 'vscode'
import { commands as Commands } from '../generated/meta'
import { canStart, gitUsable, isSessionActive, recoveryPending } from '../model/session'
import { statusText, statusTooltip } from '../model/view'
import { useAtomRef } from './binding'

export const REVIEW_SCHEME = 'guide-reviewer'

export function useGuideStatusBar(): void {
  const text = useAtomRef(statusText)
  const tooltip = useAtomRef(statusTooltip)

  useStatusBarItem({
    id: 'guideReviewer.session',
    alignment: StatusBarAlignment.Left,
    priority: 100,
    text: () => text.value ?? '',
    tooltip: () => tooltip.value ?? undefined,
    command: Commands.guideReviewerFinish,
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
  const recovery = useAtomRef(recoveryPending)

  useVscodeContext('guideReviewer.gitUsable', () => usable.value)
  useVscodeContext('guideReviewer.canStart', () => start.value)
  useVscodeContext('guideReviewer.sessionActive', () => active.value)
  useVscodeContext('guideReviewer.recoveryPending', () => recovery.value)
}
