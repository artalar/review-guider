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
  showRationale,
  stashIncludeUntracked,
  workspaceRoot,
} from './model/session'
import { useAtomRef } from './ui/binding'
import { useReviewDecorations, useReviewDocuments } from './ui/documents'
import { installPorts } from './ui/ports'
import { checkRecoveryOnActivate, useGuideDiagnostics, usePreflightPrompt, useRestoreBlockNotice } from './ui/prompts'
import { useGuideContextKeys, useGuideStatusBar } from './ui/status-bar'
import { logger } from './utils'

/**
 * There is no Reatom scope to create: atoms are module-level in the implicit
 * global context, and `context.reset()` is forbidden under `src/` because it
 * rejects wrapped promises with abort errors — during an in-flight restore that
 * is precisely the outcome the safety design exists to prevent (ADR 0002 D6).
 */
const { activate, deactivate: disposeScope } = defineExtension(() => {
  if (process.env.NODE_ENV === 'development')
    connectLogger()

  installPorts()
  bindWorkspaceRoot()
  bindConfig()
  bindGitWatcher()

  usePreflightPrompt()
  useRestoreBlockNotice()
  useGuideDiagnostics()
  useReviewDocuments()
  useReviewDecorations()
  useGuideCommands()
  useGuideStatusBar()
  useGuideContextKeys()

  // Keeps the gating computeds connected so the context keys stay live.
  useAtomRef(canStart)

  void checkRecoveryOnActivate().catch(error => logger.error('recovery check failed', error))
})

function bindWorkspaceRoot(): void {
  const folders = useWorkspaceFolders()
  // MVP: first root only. `workspaceRoot` is the single choke point for P2.
  watchEffect(wrap(() => {
    workspaceRoot.set(folders.value?.[0]?.uri.fsPath ?? null)
  }))
}

function bindConfig(): void {
  watchEffect(wrap(() => {
    showRationale.set(config.showRationale)
    guideFile.set(config.guideFile)
    revealMode.set(config['reveal.mode'])
    stashIncludeUntracked.set(config['stash.includeUntracked'])
    heuristicOptions.set({
      maxLinesPerStep: config.maxLinesPerStep,
      intraHunkGap: 1,
      hideFormattingSteps: config.hideFormattingSteps,
    })
  }))
}

function bindGitWatcher(): void {
  // Dependency-driven refresh: the bridge never calls a refresh function, it
  // bumps a token and the probes recompute themselves.
  const bump = wrap(() => gitWatchToken.set(value => value + 1))
  useFileSystemWatcher('**/.git/{HEAD,index,MERGE_HEAD,refs/**}', {
    onDidCreate: bump,
    onDidChange: bump,
    onDidDelete: bump,
  })
}

export { activate }

/**
 * Disposal order is load-bearing: drain the restore *before* disposing the
 * scope, because disposal unsubscribes the Reatom projections. A truncated
 * deactivate is safe — the journal on disk is what the next activation reads.
 */
export async function deactivate(): Promise<void> {
  try {
    await Promise.race([cancelSession('deactivate'), sleep(4000)])
  }
  catch (error) {
    logger.error('deactivate restore failed', error)
  }
  await disposeScope()
}
