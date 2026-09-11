import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { connectLogger, sleep, wrap } from '@reatom/core'
import { defineExtension, useDisposable, useFileSystemWatcher, useWorkspaceFolders, watchEffect } from 'reactive-vscode'
import { useGuideCommands } from './commands'
import { config } from './config'
import {
  bumpGitWatch,
  cancelSession,
  canStart,
  connectGuideCursorPersist,
  connectOwnershipWatch,
  finishHooks,
  finishSign,
  guideFile,
  heuristicOptions,
  revealMode,
  sequenceEditorExecPath,
  sequenceEditorPath,
  sessionModeSetting,
  showRationale,
  sweepOnActivate,
  workspaceRoot,
  worktreeDir,
} from './model/session'
import { useActiveGuideContext } from './ui/active-guide'
import { useAtomRef } from './ui/binding'
import { useReviewDecorations, useReviewDocuments } from './ui/documents'
import { installPorts } from './ui/ports'
import { useGuideDiagnostics } from './ui/prompts'
import { useGuideSidebar } from './ui/sidebar'
import { useGuideContextKeys, useGuideStatusBar } from './ui/status-bar'
import { logger } from './utils'

const { activate, deactivate: disposeScope } = defineExtension(() => {
  if (process.env.NODE_ENV === 'development')
    connectLogger()

  installPorts()
  bindWorkspaceRoot()
  bindConfig()
  bindGitWatcher()
  sequenceEditorPath.set(join(dirname(fileURLToPath(import.meta.url)), 'sequence-editor.cjs'))
  sequenceEditorExecPath.set(process.execPath)
  useDisposable({ dispose: connectOwnershipWatch() })
  useDisposable({ dispose: connectGuideCursorPersist() })

  useGuideDiagnostics()
  useReviewDocuments()
  useReviewDecorations()
  useGuideCommands()
  useGuideStatusBar()
  useGuideSidebar()
  useGuideContextKeys()
  useActiveGuideContext()

  useAtomRef(canStart)

  void sweepOnActivate().catch(error => logger.error('activation sweep failed', error))
})

function bindWorkspaceRoot(): void {
  const folders = useWorkspaceFolders()
  watchEffect(wrap(() => {
    workspaceRoot.set(folders.value?.[0]?.uri.fsPath ?? null)
  }))
}

function bindConfig(): void {
  watchEffect(wrap(() => {
    showRationale.set(config.showRationale)
    guideFile.set(config.guideFile)
    revealMode.set(config['reveal.mode'])
    sessionModeSetting.set(config['session.mode'])
    worktreeDir.set(config['worktree.dir'])
    finishHooks.set(config['finish.hooks'])
    finishSign.set(config['finish.sign'])
    heuristicOptions.set({
      maxLinesPerStep: config.maxLinesPerStep,
      intraHunkGap: 1,
      hideFormattingSteps: config.hideFormattingSteps,
    })
  }))
}

function bindGitWatcher(): void {
  const bumpRepo = wrap(() => {
    void bumpGitWatch('repo')
  })
  const bumpWorktree = wrap(() => {
    void bumpGitWatch('worktree')
  })
  useFileSystemWatcher('**/.git/{HEAD,logs/HEAD,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_LOG,rebase-merge/**,rebase-apply/**}', {
    onDidCreate: bumpRepo,
    onDidChange: bumpRepo,
    onDidDelete: bumpRepo,
  })
  useFileSystemWatcher('**/.git/{index,refs/stash}', {
    onDidCreate: bumpWorktree,
    onDidChange: bumpWorktree,
    onDidDelete: bumpWorktree,
  })
}

export { activate }

export async function deactivate(): Promise<void> {
  try {
    await Promise.race([cancelSession('deactivate'), sleep(4000)])
  }
  catch (error) {
    logger.error('deactivate close failed', error)
  }
  await disposeScope()
}
