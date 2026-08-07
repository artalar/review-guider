import type { ReviewTarget } from '../../src/git/types'
import type { NotifyLevel, Ports, StorePort } from '../../src/model/ports'
import type { Session } from '../../src/model/steps'
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
  startSession,
  workspaceRoot,
} from '../../src/model/session'
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
  /** How the scripted `UiPort` answers the pre-flight. */
  approve: boolean
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
    approve: true,
    dispose: () => {
      while (unsubscribes.length > 0)
        unsubscribes.pop()?.()
    },
  }

  const installed: Ports = {
    store,
    ui: {
      confirm: async () => harness.approve,
      notify: async (level, message) => {
        notifications.push({ level, message })
        return undefined
      },
      openReview: async () => {},
    },
    clock: {
      now: () => 1_000,
      sessionId: () => 'entry-session',
    },
  }

  ports.set(installed)
  workspaceRoot.set(root)

  unsubscribes.push(canStart.subscribe(() => {}), recoveryPending.subscribe(() => {}))
  if (options.withReview === true)
    unsubscribes.push(reviewViewModel.subscribe(() => {}))

  await gitCapability()
  await recoveryToken()
  return harness
}

/** Starts a session and plays the bridge's part in the pre-flight handshake. */
export async function startReview(harness: ModelHarness, entry: ReviewTarget): Promise<Session> {
  const running = startSession({ entry })
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
