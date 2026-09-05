import process from 'node:process'
import { connectLogger, effect, sleep, wrap } from '@reatom/core'
import { defineExtension, useDisposable, useFileSystemWatcher, useWorkspaceFolders, watchEffect } from 'reactive-vscode'
import { useGuideCommands } from './commands'
import { config } from './config'
import {
  cancelSession,
  canStart,
  gitWatchToken,
  guideFile,
  HEARTBEAT_INTERVAL_MS,
  heuristicOptions,
  isSessionOpen,
  refreshHeartbeat,
  revealMode,
  sessionModeSetting,
  showRationale,
  stashIncludeUntracked,
  workspaceRoot,
} from './model/session'
import { useActiveGuideContext } from './ui/active-guide'
import { useAtomRef } from './ui/binding'
import { useReviewDecorations, useReviewDocuments } from './ui/documents'
import { installPorts } from './ui/ports'
import { checkRecoveryOnActivate, useGuideDiagnostics, usePreflightPrompt, useRestoreBlockNotice } from './ui/prompts'
import { useGuideSidebar } from './ui/sidebar'
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
  bindSessionHeartbeat()

  usePreflightPrompt()
  useRestoreBlockNotice()
  useGuideDiagnostics()
  useReviewDocuments()
  useReviewDecorations()
  useGuideCommands()
  useGuideStatusBar()
  useGuideSidebar()
  useGuideContextKeys()
  useActiveGuideContext()

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
    sessionModeSetting.set(config['session.mode'])
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

/**
 * The window that owns a session says so on the token, roughly every seven
 * seconds. It is the only thing that tells a second window "still running
 * here" from "crashed" — from git state alone the two look identical, and the
 * second window used to offer to restore a review that was going fine.
 *
 * The loop lives here rather than in the model because `effect` self-subscribes
 * at creation: created at activation it is owned by the extension's lifetime
 * and disposed with it, instead of running forever from module scope.
 */
function bindSessionHeartbeat(): void {
  const { unsubscribe } = effect(async () => {
    while (isSessionOpen()) {
      await wrap(sleep(HEARTBEAT_INTERVAL_MS))
      await wrap(refreshHeartbeat())
    }
  }, 'session.heartbeatLoop')
  useDisposable({ dispose: unsubscribe })
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
