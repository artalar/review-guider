import type { SessionToken, TokenStore } from '../git/journal'
import type { PreflightRequest } from '../git/types'
import { repoKey } from '../git/journal'

/**
 * Everything the model needs from VS Code, as interfaces only. The bridge
 * installs real implementations at activation; tests substitute in-memory ones.
 * See architecture/overview.md §5.2.
 */

export type StorePort = TokenStore

export type NotifyLevel = 'info' | 'warn' | 'error'

export interface ReviewDocTarget {
  readonly sessionId: string
  readonly path: string
  readonly baseRev: string
  readonly title: string
}

export interface UiPort {
  confirm: (request: PreflightRequest) => Promise<boolean>
  notify: (level: NotifyLevel, message: string, actions?: readonly string[]) => Promise<string | undefined>
  openReview: (target: ReviewDocTarget) => Promise<void>
}

export interface ClockPort {
  now: () => number
  sessionId: () => string
}

export interface Ports {
  readonly store: StorePort
  readonly ui: UiPort
  readonly clock: ClockPort
}

/**
 * The default installed before activation. It refuses rather than pretends: a
 * confirm that silently returned `true` here would let a mis-ordered bootstrap
 * mutate a repository with no user consent.
 */
export const inertPorts: Ports = {
  store: {
    readToken: async () => null,
    writeToken: async () => {},
    clearToken: async () => {},
  },
  ui: {
    confirm: async () => false,
    notify: async () => undefined,
    openReview: async () => {},
  },
  clock: {
    now: () => Date.now(),
    sessionId: () => 'inert',
  },
}

/** In-memory `StorePort`, keyed like production (`repoKey`). Used by tests and the crash matrix. */
export function memoryStore(initial?: SessionToken | null): StorePort & { snapshot: () => SessionToken | null } {
  const tokens = new Map<string, SessionToken>()
  if (initial)
    tokens.set(repoKey(initial.repoRoot), initial)
  return {
    readToken: async repoRoot => tokens.get(repoKey(repoRoot)) ?? null,
    writeToken: async (token) => { tokens.set(repoKey(token.repoRoot), token) },
    clearToken: async (repoRoot) => { tokens.delete(repoKey(repoRoot)) },
    snapshot: () => tokens.values().next().value ?? null,
  }
}
