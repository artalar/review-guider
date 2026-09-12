import type { TmpRepo } from '../helpers/tmp-repo'
import { afterAll, describe, expect, it } from 'vitest'
import { readRecentCommits } from '../../src/git/log'
import {
  defaultBaseRef,
  fetchRemote,
  listBranches,
  listRemotes,
  refNameError,
  remoteNameError,
} from '../../src/git/remotes'
import { recordGitExec } from '../helpers/git-spy'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

afterAll(cleanupTempRepos)

function fetchUrlsFromRemoteV(remoteV: string): Map<string, string> {
  const urls = new Map<string, string>()
  for (const line of remoteV.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined)
      urls.set(match[1], match[2])
  }
  return urls
}

function localNamed(
  branches: Awaited<ReturnType<typeof listBranches>>,
  name: string,
) {
  return branches.find(branch =>
    branch.remote === null && (branch.name === name || branch.ref === `refs/heads/${name}`),
  )
}

function trackingNamed(
  branches: Awaited<ReturnType<typeof listBranches>>,
  remote: string,
  shortName: string,
) {
  const qualified = `${remote}/${shortName}`
  return branches.find(branch =>
    branch.remote === remote
    && (branch.name === qualified || branch.name === shortName || branch.ref === `refs/remotes/${qualified}`),
  )
}

async function addAndFetch(local: TmpRepo, name: string, remote: TmpRepo): Promise<void> {
  await local.git('remote', 'add', name, remote.root)
  await local.git('fetch', '--quiet', '--', name)
}

describe('listRemotes', () => {
  it('puts origin first, upstream second, then the rest alphabetically, with fetch URLs from git remote -v', async () => {
    const origin = await makeTempRepo()
    const upstream = await makeTempRepo()
    const other = await makeTempRepo()
    const repo = await makeTempRepo()
    await repo.git('remote', 'add', 'upstream', upstream.root)
    await repo.git('remote', 'add', 'origin', origin.root)
    await repo.git('remote', 'add', 'other', other.root)

    const remotes = await listRemotes(repo.root)
    expect(remotes.map(remote => remote.name)).toEqual(['origin', 'upstream', 'other'])

    const fromGit = fetchUrlsFromRemoteV(await repo.git('remote', '-v'))
    expect(fromGit.size).toBe(3)
    for (const remote of remotes)
      expect(remote.fetchUrl).toBe(fromGit.get(remote.name))
  })

  it('returns an empty list when the repository has no remotes', async () => {
    const repo = await makeTempRepo()
    expect(await listRemotes(repo.root)).toEqual([])
  })
})

describe('remoteNameError', () => {
  it('rejects empty, leading dash, and whitespace; origin is allowed', () => {
    expect(remoteNameError('')).not.toBeNull()
    expect(remoteNameError('-origin')).not.toBeNull()
    expect(remoteNameError('origin other')).not.toBeNull()
    expect(remoteNameError('origin')).toBeNull()
  })
})

describe('refNameError', () => {
  it('rejects empty, leading dash, and whitespace; origin/feature is allowed', () => {
    expect(refNameError('')).not.toBeNull()
    expect(refNameError('-origin/feature')).not.toBeNull()
    expect(refNameError('origin/foo bar')).not.toBeNull()
    expect(refNameError('origin/feature')).toBeNull()
  })
})

describe('listBranches', () => {
  it('marks the checked-out local branch as current', async () => {
    const repo = await makeTempRepo()
    const onMain = await listBranches(repo.root)
    expect(localNamed(onMain, 'main')?.current).toBe(true)

    await repo.git('checkout', '-q', '-b', 'feature')
    const onFeature = await listBranches(repo.root)
    expect(localNamed(onFeature, 'feature')?.current).toBe(true)
    expect(localNamed(onFeature, 'main')?.current).toBe(false)
  })

  it('includes origin remote-tracking refs when listing a path remote', async () => {
    const origin = await makeTempRepo()
    const local = await makeTempRepo()
    await addAndFetch(local, 'origin', origin)

    const branches = await listBranches(local.root, { remote: 'origin' })
    const originMain = trackingNamed(branches, 'origin', 'main')
    expect(originMain).toBeDefined()
    expect(originMain?.remote).toBe('origin')
  })
})

describe('defaultBaseRef', () => {
  it('resolves to the origin default-branch tip when origin is the only remote', async () => {
    const origin = await makeTempRepo()
    const local = await makeTempRepo()
    await addAndFetch(local, 'origin', origin)

    const base = await defaultBaseRef(local.root)
    expect(base).toBeTruthy()
    expect(base).toMatch(/origin/)
    expect((await local.git('rev-parse', '--verify', base!)).trim()).toBe(await origin.head())
  })

  it('prefers a ref on upstream when both origin and upstream exist', async () => {
    const origin = await makeTempRepo({ files: { 'README.md': '# origin\n' } })
    const upstream = await makeTempRepo({ files: { 'README.md': '# upstream\n' } })
    const local = await makeTempRepo()
    await addAndFetch(local, 'origin', origin)
    await addAndFetch(local, 'upstream', upstream)

    expect(await origin.head()).not.toBe(await upstream.head())

    const base = await defaultBaseRef(local.root)
    expect(base).toBeTruthy()
    expect(base).toMatch(/upstream/)
    expect((await local.git('rev-parse', '--verify', base!)).trim()).toBe(await upstream.head())
  })
})

describe('fetchRemote', () => {
  it('updates origin remote-tracking without checking out', async () => {
    const origin = await makeTempRepo()
    const local = await makeTempRepo()
    await addAndFetch(local, 'origin', origin)

    await origin.write('next.txt', 'from origin\n')
    await origin.git('add', '-A')
    const newSha = await origin.commit('new on origin')

    expect((await local.git('rev-parse', 'origin/main')).trim()).not.toBe(newSha)
    const headBefore = await local.head()

    const spy = recordGitExec()
    try {
      expect(await fetchRemote(local.root, 'origin')).toEqual({ ok: true })
      expect(await local.head()).toBe(headBefore)
      expect(spy.calls.filter(args => args[0] === 'checkout')).toEqual([])
    }
    finally {
      spy.restore()
    }

    const commits = await readRecentCommits(local.root, { rev: 'origin/main' })
    expect(commits.some(commit => commit.sha === newSha)).toBe(true)
  })

  it('does not spawn a dash-prefixed remote as a flag', async () => {
    const repo = await makeTempRepo()
    const spy = recordGitExec()
    try {
      const result = await fetchRemote(repo.root, '-x')
      expect(result).toEqual({ ok: false, message: remoteNameError('-x') })
      expect(spy.calls.some(args => args.includes('-x'))).toBe(false)
    }
    finally {
      spy.restore()
    }
  })
})

describe('readRecentCommits by rev', () => {
  it('lists the named ref newest first and still defaults to HEAD', async () => {
    const repo = await makeTempRepo()
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('feature.txt', 'on feature\n')
    await repo.git('add', '-A')
    const featureSha = await repo.commit('extra on feature')
    await repo.git('checkout', '-q', 'main')

    const feature = await readRecentCommits(repo.root, { rev: 'feature' })
    expect(feature[0]?.sha).toBe(featureSha)
    expect(feature[0]?.subject).toBe('extra on feature')

    const head = await readRecentCommits(repo.root)
    expect(head[0]?.sha).toBe(await repo.head())
    expect(head[0]?.subject).toBe('initial commit')
  })

  it('returns an empty list for a missing rev', async () => {
    const repo = await makeTempRepo()
    expect(await readRecentCommits(repo.root, { rev: 'no-such-ref' })).toEqual([])
  })
})
