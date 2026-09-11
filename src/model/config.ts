import type { SessionMode } from '../git/types'
import type { HeuristicOptions } from '../guide/heuristic'
import { atom } from '@reatom/core'
import { DEFAULT_HEURISTIC_OPTIONS } from '../guide/heuristic'

/**
 * Settings flow one way, VS Code → atoms. The model never writes settings.
 *
 * They live here rather than in `session.ts` because the per-file reveal in
 * `steps.ts` reads `revealMode`, and `session.ts` already imports `steps.ts`.
 */

export type RevealMode = 'progressive' | 'dim'

/** Setting value including the chooser; resolved session uses `SessionMode`. */
export type SessionModeSetting = 'ask' | SessionMode

export const showRationale = atom(true, 'config.showRationale')
export const heuristicOptions = atom<HeuristicOptions>(DEFAULT_HEURISTIC_OPTIONS, 'config.heuristicOptions')
export const guideFile = atom('.tabthrough-guide.json', 'config.guideFile')
export const revealMode = atom<RevealMode>('progressive', 'config.revealMode')
export const sessionModeSetting = atom<SessionModeSetting>('ask', 'config.sessionMode')
export const worktreeDir = atom('', 'config.worktreeDir')
export const finishHooks = atom(false, 'config.finishHooks')
export const finishSign = atom(false, 'config.finishSign')
export const sequenceEditorPath = atom<string | null>(null, 'config.sequenceEditorPath')
export const sequenceEditorExecPath = atom<string | null>(null, 'config.sequenceEditorExecPath')
