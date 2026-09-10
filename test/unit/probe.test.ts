import type { GitExec, GitExecRequest } from '../../src/git/exec'
import { describe, expect, it } from 'vitest'
import { GitMissingError } from '../../src/git/exec'
import { parseGitVersion, parseStatus, probeGit } from '../../src/git/probe'

/**
 * Probe variants against recorded outputs. The real-repo counterpart lives in
 * `test/integration/probe.test.ts`.
 */

interface Recording {
  readonly match: (args: readonly string[]) => boolean
  readonly code?: number
  readonly stdout?: string
  readonly stderr?: string
}

function recordedExec(recordings: readonly Recording[]): GitExec {
  return async (request: GitExecRequest) => {
    const hit = recordings.find(recording => recording.match(request.args))
    if (hit === undefined)
      return { code: 1, stdout: '', stderr: `unexpected: git ${request.args.join(' ')}` }
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
  }
}

function starts(...prefix: string[]) {
  return (args: readonly string[]) => prefix.every((part, index) => args[index] === part)
}

const VERSION: Recording = { match: starts('version'), stdout: 'git version 2.43.0\n' }

const HEALTHY_LAYOUT: Recording = {
  match: args => args[0] === 'rev-parse' && args.includes('--show-toplevel'),
  stdout: '/repo\nfalse\ntrue\nfalse\n/repo/.git\n',
}

const HEAD_OK: Recording = {
  match: args => args[0] === 'rev-parse' && args.includes('HEAD^{commit}'),
  stdout: '1111111111111111111111111111111111111111\n',
}

const ON_MAIN: Recording = { match: starts('symbolic-ref'), stdout: 'main\n' }

const CLEAN_STATUS: Recording = {
  match: args => args.includes('status'),
  stdout: '# branch.oid 1111111111111111111111111111111111111111\0# branch.head main\0',
}

describe('parseGitVersion', () => {
  it('reads plain and platform-suffixed versions', () => {
    expect(parseGitVersion('git version 2.43.0')).toEqual([2, 43, 0])
    expect(parseGitVersion('git version 2.47.1.windows.1')).toEqual([2, 47, 1])
    expect(parseGitVersion('git version 2.39')).toEqual([2, 39, 0])
    expect(parseGitVersion('nonsense')).toBeNull()
  })
})

describe('probeGit', () => {
  it('reports a healthy repository', async () => {
    const capability = await probeGit('/repo', {
      exec: recordedExec([VERSION, HEALTHY_LAYOUT, HEAD_OK, ON_MAIN, CLEAN_STATUS]),
    })

    expect(capability).toEqual({
      ok: true,
      repoRoot: '/repo',
      gitDir: '/repo/.git',
      headSha: '1111111111111111111111111111111111111111',
      headRef: 'main',
      detached: false,
      shallow: false,
      dirty: false,
      gitVersion: 'git version 2.43.0',
    })
  })

  it('reports git-missing when the executable is absent', async () => {
    const capability = await probeGit('/repo', {
      exec: async () => { throw new GitMissingError(new Error('ENOENT')) },
    })

    expect(capability).toMatchObject({ ok: false, reason: 'git-missing' })
  })

  it('reports git-too-old below the documented minimum', async () => {
    const capability = await probeGit('/repo', {
      exec: recordedExec([{ match: starts('version'), stdout: 'git version 2.11.0\n' }]),
    })

    expect(capability).toMatchObject({ ok: false, reason: 'git-too-old' })
  })

  it('reports not-a-repo when rev-parse refuses', async () => {
    const capability = await probeGit('/tmp/plain', {
      exec: recordedExec([
        VERSION,
        { match: starts('rev-parse'), code: 128, stderr: 'fatal: not a git repository' },
      ]),
    })

    expect(capability).toMatchObject({ ok: false, reason: 'not-a-repo' })
  })

  it('reports bare-repo when there is no working tree', async () => {
    const capability = await probeGit('/repo.git', {
      exec: recordedExec([
        VERSION,
        { match: args => args.includes('--show-toplevel'), stdout: '/repo.git\ntrue\nfalse\nfalse\n/repo.git\n' },
      ]),
    })

    expect(capability).toMatchObject({ ok: false, reason: 'bare-repo' })
  })

  it('reports unborn-head in a repository with no commits', async () => {
    const capability = await probeGit('/repo', {
      exec: recordedExec([
        VERSION,
        HEALTHY_LAYOUT,
        { match: args => args.includes('HEAD^{commit}'), code: 1 },
      ]),
    })

    expect(capability).toMatchObject({ ok: false, reason: 'unborn-head' })
  })

  it('flags a shallow clone without refusing it', async () => {
    const capability = await probeGit('/repo', {
      exec: recordedExec([
        VERSION,
        { match: args => args.includes('--show-toplevel'), stdout: '/repo\nfalse\ntrue\ntrue\n/repo/.git\n' },
        HEAD_OK,
        ON_MAIN,
        CLEAN_STATUS,
      ]),
    })

    expect(capability).toMatchObject({ ok: true, shallow: true })
  })

  it('reports a detached HEAD', async () => {
    const capability = await probeGit('/repo', {
      exec: recordedExec([
        VERSION,
        HEALTHY_LAYOUT,
        HEAD_OK,
        { match: starts('symbolic-ref'), code: 1 },
        CLEAN_STATUS,
      ]),
    })

    expect(capability).toMatchObject({ ok: true, detached: true, headRef: null })
  })
})

describe('parseStatus', () => {
  it('splits staged, unstaged, untracked and unmerged entries', () => {
    const raw = [
      '# branch.oid abc',
      '# branch.head main',
      '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
      '1 .M N... 100644 100644 100644 aaa aaa unstaged.ts',
      '1 MM N... 100644 100644 100644 aaa bbb both.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? new.ts',
      '! ignored.ts',
    ].join('\0')

    const status = parseStatus(`${raw}\0`)

    expect(status.branch).toBe('main')
    expect(status.detached).toBe(false)
    expect(status.staged).toEqual(['staged.ts', 'both.ts'])
    expect(status.unstaged).toEqual(['unstaged.ts', 'both.ts'])
    expect(status.untracked).toEqual(['new.ts'])
    expect(status.unmerged).toEqual(['conflict.ts'])
    expect(status.clean).toBe(false)
  })

  it('pairs a rename record with its pre-image path', () => {
    const raw = [
      '# branch.head main',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new/name.ts',
      'old/name.ts',
    ].join('\0')

    const status = parseStatus(`${raw}\0`)

    expect(status.entries).toHaveLength(1)
    expect(status.entries[0]).toMatchObject({ path: 'new/name.ts', oldPath: 'old/name.ts' })
  })

  it('reports a detached head', () => {
    const status = parseStatus('# branch.oid abc\0# branch.head (detached)\0')
    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
    expect(status.clean).toBe(true)
  })
})
