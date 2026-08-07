import type { TmpRepo } from '../helpers/tmp-repo'
import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPatch } from '../../src/git/diff'
import { planIsolation } from '../../src/git/isolate'
import { readRecentCommits } from '../../src/git/log'
import { parseRangeInput, rangeInputError } from '../../src/git/types'
import { cancelSession, EmptyDiffError, guideDiagnostics, session, sessionStatus } from '../../src/model/session'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

/**
 * Phase 4's gate: all three entry points resolve to the same immutable
 * `(base, after)` pair and produce a real step list, on scripted repositories
 * covering linear history, a merge, a root commit, and the two diffs that must
 * refuse to start.
 */

let harnessDispose: (() => void) | null = null

beforeEach(() => context.reset())

afterEach(async () => {
  if (peek(sessionStatus) !== 'idle')
    await cancelSession('cancel')
  harnessDispose?.()
  harnessDispose = null
})

afterAll(cleanupTempRepos)

async function bootstrap(repo: TmpRepo) {
  const harness = await bootstrapModel(repo.root)
  harnessDispose = harness.dispose
  return harness
}

function paths(): string[] {
  return [...(peek(session)?.diff.files ?? [])].map(file => file.path).sort()
}

function stepPaths(): string[] {
  return [...(peek(session)?.guide.steps ?? [])].map(step => step.path)
}

/** Every changed line group belongs to exactly one step (invariant I1). */
function coverageIsComplete(): boolean {
  const model = peek(session)
  if (model === null)
    return false
  const inDiff = model.diff.files.flatMap(file => file.groups.map(group => group.id)).sort()
  const inSteps = model.guide.steps.flatMap(step => step.groups.map(group => group.id)).sort()
  return inDiff.length === inSteps.length && inDiff.every((id, index) => id === inSteps[index])
}

async function linearRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
  await repo.write('src/types.ts', 'export interface User { id: string }\n')
  await repo.git('add', '-A')
  await repo.commit('add types')
  await repo.write('src/app.ts', 'import type { User } from \'./types\'\n\nexport function greet(user: User) {\n  return user.id\n}\n')
  await repo.git('add', '-A')
  await repo.commit('add app')
  return repo
}

describe('entry point: working tree', () => {
  it('reviews staged, unstaged and untracked work as one diff', async () => {
    const repo = await linearRepo()
    await repo.write('src/types.ts', 'export interface User { id: string, name: string }\n')
    await repo.git('add', 'src/types.ts')
    await repo.write('src/app.ts', 'import type { User } from \'./types\'\n\nexport function greet(user: User) {\n  return user.name\n}\n')
    await repo.write('src/extra.ts', 'export const extra = 1\n')

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    expect(paths()).toEqual(['src/app.ts', 'src/extra.ts', 'src/types.ts'])
    expect(model.guide.steps.length).toBeGreaterThan(0)
    expect(coverageIsComplete()).toBe(true)
    // The foundation-before-consumer rule survives the whole pipeline.
    expect(stepPaths()[0]).toBe('src/types.ts')
  })

  it('reads the diff from the capture commit, not from the stashed disk', async () => {
    const repo = await linearRepo()
    await repo.write('src/app.ts', 'export const rewritten = true\n')

    const harness = await bootstrap(repo)
    await startReview(harness, { kind: 'workingTree' })

    // The tree on disk is back at HEAD, yet the review still sees the edit.
    expect(await repo.read('src/app.ts')).not.toContain('rewritten')
    expect(paths()).toEqual(['src/app.ts'])
    expect(peek(session)?.guide.steps.some(step => step.groups.length > 0)).toBe(true)
  })
})

describe('entry point: single commit', () => {
  it('reviews a commit against its first parent', async () => {
    const repo = await linearRepo()
    const head = await repo.head()

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'commit', rev: head })

    expect(model.afterRev).toBe(head)
    expect(paths()).toEqual(['src/app.ts'])
    expect(coverageIsComplete()).toBe(true)
  })

  it('reviews a root commit against the empty tree', async () => {
    const repo = await makeTempRepo({ files: { 'src/main.ts': 'export const main = 1\n', 'README.md': '# root\n' } })
    const root = await repo.head()

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'commit', rev: root })

    expect(model.afterRev).toBe(root)
    expect(paths()).toEqual(['README.md', 'src/main.ts'])
    expect(model.diff.files.every(file => file.status === 'added')).toBe(true)
  })

  it('reviews a merge commit against its first parent', async () => {
    const repo = await linearRepo()
    const mainTip = await repo.head()

    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/feature.ts', 'export const feature = 1\n')
    await repo.git('add', '-A')
    await repo.commit('feature work')

    await repo.git('checkout', '-q', 'main')
    await repo.write('src/on-main.ts', 'export const onMain = 1\n')
    await repo.git('add', '-A')
    await repo.commit('main work')
    await repo.git('merge', '--no-ff', '--no-edit', 'feature')
    const merge = await repo.head()

    expect(merge).not.toBe(mainTip)

    const harness = await bootstrap(repo)
    await startReview(harness, { kind: 'commit', rev: merge })

    // First parent is `main`, so the merge shows what `feature` brought in.
    expect(paths()).toEqual(['src/feature.ts'])
  })
})

describe('entry point: commit range', () => {
  it('resolves A..B through merge-base, so commits only on A are excluded', async () => {
    const repo = await linearRepo()
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/feature.ts', 'export const feature = 1\n')
    await repo.git('add', '-A')
    await repo.commit('feature work')
    const tip = await repo.head()

    await repo.git('checkout', '-q', 'main')
    await repo.write('src/only-on-main.ts', 'export const onlyOnMain = 1\n')
    await repo.git('add', '-A')
    await repo.commit('divergent main work')

    const base = (await repo.git('merge-base', 'main', 'feature')).trim()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'range', from: 'main', to: 'feature' })

    expect(model.baseRev).toBe(base)
    expect(model.afterRev).toBe(tip)
    // `src/only-on-main.ts` lives on the other side of the merge base.
    expect(paths()).toEqual(['src/feature.ts'])
  })

  it('produces the same patch text as git diff $(git merge-base A B) B', async () => {
    const repo = await linearRepo()
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/feature.ts', 'export const feature = 1\n')
    await repo.git('add', '-A')
    await repo.commit('feature work')

    const plan = await planIsolation(repo.root, {
      entry: { kind: 'range', from: 'main', to: 'feature' },
      includeUntracked: true,
    })
    const base = (await repo.git('merge-base', 'main', 'feature')).trim()

    expect(plan.baseRev).toBe(base)
    expect(await readPatch(repo.root, plan.baseRev, plan.afterRev ?? '')).toBe(
      await repo.git('-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-M', '-U3', '--patch', base, 'feature'),
    )
  })
})

describe('entry points that must refuse', () => {
  it('refuses an empty working tree', async () => {
    const repo = await linearRepo()
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toBeInstanceOf(EmptyDiffError)
    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toMatchObject({ reason: 'empty' })

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
  })

  it('refuses a whitespace-only working tree', async () => {
    const repo = await linearRepo()
    await repo.write('src/app.ts', 'import type { User } from \'./types\'\n\nexport function greet(user: User) {\n    return user.id\n}\n')
    const before = await repo.fingerprint()
    const harness = await bootstrap(repo)

    await expect(startReview(harness, { kind: 'workingTree' })).rejects.toMatchObject({ reason: 'whitespace' })

    expect(peek(sessionStatus)).toBe('idle')
    expect(await repo.fingerprint()).toEqual(before)
    expect(harness.notifications.at(-1)?.message).toContain('whitespace')
  })

  it('refuses a whitespace-only commit', async () => {
    const repo = await linearRepo()
    await repo.write('src/app.ts', 'import type { User } from \'./types\'\n\nexport function greet(user: User) {\n\t\treturn user.id\n}\n')
    await repo.git('add', '-A')
    await repo.commit('reindent')

    const harness = await bootstrap(repo)
    await expect(startReview(harness, { kind: 'commit', rev: 'HEAD' })).rejects.toMatchObject({ reason: 'whitespace' })
    expect(peek(sessionStatus)).toBe('idle')
  })

  it('refuses a revision that does not exist', async () => {
    const repo = await linearRepo()
    const harness = await bootstrap(repo)

    await expect(startReview(harness, { kind: 'commit', rev: 'no-such-ref' })).rejects.toThrow()
    expect(peek(sessionStatus)).toBe('idle')
  })
})

describe('the guide sidecar reaches the session', () => {
  it('takes the step order from a committed .guide.json', async () => {
    const repo = await linearRepo()
    await repo.write('src/app.ts', 'import type { User } from \'./types\'\n\nexport function greet(user: User) {\n  return user.name\n}\n')
    await repo.write('src/types.ts', 'export interface User { id: string, name: string }\n')
    await repo.write('.guide.json', JSON.stringify({
      version: 1,
      steps: [
        { id: 'caller-first', path: 'src/app.ts', order: 1, rationale: 'Start from the call site' },
        { id: 'then-types', path: 'src/types.ts', order: 2, rationale: 'Then the shape it needs' },
      ],
    }))

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    // The heuristic would have put the type first; the sidecar overrides it.
    expect(stepPaths()[0]).toBe('src/app.ts')
    expect(model.guide.steps[0]?.source).toBe('sidecar')
    expect(model.guide.steps[0]?.rationale).toBe('Start from the call site')
    expect(coverageIsComplete()).toBe(true)
  })

  it('falls back to the heuristic and warns when the sidecar is malformed', async () => {
    const repo = await linearRepo()
    await repo.write('src/types.ts', 'export interface User { id: string, name: string }\n')
    await repo.write('.guide.json', '{ not json')

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    expect(model.guide.steps.every(step => step.source === 'heuristic')).toBe(true)
    expect(model.guide.diagnostics.map(entry => entry.code)).toContain('parse-error')

    // The bridge turns exactly the warning-severity entries into exactly one
    // notification, so a broken guide costs the reader one dismissal, not one
    // per problem (guide-schema.md §5.4).
    const published = peek(guideDiagnostics)
    expect(published.filter(entry => entry.severity === 'warning')).toHaveLength(1)
  })
})

describe('the commit picker source', () => {
  it('lists history newest first, with the fields the pick list renders', async () => {
    const repo = await linearRepo()
    const commits = await readRecentCommits(repo.root, { limit: 10 })

    expect(commits.map(commit => commit.subject)).toEqual(['add app', 'add types', 'initial commit'])
    expect(commits[0]?.sha).toBe(await repo.head())
    expect(commits[0]?.shortSha.length).toBeGreaterThan(3)
    expect(commits[0]?.author).toBe('Guide Reviewer Test')
    expect(commits[0]?.relativeDate).not.toBe('')
    expect(commits.at(-1)?.parentCount).toBe(0)
  })

  it('flags a merge commit, which is reviewed against its first parent', async () => {
    const repo = await linearRepo()
    await repo.git('checkout', '-q', '-b', 'feature')
    await repo.write('src/feature.ts', 'export const feature = 1\n')
    await repo.git('add', '-A')
    await repo.commit('feature work')
    await repo.git('checkout', '-q', 'main')
    await repo.git('merge', '--no-ff', '--no-edit', 'feature')

    const commits = await readRecentCommits(repo.root)
    expect(commits[0]?.parentCount).toBe(2)
  })

  it('offers nothing rather than failing on an unborn branch', async () => {
    const repo = await makeTempRepo({ files: {}, initialCommit: false })
    expect(await readRecentCommits(repo.root)).toEqual([])
  })

  it('honours the limit so a deep history does not stall the picker', async () => {
    const repo = await linearRepo()
    expect(await readRecentCommits(repo.root, { limit: 1 })).toHaveLength(1)
  })
})

describe('range input parsing', () => {
  it('accepts two and three dots alike', () => {
    expect(parseRangeInput('main..HEAD')).toEqual({ from: 'main', to: 'HEAD' })
    expect(parseRangeInput('main...HEAD')).toEqual({ from: 'main', to: 'HEAD' })
    expect(parseRangeInput('  main .. HEAD  ')).toEqual({ from: 'main', to: 'HEAD' })
  })

  it('keeps dots that belong to the revision', () => {
    expect(parseRangeInput('v1.0..v2.0')).toEqual({ from: 'v1.0', to: 'v2.0' })
    expect(parseRangeInput('release/1.2.3..HEAD')).toEqual({ from: 'release/1.2.3', to: 'HEAD' })
  })

  it('rejects anything that is not a range', () => {
    expect(parseRangeInput('')).toBeNull()
    expect(parseRangeInput('HEAD')).toBeNull()
    expect(parseRangeInput('..HEAD')).toBeNull()
    expect(parseRangeInput('main..')).toBeNull()
    expect(parseRangeInput('main....HEAD')).toBeNull()
    expect(parseRangeInput('a b..c')).toBeNull()
  })

  it('explains the rejection instead of failing silently', () => {
    expect(rangeInputError('main..HEAD')).toBeNull()
    expect(rangeInputError('')).toContain('main..HEAD')
    expect(rangeInputError('HEAD')).toContain('two revisions')
  })
})
