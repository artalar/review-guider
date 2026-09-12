import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitState, pendingEntry, sessionModeSetting, sessionStatus, startSession } from '../../src/model/session'
import {
  defaultBase,
  fetchRemote,
  gitBranches,
  gitRemotes,
  pickWorkingTree,
  recentCommits,
  reviewSelection,
  selectHomeRev,
  setBranch,
  setRemote,
  setupPhase,
} from '../../src/model/setup'
import { bootstrapModel } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

let dispose: (() => void) | null = null

beforeEach(() => context.reset())

afterEach(() => {
  dispose?.()
  dispose = null
})

afterAll(cleanupTempRepos)

async function settleHomeHistory() {
  await gitState()
  await gitRemotes()
  await gitBranches()
  await defaultBase()
  return await recentCommits()
}

describe('home setup machine', () => {
  it('is home after bootstrap and loads recent commits without a generate wizard', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const older = await repo.commit('older')
    await repo.write('b.ts', 'b\n')
    await repo.git('add', 'b.ts')
    const newer = await repo.commit('newer')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    expect(peek(setupPhase).kind).toBe('home')
    const commits = await settleHomeHistory()
    expect(commits.length).toBeGreaterThanOrEqual(3)
    expect(commits.map(commit => commit.sha)).toEqual(expect.arrayContaining([older, newer]))
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      loading: false,
      commits: expect.arrayContaining([
        expect.objectContaining({ sha: older, subject: 'older' }),
        expect.objectContaining({ sha: newer, subject: 'newer' }),
      ]),
    })
    expect(peek(setupPhase).kind).not.toBe('generate')
    expect(peek(setupPhase).kind).not.toBe('commits')
    expect(peek(setupPhase).kind).not.toBe('range')
  })

  it('treats a second commit click as a range ordered older from, newer to', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const older = await repo.commit('older')
    await repo.write('b.ts', 'b\n')
    await repo.git('add', 'b.ts')
    const newer = await repo.commit('newer')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    selectHomeRev(newer)
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'commit', rev: newer },
    })

    selectHomeRev(older)
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'range', from: older, to: newer },
    })

    selectHomeRev(older)
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'commit', rev: newer },
    })
  })

  it('keeps pickWorkingTree on home as an exclusive working-tree selection', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('wip.ts', 'wip\n')
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const newer = await repo.commit('newer')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    await pickWorkingTree()
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'workingTree' },
    })
    expect(peek(setupPhase).kind).not.toBe('generate')

    selectHomeRev(newer)
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'commit', rev: newer },
    })

    await pickWorkingTree()
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'workingTree' },
    })
  })

  it('rejects a hostile rev without leaving home', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    selectHomeRev('')
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      error: 'Enter a commit, tag, or ref.',
    })
    selectHomeRev('--output=/tmp/x')
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      error: 'That does not look like a commit, tag, or ref.',
    })
  })

  it('preselects working changes only when the selected ref is the dirty checkout', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.git('checkout', '-b', 'feature')
    await repo.write('feat.ts', 'feat\n')
    await repo.git('add', 'feat.ts')
    await repo.commit('on feature')
    await repo.git('checkout', 'main')
    await repo.write('wip.ts', 'wip\n')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await gitState()
    await settleHomeHistory()

    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selection: { kind: 'workingTree' },
    })

    setBranch('feature')
    await settleHomeHistory()
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selectedBranch: 'feature',
      selection: { kind: 'none' },
    })
  })

  it('starts Review of one selected commit against its parent', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const newer = await repo.commit('newer')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    selectHomeRev(newer)
    await reviewSelection()
    expect(peek(pendingEntry)).toEqual({ kind: 'commit', rev: newer })
    expect(peek(setupPhase).kind).toBe('home')
    expect(peek(setupPhase).kind).not.toBe('generate')
  })

  it('walks the selected branch against the default base when nothing is picked', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.git('checkout', '-b', 'feature')
    await repo.write('feat.ts', 'feat\n')
    await repo.git('add', 'feat.ts')
    await repo.commit('on feature')
    await repo.git('checkout', 'main')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    setBranch('feature')
    await settleHomeHistory()
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selectedBranch: 'feature',
      selection: { kind: 'none' },
    })

    await reviewSelection()
    expect(peek(pendingEntry)).toEqual({ kind: 'range', from: 'main', to: 'feature' })
    expect(peek(setupPhase).kind).toBe('home')
  })

  it('records remote and branch on home without leaving the list', async () => {
    const origin = await makeTempRepo({ files: { 'README.md': '# origin\n' } })
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.git('remote', 'add', 'origin', origin.root)
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()

    setRemote('origin')
    setBranch('main')
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      selectedRemote: 'origin',
      selectedBranch: 'main',
    })
    await fetchRemote()
    expect(peek(setupPhase).kind).toBe('home')
  })

  it('drops home remotes and commits while a session is open', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const rev = await repo.commit('change')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose
    await settleHomeHistory()
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      commits: expect.arrayContaining([expect.objectContaining({ sha: rev })]),
    })

    sessionModeSetting.set('readonly')
    await startSession({ entry: { kind: 'commit', rev } })
    expect(peek(sessionStatus)).toBe('active')
    expect(peek(setupPhase)).toMatchObject({
      kind: 'home',
      commits: [],
      remotes: [],
      branches: [],
    })
  })
})
