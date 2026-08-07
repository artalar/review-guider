import type { ReviewViewModel } from '../../src/model/view'
import type { TmpRepo } from '../helpers/tmp-repo'
import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showBlob } from '../../src/git/diff'
import { revealMode } from '../../src/model/config'
import { cancelSession, session, sessionStatus } from '../../src/model/session'
import { reviewViewModel } from '../../src/model/view'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

/**
 * Phase 5's gate: advance, retreat, and clamp, with the reveal document as a
 * pure function of the cursor. The two properties that matter are that the
 * revealed set only ever grows as the cursor advances, and that the last step
 * leaves the reveal document byte-identical to the file at the after revision.
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

const BEFORE = [
  'export const VERSION = 1',
  '',
  'function clamp(value: number, low: number, high: number) {',
  '  return Math.min(Math.max(value, low), high)',
  '}',
  '',
  'export function total(items: number[]) {',
  '  let sum = 0',
  '  for (const item of items) {',
  '    sum += item',
  '  }',
  '  return sum',
  '}',
  '',
  'export function average(items: number[]) {',
  '  return total(items) / items.length',
  '}',
  '',
  'export const legacyFlag = true',
  '',
].join('\n')

const AFTER = [
  'export const VERSION = 2',
  '',
  'function clamp(value: number, low: number, high: number) {',
  '  return Math.min(Math.max(value, low), high)',
  '}',
  '',
  'export function total(items: number[]) {',
  '  let sum = 0',
  '  for (const item of items) {',
  '    sum += clamp(item, 0, 100)',
  '  }',
  '  return sum',
  '}',
  '',
  'export function average(items: number[]) {',
  '  if (items.length === 0)',
  '    throw new Error(\'average of nothing\')',
  '  return total(items) / items.length',
  '}',
  '',
  '',
].join('\n')

const PATH = 'src/math.ts'

async function fixtureRepo(): Promise<TmpRepo> {
  const repo = await makeTempRepo({ files: { [PATH]: BEFORE } })
  await repo.write(PATH, AFTER)
  return repo
}

async function bootstrap(repo: TmpRepo) {
  const harness = await bootstrapModel(repo.root, { withReview: true })
  harnessDispose = harness.dispose
  return harness
}

/** The base blob is read lazily, so every read waits for the fold to exist. */
async function view(): Promise<ReviewViewModel> {
  return await vi.waitFor(() => {
    const model = peek(reviewViewModel)
    if (model === null || model.revealText === null || model.baseText === null)
      throw new Error('reveal document not rendered yet')
    return model
  }, { timeout: 10_000, interval: 5 })
}

function revealedIds(path: string = PATH): string[] {
  const model = peek(session)
  const file = model === null ? undefined : model.fileByPath.get(path)
  return file === undefined ? [] : [...peek(file.revealedGroups)].map(group => group.id).sort()
}

/** A module with `count` well-separated functions, so each edit is its own group. */
function moduleText(name: string, count: number, guarded: boolean): string {
  const lines: string[] = [`export const ${name}Version = ${guarded ? 2 : 1}`, '']
  for (let index = 0; index < count; index++) {
    lines.push(`export function ${name}${index}(value: number) {`)
    if (guarded) {
      lines.push('  if (!Number.isFinite(value))')
      lines.push(`    throw new Error('${name}${index}')`)
    }
    lines.push(`  return value * ${index + 1}`, '}', '')
  }
  return lines.join('\n')
}

const WIDE_MODULES = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'] as const

/** Three modules × four guard clauses each: comfortably past the ADR's ten steps. */
async function wideRepo(): Promise<TmpRepo> {
  const files: Record<string, string> = {}
  for (const path of WIDE_MODULES)
    files[path] = moduleText(path.slice(4, -3), 4, false)

  const repo = await makeTempRepo({ files })
  for (const path of WIDE_MODULES)
    await repo.write(path, moduleText(path.slice(4, -3), 4, true))
  return repo
}

describe('progressive reveal', () => {
  it('folds base → after one step at a time and lands on the after blob', async () => {
    const repo = await fixtureRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    const total = model.guide.steps.length
    expect(total).toBeGreaterThan(1)

    // Nothing revealed: the reveal document *is* the base document.
    model.jumpTo(-1)
    const empty = await view()
    expect(empty.revealText).toBe(empty.baseText)

    const seen: string[][] = []
    const texts: string[] = []
    for (let index = 0; index < total; index++) {
      model.jumpTo(index)
      const current = await view()
      texts.push(current.revealText ?? '')
      seen.push(revealedIds())
    }

    // Monotonic: a step never un-reveals what an earlier step revealed. The
    // *text* is not monotonic — revealing a deletion removes a line — which is
    // exactly why the invariant is stated over the group set.
    for (let index = 1; index < seen.length; index++)
      expect(seen[index]).toEqual(expect.arrayContaining(seen[index - 1]))

    const after = await showBlob(repo.root, model.afterRev, PATH)
    expect(after).toBe(AFTER)
    expect(texts.at(-1)).toBe(after)
  })

  // ADR 0001 acceptance gate 4, and plan Phase 5's first exit criterion. The
  // other reveal tests use `jumpTo`; this one presses Tab, because the gate is
  // about the loop a reader actually drives.
  it('advances through at least ten steps with monotonic visibility', async () => {
    const repo = await wideRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    expect(model.guide.steps.length).toBeGreaterThanOrEqual(10)

    model.jumpTo(-1)
    await view()

    let previous = new Map(WIDE_MODULES.map(path => [path, revealedIds(path)]))
    let presses = 0
    while (model.next()) {
      presses++
      await view()
      const current = new Map(WIDE_MODULES.map(path => [path, revealedIds(path)]))
      for (const path of WIDE_MODULES)
        expect(current.get(path)).toEqual(expect.arrayContaining(previous.get(path) ?? []))
      previous = current
    }

    expect(presses).toBe(model.guide.steps.length)
    expect(peek(model.isComplete)).toBe(true)

    // Every file has converged on its after blob, not just the last one visited.
    for (const path of WIDE_MODULES) {
      const after = await showBlob(repo.root, model.afterRev, path)
      await vi.waitFor(() => {
        const file = model.fileByPath.get(path)
        const text = file === undefined ? null : peek(file.revealText)
        if (text === null)
          throw new Error(`${path} is not rendered yet`)
        expect(text).toBe(after)
      }, { timeout: 10_000, interval: 5 })
    }
  })

  it('reverses exactly, so Shift+Tab restores the previous document', async () => {
    const repo = await fixtureRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    model.jumpTo(0)
    const first = (await view()).revealText

    model.jumpTo(1)
    const second = (await view()).revealText
    expect(second).not.toBe(first)

    expect(model.prev()).toBe(true)
    expect((await view()).revealText).toBe(first)

    // And forward again, to the identical document.
    expect(model.next()).toBe(true)
    expect((await view()).revealText).toBe(second)
  })

  it('clamps at both ends and reports the no-op Tab', async () => {
    const repo = await fixtureRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    model.jumpTo(model.guide.steps.length - 1)
    expect(peek(model.isComplete)).toBe(true)
    expect(model.next()).toBe(false)
    expect(peek(model.cursor)).toBe(model.guide.steps.length - 1)

    model.jumpTo(-1)
    expect(model.prev()).toBe(false)
    expect(peek(model.cursor)).toBe(-1)
  })

  it('points the highlight at lines the current step actually added', async () => {
    const repo = await fixtureRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    for (let index = 0; index < model.guide.steps.length; index++) {
      model.jumpTo(index)
      const current = await view()
      const step = model.guide.steps[index]
      if (step === undefined || step.groups.every(group => group.addedLines === 0))
        continue

      expect(current.ranges.length).toBeGreaterThan(0)
      const lines = (current.revealText ?? '').split('\n')
      for (const range of current.ranges) {
        expect(range.start).toBeGreaterThanOrEqual(1)
        expect(range.end).toBeLessThanOrEqual(lines.length)
      }
    }
  })

  it('walks a multi-file change and switches the active document with it', async () => {
    const repo = await makeTempRepo({
      files: {
        'src/types.ts': 'export interface User { id: string }\n',
        'src/ui/panel.tsx': 'export function Panel() {\n  return null\n}\n',
      },
    })
    await repo.write('src/types.ts', 'export interface User { id: string, name: string }\n')
    await repo.write('src/ui/panel.tsx', 'export function Panel() {\n  return <div>panel</div>\n}\n')

    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    const visited: string[] = []
    for (let index = 0; index < model.guide.steps.length; index++) {
      model.jumpTo(index)
      const current = await view()
      if (current.activePath !== null && visited.at(-1) !== current.activePath)
        visited.push(current.activePath)
      expect(current.revealText).not.toBeNull()
    }

    // Types before presentation, and each file gets its own document.
    expect(visited).toEqual(['src/types.ts', 'src/ui/panel.tsx'])
  })
})

describe('dim mode', () => {
  it('renders the whole change and marks what the cursor has not reached', async () => {
    revealMode.set('dim')

    const repo = await fixtureRepo()
    const harness = await bootstrap(repo)
    const model = await startReview(harness, { kind: 'workingTree' })

    model.jumpTo(0)
    const first = await view()
    const after = await showBlob(repo.root, model.afterRev, PATH)

    // The document never changes in dim mode: only the decorations move.
    expect(first.revealText).toBe(after)
    expect(first.pendingRanges.length).toBeGreaterThan(0)

    model.jumpTo(model.guide.steps.length - 1)
    const last = await view()
    expect(last.revealText).toBe(after)
    expect(last.pendingRanges).toEqual([])
  })
})
