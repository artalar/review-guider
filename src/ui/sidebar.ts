import type { WebviewView, WebviewViewProvider } from 'vscode'
import type { SidebarViewModel } from '../model/view'
import { peek } from '@reatom/core'
import { useDisposable, watch } from 'reactive-vscode'
import { commands as VscodeCommands, window } from 'vscode'
import { sidebarItems } from '../model/sidebar'
import { sidebarViewModel } from '../model/view'
import { useAtomRef } from './binding'
import { renderSidebarBody, renderSidebarHtml } from './sidebar-html'

const SIDEBAR_COMMANDS = new Set([
  'tabthrough.start',
  'tabthrough.startFromCommit',
  'tabthrough.startFromRange',
  'tabthrough.next',
  'tabthrough.previous',
  'tabthrough.finish',
  'tabthrough.cancel',
  'tabthrough.restoreBackup',
  'tabthrough.discardRecovery',
  'tabthrough.showStepDetail',
  'tabthrough.showWalkthrough',
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
      if (enabled)
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

function isSidebarMessage(value: unknown): value is { readonly command: string } {
  if (typeof value !== 'object' || value === null || !('command' in value))
    return false
  const command = (value as { command?: unknown }).command
  return typeof command === 'string' && SIDEBAR_COMMANDS.has(command)
}

/** Installs the sidebar and refreshes both native projections from Reatom. */
export function useGuideSidebar(): void {
  const view = useAtomRef(sidebarViewModel)
  const webview = new SidebarWebviewProvider(() => view.value)
  useDisposable(webview)
  useDisposable(window.registerWebviewViewProvider('tabthrough.sidebar', webview, { webviewOptions: { retainContextWhenHidden: true } }))
  let sessionShown = false
  watch(view, () => {
    webview.update()
    if (view.value.status === 'idle') {
      sessionShown = false
    }
    else if (view.value.status === 'active' && !sessionShown) {
      sessionShown = true
      void VscodeCommands.executeCommand('tabthrough.sidebar.focus', { preserveFocus: true })
        .then(undefined, () => undefined)
    }
  }, { immediate: true })
}

/** Read helper for tests and diagnostics without constructing VS Code items. */
export function readSidebarItems(): readonly ReturnType<typeof sidebarItems>[number][] {
  return sidebarItems(peek(sidebarViewModel))
}
