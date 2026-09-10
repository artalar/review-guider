import type { GitCommandResult } from '../git/state'
import type { LineRange } from '../guide/types'

/**
 * Everything the model needs from VS Code, as interfaces only. The bridge
 * installs real implementations at activation; tests substitute in-memory ones.
 */

export type NotifyLevel = 'info' | 'warn' | 'error'

export type SaveDocumentsResult
  = | { readonly ok: true }
    | { readonly ok: false, readonly path: string }

export interface ReviewDocTarget {
  readonly sessionId: string
  readonly path: string
  readonly baseRev: string
  readonly title: string
}

export interface UiPort {
  notify: (level: NotifyLevel, message: string, actions?: readonly string[]) => Promise<string | undefined>
  openReview: (target: ReviewDocTarget) => Promise<void>
  openWorkspaceFile: (repoRoot: string, path: string) => Promise<void>
  openFileAt: (repoRoot: string, path: string, line: number, ranges: readonly LineRange[]) => Promise<void>
  openSourceControl: () => Promise<void>
  openFolder: (dir: string, newWindow: boolean) => Promise<void>
  saveDocuments: (repoRoot: string, paths: readonly string[]) => Promise<SaveDocumentsResult>
  writeTextFile: (repoRoot: string, path: string, text: string) => Promise<void>
  fileExists: (repoRoot: string, path: string) => Promise<boolean>
  readBundledSkill: () => Promise<string | null>
  openAgentChat: (prompt: string) => Promise<void>
  logGit: (result: GitCommandResult) => void
}

export interface ClockPort {
  sessionId: () => string
}

export interface Ports {
  readonly ui: UiPort
  readonly clock: ClockPort
}

export const inertPorts: Ports = {
  ui: {
    notify: async () => undefined,
    openReview: async () => {},
    openWorkspaceFile: async () => {},
    openFileAt: async () => {},
    openSourceControl: async () => {},
    openFolder: async () => {},
    saveDocuments: async () => ({ ok: true }),
    writeTextFile: async () => {},
    fileExists: async () => false,
    readBundledSkill: async () => null,
    openAgentChat: async () => {},
    logGit: () => {},
  },
  clock: {
    sessionId: () => 'inert',
  },
}
