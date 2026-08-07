import type { SessionToken } from '../git/journal'
import type { PreflightRequest } from '../git/types'
import type { ClockPort, Ports, StorePort, UiPort } from '../model/ports'
import { randomUUID } from 'node:crypto'
import { extensionContext } from 'reactive-vscode'
import { window } from 'vscode'
import { parseToken, repoKey } from '../git/journal'
import { describeTarget } from '../git/types'
import { ports } from '../model/session'
import { logger } from '../utils'

const TOKEN_PREFIX = 'tabthrough.token.'

/**
 * `globalState`, not `workspaceState`: a second window on the same repository
 * must be able to see the journal, and it must survive the folder being
 * reopened by another path (ADR 0002 D3).
 */
export const globalStateStore: StorePort = {
  async readToken(repoRoot) {
    const context = extensionContext.value
    if (context === null)
      return null
    return parseToken(context.globalState.get<unknown>(TOKEN_PREFIX + repoKey(repoRoot)))
  },
  async writeToken(token: SessionToken) {
    const context = extensionContext.value
    if (context === null)
      return
    await context.globalState.update(TOKEN_PREFIX + repoKey(token.repoRoot), token)
  },
  async clearToken(repoRoot) {
    const context = extensionContext.value
    if (context === null)
      return
    await context.globalState.update(TOKEN_PREFIX + repoKey(repoRoot), undefined)
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
  lines.push(
    'Everything is captured to refs/tabthrough/after/<session> before anything is touched, '
    + 'and "Tabthrough: Cancel Review" restores it at any time.',
  )

  return {
    message: `Isolate this workspace to review ${describeTarget(request.entry)}?`,
    detail: lines.join('\n\n'),
  }
}

/** Cancel is the default button on the pre-flight — the modal's Escape action. */
export const windowUi: UiPort = {
  async confirm(request) {
    const { message, detail } = describePreflight(request)
    const answer = await window.showWarningMessage(message, { modal: true, detail }, 'Isolate and Start')
    return answer === 'Isolate and Start'
  },
  async notify(level, message, actions = []) {
    const items = [...actions]
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
}

export const systemClock: ClockPort = {
  now: () => Date.now(),
  sessionId: () => randomUUID().replace(/-/g, '').slice(0, 12),
}

export function installPorts(overrides: Partial<Ports> = {}): void {
  ports.set({
    store: overrides.store ?? globalStateStore,
    ui: overrides.ui ?? windowUi,
    clock: overrides.clock ?? systemClock,
  })
}
