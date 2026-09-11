import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { context, peek, take, throwAbort, wrap } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execGit } from '../../src/git/exec'
import {
  abortRebase,
  finishRebase,
  formatRebaseCommand,
  formatSequenceEditor,
  gitOutput,
  isAncestor,
  quoteArg,
  readOwnership,
  rebaseBypassFlags,
  startRebase,
} from '../../src/git/rebase'
import { readGitState } from '../../src/git/state'
import { guideSource } from '../../src/model/guide-source'
import {
  cancelSession,
  CONFLICT_STOP,
  finishHooks,
  finishSession,
  gitState,
  gitWatchToken,
  MERGE_ABOVE_HINT,
  MERGE_AFTER_HINT,
  OWNERSHIP_LOST,
  pendingEntry,
  REBASE_IN_PROGRESS_HINT,
  RebaseNotApplicableError,
  rebaseOwnership,
  sequenceEditorPath,
  session,
  sessionModeSetting,
  sessionStatus,
  startPreview,
  startSession,
  syncRebaseOwnership,
} from '../../src/model/session'
import { bootstrapModel } from '../helpers/model'
import { cleanupTempRepos, isWindows, makeTempRepo } from '../helpers/tmp-repo'

const SEQUENCE_EDITOR = fileURLToPath(new URL('../helpers/sequence-editor.cjs', import.meta.url))
const DIST_EDITOR = fileURLToPath(new URL('../../dist/sequence-editor.cjs', import.meta.url))

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function finishGuide(hooks: boolean): string {
  return JSON.stringify({
    version: 1,
    defaults: { finish: { hooks, sign: false } },
    steps: [{ id: 'app', path: 'app.ts', rationale: 'The reviewed file', title: 'app' }],
  })
}

afterAll(cleanupTempRepos)

async function threeCommitRepo() {
  const repo = await makeTempRepo({ files: { 'app.ts': 'one\n', 'note.ts': 'n1\n' } })
  await repo.write('app.ts', 'two\n')
  await repo.write('note.ts', 'n2\n')
  await repo.git('add', '-A')
  const after = await repo.commit('second')
  await repo.write('app.ts', 'three\n')
  await repo.git('add', '-A')
  await repo.commit('third')
  await repo.write('app.ts', 'four\n')
  await repo.git('add', '-A')
  await repo.commit('fourth')
  return { repo, after }
}

async function startAtAfter(repoRoot: string, after: string, hooks = false, sign = false) {
  const parent = (await execGit({ cwd: repoRoot, args: ['rev-parse', `${after}^`] })).stdout.trim()
  return await startRebase({
    repoRoot,
    base: parent,
    after,
    hooks,
    sign,
    execPath: process.execPath,
    sequenceEditor: SEQUENCE_EDITOR,
  })
}

describe('rebase driver', () => {
  it('starts on HEAD~2 with a dirty tree, parks WIP, and stops at after', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    await repo.write('notes.txt', 'untracked\n')

    const started = await startAtAfter(repo.root, after)
    expect(started.code).toBe(0)
    expect(started.command).toContain('--no-verify')
    expect(started.command).toContain('--no-gpg-sign')

    expect(await repo.head()).toBe(after)
    expect(await repo.read('app.ts')).toBe('two\n')
    const state = await readGitState(repo.root)
    expect(state.rebase).not.toBeNull()
    expect(state.rebase?.stoppedSha).toBe(after)
    expect(state.rebase?.autostashSha).not.toBeNull()
    const todo = await repo.read('.git/rebase-merge/git-rebase-todo')
    expect(todo).toMatch(/^pick /m)
    expect(todo).not.toMatch(new RegExp(`^edit ${after.slice(0, 7)}`, 'm'))
    const done = await repo.read('.git/rebase-merge/done')
    expect(done).toMatch(/^edit /m)
  })

  it('includes bypass flags by default and omits them when hooks and sign are on', async () => {
    expect(rebaseBypassFlags(false, false)).toEqual(['--no-verify', '--no-gpg-sign'])
    expect(rebaseBypassFlags(true, true)).toEqual([])
    expect(rebaseBypassFlags(true, false)).toEqual(['--no-gpg-sign'])
    expect(rebaseBypassFlags(false, true)).toEqual(['--no-verify'])

    const { repo, after } = await threeCommitRepo()
    const recorded: string[][] = []
    const started = await startRebase({
      repoRoot: repo.root,
      base: (await execGit({ cwd: repo.root, args: ['rev-parse', `${after}^`] })).stdout.trim(),
      after,
      hooks: true,
      sign: true,
      execPath: process.execPath,
      sequenceEditor: SEQUENCE_EDITOR,
      options: {
        exec: async (request) => {
          recorded.push([...request.args])
          return execGit(request)
        },
      },
    })
    expect(started.code).toBe(0)
    const rebaseArgs = recorded.find(args => args[0] === 'rebase' && args.includes('-i'))
    expect(rebaseArgs).toBeDefined()
    expect(rebaseArgs).toContain('--no-autosquash')
    expect(rebaseArgs).not.toContain('--no-verify')
    expect(rebaseArgs).not.toContain('--no-gpg-sign')
  })

  it('puts --no-autosquash on the Start argv and Will-run line', () => {
    expect(formatRebaseCommand('abc1234', false, false))
      .toBe('git rebase -i --autostash --no-autosquash --no-verify --no-gpg-sign abc1234')
  })

  it('keeps the last carriage-return progress segment in git output', () => {
    expect(gitOutput({
      command: 'git rebase --continue',
      code: 0,
      stdout: '',
      stderr: 'Rebasing (2/3)\rRebasing (3/3)\rSuccessfully rebased and updated refs/heads/main.\n',
    })).toBe('Successfully rebased and updated refs/heads/main.')
  })

  it('finishes without edits: replays above, pops WIP, empties the stash', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')

    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    const finished = await finishRebase({ repoRoot: repo.root, hooks: false, sign: false, stageUntracked: [] })
    expect(finished.ok).toBe(true)

    expect((await readGitState(repo.root)).rebase).toBeNull()
    expect(await repo.read('app.ts')).toBe('wip\n')
    expect((await repo.git('stash', 'list')).trim()).toBe('')
    const log = await repo.git('log', '--oneline', '-3')
    expect(log).toContain('fourth')
    expect(log).toContain('third')
    expect(log).toContain('second')
  })

  it('amends edits and a ticked untracked file; leaves an unticked file untracked', async () => {
    const { repo, after } = await threeCommitRepo()
    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    await repo.write('note.ts', 'fixed\n')
    await repo.write('keep.txt', 'keep\n')
    await repo.write('skip.txt', 'skip\n')

    const finished = await finishRebase({
      repoRoot: repo.root,
      hooks: false,
      sign: false,
      stageUntracked: ['keep.txt'],
    })
    expect(finished.ok).toBe(true)
    expect(await repo.read('note.ts')).toBe('fixed\n')
    expect(await repo.read('app.ts')).toBe('four\n')
    expect(await repo.exists('keep.txt')).toBe(true)
    expect((await repo.git('ls-files', 'keep.txt')).trim()).toBe('keep.txt')
    expect((await repo.git('status', '--porcelain', 'skip.txt')).trim()).toMatch(/^\?\? skip\.txt/)
  })

  it('runs a fixture pre-commit hook only when hooks are on', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('.git/hooks/pre-commit', '#!/bin/sh\necho hook-ran >> hook.log\nexit 1\n')
    if (!isWindows)
      await repo.setExecutable('.git/hooks/pre-commit')

    expect((await startAtAfter(repo.root, after, true, false)).code).toBe(0)
    await repo.write('note.ts', 'hooked\n')
    const failed = await finishRebase({ repoRoot: repo.root, hooks: true, sign: false, stageUntracked: [] })
    expect(failed.ok).toBe(false)
    expect(failed.ok ? null : failed.kind).toBe('hooks-or-sign')
    expect(await repo.exists('hook.log')).toBe(true)

    const retried = await finishRebase({ repoRoot: repo.root, hooks: false, sign: false, stageUntracked: [] })
    expect(retried.ok).toBe(true)
  })

  it('stops on a replay conflict and continue works after resolution', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'base\n' } })
    await repo.write('app.ts', 'alpha\n')
    await repo.git('add', '-A')
    const after = await repo.commit('alpha')
    await repo.write('app.ts', 'beta\n')
    await repo.git('add', '-A')
    await repo.commit('beta')

    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    await repo.write('app.ts', 'gamma\n')
    const finished = await finishRebase({ repoRoot: repo.root, hooks: false, sign: false, stageUntracked: [] })
    expect(finished.ok).toBe(false)
    expect(finished.ok ? null : finished.kind).toBe('conflict')
    const state = await readGitState(repo.root)
    expect(state.rebase).not.toBeNull()
    expect(state.conflicts).toContain('app.ts')

    await repo.write('app.ts', 'resolved\n')
    await repo.git('add', 'app.ts')
    const continued = await execGit({
      cwd: repo.root,
      args: ['rebase', '--continue'],
      env: { GIT_EDITOR: 'true' },
    })
    expect(continued.code).toBe(0)
    expect((await readGitState(repo.root)).rebase).toBeNull()
    expect(await repo.read('app.ts')).toBe('resolved\n')
  })

  it('aborts and restores HEAD and WIP byte-identically', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    const before = await repo.fingerprint()

    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    const aborted = await abortRebase(repo.root)
    expect(aborted.code).toBe(0)
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('detects ownership lost after a terminal abort', async () => {
    const { repo, after } = await threeCommitRepo()
    const origHead = await repo.head()
    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    expect((await readOwnership(repo.root, after, origHead)).ours).toBe(true)

    await repo.git('rebase', '--abort')
    const lost = await readOwnership(repo.root, after, origHead)
    expect(lost.ours).toBe(false)
    expect(lost.rebase).toBeNull()
  })

  it('reports a non-ancestor commit', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.git('checkout', '--orphan', 'other')
    await repo.git('commit', '--allow-empty', '-m', 'orphan')
    expect(await isAncestor(repo.root, after)).toBe(false)
  })

  it('forwards git\'s refusal when a rebase is already in progress', async () => {
    const { repo, after } = await threeCommitRepo()
    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    const second = await startAtAfter(repo.root, after)
    expect(second.code).not.toBe(0)
    expect(`${second.stdout}\n${second.stderr}`).toMatch(/rebase/i)
  })
})

describe('rebase session ownership', () => {
  beforeEach(() => context.reset())

  afterEach(async () => {
    if (peek(sessionStatus) !== 'idle')
      await cancelSession('deactivate')
  })

  it('closes the review when the terminal aborts the rebase', async () => {
    const { repo, after } = await threeCommitRepo()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    await startSession({ entry: { kind: 'commit', rev: after } })
    expect(peek(sessionStatus)).toBe('active')
    expect(peek(session)?.mode).toBe('rebase')

    await repo.git('rebase', '--abort')
    gitWatchToken.set(value => value + 1)
    await gitState()
    await syncRebaseOwnership()
    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(note => note.message === OWNERSHIP_LOST)).toBe(true)
    harness.dispose()
  })

  it('closes the review from the ownership effect after a terminal abort', async () => {
    const { repo, after } = await threeCommitRepo()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    await startSession({ entry: { kind: 'commit', rev: after } })
    expect(peek(sessionStatus)).toBe('active')

    const closed = take(sessionStatus, status => status === 'idle' || throwAbort(), 'ownershipClosed')
    await repo.git('rebase', '--abort')
    gitWatchToken.set(value => value + 1)
    await gitState()
    await wrap(closed)
    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(note => note.message === OWNERSHIP_LOST)).toBe(true)
    harness.dispose()
  })
})

describe('rebase quoting and start env', () => {
  it('escapes $, backtick, backslash and quotes in the sequence editor path', () => {
    const path = '/Users/foo$bar/`baz`/Cursor Helper (Plugin)/ed\\"itor.cjs'
    const formatted = formatSequenceEditor(path, path, 'abc1234')
    expect(formatted).toContain(quoteArg(path))
    expect(quoteArg(path)).toBe(`"${path.replace(/["$`\\]/g, '\\$&')}"`)
  })

  it('sets GIT_EDITOR=true on start', async () => {
    const { repo, after } = await threeCommitRepo()
    const envs: Array<Readonly<Record<string, string>> | undefined> = []
    const started = await startRebase({
      repoRoot: repo.root,
      base: (await execGit({ cwd: repo.root, args: ['rev-parse', `${after}^`] })).stdout.trim(),
      after,
      hooks: false,
      sign: false,
      execPath: process.execPath,
      sequenceEditor: SEQUENCE_EDITOR,
      options: {
        exec: async (request) => {
          envs.push(request.env)
          return execGit(request)
        },
      },
    })
    expect(started.code).toBe(0)
    expect(envs.some(env => env?.GIT_EDITOR === 'true')).toBe(true)
  })

  it('retries amend without re-running add', async () => {
    const { repo, after } = await threeCommitRepo()
    expect((await startAtAfter(repo.root, after)).code).toBe(0)
    await repo.write('note.ts', 'fixed\n')
    await repo.git('add', '-u')
    const recorded: string[][] = []
    const finished = await finishRebase({
      repoRoot: repo.root,
      hooks: false,
      sign: false,
      stageUntracked: [],
      from: 'amend',
      options: {
        exec: async (request) => {
          recorded.push([...request.args])
          return execGit(request)
        },
      },
    })
    expect(finished.ok).toBe(true)
    expect(recorded.some(args => args[0] === 'add')).toBe(false)
    expect(recorded.some(args => args[0] === 'commit' && args.includes('--amend'))).toBe(true)
    expect(recorded.some(args => args[0] === 'rebase' && args.includes('--continue'))).toBe(true)
  })
})

describe('rebase session finish and start guards', () => {
  beforeEach(() => context.reset())

  afterEach(async () => {
    if (peek(sessionStatus) !== 'idle')
      await cancelSession('deactivate')
  })

  it('refuses Finish writes after Cancel during the untracked pick', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    await repo.write('notes.txt', 'untracked\n')
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })

    const pick = deferred<readonly string[] | undefined>()
    const parked = deferred<void>()
    harness.onPickUntracked = () => parked.resolve()
    harness.pickUntrackedWait = pick.promise

    const finishing = finishSession()
    await parked.promise
    await cancelSession('cancel')
    pick.resolve([])
    await finishing

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.head()).toBe(origHead)
    expect(await repo.read('app.ts')).toBe('wip\n')
    const abortAt = harness.gitLogs.findIndex(entry => entry.command === 'git rebase --abort')
    expect(abortAt).toBeGreaterThan(-1)
    expect(harness.gitLogs.slice(abortAt + 1).some(entry =>
      entry.command.includes('add -u') || entry.command.includes('commit --amend'),
    )).toBe(false)
    harness.dispose()
  })

  it('refuses Finish writes after a terminal abort during the untracked pick', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    await repo.write('notes.txt', 'untracked\n')
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })

    const pick = deferred<readonly string[] | undefined>()
    const parked = deferred<void>()
    harness.onPickUntracked = () => parked.resolve()
    harness.pickUntrackedWait = pick.promise

    const finishing = finishSession()
    await parked.promise
    await repo.git('rebase', '--abort')
    gitWatchToken.set(value => value + 1)
    await gitState()
    await syncRebaseOwnership()
    pick.resolve([])
    await finishing

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.head()).toBe(origHead)
    expect(await repo.read('app.ts')).toBe('wip\n')
    expect(harness.gitLogs.some(entry => entry.command.includes('commit --amend'))).toBe(false)
    harness.dispose()
  })

  it('refuses a merge commit as after and leaves the graph untouched', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'base\n' } })
    const base = await repo.head()
    await repo.write('app.ts', 'main2\n')
    await repo.git('add', '-A')
    await repo.commit('main2')
    await repo.git('checkout', '-b', 'side', base)
    await repo.write('side.ts', 'side1\n')
    await repo.git('add', '-A')
    await repo.commit('side1')
    await repo.write('side.ts', 'side2\n')
    await repo.git('add', '-A')
    await repo.commit('side2')
    await repo.git('checkout', 'main')
    await repo.git('merge', '--no-ff', '-m', 'merge side', 'side')
    const merge = await repo.head()
    await repo.write('app.ts', 'above1\n')
    await repo.git('add', '-A')
    await repo.commit('above1')
    const graph = await repo.git('log', '--graph', '--pretty=%s')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: merge })
    const preview = await startPreview()
    expect(preview.rebaseApplicable).toBe(false)
    expect(preview.rebaseHint).toBe(MERGE_AFTER_HINT)
    expect(preview.startEnabled).toBe(false)

    await expect(startSession({ entry: { kind: 'commit', rev: merge } }))
      .rejects
      .toBeInstanceOf(RebaseNotApplicableError)
    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.git('log', '--graph', '--pretty=%s')).toBe(graph)
    harness.dispose()
  })

  it('refuses a merge above the reviewed commit', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'base\n' } })
    await repo.write('app.ts', 'after\n')
    await repo.git('add', '-A')
    const after = await repo.commit('after')
    await repo.git('checkout', '-b', 'side')
    await repo.write('side.ts', 'side\n')
    await repo.git('add', '-A')
    await repo.commit('side')
    await repo.git('checkout', 'main')
    await repo.git('merge', '--no-ff', '-m', 'merge side', 'side')
    const graph = await repo.git('log', '--graph', '--pretty=%s')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: after })
    const preview = await startPreview()
    expect(preview.rebaseApplicable).toBe(false)
    expect(preview.rebaseHint).toBe(MERGE_ABOVE_HINT)

    await expect(startSession({ entry: { kind: 'commit', rev: after } }))
      .rejects
      .toBeInstanceOf(RebaseNotApplicableError)
    expect(await repo.git('log', '--graph', '--pretty=%s')).toBe(graph)
    harness.dispose()
  })

  it('aborts a live start instead of SIGKILL, then restores HEAD', async () => {
    const { repo, after } = await threeCommitRepo()
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    const flag = join(repo.root, 'editor-started')
    const sleeper = join(repo.root, 'sleeper.cjs')
    await writeFile(sleeper, [
      '\'use strict\'',
      'const { spawnSync } = require(\'node:child_process\')',
      'const { writeFileSync } = require(\'node:fs\')',
      `writeFileSync(${JSON.stringify(flag)}, '1')`,
      'const started = Date.now()',
      'while (Date.now() - started < 1500) {}',
      `const result = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(SEQUENCE_EDITOR)}, ...process.argv.slice(2)], { stdio: 'inherit' })`,
      'process.exit(result.status ?? 1)',
      '',
    ].join('\n'))
    sequenceEditorPath.set(sleeper)

    const starting = startSession({ entry: { kind: 'commit', rev: after } })
    const waitStart = Date.now()
    while (!(await repo.exists('editor-started'))) {
      if (Date.now() - waitStart > 8000)
        throw new Error('sequence editor never started')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await cancelSession('cancel')
    await expect(starting).rejects.toBeDefined()

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.head()).toBe(origHead)
    expect((await readGitState(repo.root)).rebase).toBeNull()
    harness.dispose()
  })

  it('saves dirty editors before Finish writes', async () => {
    const { repo, after } = await threeCommitRepo()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    harness.saveDocumentsCalls.length = 0
    harness.saveDocumentsResult = { ok: false, path: 'note.ts' }

    await finishSession()

    expect(peek(sessionStatus)).toBe('active')
    expect(harness.saveDocumentsCalls.length).toBeGreaterThan(0)
    expect(harness.notifications.some(note => note.message.includes('note.ts'))).toBe(true)
    expect(harness.gitLogs.some(entry => entry.command.includes('add -u'))).toBe(false)
    harness.dispose()
  })

  it('forwards an autostash pop conflict instead of claiming Finish succeeded', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('note.ts', 'wip\n')
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('note.ts', 'fixed\n')

    await finishSession()

    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(note => note.message === 'Review finished.')).toBe(false)
    expect(harness.notifications.some(note => /autostash/i.test(note.message))).toBe(true)
    gitWatchToken.set(value => value + 1)
    const state = await gitState()
    expect(state?.autostashes.length).toBe(1)
    expect((await repo.git('status', '--porcelain')).includes('UU')
      || (await readGitState(repo.root)).conflicts.length > 0).toBe(true)
    harness.dispose()
  })

  it('names a replay conflict instead of Review finished', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'base\n' } })
    await repo.write('app.ts', 'alpha\n')
    await repo.git('add', '-A')
    const after = await repo.commit('alpha')
    await repo.write('app.ts', 'beta\n')
    await repo.git('add', '-A')
    await repo.commit('beta')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('app.ts', 'gamma\n')
    await finishSession()

    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(note => note.message === CONFLICT_STOP)).toBe(true)
    expect(harness.notifications.some(note => note.message === 'Review finished.')).toBe(false)
    expect((await readGitState(repo.root)).rebase).not.toBeNull()
    harness.dispose()
  })

  it('finishes a ticked untracked file with guide defaults.finish and cancels with a matching fingerprint', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'one\n', 'note.ts': 'n1\n' } })
    await repo.write('app.ts', 'two\n')
    await repo.write('note.ts', 'n2\n')
    await repo.write('.tabthrough-guide.json', finishGuide(true))
    await repo.git('add', '-A')
    const after = await repo.commit('second')
    await repo.write('app.ts', 'three\n')
    await repo.git('add', '-A')
    await repo.commit('third')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('note.ts', 'fixed\n')
    await repo.write('keep.txt', 'keep\n')
    harness.pickedUntracked = ['keep.txt']
    await finishSession()

    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.gitLogs.some(entry => entry.command === 'git add -- keep.txt')).toBe(true)
    const amend = harness.gitLogs.find(entry => entry.command.includes('commit --amend'))
    expect(amend?.command.includes('--no-verify')).toBe(false)
    expect((await repo.git('ls-files', 'keep.txt')).trim()).toBe('keep.txt')
    harness.dispose()
  })

  it('cancel aborts and deactivate leaves the owned rebase', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    const before = await repo.fingerprint()
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    await startSession({ entry: { kind: 'commit', rev: after } })
    await cancelSession('cancel')
    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(true)

    await startSession({ entry: { kind: 'commit', rev: after } })
    const owned = peek(rebaseOwnership)
    expect(owned).not.toBeNull()
    await cancelSession('deactivate')
    expect(peek(sessionStatus)).toBe('idle')
    expect((await readGitState(repo.root)).rebase).not.toBeNull()
    expect((await readOwnership(repo.root, after, origHead)).ours).toBe(true)
    await repo.git('rebase', '--abort')
    harness.dispose()
  })

  it('matches Will run to the argv Start actually runs', async () => {
    const { repo, after } = await threeCommitRepo()
    const first = (await execGit({ cwd: repo.root, args: ['rev-parse', 'HEAD~3'] })).stdout.trim()
    const third = (await execGit({ cwd: repo.root, args: ['rev-parse', 'HEAD~1'] })).stdout.trim()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    pendingEntry.set({ kind: 'commit', rev: after })
    const commitPreview = await startPreview()
    await startSession({ entry: { kind: 'commit', rev: after } })
    const commitLog = harness.gitLogs.find(entry => entry.command.startsWith('git rebase -i'))
    expect(commitLog?.command).toBe(commitPreview.willRun)
    await cancelSession('cancel')

    pendingEntry.set({ kind: 'range', from: first, to: third })
    const rangePreview = await startPreview()
    await startSession({ entry: { kind: 'range', from: first, to: third } })
    const rangeLog = harness.gitLogs.filter(entry => entry.command.startsWith('git rebase -i')).at(-1)
    expect(rangePreview.willRun).toBe(rangeLog?.command)
    expect(rangePreview.willRun).toContain(first)
    expect(rangePreview.willRun).not.toContain(after)
    await cancelSession('cancel')
    harness.dispose()
  })

  it('matches Will run for a root commit and a guide defaults.finish', async () => {
    const rootRepo = await makeTempRepo({ files: { 'app.ts': 'one\n' } })
    const rootAfter = await rootRepo.head()
    const empty = (await execGit({
      cwd: rootRepo.root,
      args: ['hash-object', '-t', 'tree', '--stdin'],
      stdin: '',
    })).stdout.trim()
    const rootHarness = await bootstrapModel(rootRepo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: rootAfter })
    const rootPreview = await startPreview()
    expect(rootPreview.willRun).toBe(formatRebaseCommand(empty, false, false))
    await expect(startSession({ entry: { kind: 'commit', rev: rootAfter } })).rejects.toBeDefined()
    const rootLog = rootHarness.gitLogs.find(entry => entry.command.startsWith('git rebase -i'))
    expect(rootLog?.command).toBe(rootPreview.willRun)
    rootHarness.dispose()

    const repo = await makeTempRepo({ files: { 'app.ts': 'one\n' } })
    await repo.write('app.ts', 'two\n')
    await repo.write('.tabthrough-guide.json', finishGuide(true))
    await repo.git('add', '-A')
    const after = await repo.commit('second')
    await repo.write('app.ts', 'three\n')
    await repo.git('add', '-A')
    await repo.commit('third')
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: after })
    const preview = await startPreview()
    expect(preview.willRun.includes('--no-verify')).toBe(false)
    await startSession({ entry: { kind: 'commit', rev: after } })
    const logged = harness.gitLogs.find(entry => entry.command.startsWith('git rebase -i'))
    expect(logged?.command).toBe(preview.willRun)
    await cancelSession('cancel')
    harness.dispose()
  })

  it('returns staged WIP unstaged after Finish and after Cancel', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    await repo.git('add', 'app.ts')
    expect((await repo.git('status', '--porcelain', 'app.ts')).startsWith('M ')).toBe(true)

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await finishSession()
    expect((await repo.git('status', '--porcelain', 'app.ts')).startsWith(' M')).toBe(true)

    await repo.git('add', 'app.ts')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await cancelSession('cancel')
    expect((await repo.git('status', '--porcelain', 'app.ts')).startsWith(' M')).toBe(true)
    harness.dispose()
  })

  it('aborts a rebase cancelled after git rebase -i returns (T9)', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    const starting = startSession({ entry: { kind: 'commit', rev: after } })
    const waitStart = Date.now()
    while (!harness.gitLogs.some(entry => entry.command.startsWith('git rebase -i') && entry.code === 0)) {
      if (Date.now() - waitStart > 8000)
        throw new Error('git rebase -i never logged')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await cancelSession('cancel')
    await expect(starting).rejects.toBeDefined()

    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(session)).toBeNull()
    expect((await readGitState(repo.root)).rebase).toBeNull()
    expect(await repo.head()).toBe(origHead)
    expect(await repo.read('app.ts')).toBe('wip\n')
    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(true)
    harness.dispose()
  })

  it('does not let Cancel race Finish writes (T10)', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('.git/hooks/pre-commit', [
      '#!/bin/sh',
      'touch hook-started',
      'while [ ! -f hook-release ]; do',
      '  sleep 0.05',
      'done',
      '',
    ].join('\n'))
    if (!isWindows)
      await repo.setExecutable('.git/hooks/pre-commit')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    finishHooks.set(true)
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('note.ts', 'fixed\n')

    const finishing = finishSession()
    try {
      const waitStart = Date.now()
      while (!(await repo.exists('hook-started'))) {
        if (Date.now() - waitStart > 8000)
          throw new Error('pre-commit never started')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(peek(sessionStatus)).toBe('finishing')
      await cancelSession('cancel')
    }
    finally {
      await repo.write('hook-release', '1')
    }
    await finishing

    const aborted = harness.gitLogs.some(entry => entry.command === 'git rebase --abort' && entry.code === 0)
    const amendLocked = harness.gitLogs.some(entry =>
      entry.command.includes('commit --amend') && entry.code === 128)
    expect(aborted && amendLocked).toBe(false)
    expect(harness.notifications.some(note => note.message === 'Review finished.')).toBe(true)
    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.read('note.ts')).toBe('fixed\n')
    harness.dispose()
  })

  it('does not let Finish write while Cancel abort is in flight (T11)', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    await repo.write('notes.txt', 'untracked\n')
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })

    const pick = deferred<readonly string[] | undefined>()
    const parked = deferred<void>()
    harness.onPickUntracked = () => parked.resolve()
    harness.pickUntrackedWait = pick.promise

    const finishing = finishSession()
    await parked.promise
    const cancelling = cancelSession('cancel')
    pick.resolve([])
    await Promise.all([finishing, cancelling])

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.head()).toBe(origHead)
    expect(await repo.read('app.ts')).toBe('wip\n')
    expect(harness.gitLogs.some(entry =>
      entry.command.includes('add -u') || entry.command.includes('commit --amend'),
    )).toBe(false)
    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(true)
    harness.dispose()
  })

  it('waits for start abort before Cancel returns (T12)', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('app.ts', 'wip\n')
    const origHead = await repo.head()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')

    const parked = deferred<void>()
    const build = deferred<never>()
    guideSource.set({
      build: async () => {
        parked.resolve()
        return await build.promise
      },
    })

    const starting = startSession({ entry: { kind: 'commit', rev: after } })
    await parked.promise
    await cancelSession('cancel')

    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(true)
    expect((await readGitState(repo.root)).rebase).toBeNull()
    expect(await repo.head()).toBe(origHead)
    expect(await repo.read('app.ts')).toBe('wip\n')
    await expect(starting).rejects.toBeDefined()
    expect(peek(sessionStatus)).toBe('idle')
    harness.dispose()
  })

  it('does not abort a foreign rebase when Start is refused', async () => {
    const { repo, after } = await threeCommitRepo()
    const started = await startRebase({
      repoRoot: repo.root,
      base: (await execGit({ cwd: repo.root, args: ['rev-parse', `${after}^`] })).stdout.trim(),
      after,
      hooks: false,
      sign: false,
      execPath: process.execPath,
      sequenceEditor: SEQUENCE_EDITOR,
    })
    expect(started.code).toBe(0)
    expect((await readGitState(repo.root)).rebase).not.toBeNull()

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: after })
    const preview = await startPreview()
    expect(preview.rebaseApplicable).toBe(false)
    expect(preview.rebaseHint).toBe(REBASE_IN_PROGRESS_HINT)
    expect(preview.startEnabled).toBe(false)

    await expect(startSession({ entry: { kind: 'commit', rev: after } }))
      .rejects
      .toBeInstanceOf(RebaseNotApplicableError)
    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(false)
    expect((await readGitState(repo.root)).rebase).not.toBeNull()
    harness.dispose()
  })

  it('refuses rebase mode while a merge is in progress', async () => {
    const repo = await makeTempRepo({ files: { 'app.ts': 'base\n' } })
    await repo.write('app.ts', 'after\n')
    await repo.git('add', '-A')
    const after = await repo.commit('after')
    await repo.git('checkout', '-b', 'side')
    await repo.write('side.ts', 'side\n')
    await repo.git('add', '-A')
    await repo.commit('side')
    await repo.git('checkout', 'main')
    await repo.git('merge', '--no-commit', '--no-ff', 'side')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    pendingEntry.set({ kind: 'commit', rev: after })
    const preview = await startPreview()
    expect(preview.rebaseApplicable).toBe(false)
    expect(preview.rebaseHint).toBe(REBASE_IN_PROGRESS_HINT)

    await expect(startSession({ entry: { kind: 'commit', rev: after } }))
      .rejects
      .toBeInstanceOf(RebaseNotApplicableError)
    expect(harness.gitLogs.some(entry => entry.command === 'git rebase --abort')).toBe(false)
    expect((await readGitState(repo.root)).operation).toBe('merge')
    harness.dispose()
  })

  it('says Review finished on a clean Finish', async () => {
    const { repo, after } = await threeCommitRepo()
    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('note.ts', 'fixed\n')
    await finishSession()

    expect(peek(sessionStatus)).toBe('idle')
    expect(harness.notifications.some(note => note.message === 'Review finished.')).toBe(true)
    expect(harness.notifications.some(note => /\r/.test(note.message) || /Successfully rebased/.test(note.message)))
      .toBe(false)
    harness.dispose()
  })

  it('closes a zombie session after terminal abort under the Retry notice', async () => {
    const { repo, after } = await threeCommitRepo()
    await repo.write('.git/hooks/pre-commit', '#!/bin/sh\necho hook-ran >> hook.log\nexit 1\n')
    if (!isWindows)
      await repo.setExecutable('.git/hooks/pre-commit')

    const harness = await bootstrapModel(repo.root)
    sessionModeSetting.set('rebase')
    finishHooks.set(true)
    await startSession({ entry: { kind: 'commit', rev: after } })
    await repo.write('note.ts', 'fixed\n')

    const reply = deferred<string | undefined>()
    const parked = deferred<void>()
    harness.onNotify = () => parked.resolve()
    harness.notifyWait = reply.promise

    const finishing = finishSession()
    await parked.promise
    await repo.git('rebase', '--abort')
    gitWatchToken.set(value => value + 1)
    await gitState()
    reply.resolve(undefined)
    await finishing

    expect(peek(sessionStatus)).toBe('idle')
    expect(peek(session)).toBeNull()
    expect((await readGitState(repo.root)).rebase).toBeNull()
    expect(harness.notifications.some(note => note.message === OWNERSHIP_LOST)).toBe(true)
    harness.dispose()
  })
})

describe('shipped sequence editor', () => {
  it('stops at after when dist/sequence-editor.cjs is GIT_SEQUENCE_EDITOR', async () => {
    await access(DIST_EDITOR)
    const { repo, after } = await threeCommitRepo()
    const started = await startRebase({
      repoRoot: repo.root,
      base: (await execGit({ cwd: repo.root, args: ['rev-parse', `${after}^`] })).stdout.trim(),
      after,
      hooks: false,
      sign: false,
      execPath: process.execPath,
      sequenceEditor: DIST_EDITOR,
    })
    expect(started.code).toBe(0)
    expect(await repo.head()).toBe(after)
    expect((await readGitState(repo.root)).rebase?.stoppedSha).toBe(after)
  })
})
