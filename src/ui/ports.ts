import type { ExtensionContext } from 'vscode'
import type { PreflightRequest } from '../git/types'
import type { ClockPort, Ports, StorePort, UiPort } from '../model/ports'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { extensionContext } from 'reactive-vscode'
import { commands, Uri, window, workspace } from 'vscode'
import { describeTarget } from '../git/types'
import { ports } from '../model/session'
import { logger } from '../utils'
import { createGlobalStateStore } from './global-state-store'

export { createGlobalStateStore } from './global-state-store'
export type { GlobalStateBag, GlobalStateContext } from './global-state-store'

/**
 * Fallback used only when activation somehow lacks a context. It throws rather
 * than pretending journal writes succeeded; recovery must fail closed when the
 * durable store is unavailable.
 */
const missingContextStore: StorePort = {
  async readToken() {
    const error = new Error('Tabthrough journal unavailable: ExtensionContext was never captured')
    logger.error(error.message)
    throw error
  },
  async writeToken() {
    const error = new Error('Tabthrough journal unavailable: ExtensionContext was never captured')
    logger.error(error.message)
    throw error
  },
  async clearToken() {
    const error = new Error('Tabthrough journal unavailable: ExtensionContext was never captured')
    logger.error(error.message)
    throw error
  },
}

export function describePreflight(request: PreflightRequest): { message: string, detail: string } {
  const { files } = request
  const scope: string[] = []
  if (files.staged.length > 0)
    scope.push(`${files.staged.length} staged`)
  if (files.unstaged.length > 0)
    scope.push(`${files.unstaged.length} unstaged`)
  if (files.untracked.length > 0)
    scope.push(`${files.untracked.length} untracked`)

  const lines: string[] = []
  lines.push(request.willStash
    ? `Your ${scope.join(', ')} change${scope.length === 1 && files.staged.length + files.unstaged.length + files.untracked.length === 1 ? '' : 's'} will be stashed as "tabthrough:<session>". Ignored files are never touched.`
    : 'Your working tree is already clean, so nothing will be stashed.')
  if (request.willCheckout !== null)
    lines.push(`HEAD will detach at ${request.willCheckout.slice(0, 12)}.`)

  if (request.sessionMode === 'apply') {
    lines.push(
      'Apply mode writes real files as you Tab through steps. Cancel restores your pre-session tree. '
      + 'Finish keeps the applied tree and offers Source Control so you can commit — it does not restore.',
    )
  }
  else {
    lines.push(
      'Everything is captured to refs/tabthrough/after/<session> before anything is touched, '
      + 'and "Tabthrough: Cancel Review" restores it at any time.',
    )
  }

  return {
    message: request.sessionMode === 'apply'
      ? `Isolate this workspace and apply ${describeTarget(request.entry)} step by step?`
      : `Isolate this workspace to review ${describeTarget(request.entry)}?`,
    detail: lines.join('\n\n'),
  }
}

/** Cancel is the default button on the pre-flight — the modal's Escape action. */
export const windowUi: UiPort = {
  async confirm(request) {
    const { message, detail } = describePreflight(request)
    const startLabel = request.sessionMode === 'apply' ? 'Isolate and Apply' : 'Isolate and Start'
    const answer = await window.showWarningMessage(message, { modal: true, detail }, startLabel)
    return answer === startLabel
  },
  async chooseSessionMode() {
    const pick = await window.showQuickPick(
      [
        {
          label: 'Read-only review',
          description: 'Virtual docs; Finish and Cancel both restore',
          mode: 'readonly' as const,
        },
        {
          label: 'Apply with me',
          description: 'Writes real files as you Tab; Finish keeps, Cancel restores',
          mode: 'apply' as const,
        },
      ],
      {
        title: 'Tabthrough session mode',
        placeHolder: 'How should this walkthrough run?',
        ignoreFocusOut: true,
      },
    )
    return pick?.mode ?? null
  },
  async notify(level, message, actions = []) {
    const items = [...actions]
    // VS Code resolves message promises only when the toast is dismissed.
    // Informational notices must not hold an apply action pending indefinitely.
    if (items.length === 0) {
      const shown = level === 'info'
        ? window.showInformationMessage(message)
        : level === 'warn'
          ? window.showWarningMessage(message)
          : window.showErrorMessage(message)
      void shown.then(undefined, error => logger.error('notification failed', error))
      return undefined
    }
    switch (level) {
      case 'info':
        return await window.showInformationMessage(message, ...items)
      case 'warn':
        return await window.showWarningMessage(message, ...items)
      case 'error':
        return await window.showErrorMessage(message, ...items)
    }
  },
  async openReview(target) {
    // Phase 5 opens `vscode.diff` over the two review documents.
    logger.info(`openReview requested for ${target.path} (reveal lands in Phase 5)`)
  },
  async openWorkspaceFile(repoRoot, path) {
    const root = canonicalPath(repoRoot)
    const absolute = canonicalPath(join(repoRoot, path))
    if (!isWithin(root, absolute))
      throw new Error(`Refusing to open a path outside the repository: ${path}`)
    const uri = Uri.file(absolute)
    await window.showTextDocument(uri, { preview: false })
  },
  async openSourceControl() {
    await commands.executeCommand('workbench.view.scm')
  },
  async saveDocuments(repoRoot, paths) {
    const root = canonicalPath(repoRoot)
    const requested = new Set<string>()
    for (const path of paths) {
      const target = canonicalPath(join(repoRoot, path))
      if (!isWithin(root, target))
        return { ok: false, path }
      requested.add(target)
    }
    const docs = workspace.textDocuments.filter((document) => {
      if (document.uri.scheme !== 'file')
        return false
      const path = canonicalPath(document.uri.fsPath)
      if (!isWithin(root, path))
        return false
      return paths.length === 0 || requested.has(path)
    })

    for (const doc of docs) {
      if (!doc.isDirty)
        continue
      const ok = await doc.save()
      if (!ok)
        return { ok: false, path: relativePath(root, canonicalPath(doc.uri.fsPath)) }
    }
    return { ok: true }
  },
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved).replaceAll('\\', '/')
  }
  catch {
    return resolved.replaceAll('\\', '/')
  }
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function relativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

export const systemClock: ClockPort = {
  now: () => Date.now(),
  sessionId: () => randomUUID().replace(/-/g, '').slice(0, 12),
}

function resolveDefaultStore(): StorePort {
  const context: ExtensionContext | null = extensionContext.value
  if (context === null) {
    logger.error('installPorts: ExtensionContext missing; journal I/O will fail closed')
    return missingContextStore
  }
  return createGlobalStateStore(context)
}

export function installPorts(overrides: Partial<Ports> = {}): void {
  ports.set({
    store: overrides.store ?? resolveDefaultStore(),
    ui: overrides.ui ?? windowUi,
    clock: overrides.clock ?? systemClock,
  })
}
