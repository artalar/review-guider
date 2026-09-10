import process from 'node:process'
import { connectLogger, sleep, wrap } from '@reatom/core'
import { defineExtension, useFileSystemWatcher, useWorkspaceFolders, watchEffect } from 'reactive-vscode'
import { useGuideCommands } from './commands'
import { config } from './config'
import {
  cancelSession,
  canStart,
  gitWatchToken,
  guideFile,
  heuristicOptions,
  revealMode,
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
    heuristicOptions.set({
      maxLinesPerStep: config.maxLinesPerStep,
      intraHunkGap: 1,
      hideFormattingSteps: config.hideFormattingSteps,
    })
  }))
}

function bindGitWatcher(): void {
  const bump = wrap(() => gitWatchToken.set(value => value + 1))
  useFileSystemWatcher('**/.git/{HEAD,index,MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,BISECT_LOG,refs/**,rebase-merge/**,rebase-apply/**}', {
    onDidCreate: bump,
    onDidChange: bump,
    onDidDelete: bump,
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
