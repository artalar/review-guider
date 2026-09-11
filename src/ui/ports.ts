import type { GitCommandResult } from '../git/state'
import type { ClockPort, Ports, UiPort } from '../model/ports'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { extensionContext } from 'reactive-vscode'
import { commands, env, Position, Range, Selection, Uri, window, workspace } from 'vscode'
import { ports } from '../model/session'
import { logger } from '../utils'

export function logGitResult(result: GitCommandResult): void {
  logger.info(`$ ${result.command}`)
  if (result.stdout.trim() !== '')
    logger.info(result.stdout.trimEnd())
  if (result.stderr.trim() !== '')
    logger.info(result.stderr.trimEnd())
  if (result.code !== 0)
    logger.info(`exit ${result.code}`)
}

export const windowUi: UiPort = {
  async notify(level, message, actions = []) {
    const items = [...actions]
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
    logger.info(`openReview requested for ${target.path}`)
  },
  async openWorkspaceFile(repoRoot, path) {
    const root = canonicalPath(repoRoot)
    const absolute = canonicalPath(join(repoRoot, path))
    if (!isWithin(root, absolute))
      throw new Error(`Refusing to open a path outside the repository: ${path}`)
    await window.showTextDocument(Uri.file(absolute), { preview: false, viewColumn: 2 })
  },
  async openFileAt(repoRoot, path, line, ranges) {
    const root = canonicalPath(repoRoot)
    const absolute = canonicalPath(join(repoRoot, path))
    if (!isWithin(root, absolute))
      throw new Error(`Refusing to open a path outside the repository: ${path}`)
    const editor = await window.showTextDocument(Uri.file(absolute), { preview: false, viewColumn: 2 })
    const selections = ranges
      .filter(range => range.end >= range.start)
      .map(range => new Selection(
        new Position(Math.max(0, range.start - 1), 0),
        new Position(Math.max(0, range.end - 1), 0),
      ))
    if (selections[0] !== undefined)
      editor.selections = selections
    const focus = Math.max(0, line - 1)
    editor.revealRange(new Range(focus, 0, focus, 0))
  },
  async openSourceControl() {
    await commands.executeCommand('workbench.view.scm')
  },
  async openFolder(dir, newWindow) {
    await commands.executeCommand('vscode.openFolder', Uri.file(dir), { forceNewWindow: newWindow })
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
  async writeTextFile(repoRoot, path, text) {
    const root = canonicalPath(repoRoot)
    const absolute = canonicalPath(join(repoRoot, path))
    if (!isWithin(root, absolute))
      throw new Error(`Refusing to write a path outside the repository: ${path}`)
    await workspace.fs.createDirectory(Uri.file(dirname(absolute)))
    await workspace.fs.writeFile(Uri.file(absolute), new TextEncoder().encode(text))
  },
  async fileExists(repoRoot, path) {
    const root = canonicalPath(repoRoot)
    const absolute = canonicalPath(join(repoRoot, path))
    if (!isWithin(root, absolute))
      return false
    try {
      await workspace.fs.stat(Uri.file(absolute))
      return true
    }
    catch {
      return false
    }
  },
  async readBundledSkill() {
    const context = extensionContext.value
    if (context === null)
      return null
    try {
      const source = Uri.joinPath(context.extensionUri, 'res', 'skill', 'tabthrough', 'SKILL.md')
      const bytes = await workspace.fs.readFile(source)
      return new TextDecoder().decode(bytes)
    }
    catch {
      return null
    }
  },
  async openAgentChat(prompt) {
    const available = await commands.getCommands(true)
    if (available.includes('workbench.action.chat.open')) {
      try {
        await commands.executeCommand('workbench.action.chat.open', {
          query: prompt,
          isPartialQuery: true,
          mode: 'agent',
        })
        return
      }
      catch {
        // Cursor may reject unknown option keys.
      }
    }
    await env.clipboard.writeText(prompt)
    await window.showInformationMessage('Guide prompt copied. Paste it into Chat and send.')
  },
  logGit: logGitResult,
  async pickUntracked(paths) {
    if (paths.length === 0)
      return []
    const picked = await window.showQuickPick(
      paths.map(path => ({ label: path, picked: false })),
      {
        canPickMany: true,
        title: 'Stage untracked files into the amended commit?',
        placeHolder: 'None are staged unless you tick them',
        ignoreFocusOut: true,
      },
    )
    if (picked === undefined)
      return undefined
    return picked.map(item => item.label)
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
  sessionId: () => randomUUID().replace(/-/g, '').slice(0, 12),
}

export function installPorts(overrides: Partial<Ports> = {}): void {
  ports.set({
    ui: overrides.ui ?? windowUi,
    clock: overrides.clock ?? systemClock,
  })
}
