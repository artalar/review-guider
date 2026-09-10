import type { WebviewView, WebviewViewProvider } from 'vscode'
import type { SidebarViewModel } from '../model/view'
import { effect, peek, wrap } from '@reatom/core'
import { useDisposable, watch } from 'reactive-vscode'
import { commands as VscodeCommands, window } from 'vscode'
import { sessionStatus } from '../model/session'
import { resetSetup, skillEpoch } from '../model/setup'
import { sidebarItems } from '../model/sidebar'
import { sidebarViewModel } from '../model/view'
import { useAtomRef } from './binding'
import { renderSidebarBody, renderSidebarHtml } from './sidebar-html'

const SIDEBAR_COMMANDS = new Set([
  'tabthrough.review',
  'tabthrough.startFromGuide',
  'tabthrough.installSkill',
  'tabthrough.pickWorkingTree',
  'tabthrough.pickCommit',
  'tabthrough.pickRange',
  'tabthrough.selectCommit',
  'tabthrough.submitRange',
  'tabthrough.generateSimple',
  'tabthrough.generateAgent',
  'tabthrough.setupBack',
  'tabthrough.next',
  'tabthrough.previous',
  'tabthrough.finish',
  'tabthrough.cancel',
  'tabthrough.editHere',
  'tabthrough.showStepDetail',
  'tabthrough.showWalkthrough',
  'tabthrough.commitHandoff',
  'tabthrough.continueRebase',
  'tabthrough.abortRebase',
  'tabthrough.popAutostash',
  'tabthrough.showAutostash',
  'tabthrough.openWorktree',
  'tabthrough.removeWorktree',
  'tabthrough.pruneWorktrees',
  'tabthrough.openConflict',
])

const PAYLOAD_COMMANDS = new Set([
  'tabthrough.selectCommit',
  'tabthrough.submitRange',
  'tabthrough.popAutostash',
  'tabthrough.showAutostash',
  'tabthrough.openWorktree',
  'tabthrough.removeWorktree',
  'tabthrough.openConflict',
])

class SidebarWebviewProvider implements WebviewViewProvider {
  private view: WebviewView | undefined
  private listener: { dispose: () => void } | undefined
  private ready = false

  constructor(private readonly current: () => SidebarViewModel) {}

  resolveWebviewView(view: WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [] }
    this.listener?.dispose()
    this.listener = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSidebarMessage(message))
        return
      const enabled = sidebarItems(this.current()).some(row => row.command === message.command && row.enabled !== false)
      if (!enabled)
        return
      if (message.payload !== undefined && PAYLOAD_COMMANDS.has(message.command))
        void VscodeCommands.executeCommand(message.command, message.payload).then(undefined, () => undefined)
      else
        void VscodeCommands.executeCommand(message.command).then(undefined, () => undefined)
    })
    view.onDidDispose(() => {
      this.listener?.dispose()
      this.listener = undefined
      this.view = undefined
      this.ready = false
    })
    view.show(true)
    view.webview.html = renderSidebarHtml(this.current())
    this.ready = true
  }

  update(): void {
    if (this.view === undefined)
      return
    if (!this.ready) {
      this.view.webview.html = renderSidebarHtml(this.current())
      this.ready = true
      return
    }
    void this.view.webview.postMessage({ type: 'update', body: renderSidebarBody(this.current()) })
  }

  dispose(): void {
    this.listener?.dispose()
    this.listener = undefined
    this.view = undefined
    this.ready = false
  }
}

function isSidebarMessage(value: unknown): value is { readonly command: string, readonly payload?: string } {
  if (typeof value !== 'object' || value === null || !('command' in value))
    return false
  const command = Reflect.get(value, 'command')
  if (typeof command !== 'string' || !SIDEBAR_COMMANDS.has(command))
    return false
  if (!Object.hasOwn(value, 'payload'))
    return true
  return typeof Reflect.get(value, 'payload') === 'string'
}

/** Installs the sidebar and refreshes both native projections from Reatom. */
export function useGuideSidebar(): void {
  const view = useAtomRef(sidebarViewModel)
  const webview = new SidebarWebviewProvider(() => view.value)
  useDisposable(webview)
  useDisposable(window.registerWebviewViewProvider('tabthrough.sidebar', webview, { webviewOptions: { retainContextWhenHidden: true } }))
  let previousStatus = peek(sessionStatus)
  const resetOnIdle = effect(() => {
    const status = sessionStatus()
    if (status === 'idle' && previousStatus !== 'idle') {
      resetSetup()
      skillEpoch.set(value => value + 1)
    }
    previousStatus = status
  }, 'setup.resetOnIdle')
  useDisposable({ dispose: resetOnIdle.unsubscribe })
  let sessionShown = false
  watch(view, wrap(() => {
    webview.update()
    const status = view.value.status
    if (status === 'idle') {
      sessionShown = false
    }
    else if (status === 'active' && !sessionShown) {
      sessionShown = true
      void VscodeCommands.executeCommand('tabthrough.sidebar.focus', { preserveFocus: true })
        .then(undefined, () => undefined)
    }
  }), { immediate: true })
}

/** Read helper for tests and diagnostics without constructing VS Code items. */
export function readSidebarItems(): readonly ReturnType<typeof sidebarItems>[number][] {
  return sidebarItems(peek(sidebarViewModel))
}
