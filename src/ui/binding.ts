import type { AtomLike } from '@reatom/core'
import type { ShallowRef } from 'reactive-vscode'
import { peek } from '@reatom/core'
import { shallowRef, useDisposable } from 'reactive-vscode'
import { logger } from '../utils'

/** Any readable, subscribable Reatom target: `atom`, `computed`, or an extended one. */
export type ReadableAtom<T> = AtomLike<T, [], T>

/**
 * The one adapter between Reatom and reactive-vscode. Reatom owns state,
 * reactive-vscode owns VS Code lifetimes, and this is the whole seam.
 */
export function useAtomRef<T>(target: ReadableAtom<T>): ShallowRef<T> {
  const state = shallowRef(peek(target)) as ShallowRef<T>
  const unsubscribe = target.subscribe(
    (value) => { state.value = value },
    // Not optional: an async computed that rejects — a failing `git cat-file`,
    // say — must land in the output channel, not become an unhandled rejection.
    error => logger.error(`[${target.name}]`, error),
  )
  useDisposable({ dispose: unsubscribe })
  return state
}
