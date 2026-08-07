import type { IsolationStage, SessionToken } from '../../src/git/journal'
import type { StorePort } from '../../src/model/ports'
import type { TmpRepo } from './tmp-repo'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { readHeadPosition } from '../../src/git/isolate'
import { advanceStage, persistToken, stashMessageFor } from '../../src/git/journal'
import { acquireLock, afterRefName, backupRefName, writeRef } from '../../src/git/refs'
import { captureWorkingState, readStatusDigest } from '../../src/git/snapshot'
import { stashPush } from '../../src/git/stash'
import { memoryStore } from '../../src/model/ports'

/**
 * Drives the isolation protocol by hand, stopping at a chosen journal stage.
 *
 * This is the crash matrix: the journal stage is written *before* its
 * operation, so a token that stopped at stage X means at most X happened. Every
 * one of those states must restore byte-identically, and no process needs to be
 * killed to produce them.
 */
export async function isolateUpTo(
  repo: TmpRepo,
  stage: IsolationStage,
  args: { readonly sessionId?: string, readonly checkout?: string | null } = {},
): Promise<{ token: SessionToken, store: StorePort }> {
  const sessionId = args.sessionId ?? 'crashtest'
  const store = memoryStore()
  const headBefore = await readHeadPosition(repo.root)
  const lockValue = (await repo.git('rev-parse', 'HEAD')).trim()

  expect(await acquireLock(repo.root, lockValue)).toBe(true)

  let token: SessionToken = {
    v: 1,
    sessionId,
    createdAt: 0,
    repoRoot: repo.root,
    stage: 'planned',
    entry: { kind: 'workingTree' },
    headBefore,
    lockValue,
    afterRef: afterRefName(sessionId),
    afterCommit: null,
    afterTree: null,
    statusDigest: null,
    backupRef: null,
    backupCommit: null,
    stashMessage: null,
    checkedOut: null,
  }
  await store.writeToken(token)
  if (stage === 'planned')
    return { token, store }

  const statusDigest = await readStatusDigest(repo.root)
  const capture = await captureWorkingState(repo.root, sessionId)
  await writeRef(repo.root, token.afterRef, capture.commit)
  token = await advanceStage(store, {
    ...token,
    afterCommit: capture.commit,
    afterTree: capture.tree,
    statusDigest,
  }, 'captured')
  if (stage === 'captured')
    return { token, store }

  token = await advanceStage(store, { ...token, stashMessage: stashMessageFor(sessionId) }, 'stashed')
  const push = await stashPush(repo.root, { message: stashMessageFor(sessionId), includeUntracked: true })
  if (push.sha !== null) {
    await writeRef(repo.root, backupRefName(sessionId), push.sha)
    token = await persistToken(store, { ...token, backupRef: backupRefName(sessionId), backupCommit: push.sha })
  }
  if (stage === 'stashed')
    return { token, store }

  const checkout = args.checkout ?? null
  token = await advanceStage(store, { ...token, checkedOut: checkout }, 'checkedout')
  if (checkout !== null)
    await repo.git('checkout', '--detach', checkout)
  if (stage === 'checkedout')
    return { token, store }

  token = await advanceStage(store, token, 'reviewing')
  return { token, store }
}

/** `git ls-tree -r <rev>` as a map of path to mode and blob content. */
export async function readTree(repo: TmpRepo, rev: string): Promise<Map<string, { mode: string, content: string }>> {
  const raw = await repo.git('ls-tree', '-r', '-z', rev)
  const out = new Map<string, { mode: string, content: string }>()
  for (const record of raw.split('\0')) {
    if (record === '')
      continue
    const [meta, path] = record.split('\t')
    const [mode, , object] = meta.split(' ')
    out.set(path, { mode, content: await repo.git('cat-file', 'blob', object) })
  }
  return out
}

/** Tracked and untracked working-tree content, as the capture should record it. */
export async function readWorkingFiles(repo: TmpRepo): Promise<Map<string, { executable: boolean, content: string }>> {
  const list = (raw: string) => raw.split('\0').filter(entry => entry !== '')
  const tracked = list(await repo.git('ls-files', '-z'))
  const untracked = list(await repo.git('ls-files', '--others', '--exclude-standard', '-z'))

  const out = new Map<string, { executable: boolean, content: string }>()
  for (const path of new Set([...tracked, ...untracked])) {
    if (!await repo.exists(path))
      continue
    const { mode } = await stat(join(repo.root, path))
    out.set(path, { executable: (mode & 0o111) !== 0, content: await repo.read(path) })
  }
  return out
}
