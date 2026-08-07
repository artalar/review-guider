import type { IsolationStage, SessionToken } from '../../src/git/journal'
import { describe, expect, it } from 'vitest'
import {
  advanceStage,
  HEARTBEAT_STALE_MS,
  IllegalStageError,
  ISOLATION_STAGES,
  isRecoverable,
  isSessionLive,
  parseToken,
  repoKey,
  stashMessageFor,
  withStage,
} from '../../src/git/journal'
import { memoryStore } from '../../src/model/ports'

/**
 * The journal is what recovery depends on, so its transition table gets the
 * same treatment as the session status machine: every pair asserted, not just
 * the happy path.
 */

const BASE: SessionToken = {
  v: 1,
  sessionId: 'abc',
  createdAt: 1,
  heartbeatAt: null,
  repoRoot: '/repo',
  stage: 'planned',
  entry: { kind: 'workingTree' },
  headBefore: { kind: 'branch', name: 'main' },
  lockValue: 'deadbeef',
  afterRef: 'refs/tabthrough/after/abc',
  afterCommit: null,
  afterTree: null,
  statusDigest: null,
  backupRef: null,
  backupCommit: null,
  stashMessage: null,
  checkedOut: null,
}

/** Every transition the protocol is allowed to make, listed exhaustively. */
const LEGAL: Readonly<Record<IsolationStage, readonly IsolationStage[]>> = {
  planned: ['captured', 'restoring', 'done'],
  captured: ['stashed', 'checkedout', 'restoring', 'done'],
  stashed: ['checkedout', 'restoring'],
  checkedout: ['reviewing', 'restoring'],
  reviewing: ['restoring'],
  restoring: ['restoring', 'done'],
  done: [],
}

function at(stage: IsolationStage): SessionToken {
  return { ...BASE, stage }
}

describe('journal stage table', () => {
  for (const from of ISOLATION_STAGES) {
    for (const to of ISOLATION_STAGES) {
      const allowed = from === to || LEGAL[from].includes(to)
      it(`${allowed ? 'allows' : 'rejects'} ${from} -> ${to}`, () => {
        if (allowed)
          expect(withStage(at(from), to).stage).toBe(to)
        else
          expect(() => withStage(at(from), to)).toThrow(IllegalStageError)
      })
    }
  }

  it('is a no-op when the stage does not change', () => {
    const token = at('stashed')
    expect(withStage(token, 'stashed')).toBe(token)
  })

  it('never leaves "done"', () => {
    for (const to of ISOLATION_STAGES.filter(stage => stage !== 'done'))
      expect(() => withStage(at('done'), to)).toThrow(IllegalStageError)
  })
})

describe('advanceStage', () => {
  it('persists the new stage before returning it', async () => {
    const store = memoryStore()
    const advanced = await advanceStage(store, BASE, 'captured')

    expect(advanced.stage).toBe('captured')
    expect((await store.readToken('/repo'))?.stage).toBe('captured')
  })

  it('writes nothing when the transition is illegal', async () => {
    const store = memoryStore()
    await store.writeToken(BASE)

    await expect(advanceStage(store, BASE, 'reviewing')).rejects.toThrow(IllegalStageError)
    expect((await store.readToken('/repo'))?.stage).toBe('planned')
  })
})

describe('isRecoverable', () => {
  it('ignores the states where nothing is outstanding', () => {
    expect(isRecoverable(null)).toBe(false)
    expect(isRecoverable(at('planned'))).toBe(false)
    expect(isRecoverable(at('done'))).toBe(false)
  })

  it('flags every state that mutated something', () => {
    for (const stage of ['captured', 'stashed', 'checkedout', 'reviewing', 'restoring'] as const)
      expect(isRecoverable(at(stage))).toBe(true)
  })
})

/**
 * The distinction the second window depends on: `isRecoverable` says something
 * was mutated, `isSessionLive` says a window is still standing over it. Only
 * the heartbeat can tell them apart — git state cannot.
 */
describe('isSessionLive', () => {
  const NOW = 1_000_000
  const live = (stage: IsolationStage, heartbeatAt: number | null): SessionToken =>
    ({ ...BASE, stage, heartbeatAt })

  it('is live while the heartbeat is fresh', () => {
    expect(isSessionLive(live('reviewing', NOW), NOW)).toBe(true)
    expect(isSessionLive(live('reviewing', NOW - (HEARTBEAT_STALE_MS - 1)), NOW)).toBe(true)
  })

  it('goes stale on the window the crash matrix restores from', () => {
    expect(isSessionLive(live('reviewing', NOW - HEARTBEAT_STALE_MS), NOW)).toBe(false)
    expect(isSessionLive(live('reviewing', NOW - 10 * HEARTBEAT_STALE_MS), NOW)).toBe(false)
  })

  it('reads a token written before the field existed as not live', () => {
    expect(isSessionLive(live('reviewing', null), NOW)).toBe(false)
    expect(isSessionLive(null, NOW)).toBe(false)
  })

  /**
   * Every stage that mutated something, not just `reviewing`: a second window
   * that catches the first mid-isolation must stay out of the way too, and
   * that window is the most dangerous one to race.
   */
  it('covers every recoverable stage, and no others', () => {
    for (const stage of ['captured', 'stashed', 'checkedout', 'reviewing', 'restoring'] as const)
      expect(isSessionLive(live(stage, NOW), NOW)).toBe(true)
    for (const stage of ['planned', 'done'] as const)
      expect(isSessionLive(live(stage, NOW), NOW)).toBe(false)
  })

  /** A clock jump must not suppress recovery until the wall clock catches up. */
  it('does not trust a heartbeat from the far future', () => {
    expect(isSessionLive(live('reviewing', NOW + 10 * HEARTBEAT_STALE_MS), NOW)).toBe(false)
  })
})

describe('repoKey', () => {
  it('is stable across separator and trailing-slash noise', () => {
    expect(repoKey('/home/me/repo')).toBe(repoKey('/home/me/repo/'))
    expect(repoKey('C:\\work\\repo')).toBe(repoKey('C:/work/repo'))
  })

  it('separates different repositories', () => {
    expect(repoKey('/a')).not.toBe(repoKey('/b'))
  })
})

describe('stashMessageFor', () => {
  it('scopes the message so no other tool can collide with it', () => {
    expect(stashMessageFor('s1')).toBe('tabthrough:s1')
    expect(stashMessageFor('s1')).not.toBe(stashMessageFor('s2'))
  })
})

describe('parseToken', () => {
  it('round-trips a token through JSON', () => {
    const token: SessionToken = { ...BASE, stage: 'stashed', afterCommit: 'aaa', stashMessage: 'tabthrough:abc' }
    expect(parseToken(JSON.parse(JSON.stringify(token)))).toEqual(token)
  })

  it('reads a detached head and a range entry', () => {
    const token: SessionToken = {
      ...BASE,
      entry: { kind: 'range', from: 'a', to: 'b' },
      headBefore: { kind: 'detached', sha: 'cafe' },
    }
    expect(parseToken(JSON.parse(JSON.stringify(token)))).toEqual(token)
  })

  it('reports malformed input as absent rather than throwing', () => {
    const cases: readonly unknown[] = [
      null,
      undefined,
      'a string',
      [],
      {},
      { ...BASE, v: 2 },
      { ...BASE, stage: 'wandering' },
      { ...BASE, entry: { kind: 'nonsense' } },
      { ...BASE, headBefore: { kind: 'branch' } },
      { ...BASE, sessionId: 42 },
    ]
    for (const input of cases)
      expect(parseToken(input)).toBeNull()
  })

  it('defaults a missing timestamp instead of rejecting the token', () => {
    const { createdAt: _dropped, ...rest } = BASE
    expect(parseToken(rest)?.createdAt).toBe(0)
  })

  /**
   * The heartbeat was added without leaving `v: 1`, so a token written by an
   * older build has to keep parsing — as not live, which only ever costs a
   * recovery prompt nobody needed.
   */
  it('reads a token that predates the heartbeat', () => {
    const { heartbeatAt: _dropped, ...rest } = BASE
    expect(parseToken(rest)?.heartbeatAt).toBeNull()
    expect(parseToken({ ...BASE, heartbeatAt: 'soon' })?.heartbeatAt).toBeNull()
    expect(parseToken({ ...BASE, heartbeatAt: 42 })?.heartbeatAt).toBe(42)
  })
})
