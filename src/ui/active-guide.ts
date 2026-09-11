import type { TextDocument, Uri } from 'vscode'
import { basename, join, relative } from 'node:path'
import { action, atom, peek, sleep, withAbort, wrap } from '@reatom/core'
import { useActiveTextEditor, useDisposable, useVscodeContext, watchEffect } from 'reactive-vscode'
import { commands, window, workspace } from 'vscode'
import { entryFromGuideScope, isGuideFileName, isTabthroughGuideFileName } from '../guide/from-file'
import { isSafeRepoPath, loadSidecar, normalizeRepoPath } from '../guide/sidecar'
import {
  canStart,
  gitCapability,
  startBlockedReason,
  startSession,
} from '../model/session'
import { focusedGuidePath, generateGuideFile, setupPhase } from '../model/setup'
import { useAtomRef } from './binding'
import { pickCommitEntry, promptRangeEntry } from './entry'

/** Bumped when a guide buffer changes so schema enablement stays honest. */
const activeGuideBump = atom(0, 'ui.activeGuideBump')
const bumpActiveGuide = action(async () => {
  await wrap(sleep(150))
  activeGuideBump.set(value => value + 1)
}, 'ui.bumpActiveGuide').extend(withAbort())
const activeGuideValid = atom(false, 'ui.activeGuideValid')
const lastAutoStartedUri = atom<string | null>(null, 'ui.lastAutoStartedGuide')

/**
 * True when the active editor is a `*.guide.json` whose buffer validates as
 * guide v1. Drives command enablement and editor menus.
 */
export function useActiveGuideContext(): void {
  const editor = useActiveTextEditor()
  const bump = useAtomRef(activeGuideBump)

  useDisposable(workspace.onDidChangeTextDocument(wrap((event) => {
    if (isGuideFileName(basename(event.document.fileName)))
      void bumpActiveGuide()
  })))

  const valid = useAtomRef(activeGuideValid)
  useVscodeContext('tabthrough.activeGuideValid', () => valid.value)

  watchEffect(wrap(() => {
    void bump.value
    const document = editor.value?.document
    if (document === undefined || document.uri.scheme !== 'file' || !isGuideFileName(basename(document.fileName))) {
      activeGuideValid.set(false)
      focusedGuidePath.set(null)
      lastAutoStartedUri.set(null)
      return
    }
    const loaded = loadSidecar({ path: basename(document.fileName), text: document.getText() })
    const ok = loaded.doc !== null
    activeGuideValid.set(ok)
    if (!ok) {
      focusedGuidePath.set(null)
      return
    }
    const capability = gitCapability.data()
    if (capability === null || !capability.ok) {
      focusedGuidePath.set(null)
      return
    }
    const repoRelative = normalizeRepoPath(relative(capability.repoRoot, document.uri.fsPath))
    focusedGuidePath.set(isSafeRepoPath(repoRelative) && !repoRelative.startsWith('..') ? repoRelative : null)
  }))

  watchEffect(wrap(() => {
    const document = editor.value?.document
    if (document === undefined || document.uri.scheme !== 'file') {
      lastAutoStartedUri.set(null)
      return
    }
    if (!isTabthroughGuideFileName(basename(document.fileName))) {
      lastAutoStartedUri.set(null)
      return
    }
    if (!activeGuideValid() || !canStart())
      return
    const uri = document.uri.toString()
    if (peek(lastAutoStartedUri) === uri)
      return
    lastAutoStartedUri.set(uri)
    void beginFromGuideDocument(document)
  }))
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

  const phase = peek(setupPhase)
  if (phase.kind === 'generate' && uri === undefined) {
    const sidecarPath = peek(generateGuideFile)
    if (!isSafeRepoPath(sidecarPath)) {
      await window.showWarningMessage('That review topic is not a safe repository path.')
      return
    }
    const documentForTarget = await wrap(workspace.openTextDocument(join(capability.repoRoot, sidecarPath)))
    const targetSidecar = { path: sidecarPath, text: documentForTarget.getText() }
    const targetLoaded = loadSidecar(targetSidecar)
    if (targetLoaded.doc === null) {
      await window.showWarningMessage(
        targetLoaded.diagnostics[0]?.message ?? `${sidecarPath} is not a valid Tabthrough guide.`,
      )
      return
    }
    await wrap(commands.executeCommand('tabthrough.sidebar.focus'))
    await wrap(startSession({
      entry: phase.target,
      guideFile: sidecarPath,
      sidecar: targetSidecar,
      ...(targetLoaded.doc.cursor === undefined ? {} : { cursor: targetLoaded.doc.cursor }),
    }))
    return
  }

  const document = uri !== undefined
    ? await wrap(workspace.openTextDocument(uri))
    : window.activeTextEditor?.document
  if (document === undefined || document.uri.scheme !== 'file') {
    await window.showWarningMessage('Open a .tabthrough.{topic}.guide.json file to start a review from it.')
    return
  }
  await wrap(beginFromGuideDocument(document))
}

export async function beginFromGuideDocument(document: TextDocument): Promise<void> {
  if (!peek(canStart)) {
    await window.showWarningMessage(peek(startBlockedReason) ?? 'Tabthrough cannot start right now.')
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

  if (document.uri.scheme !== 'file') {
    await window.showWarningMessage('Open a .tabthrough.{topic}.guide.json file to start a review from it.')
    return
  }
  if (!isGuideFileName(basename(document.fileName))) {
    await window.showWarningMessage('The active file is not a Tabthrough guide.')
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

  await wrap(commands.executeCommand('tabthrough.sidebar.focus'))
  await wrap(startSession({
    entry,
    guideFile: repoRelative,
    sidecar,
    ...(loaded.doc.cursor === undefined ? {} : { cursor: loaded.doc.cursor }),
  }))
}
