import type { CommitSummary } from '../../src/git/log'
import type { GitState } from '../../src/git/state'
import type { GuideStep } from '../../src/guide/types'
import type { RangeSetupPhase } from '../../src/model/setup'
import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { safeSidebarText, sidebarItems } from '../../src/model/sidebar'

function step(overrides: Partial<GuideStep> = {}): GuideStep {
  return {
    id: 'step',
    path: 'src/app.ts',
    groups: [],
    kind: 'reveal',
    significance: 'normal',
    rationale: 'The contract comes before its consumer',
    source: 'sidecar',
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

function commitSummary(overrides: Partial<CommitSummary> & Pick<CommitSummary, 'sha' | 'subject'>): CommitSummary {
  return {
    shortSha: overrides.sha.slice(0, 7),
    author: 'Ada',
    relativeDate: '2 hours ago',
    parentCount: 1,
    ...overrides,
  }
}

function rangeSetup(overrides: Partial<Omit<RangeSetupPhase, 'kind'>> = {}): RangeSetupPhase {
  return {
    kind: 'range',
    commits: [],
    loading: false,
    error: null,
    from: null,
    to: null,
    ...overrides,
  }
}

function view(overrides: Partial<SidebarViewModel> = {}): SidebarViewModel {
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
    setup: { kind: 'home' },
    skillInstalled: true,
    guideFocused: false,
    sidecarReady: false,
    focusedGuideMismatch: false,
    guideFileName: '.tabthrough-guide.json',
    gitState: null,
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
  }
  return { ...base, ...overrides }
}

describe('sidebar projection', () => {
  it('offers Review and optional Start while idle', () => {
    const rows = sidebarItems(view())
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.review',
    ])
  })

  it('lists review targets in the sidebar', () => {
    const rows = sidebarItems(view({ setup: { kind: 'targets' } }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.pickWorkingTree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
      'tabthrough.setupBack',
    ])
    expect(rows.find(row => row.id === 'working-tree')?.description).toContain('Uncommitted')
    expect(rows.find(row => row.id === 'back')?.slot).toBe('nav')
  })

  it('lists commits with a ref input once history is loaded', () => {
    const rows = sidebarItems(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        commits: [commitSummary({ sha: 'abc123def456', shortSha: 'abc123d', subject: 'Add types' })],
      },
    }))
    expect(rows.find(row => row.id === 'commit-abc123def456')?.payload).toBe('abc123def456')
    expect(rows.find(row => row.id === 'commit-abc123def456')?.description).toContain('abc123d')
    expect(rows.find(row => row.id === 'commit-ref')?.input?.placeholder).toBe('HEAD~1')
    expect(rows.find(row => row.id === 'commit-ref')?.input?.submit).toBe('Go')
    expect(rows.find(row => row.id === 'commit-ref')?.enabled).toBe(true)
    expect(rows.find(row => row.id === 'back')?.slot).toBe('nav')
  })

  it('surfaces a commit picker error and keeps Back', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'commits', commits: [], loading: false, error: 'That does not look like a commit, tag, or ref.' },
    }))
    expect(rows.find(row => row.id === 'pick-commit')?.description).toContain('does not look like')
    expect(rows.some(row => row.command === 'tabthrough.setupBack')).toBe(true)
  })

  it('shows range error text on the form', () => {
    const rows = sidebarItems(view({
      setup: rangeSetup({ error: 'Enter a commit range, for example main..HEAD.' }),
    }))
    expect(rows.find(row => row.id === 'pick-range')?.description).toContain('main..HEAD')
    expect(rows.find(row => row.id === 'range-input')?.input?.placeholder).toBe('main..HEAD')
    expect(rows.find(row => row.id === 'range-input')?.input?.submit).toBe('Use')
    expect(rows.find(row => row.id === 'back')?.slot).toBe('nav')
  })

  it('lists range commits and marks the start, end, and in-between', () => {
    const newer = commitSummary({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortSha: 'aaaaaaa', subject: 'Tip' })
    const middle = commitSummary({ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shortSha: 'bbbbbbb', subject: 'Middle' })
    const older = commitSummary({ sha: 'cccccccccccccccccccccccccccccccccccccccc', shortSha: 'ccccccc', subject: 'Base' })
    const rows = sidebarItems(view({
      setup: rangeSetup({
        commits: [newer, middle, older],
        from: older.sha,
        to: newer.sha,
      }),
    }))
    expect(rows.find(row => row.id === `commit-${newer.sha}`)?.surface).toBe('list')
    expect(rows.find(row => row.id === `commit-${newer.sha}`)?.accent).toBe('end')
    expect(rows.find(row => row.id === `commit-${middle.sha}`)?.accent).toBe('between')
    expect(rows.find(row => row.id === `commit-${older.sha}`)?.accent).toBe('start')
    expect(rows.find(row => row.id === 'use-range')?.payload).toBe(`${older.sha}..${newer.sha}`)
    expect(rows.find(row => row.id === 'use-range')?.label).toContain('ccccccc..aaaaaaa')
  })

  it('marks a single range bound as selected until the other end is picked', () => {
    const newer = commitSummary({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', subject: 'Tip' })
    const rows = sidebarItems(view({
      setup: rangeSetup({ commits: [newer], from: newer.sha }),
    }))
    expect(rows.find(row => row.id === `commit-${newer.sha}`)?.accent).toBe('selected')
    expect(rows.find(row => row.id === 'use-range')?.enabled).toBe(false)
  })

  it('shows Start when a guide is focused at home', () => {
    const rows = sidebarItems(view({ guideFocused: true }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.startFromGuide',
      'tabthrough.review',
    ])
  })

  it('offers Simple and Agent after a target is picked, and names Will run', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
    }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.generateSimple',
      'tabthrough.generateAgent',
      'tabthrough.setupBack',
    ])
    expect(rows.find(row => row.id === 'will-run')?.label).toBe('Will run: nothing')
  })

  it('offers Rebase when asked, and disables Start when the commit is not an ancestor', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'commit', rev: 'abc' } },
      showModePicker: true,
      showRebase: true,
      rebaseApplicable: false,
      rebaseHint: 'This commit is not on the current branch. Start in Worktree mode.',
      startEnabled: false,
      startHint: 'This commit is not on the current branch. Start in Worktree mode.',
      willRun: 'nothing',
      sidecarReady: true,
    }))
    expect(rows.find(row => row.id === 'mode-rebase')?.enabled).toBe(false)
    expect(rows.find(row => row.id === 'mode-rebase')?.description).toContain('Worktree')
    expect(rows.find(row => row.command === 'tabthrough.startFromGuide')?.enabled).toBe(false)
  })

  it('shows Start in generate when the sidecar is already on disk', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
      sidecarReady: true,
    }))
    expect(rows.some(row => row.command === 'tabthrough.startFromGuide')).toBe(true)
  })

  it('explains a focused guide that is not the sidecar', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
      guideFocused: true,
      focusedGuideMismatch: true,
    }))
    expect(rows.some(row => row.id === 'guide-mismatch')).toBe(true)
    expect(rows.some(row => row.command === 'tabthrough.startFromGuide')).toBe(false)
  })

  it('hides Agent until skill presence is known', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
      skillInstalled: null,
    }))
    expect(rows.find(row => row.command === 'tabthrough.generateAgent')?.enabled).toBe(false)
  })

  it('shows the install skill action when the workspace has no skill', () => {
    const rows = sidebarItems(view({ skillInstalled: false }))
    expect(rows.some(row => row.command === 'tabthrough.installSkill')).toBe(true)
  })

  it('keeps summary, rationale, notes, and controls visible during a walk', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'readonly',
      entry: 'working tree',
      summary: 'Read the state model before the bridge wiring.',
      progress: { index: 1, total: 2 },
      canAdvance: true,
      editHereEnabled: true,
      currentStep: step({ title: 'State contract', notes: 'This note must remain visible without opening a tooltip.' }),
      nextStep: step({ id: 'next', path: 'src/ui.ts', title: 'Bridge wiring' }),
    }))
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('summary')?.description).toContain('state model')
    expect(byId.get('rationale')?.description).toContain('contract')
    expect(byId.get('notes')?.description).toContain('remain visible')
    expect(byId.get('previous')?.slot).toBe('nav')
    expect(byId.get('previous')?.enabled).toBe(false)
    expect(byId.get('next')?.command).toBe('tabthrough.next')
    expect(byId.get('next')?.slot).toBe('nav')
    expect(byId.get('finish')?.slot).toBeUndefined()
    expect(byId.get('cancel')?.command).toBe('tabthrough.cancel')
    expect(byId.get('edit-here')?.enabled).toBe(true)
  })

  it('marks the current file when disk differs from the snapshot', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'readonly',
      currentStep: step({ title: 'State contract' }),
      editedPaths: ['src/app.ts'],
    }))
    expect(rows.find(row => row.id === 'current')?.label).toContain('edited on disk')
  })

  it('disables Edit here for a commit review', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'readonly',
      entry: 'commit abc',
      editHereEnabled: false,
      currentStep: step(),
    }))
    expect(rows.find(row => row.id === 'edit-here')?.enabled).toBe(false)
    expect(rows.find(row => row.id === 'edit-here')?.description).toContain('Rebase or Worktree')
  })

  it('shows starting with Will run and a cancel', () => {
    const rows = sidebarItems(view({ status: 'starting', willRun: 'nothing' }))
    expect(rows.find(row => row.id === 'starting')?.description).toBe('Will run: nothing')
    expect(rows.some(row => row.command === 'tabthrough.cancel')).toBe(true)
  })

  it('hides cancel while finishing', () => {
    const rows = sidebarItems(view({ status: 'finishing' }))
    expect(rows.some(row => row.command === 'tabthrough.cancel')).toBe(false)
  })

  it('bounds and removes control characters from untrusted guide text', () => {
    const clean = safeSidebarText(`ok\u0000${'x'.repeat(600)}`)
    expect(clean).toMatch(/^okx+/)
    expect(clean.length).toBe(500)
    expect(clean).not.toContain('\u0000')
  })

  it('keeps the full last-step note visible at completion', () => {
    const notes = 'A detailed explanation. '.repeat(70)
    const rows = sidebarItems(view({ status: 'active', mode: 'readonly', complete: true, currentStep: step({ notes }) }))
    expect(rows.find(row => row.id === 'notes')?.description).toBe(notes)
    expect(rows.find(row => row.id === 'finish')?.slot).toBe('nav')
    expect(rows.some(row => row.id === 'next')).toBe(false)
  })

  it('shows Continue and Abort while a rebase is stopped', () => {
    const rows = sidebarItems(view({
      gitState: gitState({
        rebase: {
          branch: 'main',
          onto: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          stoppedSha: 'cccccccccccccccccccccccccccccccccccccccc',
          origHead: 'dddddddddddddddddddddddddddddddddddddddd',
          done: 1,
          total: 3,
          autostashSha: null,
        },
      }),
    }))
    expect(rows.find(row => row.id === 'rebase')?.label).toContain('Rebasing main')
    expect(rows.map(row => row.command).filter(Boolean)).toEqual(expect.arrayContaining([
      'tabthrough.continueRebase',
      'tabthrough.abortRebase',
      'tabthrough.commitHandoff',
    ]))
  })

  it('lists autostash Pop / Show and worktree Open / Remove / Prune', () => {
    const rows = sidebarItems(view({
      gitState: gitState({
        autostashes: [{ selector: 'stash@{0}', subject: 'On main: autostash' }],
        worktrees: [{ path: '/tmp/tabthrough/ours', head: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', dirty: false }],
      }),
    }))
    const ids = rows.map(row => row.id)
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('autostash-stash@{0}'))
    expect(ids.indexOf('review')).toBeLessThan(ids.indexOf('pop-stash@{0}'))
    expect(rows.some(row => row.command === 'tabthrough.popAutostash' && row.payload === 'stash@{0}')).toBe(true)
    expect(rows.some(row => row.command === 'tabthrough.showAutostash')).toBe(true)
    expect(rows.some(row => row.command === 'tabthrough.openWorktree')).toBe(true)
    expect(rows.some(row => row.command === 'tabthrough.removeWorktree')).toBe(true)
    expect(rows.some(row => row.command === 'tabthrough.pruneWorktrees')).toBe(true)
  })

  it('keeps leftover autostash under the walk actions', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'readonly',
      currentStep: step(),
      gitState: gitState({
        autostashes: [{ selector: 'stash@{1}', subject: 'On main: autostash' }],
      }),
    }))
    const ids = rows.map(row => row.id)
    expect(ids.indexOf('cancel')).toBeLessThan(ids.indexOf('autostash-stash@{1}'))
    expect(ids.indexOf('edit-here')).toBeLessThan(ids.indexOf('autostash-stash@{1}'))
  })

  it('opens a conflicted path from the banner', () => {
    const rows = sidebarItems(view({
      gitState: gitState({ conflicts: ['src/app.ts'] }),
    }))
    expect(rows.find(row => row.command === 'tabthrough.openConflict')?.payload).toBe('src/app.ts')
  })
})
