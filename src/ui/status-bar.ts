import { useActiveTextEditor, useStatusBarItem, useVscodeContext } from 'reactive-vscode'
import { StatusBarAlignment } from 'vscode'
import { commands as Commands } from '../generated/meta'
import {
  canStart,
  editHereEnabled,
  gitUsable,
  hasAutostash,
  hasConflicts,
  hasTabthroughWorktree,
  isSessionActive,
  isSessionOpen,
  rebaseInProgress,
  session,
} from '../model/session'
import { REVIEW_SCHEME, statusText, statusTooltip } from '../model/view'
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
    command: Commands.showStepDetail,
    visible: () => text.value !== null,
  })
}

export function useGuideContextKeys(): void {
  const usable = useAtomRef(gitUsable)
  const start = useAtomRef(canStart)
  const active = useAtomRef(isSessionActive)
  const open = useAtomRef(isSessionOpen)
  const model = useAtomRef(session)
  const rebase = useAtomRef(rebaseInProgress)
  const autostash = useAtomRef(hasAutostash)
  const worktree = useAtomRef(hasTabthroughWorktree)
  const conflicts = useAtomRef(hasConflicts)
  const editHere = useAtomRef(editHereEnabled)
  const editor = useActiveTextEditor()

  useVscodeContext('tabthrough.gitUsable', () => usable.value)
  useVscodeContext('tabthrough.canStart', () => start.value)
  useVscodeContext('tabthrough.sessionActive', () => active.value)
  useVscodeContext('tabthrough.sessionOpen', () => open.value)
  useVscodeContext('tabthrough.sessionMode', () => model.value?.mode ?? '')
  useVscodeContext('tabthrough.rebaseInProgress', () => rebase.value)
  useVscodeContext('tabthrough.hasAutostash', () => autostash.value)
  useVscodeContext('tabthrough.hasTabthroughWorktree', () => worktree.value)
  useVscodeContext('tabthrough.hasConflicts', () => conflicts.value)
  useVscodeContext('tabthrough.editHereEnabled', () => editHere.value)
  useVscodeContext(
    'tabthrough.reviewEditorFocused',
    () => editor.value?.document.uri.scheme === REVIEW_SCHEME,
  )
}
