import { afterAll, describe, expect, it } from 'vitest'
import { probeGit, readStatus } from '../../src/git/probe'
import { cleanupTempRepos, makeTempDir, makeTempRepo } from '../helpers/tmp-repo'

afterAll(cleanupTempRepos)

describe('probeGit against real repositories', () => {
  it('accepts a clean repository', async () => {
    const repo = await makeTempRepo()

    const capability = await probeGit(repo.root)

    expect(capability.ok).toBe(true)
    if (!capability.ok)
      return
    expect(capability.headSha).toBe(await repo.head())
    expect(capability.headRef).toBe('main')
    expect(capability.detached).toBe(false)
    expect(capability.dirty).toBe(false)
    expect(capability.shallow).toBe(false)
  })

  it('reports a dirty tree', async () => {
    const repo = await makeTempRepo()
    await repo.write('README.md', '# changed\n')
    await repo.write('new.txt', 'untracked\n')

    const capability = await probeGit(repo.root)

    expect(capability).toMatchObject({ ok: true, dirty: true })
  })

  it('rejects a directory that is not a repository', async () => {
    const dir = await makeTempDir()

    expect(await probeGit(dir)).toMatchObject({ ok: false, reason: 'not-a-repo' })
  })

  it('rejects a repository with no commits', async () => {
    const repo = await makeTempRepo({ initialCommit: false })

    expect(await probeGit(repo.root)).toMatchObject({ ok: false, reason: 'unborn-head' })
  })

  it('rejects a bare repository', async () => {
    const repo = await makeTempRepo()
    await repo.git('config', 'core.bare', 'true')

    expect(await probeGit(repo.root)).toMatchObject({ ok: false, reason: 'bare-repo' })
  })

  it('refuses while a merge is in progress', async () => {
    const repo = await makeTempRepo({ files: { 'conflict.txt': 'base\n' } })
    await repo.git('checkout', '-q', '-b', 'other')
    await repo.write('conflict.txt', 'other\n')
    await repo.git('add', '-A')
    await repo.commit('other side')
    await repo.git('checkout', '-q', 'main')
    await repo.write('conflict.txt', 'main\n')
    await repo.git('add', '-A')
    await repo.commit('main side')

    const merge = await repo.tryGit('merge', 'other')
    expect(merge.code).not.toBe(0)

    expect(await probeGit(repo.root)).toMatchObject({ ok: false, reason: 'rebase-or-merge-in-progress' })
  })

  it('reports a detached HEAD as usable', async () => {
    const repo = await makeTempRepo()
    await repo.git('checkout', '-q', '--detach', 'HEAD')

    expect(await probeGit(repo.root)).toMatchObject({ ok: true, detached: true, headRef: null })
  })

  it('resolves the repository root from a subdirectory', async () => {
    const repo = await makeTempRepo({ files: { 'pkg/index.ts': 'export {}\n' } })

    const capability = await probeGit(`${repo.root}/pkg`)

    expect(capability.ok).toBe(true)
    if (capability.ok)
      expect(await probeGit(capability.repoRoot)).toMatchObject({ ok: true })
  })
})

describe('readStatus against real repositories', () => {
  it('reports the staged / unstaged / untracked split', async () => {
    const repo = await makeTempRepo({ files: { 'a.txt': 'one\n' } })
    await repo.write('a.txt', 'staged\n')
    await repo.git('add', 'a.txt')
    await repo.write('a.txt', 'staged and edited\n')
    await repo.write('b.txt', 'untracked\n')

    const status = await readStatus(repo.root)

    expect(status.staged).toEqual(['a.txt'])
    expect(status.unstaged).toEqual(['a.txt'])
    expect(status.untracked).toEqual(['b.txt'])
    expect(status.clean).toBe(false)
  })

  it('excludes ignored files', async () => {
    const repo = await makeTempRepo({ files: { '.gitignore': 'secret.env\n' } })
    await repo.write('secret.env', 'TOKEN=1\n')

    const status = await readStatus(repo.root)

    expect(status.untracked).toEqual([])
    expect(status.clean).toBe(true)
  })
})
