import type { ReviewTarget } from '../../src/git/types'
import type { LineRange } from '../../src/guide/types'
import type { NotifyLevel, Ports } from '../../src/model/ports'
import type { StartRequest } from '../../src/model/session'
import type { Session } from '../../src/model/steps'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  canStart,
  connectOwnershipWatch,
  gitCapability,
  gitState,
  ports,
  sequenceEditorExecPath,
  sequenceEditorPath,
  startPreview,
  startSession,
  workspaceRoot,
} from '../../src/model/session'
import { setupPhase, sidecarExists, skillInstalled } from '../../src/model/setup'
import { reviewViewModel } from '../../src/model/view'

/**
 * Drives the Reatom model the way the bridge does: in-memory ports and the
 * gating computeds connected. Async computeds only refresh while something is
 * listening, so a harness that skipped them would assert against a stale cache.
 */

export interface Notification {
  readonly level: NotifyLevel
  readonly message: string
}

export interface OpenedAt {
  readonly path: string
  readonly line: number
  readonly ranges: readonly LineRange[]
}

export interface ModelHarness {
  readonly notifications: Notification[]
  readonly writes: Array<{ readonly path: string, readonly text: string }>
  readonly agentPrompts: string[]
  readonly openedFiles: string[]
  readonly openedAt: OpenedAt[]
  readonly gitLogs: Array<{ readonly command: string, readonly code: number }>
  /** Which action button a notification comes back with, if any. */
  answer: string | undefined
  /** How many times the SCM handoff port was opened. */
  scmOpened: number
  saveDocumentsResult: { readonly ok: true } | { readonly ok: false, readonly path: string }
  readonly saveDocumentsCalls: Array<{ readonly repoRoot: string, readonly paths: readonly string[] }>
  pickedUntracked: readonly string[]
  pickUntrackedCancelled: boolean
  pickUntrackedWait: Promise<readonly string[] | undefined> | null
  onPickUntracked: (() => void) | null
  notifyWait: Promise<string | undefined> | null
  onNotify: (() => void) | null
  readonly dispose: () => void
}

export interface BootstrapOptions {
  readonly withReview?: boolean
  readonly sessionId?: string
}

export async function bootstrapModel(root: string, options: BootstrapOptions = {}): Promise<ModelHarness> {
  const notifications: Notification[] = []
  const unsubscribes: Array<() => void> = []

  const harness: ModelHarness = {
    notifications,
    writes: [],
    agentPrompts: [],
    openedFiles: [],
    openedAt: [],
    gitLogs: [],
    answer: undefined,
    scmOpened: 0,
    saveDocumentsResult: { ok: true },
    saveDocumentsCalls: [],
    pickedUntracked: [],
    pickUntrackedCancelled: false,
    pickUntrackedWait: null,
    onPickUntracked: null,
    notifyWait: null,
    onNotify: null,
    dispose: () => {
      while (unsubscribes.length > 0)
        unsubscribes.pop()?.()
    },
  }

  const installed: Ports = {
    ui: {
      notify: async (level, message) => {
        notifications.push({ level, message })
        harness.onNotify?.()
        if (harness.notifyWait !== null)
          return await harness.notifyWait
        return harness.answer
      },
      openReview: async () => {},
      openWorkspaceFile: async (_repoRoot, path) => {
        harness.openedFiles.push(path)
      },
      openFileAt: async (_repoRoot, path, line, ranges) => {
        harness.openedAt.push({ path, line, ranges })
      },
      openSourceControl: async () => {
        harness.scmOpened += 1
      },
      openFolder: async () => {},
      saveDocuments: async (repoRoot, paths) => {
        harness.saveDocumentsCalls.push({ repoRoot, paths })
        return harness.saveDocumentsResult
      },
      writeTextFile: async (repoRoot, path, text) => {
        const absolute = join(repoRoot, path)
        await mkdir(dirname(absolute), { recursive: true })
        await writeFile(absolute, text, 'utf8')
        harness.writes.push({ path, text })
      },
      fileExists: async (repoRoot, path) => {
        try {
          await access(join(repoRoot, path))
          return true
        }
        catch {
          return false
        }
      },
      readBundledSkill: async () => '# Tabthrough\n',
      openAgentChat: async (prompt) => {
        harness.agentPrompts.push(prompt)
      },
      logGit: (result) => {
        harness.gitLogs.push({ command: result.command, code: result.code })
      },
      pickUntracked: async () => {
        harness.onPickUntracked?.()
        if (harness.pickUntrackedWait !== null)
          return await harness.pickUntrackedWait
        if (harness.pickUntrackedCancelled)
          return undefined
        return harness.pickedUntracked
      },
    },
    clock: {
      sessionId: () => options.sessionId ?? 'entry-session',
    },
  }

  ports.set(installed)
  workspaceRoot.set(root)
  sequenceEditorPath.set(fileURLToPath(new URL('./sequence-editor.cjs', import.meta.url)))
  sequenceEditorExecPath.set(process.execPath)

  unsubscribes.push(
    canStart.subscribe(() => {}),
    gitState.subscribe(() => {}),
    startPreview.subscribe(() => {}),
    connectOwnershipWatch(),
    skillInstalled.subscribe(() => {}),
    sidecarExists.subscribe(() => {}),
    setupPhase.subscribe(() => {}),
  )
  if (options.withReview === true)
    unsubscribes.push(reviewViewModel.subscribe(() => {}))

  await gitCapability()
  await skillInstalled()
  await sidecarExists()
  return harness
}

function isStartRequest(request: ReviewTarget | StartRequest): request is StartRequest {
  return 'entry' in request
}

export async function startReview(
  harness: ModelHarness,
  request: ReviewTarget | StartRequest,
): Promise<Session> {
  void harness
  return await startSession(isStartRequest(request) ? request : { entry: request })
}
