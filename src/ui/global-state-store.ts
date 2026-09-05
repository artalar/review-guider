import type { SessionToken, TokenStore } from '../git/journal'
import { parseToken, repoKey } from '../git/journal'

const TOKEN_PREFIX = 'tabthrough.token.'

/**
 * The slice of VS Code `ExtensionContext` the journal needs. Tests pass a fake
 * bag without constructing a full host context.
 */
export interface GlobalStateBag {
  get: <T>(key: string) => T | undefined
  update: (key: string, value: unknown) => PromiseLike<void>
}

export interface GlobalStateContext {
  readonly globalState: GlobalStateBag
}

/**
 * `globalState`, not `workspaceState`: a second window on the same repository
 * must be able to see the journal, and it must survive the folder being
 * reopened by another path (ADR 0002 D3).
 *
 * The context is captured by reference at construction. `deactivate` may null
 * the reactive `extensionContext` while a restore is still draining; the
 * journal must still be able to write `done` / clear the token after that.
 */
export function createGlobalStateStore(context: GlobalStateContext): TokenStore {
  return {
    async readToken(repoRoot) {
      return parseToken(context.globalState.get<unknown>(TOKEN_PREFIX + repoKey(repoRoot)))
    },
    async writeToken(token: SessionToken) {
      await context.globalState.update(TOKEN_PREFIX + repoKey(token.repoRoot), token)
    },
    async clearToken(repoRoot) {
      await context.globalState.update(TOKEN_PREFIX + repoKey(repoRoot), undefined)
    },
  }
}
