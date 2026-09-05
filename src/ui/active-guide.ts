import type { Uri } from 'vscode'
import { basename, relative } from 'node:path'
import { atom, peek, wrap } from '@reatom/core'
import { useActiveTextEditor, useDisposable, useVscodeContext } from 'reactive-vscode'
import { window, workspace } from 'vscode'
import { entryFromGuideScope, isGuideFileName } from '../guide/from-file'
import { isSafeRepoPath, loadSidecar, normalizeRepoPath } from '../guide/sidecar'
import {
  canStart,
  gitCapability,
  startBlockedReason,
  startSession,
} from '../model/session'
import { useAtomRef } from './binding'
import { pickCommitEntry, promptRangeEntry } from './entry'

/** Bumped when a guide buffer changes so schema enablement stays honest. */
const activeGuideBump = atom(0, 'ui.activeGuideBump')

/**
 * True when the active editor is a `*.guide.json` whose buffer validates as
 * guide v1. Drives command enablement and editor menus.
 */
export function useActiveGuideContext(): void {
  const editor = useActiveTextEditor()
  const bump = useAtomRef(activeGuideBump)

  useDisposable(workspace.onDidChangeTextDocument((event) => {
    if (isGuideFileName(basename(event.document.fileName)))
      activeGuideBump.set(value => value + 1)
  }))

  useVscodeContext('tabthrough.activeGuideValid', () => {
    void bump.value
    const document = editor.value?.document
    if (document === undefined || document.uri.scheme !== 'file')
      return false
    if (!isGuideFileName(basename(document.fileName)))
      return false
    return loadSidecar({ path: basename(document.fileName), text: document.getText() }).doc !== null
  })
}

/**
 * Start a review from a guide file: use its `scope` for the entry, and pass
 * the buffer as the sidecar so an uncommitted guide still applies.
 *
 * `uri` is set when the command is invoked from the explorer context menu.
 */
export async function beginFromActiveGuide(uri?: Uri): Promise<void> {
  if (!peek(canStart)) {
    await window.showWarningMessage(peek(startBlockedReason) ?? 'Tabthrough cannot start right now.')
    return
  }

  const document = uri !== undefined
    ? await wrap(workspace.openTextDocument(uri))
    : window.activeTextEditor?.document
  if (document === undefined || document.uri.scheme !== 'file') {
    await window.showWarningMessage('Open a *.guide.json file to start a review from it.')
    return
  }
  if (!isGuideFileName(basename(document.fileName))) {
    await window.showWarningMessage('The active file is not a *.guide.json guide.')
    return
  }

  const capability = await wrap(gitCapability())
  if (capability === null || !capability.ok) {
    await window.showWarningMessage(
      capability === null
        ? 'Tabthrough is still checking the repository.'
        : capability.hint === undefined
          ? capability.message
          : `${capability.message} ${capability.hint}`,
    )
    return
  }

  const repoRelative = normalizeRepoPath(relative(capability.repoRoot, document.uri.fsPath))
  if (!isSafeRepoPath(repoRelative) || repoRelative.startsWith('..')) {
    await window.showWarningMessage('The guide file must live inside the repository.')
    return
  }

  const sidecar = { path: repoRelative, text: document.getText() }
  const loaded = loadSidecar(sidecar)
  if (loaded.doc === null) {
    await window.showWarningMessage(
      loaded.diagnostics[0]?.message ?? `${repoRelative} is not a valid Tabthrough guide.`,
    )
    return
  }

  const resolved = entryFromGuideScope(loaded.doc.scope)
  let entry = resolved.kind === 'entry' ? resolved.entry : null
  if (resolved.kind === 'needs-commit')
    entry = await wrap(pickCommitEntry())
  else if (resolved.kind === 'needs-range')
    entry = await wrap(promptRangeEntry())
  if (entry === null)
    return

  await wrap(startSession({ entry, guideFile: repoRelative, sidecar }))
}
