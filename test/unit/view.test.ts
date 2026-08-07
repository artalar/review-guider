import type { IsolationHandle } from '../../src/git/isolate'
import type { SessionToken } from '../../src/git/journal'
import type { GuideStep } from '../../src/guide/types'
import { context, peek } from '@reatom/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { showRationale } from '../../src/model/config'
import { session } from '../../src/model/session'
import { reatomSession } from '../../src/model/steps'
import {
  basename,
  parseReviewDocPath,
  reviewDocPath,
  reviewDocTitle,
  reviewViewModel,
  statusText,
  statusTooltip,
} from '../../src/model/view'

/** The bridge's projections: URIs it addresses documents by, and the labels. */

const TOKEN: SessionToken = {
  v: 1,
  sessionId: 'view',
  createdAt: 0,
  heartbeatAt: null,
  repoRoot: '/repo',
  stage: 'reviewing',
  entry: { kind: 'workingTree' },
  headBefore: { kind: 'branch', name: 'main' },
  lockValue: null,
  afterRef: 'refs/tabthrough/after/view',
  afterCommit: 'aaa',
  afterTree: 'ttt',
  statusDigest: null,
  backupRef: null,
  backupCommit: null,
  stashMessage: null,
  checkedOut: null,
}

const HANDLE: IsolationHandle = {
  sessionId: 'view',
  repoRoot: '/repo',
  baseRev: 'base',
  afterRev: 'after',
  token: TOKEN,
}

function step(overrides: Partial<GuideStep> = {}): GuideStep {
  return {
    id: 'h:step',
    path: 'src/api/client.ts',
    groups: [],
    kind: 'stub',
    significance: 'normal',
    rationale: 'Types before callers',
    source: 'heuristic',
    ...overrides,
  }
}

function makeSession(steps: readonly GuideStep[]) {
  return reatomSession({
    id: 'view',
    repoRoot: '/repo',
    entry: { kind: 'workingTree' },
    baseRev: 'base',
    afterRev: 'after',
    handle: HANDLE,
    diff: { files: [], digest: 'sha256:test' },
    guide: { steps, stale: false, diagnostics: [] },
  })
}

beforeEach(() => context.reset())

describe('review document addresses', () => {
  it('keeps the repo-relative path intact so the editor can pick a language', () => {
    expect(reviewDocPath({ kind: 'reveal', sessionId: 'abc', path: 'src/deep/file.ts' }))
      .toBe('/abc/src/deep/file.ts')
  })

  it('round-trips through the parser', () => {
    for (const ref of [
      { kind: 'base' as const, sessionId: 'abc', path: 'a.ts' },
      { kind: 'reveal' as const, sessionId: 'abc', path: 'src/deep/nested/file.tsx' },
      { kind: 'reveal' as const, sessionId: 'abc', path: 'has space/and#hash.md' },
    ]) {
      expect(parseReviewDocPath(ref.kind, reviewDocPath(ref))).toEqual(ref)
    }
  })

  it('refuses anything that is not one of the two document kinds', () => {
    expect(parseReviewDocPath('other', '/abc/a.ts')).toBeNull()
    expect(parseReviewDocPath('reveal', '/abc')).toBeNull()
    expect(parseReviewDocPath('reveal', '/abc/')).toBeNull()
    expect(parseReviewDocPath('reveal', '/')).toBeNull()
  })

  it('titles the diff by file, not by step', () => {
    expect(reviewDocTitle('src/api/client.ts')).toBe('client.ts (Tabthrough)')
    expect(basename('src/api/client.ts')).toBe('client.ts')
    expect(basename('client.ts')).toBe('client.ts')
  })
})

describe('status bar composition', () => {
  it('reads $(book) k of n · file · rationale', () => {
    context.start(() => {
      const model = makeSession([step(), step({ id: 'h:second', path: 'src/ui/panel.tsx' })])
      session.set(model)

      expect(peek(statusText)).toBe('$(book) 0 of 2')

      model.next()
      expect(peek(statusText)).toBe('$(book) 1 of 2 · client.ts · Types before callers')

      showRationale.set(false)
      expect(peek(statusText)).toBe('$(book) 1 of 2 · client.ts')

      model.next()
      expect(peek(statusText)).toBe('$(book) Walkthrough complete · Finish and restore')
    })
  })

  it('has no text at all without a session, and explains why in the tooltip', () => {
    context.start(() => {
      expect(peek(statusText)).toBeNull()
      expect(peek(statusTooltip)).toContain('Tabthrough')
    })
  })

  it('offers the click target in the tooltip while reviewing', () => {
    context.start(() => {
      const model = makeSession([step({ title: 'The client', notes: 'Watch the retry' })])
      session.set(model)
      model.next()

      const tooltip = peek(statusTooltip) ?? ''
      expect(tooltip).toContain('The client')
      expect(tooltip).toContain('Watch the retry')
      expect(tooltip).toContain('jump to the current step')
    })
  })
})

describe('the view model', () => {
  it('is null without a session', () => {
    context.start(() => {
      expect(peek(reviewViewModel)).toBeNull()
    })
  })

  it('explains a stub step instead of opening an empty document', () => {
    context.start(() => {
      const model = makeSession([step({ kind: 'stub', path: 'res/icon.png', rationale: 'Skipped: binary file' })])
      session.set(model)
      model.next()

      const view = peek(reviewViewModel)
      expect(view?.activePath).toBe('res/icon.png')
      expect(view?.baseText).toBe('')
      expect(view?.revealText).toContain('Skipped: binary file')
      expect(view?.ranges).toEqual([])
      expect(view?.complete).toBe(true)
    })
  })

  it('reports progress and the after-revision the documents are cut from', () => {
    context.start(() => {
      const model = makeSession([step(), step({ id: 'h:second' })])
      session.set(model)
      model.next()

      const view = peek(reviewViewModel)
      expect(view?.progress).toEqual({ index: 1, total: 2 })
      expect(view?.baseRev).toBe('base')
      expect(view?.title).toBe('client.ts (Tabthrough)')
      expect(view?.complete).toBe(false)
    })
  })
})
