import type { SessionToken } from '../../src/git/journal'
import { afterAll, describe, expect, it } from 'vitest'
import { applyGuideStep, mergeThreeWay } from '../../src/git/apply'
import { showBlob } from '../../src/git/diff'
import { isRecoverable } from '../../src/git/journal'
import { appliedRefName, resolveRef } from '../../src/git/refs'
import { buildHeuristicGuide } from '../../src/guide/heuristic'
import { parseUnifiedDiff } from '../../src/guide/parse-diff'
import { renderReveal } from '../../src/guide/render'
import { memoryStore } from '../../src/model/ports'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

/**
 * Apply engine + commit happy path / conflict stop (plan Phase 7 / R-apply-1).
 */

afterAll(cleanupTempRepos)

function reviewingToken(repoRoot: string, sessionId: string): SessionToken {
  return {
    v: 1,
    sessionId,
    createdAt: 0,
    heartbeatAt: 0,
    repoRoot,
    stage: 'reviewing',
    entry: { kind: 'commit', rev: 'HEAD' },
    headBefore: { kind: 'branch', name: 'main' },
    lockValue: sessionId,
    afterRef: `refs/tabthrough/after/${sessionId}`,
    afterCommit: 'after',
    afterTree: 'tree',
    statusDigest: null,
    backupRef: null,
    backupCommit: null,
    stashMessage: null,
    checkedOut: 'HEAD',
    mode: 'apply',
    appliedIndex: -1,
    appliedRef: null,
  }
}

describe('mergeThreeWay', () => {
  it('keeps a clean edit when sides do not overlap', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'line1\nline2\nline3\n' } })
    const base = 'line1\nline2\nline3\n'
    const ours = 'line1\nUSER\nline3\n'
    const theirs = 'line1\nline2\nline3\nNEXT\n'
    const merged = await mergeThreeWay(repo.root, base, ours, theirs)
    expect(merged.clean).toBe(true)
    if (merged.clean)
      expect(merged.text).toContain('USER')
  })

  it('reports conflict when the same region diverges', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'line1\nline2\nline3\n' } })
    const base = 'line1\nline2\nline3\n'
    const ours = 'line1\nOURS\nline3\n'
    const theirs = 'line1\nTHEIRS\nline3\n'
    const merged = await mergeThreeWay(repo.root, base, ours, theirs)
    expect(merged.clean).toBe(false)
    expect(merged.text).toContain('<<<<<<<')
  })
})

describe('applyGuideStep — commit target', () => {
  it('checks out base semantics: applies step 0 onto C^ content', async () => {
    const repo = await makeTempRepo({
      files: { 'src/hello.ts': 'export const hello = 1\n' },
    })
    await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
    await repo.git('add', '-A')
    const after = await repo.commit('add world')
    const base = (await repo.git('rev-parse', 'HEAD^')).trim()

    await repo.git('checkout', '--detach', base)
    expect(await repo.read('src/hello.ts')).toBe('export const hello = 1\n')

    const patch = await repo.git(
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--patch',
      base,
      after,
    )
    const diff = parseUnifiedDiff(patch)
    const guide = buildHeuristicGuide(diff)
    expect(guide.steps.length).toBeGreaterThan(0)

    const store = memoryStore()
    const token = reviewingToken(repo.root, 'apply-happy')
    await store.writeToken(token)

    const outcome = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })

    expect(outcome.kind).toBe('applied')
    if (outcome.kind !== 'applied')
      return

    expect(outcome.token.appliedIndex).toBe(0)
    expect(outcome.token.stage).toBe('reviewing')
    expect(await resolveRef(repo.root, appliedRefName('apply-happy'))).not.toBeNull()

    const file = diff.files[0]!
    const baseText = await showBlob(repo.root, base, file.path) ?? ''
    const intended = renderReveal(baseText, file, guide.steps[0]!.groups).text
    expect(await repo.read('src/hello.ts')).toBe(intended)
  })

  it('stops without advancing on edit-then-Tab conflict', async () => {
    const repo = await makeTempRepo({
      files: { 'src/hello.ts': 'export const hello = 1\n' },
    })
    await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
    await repo.git('add', '-A')
    const after = await repo.commit('add world')
    const base = (await repo.git('rev-parse', 'HEAD^')).trim()
    await repo.git('checkout', '--detach', base)

    const patch = await repo.git(
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--patch',
      base,
      after,
    )
    const diff = parseUnifiedDiff(patch)
    const guide = buildHeuristicGuide(diff)

    // Messy user edit that will conflict with the intended next line.
    await repo.write('src/hello.ts', 'export const hello = 999\n')

    const store = memoryStore()
    const token = reviewingToken(repo.root, 'apply-conflict')
    await store.writeToken(token)

    const outcome = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })

    expect(outcome.kind).toBe('conflict')
    if (outcome.kind !== 'conflict')
      return
    expect(outcome.token.appliedIndex).toBe(-1)
    expect(outcome.token.stage).toBe('reviewing')
    expect(await resolveRef(repo.root, appliedRefName('apply-conflict'))).toBeNull()
  })

  it('reverts the last applied step on backward', async () => {
    const repo = await makeTempRepo({
      files: { 'src/hello.ts': 'export const hello = 1\n' },
    })
    await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
    await repo.git('add', '-A')
    const after = await repo.commit('add world')
    const base = (await repo.git('rev-parse', 'HEAD^')).trim()
    await repo.git('checkout', '--detach', base)

    const patch = await repo.git(
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--patch',
      base,
      after,
    )
    const diff = parseUnifiedDiff(patch)
    const guide = buildHeuristicGuide(diff)
    const store = memoryStore()
    let token = reviewingToken(repo.root, 'apply-revert')
    await store.writeToken(token)

    const forward = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(forward.kind).toBe('applied')
    if (forward.kind !== 'applied')
      return
    token = forward.token

    const backward = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'backward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(backward.kind).toBe('applied')
    if (backward.kind !== 'applied')
      return
    expect(backward.token.appliedIndex).toBe(-1)
    expect(await repo.read('src/hello.ts')).toBe('export const hello = 1\n')
  })

  it('journals applying mid-write so a crash leaves a recoverable token', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    const store = memoryStore()
    const token = reviewingToken(repo.root, 'apply-journal')
    await store.writeToken(token)
    // Crash stub: stage flipped to applying before the applied-ref bump.
    await store.writeToken({ ...token, stage: 'applying' })
    const stored = await store.readToken(repo.root)
    expect(stored?.stage).toBe('applying')
    expect(stored?.mode).toBe('apply')
    expect(isRecoverable(stored)).toBe(true)
  })

  it('refuses to re-merge while conflict markers remain (no nested markers)', async () => {
    const repo = await makeTempRepo({
      files: { 'src/hello.ts': 'export const hello = 1\n' },
    })
    await repo.write('src/hello.ts', 'export const hello = 1\nexport const world = 2\n')
    await repo.git('add', '-A')
    const after = await repo.commit('add world')
    const base = (await repo.git('rev-parse', 'HEAD^')).trim()
    await repo.git('checkout', '--detach', base)

    const patch = await repo.git(
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--patch',
      base,
      after,
    )
    const diff = parseUnifiedDiff(patch)
    const guide = buildHeuristicGuide(diff)
    const store = memoryStore()
    let token = reviewingToken(repo.root, 'apply-markers')
    await store.writeToken(token)

    await repo.write('src/hello.ts', 'export const hello = 999\n')
    const conflict = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(conflict.kind).toBe('conflict')
    if (conflict.kind !== 'conflict')
      return
    token = conflict.token
    const afterConflict = await repo.read('src/hello.ts')
    expect(afterConflict).toContain('<<<<<<<')

    const retry = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(retry.kind).toBe('refused')
    if (retry.kind !== 'refused')
      return
    expect(retry.reason).toBe('unmerged')
    expect(retry.message).toMatch(/Resolve conflict markers/)
    expect(await repo.read('src/hello.ts')).toBe(afterConflict)
  })

  it.each([false, true])('does not warn about previously applied paths as drift (new file: %s)', async (newFile) => {
    const repo = await makeTempRepo({
      files: {
        ...(newFile ? {} : { 'src/types.ts': 'export type Id = string\n' }),
        'src/service.ts': 'export const n = 1\n',
      },
    })
    await repo.write('src/types.ts', 'export type Id = string\nexport type Name = string\n')
    await repo.write('src/service.ts', 'export const n = 1\nexport const m = 2\n')
    await repo.git('add', '-A')
    const after = await repo.commit('two files')
    const base = (await repo.git('rev-parse', 'HEAD^')).trim()
    await repo.git('checkout', '--detach', base)

    const patch = await repo.git(
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '-U3',
      '--patch',
      base,
      after,
    )
    const diff = parseUnifiedDiff(patch)
    const guide = buildHeuristicGuide(diff)
    expect(guide.steps.length).toBeGreaterThanOrEqual(2)

    const store = memoryStore()
    let token = reviewingToken(repo.root, 'apply-drift')
    token = { ...token, checkedOut: base }
    await store.writeToken(token)

    const first = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 0,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(first.kind).toBe('applied')
    if (first.kind !== 'applied')
      return
    expect(first.driftPaths).toEqual([])
    token = first.token

    const second = await applyGuideStep({
      repoRoot: repo.root,
      baseRev: base,
      stepIndex: 1,
      direction: 'forward',
      steps: guide.steps,
      files: diff.files,
      store,
      token,
    })
    expect(second.kind).toBe('applied')
    if (second.kind !== 'applied')
      return
    expect(second.driftPaths).not.toContain(guide.steps[0]!.path)
  })
})
