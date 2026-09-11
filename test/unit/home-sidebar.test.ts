import type { CommitSummary } from '../../src/git/log'
import type { GitState } from '../../src/git/state'
import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { sidebarItems } from '../../src/model/sidebar'
import { PAYLOAD_COMMANDS, SIDEBAR_COMMANDS } from '../../src/ui/sidebar-commands'

type HomeSelection
  = | { readonly kind: 'none' }
    | { readonly kind: 'workingTree' }
    | { readonly kind: 'commit', readonly rev: string }
    | { readonly kind: 'range', readonly from: string, readonly to: string }

interface HomeRemote {
  readonly name: string
  readonly fetchUrl: string
}

interface HomeBranch {
  readonly name: string
  readonly ref: string
  readonly remote: string | null
  readonly current: boolean
  readonly shortSha: string
}

/** T-002 home phase: idle is one screen with history, selectors, and a selection. */
interface HomeSetupPhase {
  readonly kind: 'home'
  readonly commits: readonly CommitSummary[]
  readonly loading: boolean
  readonly error: string | null
  readonly remotes: readonly HomeRemote[]
  readonly selectedRemote: string | null
  readonly branches: readonly HomeBranch[]
  readonly selectedBranch: string | null
  readonly defaultBase: string | null
  readonly selection: HomeSelection
  readonly fetching: boolean
  readonly fetchError: string | null
}

function commitSummary(overrides: Partial<CommitSummary> & Pick<CommitSummary, 'sha' | 'subject'>): CommitSummary {
  return {
    shortSha: overrides.sha.slice(0, 7),
    author: 'Ada',
    relativeDate: '2 hours ago',
    parentCount: 1,
    ...overrides,
  }
}

function gitState(overrides: Partial<GitState> = {}): GitState {
  return {
    rebase: null,
    operation: null,
    conflicts: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    detached: false,
    branch: 'main',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    autostashes: [],
    worktrees: [],
    snapshotRefCount: 0,
    ...overrides,
  }
}

const NEWER = commitSummary({
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  shortSha: 'aaaaaaa',
  subject: 'Tip',
})
const OLDER = commitSummary({
  sha: 'cccccccccccccccccccccccccccccccccccccccc',
  shortSha: 'ccccccc',
  subject: 'Base',
})

function homeSetup(overrides: Partial<HomeSetupPhase> = {}): HomeSetupPhase {
  return {
    kind: 'home',
    commits: [NEWER, OLDER],
    loading: false,
    error: null,
    remotes: [{ name: 'origin', fetchUrl: 'https://example.invalid/tabthrough.git' }],
    selectedRemote: 'origin',
    branches: [
      { name: 'main', ref: 'refs/heads/main', remote: null, current: true, shortSha: 'aaaaaaa' },
      { name: 'feature', ref: 'refs/remotes/origin/feature', remote: 'origin', current: false, shortSha: 'bbbbbbb' },
    ],
    selectedBranch: 'main',
    defaultBase: 'main',
    selection: { kind: 'none' },
    fetching: false,
    fetchError: null,
    ...overrides,
  }
}

function view(setup: HomeSetupPhase, overrides: Partial<Omit<SidebarViewModel, 'setup'>> = {}): SidebarViewModel {
  const base: SidebarViewModel = {
    status: 'idle',
    mode: null,
    entry: null,
    summary: null,
    canStart: true,
    progress: null,
    currentStep: null,
    nextStep: null,
    complete: false,
    canAdvance: false,
    canRetreat: false,
    idleReason: null,
    setup,
    skillInstalled: true,
    guideFocused: false,
    sidecarReady: false,
    focusedGuideMismatch: false,
    guideFileName: '.tabthrough-guide.json',
    guideTopic: 'review',
    gitState: gitState({ unstaged: 1 }),
    willRun: 'nothing',
    willRunNotes: 'Read-only — the working tree is not checked out.',
    editHereEnabled: false,
    editedPaths: [],
    startEnabled: true,
    startHint: null,
    showModePicker: false,
    showRebase: false,
    rebaseApplicable: false,
    rebaseHint: null,
    chosenMode: null,
    askMode: false,
    previewMode: 'readonly',
    guideProvenance: null,
    guideFallback: false,
  }
  return { ...base, ...overrides, setup }
}

function rowsFor(setup: HomeSetupPhase, overrides: Partial<Omit<SidebarViewModel, 'setup'>> = {}) {
  return sidebarItems(view(setup, overrides))
}

function requireHome(setup: HomeSetupPhase): HomeSetupPhase {
  return setup
}

describe('home sidebar', () => {
  it('lists commits, working changes, remote/branch, and a header Review on home', () => {
    const setup = requireHome(homeSetup({
      selection: { kind: 'workingTree' },
    }))
    const rows = rowsFor(setup)
    const ids = rows.map(row => row.id)
    const commands = rows.map(row => row.command).filter(Boolean)

    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)?.surface).toBe('list')
    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)?.command).toBe('tabthrough.selectHomeRev')
    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)?.payload).toBe(NEWER.sha)
    expect(rows.find(row => row.id === `commit-${OLDER.sha}`)?.label).toBe('Base')

    expect(rows.find(row => row.id === 'working-tree')?.label).toBe('Working changes')
    expect(rows.find(row => row.id === 'working-tree')?.accent).toBe('selected')
    expect(rows.find(row => row.id === 'working-tree')?.command).toBe('tabthrough.pickWorkingTree')
    expect(ids.indexOf('working-tree')).toBeLessThan(ids.indexOf(`commit-${NEWER.sha}`))

    expect(rows.find(row => row.id === 'remote')?.command).toBe('tabthrough.setRemote')
    expect(rows.find(row => row.id === 'branch')?.command).toBe('tabthrough.setBranch')
    expect(rows.some(row => row.command === 'tabthrough.fetchRemote')).toBe(true)
    expect(ids.indexOf('remote')).toBeLessThan(ids.indexOf(`commit-${NEWER.sha}`))
    expect(ids.indexOf('branch')).toBeLessThan(ids.indexOf(`commit-${NEWER.sha}`))

    const review = rows.find(row => row.command === 'tabthrough.reviewSelection')
    expect(review?.slot).toBe('nav')
    expect(review?.tone).toBe('primary')
    expect(review?.label).toMatch(/Review|Working/i)

    expect(commands).not.toContain('tabthrough.pickCommit')
    expect(commands).not.toContain('tabthrough.pickRange')
    expect(rows.find(row => row.id === 'commit')).toBeUndefined()
    expect(rows.find(row => row.id === 'range')).toBeUndefined()
    expect(rows.find(row => row.id === 'welcome')).toBeUndefined()
    for (const row of rows) {
      if (row.command === undefined)
        continue
      expect(SIDEBAR_COMMANDS.has(row.command), row.command).toBe(true)
      if (row.payload !== undefined)
        expect(PAYLOAD_COMMANDS.has(row.command), row.command).toBe(true)
    }
  })

  it('marks Start and End when home selection is a two-commit range', () => {
    const rows = rowsFor(homeSetup({
      selection: { kind: 'range', from: OLDER.sha, to: NEWER.sha },
    }))
    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)?.accent).toBe('end')
    expect(rows.find(row => row.id === `commit-${OLDER.sha}`)?.accent).toBe('start')
    const review = rows.find(row => row.command === 'tabthrough.reviewSelection')
    expect(review?.slot).toBe('nav')
    expect(review?.tone).toBe('primary')
    expect(review?.enabled).toBe(true)
  })

  it('names a single selected commit on Review and does not keep a working-tree accent', () => {
    const rows = rowsFor(homeSetup({
      selection: { kind: 'commit', rev: NEWER.sha },
    }))
    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)?.accent).toBe('selected')
    expect(rows.find(row => row.id === 'working-tree')?.accent).not.toBe('selected')
    const review = rows.find(row => row.command === 'tabthrough.reviewSelection')
    expect(review?.slot).toBe('nav')
    expect(review?.tone).toBe('primary')
    expect(review?.label).toContain(NEWER.shortSha)
  })

  it('hides working changes when the checkout is clean', () => {
    const rows = rowsFor(homeSetup(), { gitState: gitState() })
    expect(rows.find(row => row.id === 'working-tree')).toBeUndefined()
    expect(rows.find(row => row.id === `commit-${NEWER.sha}`)).toBeDefined()
  })

  it('hides the remote selector when there are no remotes and disables Fetch', () => {
    const rows = rowsFor(homeSetup({
      remotes: [],
      selectedRemote: null,
    }))
    expect(rows.find(row => row.id === 'remote')).toBeUndefined()
    expect(rows.find(row => row.id === 'branch')?.command).toBe('tabthrough.setBranch')
    expect(rows.find(row => row.command === 'tabthrough.fetchRemote')?.enabled).toBe(false)
  })

  it('enables vs-default Review when nothing is selected on a non-default branch', () => {
    const rows = rowsFor(homeSetup({
      selectedBranch: 'feature',
      defaultBase: 'main',
      selection: { kind: 'none' },
    }), { gitState: gitState({ branch: 'main', unstaged: 1 }) })
    const review = rows.find(row => row.command === 'tabthrough.reviewSelection')
    expect(review?.slot).toBe('nav')
    expect(review?.tone).toBe('primary')
    expect(review?.enabled).toBe(true)
    expect(review?.label).toMatch(/main|feature|default/i)
    expect(rows.find(row => row.id === 'working-tree')?.accent).not.toBe('selected')
  })
})
