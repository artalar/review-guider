import type { SessionStatus } from '../../src/model/session'
import { context } from '@reatom/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IllegalTransitionError,
  isSessionActive,
  LEGAL_TRANSITIONS,
  sessionStatus,
} from '../../src/model/session'

/**
 * The plan's Phase 1 gate: enumerate every legal and illegal pair. Illegal
 * transitions must be rejected, never silently applied.
 */

const ALL: readonly SessionStatus[] = ['idle', 'preflight', 'stashing', 'active', 'restoring', 'blocked', 'error']

// `error` and `blocked` are only reachable through a mutation, so tests reach
// them the same way the model does, one legal hop at a time.
const PATHS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: [],
  preflight: ['preflight'],
  stashing: ['preflight', 'stashing'],
  active: ['preflight', 'stashing', 'active'],
  restoring: ['preflight', 'stashing', 'active', 'restoring'],
  blocked: ['preflight', 'stashing', 'active', 'restoring', 'blocked'],
  error: ['preflight', 'error'],
}

function moveTo(status: SessionStatus): void {
  for (const step of PATHS[status])
    sessionStatus.to(step)
}

beforeEach(() => context.reset())

describe('session status machine', () => {
  it('starts idle', () => {
    context.start(() => {
      expect(sessionStatus()).toBe('idle')
      expect(isSessionActive()).toBe(false)
    })
  })

  it('accepts every legal pair', () => {
    for (const from of ALL) {
      for (const to of LEGAL_TRANSITIONS[from]) {
        context.reset()
        context.start(() => {
          moveTo(from)
          expect(sessionStatus()).toBe(from)
          expect(sessionStatus.to(to)).toBe(to)
          expect(sessionStatus()).toBe(to)
        })
      }
    }
  })

  it('rejects every illegal pair', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (to === from || LEGAL_TRANSITIONS[from].includes(to))
          continue
        context.reset()
        context.start(() => {
          moveTo(from)
          expect(() => sessionStatus.to(to)).toThrow(IllegalTransitionError)
          expect(sessionStatus()).toBe(from)
        })
      }
    }
  })

  it('treats a self-transition as a no-op', () => {
    context.start(() => {
      expect(sessionStatus.to('idle')).toBe('idle')
      expect(sessionStatus()).toBe('idle')
    })
  })

  it('never allows active -> stashing', () => {
    context.start(() => {
      moveTo('active')
      expect(() => sessionStatus.to('stashing')).toThrow(IllegalTransitionError)
    })
  })

  it('tracks isSessionActive', () => {
    context.start(() => {
      moveTo('active')
      expect(isSessionActive()).toBe(true)
      sessionStatus.to('restoring')
      expect(isSessionActive()).toBe(false)
    })
  })
})
