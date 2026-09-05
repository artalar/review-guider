import type { ReviewTarget } from '../../src/git/types'
import type { NotifyLevel, Ports, StorePort } from '../../src/model/ports'
import type { StartRequest } from '../../src/model/session'
import type { Session } from '../../src/model/steps'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { peek } from '@reatom/core'
import { vi } from 'vitest'
import { memoryStore } from '../../src/model/ports'
import {
  canStart,
  gitCapability,
  ports,
  preflightAnswer,
  preflightRequest,
  recoveryPending,
  recoveryToken,
  repoLockOwner,
  staleLock,
  startSession,
  workspaceRoot,
} from '../../src/model/session'
import { sidecarExists, skillInstalled } from '../../src/model/setup'
import { reviewViewModel } from '../../src/model/view'

/**
 * Drives the Reatom model the way the bridge does: in-memory ports, the
 * gating computeds connected, and the pre-flight answered by hand.
 *
 * The bridge's own subscriptions are not decoration here — the async
 * computeds only refresh while something is listening, so a harness that
 * skipped them would assert against a never-updated cache.
 */

export interface Notification {
  readonly level: NotifyLevel
  readonly message: string
}

export interface ModelHarness {
  readonly store: StorePort
  readonly notifications: Notification[]
  readonly writes: Array<{ readonly path: string, readonly text: string }>
  readonly agentPrompts: string[]
  readonly openedFiles: string[]
  /** How the scripted `UiPort` answers the pre-flight. */
  approve: boolean
  /** Which action button a notification comes back with, if any. */
  answer: string | undefined
  /** How many times the SCM handoff port was opened. */
  scmOpened: number
  readonly dispose: () => void
}

export interface BootstrapOptions {
  readonly store?: StorePort
  /** Also connect `reviewViewModel`, which is what starts the base-blob reads. */
  readonly withReview?: boolean
}

export async function bootstrapModel(root: string, options: BootstrapOptions = {}): Promise<ModelHarness> {
  const store = options.store ?? memoryStore()
  const notifications: Notification[] = []
  const unsubscribes: Array<() => void> = []

  const harness: ModelHarness = {
    store,
    notifications,
    writes: [],
    agentPrompts: [],
    openedFiles: [],
    approve: true,
    answer: undefined,
    scmOpened: 0,
    dispose: () => {
      while (unsubscribes.length > 0)
        unsubscribes.pop()?.()
    },
  }

  const installed: Ports = {
    store,
    ui: {
      confirm: async () => harness.approve,
      chooseSessionMode: async () => 'readonly',
      notify: async (level, message) => {
        notifications.push({ level, message })
        return harness.answer
      },
      openReview: async () => {},
      openWorkspaceFile: async (_repoRoot, path) => {
        harness.openedFiles.push(path)
      },
      openSourceControl: async () => {
        harness.scmOpened += 1
      },
      saveDocuments: async () => ({ ok: true }),
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
    },
    clock: {
      now: () => 1_000,
      sessionId: () => 'entry-session',
    },
  }

  ports.set(installed)
  workspaceRoot.set(root)

  unsubscribes.push(
    canStart.subscribe(() => {}),
    recoveryPending.subscribe(() => {}),
    staleLock.subscribe(() => {}),
    skillInstalled.subscribe(() => {}),
    sidecarExists.subscribe(() => {}),
  )
  if (options.withReview === true)
    unsubscribes.push(reviewViewModel.subscribe(() => {}))

  await gitCapability()
  await recoveryToken()
  await repoLockOwner()
  await skillInstalled()
  await sidecarExists()
  return harness
}

function isStartRequest(request: ReviewTarget | StartRequest): request is StartRequest {
  return 'entry' in request
}

/** Starts a session and plays the bridge's part in the pre-flight handshake. */
export async function startReview(
  harness: ModelHarness,
  request: ReviewTarget | StartRequest,
): Promise<Session> {
  const running = startSession(isStartRequest(request) ? request : { entry: request })
  const settled = running.then(() => undefined, () => undefined)

  await Promise.race([
    settled,
    vi.waitFor(() => {
      if (peek(preflightRequest) === null)
        throw new Error('pre-flight not published yet')
    }, { timeout: 5_000, interval: 5 }),
  ])

  if (peek(preflightRequest) !== null)
    preflightAnswer(harness.approve)

  return await running
}
