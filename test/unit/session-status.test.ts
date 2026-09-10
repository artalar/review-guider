import type { SessionStatus } from '../../src/model/session'
import { context } from '@reatom/core'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  IllegalTransitionError,
  isSessionActive,
  isSessionOpen,
  LEGAL_TRANSITIONS,
  sessionStatus,
} from '../../src/model/session'

/**
 * ADR 0005 D7: enumerate every legal and illegal pair. Illegal transitions
 * must be rejected, never silently applied.
 */

const ALL: readonly SessionStatus[] = ['idle', 'starting', 'active', 'finishing']

const PATHS: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  idle: [],
  starting: ['starting'],
  active: ['starting', 'active'],
  finishing: ['starting', 'active', 'finishing'],
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
      expect(isSessionOpen()).toBe(false)
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

  it('never allows active -> starting', () => {
    context.start(() => {
      moveTo('active')
      expect(() => sessionStatus.to('starting')).toThrow(IllegalTransitionError)
    })
  })

  it('tracks isSessionActive only while reviewing', () => {
    context.start(() => {
      moveTo('active')
      expect(isSessionActive()).toBe(true)
      expect(isSessionOpen()).toBe(true)
      sessionStatus.to('finishing')
      expect(isSessionActive()).toBe(false)
      expect(isSessionOpen()).toBe(true)
    })
  })
})
