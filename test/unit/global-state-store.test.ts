import type { SessionToken } from '../../src/git/journal'
import { describe, expect, it } from 'vitest'
import { createGlobalStateStore } from '../../src/ui/global-state-store'
import {
  describeRecoveryPrompt,
  RECOVERY_DISMISS,
  RECOVERY_LATER,
  RECOVERY_RESTORE,
} from '../../src/ui/recovery-prompt'

const TOKEN: SessionToken = {
  v: 1,
  sessionId: 'aff19ffebe8f',
  createdAt: 1,
  heartbeatAt: null,
  repoRoot: '/repo',
  stage: 'restoring',
  entry: { kind: 'commit', rev: 'abc' },
  headBefore: { kind: 'branch', name: 'main' },
  lockValue: 'deadbeef',
  afterRef: 'refs/tabthrough/after/aff19ffebe8f',
  afterCommit: 'aaa',
  afterTree: 'bbb',
  statusDigest: 'ccc',
  backupRef: null,
  backupCommit: null,
  stashMessage: null,
  checkedOut: 'abc',
  mode: 'readonly',
  appliedIndex: -1,
  appliedRef: null,
}

function memoryMemento() {
  const values = new Map<string, unknown>()
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      if (value === undefined)
        values.delete(key)
      else
        values.set(key, value)
    },
    snapshot: () => values,
  }
}

describe('createGlobalStateStore', () => {
  it('clears a token through a captured context after the reactive host would have nulled it', async () => {
    const memento = memoryMemento()
    const context = { globalState: memento }
    const store = createGlobalStateStore(context)

    await store.writeToken(TOKEN)
    expect(await store.readToken('/repo')).toMatchObject({ sessionId: 'aff19ffebe8f', stage: 'restoring' })

    // Simulate disposeScope nulling extensionContext.value: the store still
    // holds `context`, so finalize can clear the journal.
    await store.clearToken('/repo')
    expect(await store.readToken('/repo')).toBeNull()
    expect(memento.snapshot().size).toBe(0)
  })
})

describe('describeRecoveryPrompt', () => {
  it('names the session and tells the user Later keeps Start blocked', () => {
    const { message, detail } = describeRecoveryPrompt(TOKEN)
    expect(message).toBe('Tabthrough did not finish restoring your work last time.')
    expect(detail).toContain('aff19ffebe8f')
    expect(detail).toContain('"restoring"')
    expect(detail).toContain('Later keeps Start blocked')
    expect(detail).toContain('Dismiss reminder')
  })

  it('exposes the three modal actions the activation prompt wires', () => {
    expect(RECOVERY_RESTORE).toBe('Restore now')
    expect(RECOVERY_LATER).toBe('Later')
    expect(RECOVERY_DISMISS).toBe('Dismiss reminder')
  })
})
