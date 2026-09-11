import type { CommitSummary } from '../../src/git/log'
import type { GitState } from '../../src/git/state'
import type { GuideStep } from '../../src/guide/types'
import type { RangeSetupPhase } from '../../src/model/setup'
import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { safeSidebarText, sidebarItems } from '../../src/model/sidebar'
import { PAYLOAD_COMMANDS, SIDEBAR_COMMANDS } from '../../src/ui/sidebar-commands'

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
    pick: 'from',
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
    guideProvenance: null,
    guideFallback: false,
  }
  return { ...base, ...overrides }
}

describe('sidebar projection', () => {
  it('opens home on the three review targets', () => {
    const rows = sidebarItems(view())
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.pickWorkingTree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
    ])
    expect(rows.find(row => row.id === 'welcome')?.label).toBe('Review a change')
    expect(rows.find(row => row.id === 'working-tree')?.description).toContain('Staged')
    expect(rows.find(row => row.id === 'working-tree')?.surface).toBe('list')
    expect(rows.find(row => row.id === 'commit')?.surface).toBe('list')
    expect(rows.find(row => row.id === 'range')?.surface).toBe('list')
  })

  it('lists the same targets when setup is still on the legacy targets phase', () => {
    const rows = sidebarItems(view({ setup: { kind: 'targets' } }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.pickWorkingTree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
    ])
    expect(rows.find(row => row.id === 'back')).toBeUndefined()
  })

  it('lists commits with a ref input once history is loaded', () => {
    const rows = sidebarItems(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        commits: [commitSummary({ sha: 'abc123def456', shortSha: 'abc123d', subject: 'Add types' })],
        selected: null,
      },
    }))
    expect(rows.find(row => row.id === 'commit-abc123def456')?.payload).toBe('pick:abc123def456')
    expect(rows.find(row => row.id === 'commit-abc123def456')?.description).toContain('abc123d')
    expect(rows.find(row => row.id === 'commit-ref')?.input?.placeholder).toBe('HEAD~1')
    expect(rows.find(row => row.id === 'commit-ref')?.input?.hideSubmit).toBe(true)
    expect(rows.find(row => row.id === 'use-commit')?.slot).toBe('nav')
    expect(rows.find(row => row.id === 'use-commit')?.enabled).toBe(false)
    expect(rows.find(row => row.id === 'back')?.slot).toBe('nav')
  })

  it('enables Use commit after a history row is picked', () => {
    const commit = commitSummary({ sha: 'abc123def456', shortSha: 'abc123d', subject: 'Add types' })
    const rows = sidebarItems(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        commits: [commit],
        selected: commit.sha,
      },
    }))
    expect(rows.find(row => row.id === `commit-${commit.sha}`)?.accent).toBe('selected')
    expect(rows.find(row => row.id === 'use-commit')?.enabled).toBe(true)
    expect(rows.find(row => row.id === 'use-commit')?.payload).toBe(commit.sha)
  })

  it('surfaces a commit picker error and keeps Back', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'commits', commits: [], loading: false, error: 'That does not look like a commit, tag, or ref.', selected: null },
    }))
    expect(rows.find(row => row.id === 'commit-ref')?.input?.error).toContain('does not look like')
    expect(rows.some(row => row.command === 'tabthrough.setupBack')).toBe(true)
  })

  it('shows range error text on the form', () => {
    const rows = sidebarItems(view({
      setup: rangeSetup({ error: 'Enter a commit range, for example main..HEAD.' }),
    }))
    expect(rows.find(row => row.id === 'range-start')?.input?.error).toContain('main..HEAD')
    expect(rows.find(row => row.id === 'range-start')?.input?.bound).toBe('from')
    expect(rows.find(row => row.id === 'range-end')?.input?.bound).toBe('to')
    expect(rows.find(row => row.id === 'use-range')?.slot).toBe('nav')
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
    expect(rows.find(row => row.id === 'use-range')?.label).toBe('Use range')
    expect(rows.find(row => row.id === 'history-heading')?.label).toBe('Recent commits · choose start')
  })

  it('names the next range bound from the focused field', () => {
    const rows = sidebarItems(view({
      setup: rangeSetup({ pick: 'to', from: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    }))
    expect(rows.find(row => row.id === 'history-heading')?.label).toBe('Recent commits · choose end')
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
      'tabthrough.pickWorkingTree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
    ])
    expect(rows.find(row => row.id === 'start-guide')?.label).toBe('Continue with this guide')
  })

  it('offers Simple and Agent after a target is picked, and names the workspace consequence', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
    }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.generateSimple',
      'tabthrough.generateAgent',
      'tabthrough.startFromGuide',
      'tabthrough.setupBack',
    ])
    expect(rows.find(row => row.id === 'start-guide')?.slot).toBe('nav')
    expect(rows.find(row => row.id === 'start-guide')?.enabled).toBe(false)
    expect(rows.find(row => row.id === 'simple')?.label).toBe('Generate Simple guide')
    expect(rows.find(row => row.id === 'agent')?.label).toBe('Ask editor agent')
    expect(rows.find(row => row.id === 'will-run')?.label).toContain('review snapshot')
    expect(rows.find(row => row.id === 'will-run')?.label).not.toContain('Will run: nothing')
  })

  it('offers Rebase when asked, and disables Start when the commit is not an ancestor', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'commit', rev: 'abc' } },
      showModePicker: true,
      showRebase: true,
      rebaseApplicable: false,
      rebaseHint: 'This commit is not on the current branch, so Rebase is unavailable.',
      startEnabled: false,
      startHint: 'This commit is not on the current branch, so Rebase is unavailable.',
      willRun: 'nothing',
      sidecarReady: true,
    }))
    expect(rows.find(row => row.id === 'mode-rebase')?.enabled).toBe(false)
    expect(rows.find(row => row.id === 'mode-rebase')?.description).toContain('Rebase is unavailable')
    expect(rows.find(row => row.id === 'mode-worktree')).toBeUndefined()
    expect(rows.find(row => row.command === 'tabthrough.startFromGuide')?.enabled).toBe(false)
  })

  it('allowlists mode picker clicks so Read-only and Rebase reach chooseMode', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'commit', rev: 'abc' } },
      showModePicker: true,
      showRebase: true,
      rebaseApplicable: true,
    }))
    const readonly = rows.find(row => row.id === 'mode-readonly')
    const rebase = rows.find(row => row.id === 'mode-rebase')
    expect(readonly?.command).toBe('tabthrough.chooseMode')
    expect(readonly?.payload).toBe('readonly')
    expect(readonly?.surface).toBe('list')
    expect(rebase?.command).toBe('tabthrough.chooseMode')
    expect(rebase?.surface).toBe('list')
    expect(rebase?.payload).toBe('rebase')
    expect(SIDEBAR_COMMANDS.has('tabthrough.chooseMode')).toBe(true)
    expect(PAYLOAD_COMMANDS.has('tabthrough.chooseMode')).toBe(true)
    for (const row of rows) {
      if (row.command === undefined)
        continue
      expect(SIDEBAR_COMMANDS.has(row.command)).toBe(true)
      if (row.payload !== undefined)
        expect(PAYLOAD_COMMANDS.has(row.command)).toBe(true)
    }
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
    expect(rows.find(row => row.id === 'start-guide')?.enabled).toBe(false)
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
      guideProvenance: 'repository',
      summary: 'Read the state model before the bridge wiring.',
      progress: { index: 1, total: 2 },
      canAdvance: true,
      editHereEnabled: true,
      currentStep: step({ title: 'State contract', notes: 'This note must remain visible without opening a tooltip.' }),
      nextStep: step({ id: 'next', path: 'src/ui.ts', title: 'Bridge wiring' }),
    }))
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('summary')?.description).toContain('state model')
    expect(byId.get('summary')?.label).toBe('Guide overview')
    expect(byId.get('summary')?.surface).toBe('disclosure')
    expect(byId.get('session')?.label).toBe('Read-only · Working changes')
    expect(byId.get('rationale')?.label).toBe('Why this comes here')
    expect(byId.get('rationale')?.description).toContain('contract')
    expect(byId.get('notes')?.description).toContain('remain visible')
    expect(rows.findIndex(row => row.id === 'notes')).toBeLessThan(rows.findIndex(row => row.id === 'rationale'))
    expect(rows.findIndex(row => row.id === 'rationale')).toBeLessThan(rows.findIndex(row => row.id === 'edit-here'))
    expect(byId.get('next-step')?.label).toBe('Up next')
    expect(byId.get('previous')?.slot).toBe('nav')
    expect(byId.get('previous')?.enabled).toBe(false)
    expect(byId.get('next')?.command).toBe('tabthrough.next')
    expect(byId.get('next')?.slot).toBe('nav')
    expect(byId.get('finish')).toBeUndefined()
    expect(byId.get('cancel')?.command).toBe('tabthrough.cancel')
    expect(byId.get('cancel')?.label).toBe('End walkthrough')
    expect(byId.get('cancel')?.slot).toBe('nav')
    expect(byId.get('edit-here')?.label).toBe('Open real file')
    expect(byId.get('edit-here')?.enabled).toBe(true)
  })

  it('marks the current file when disk differs from the snapshot', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'readonly',
      currentStep: step({ title: 'State contract' }),
      editedPaths: ['src/app.ts'],
    }))
    expect(rows.find(row => row.id === 'current')?.label).toBe('State contract')
    expect(rows.find(row => row.id === 'edited')?.label).toBe('Edited on disk')
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
    expect(rows.find(row => row.id === 'edit-here')?.label).toBe('Open real file')
    expect(rows.find(row => row.id === 'edit-here')?.description).toContain('working-changes or rebase')
  })

  it('shows starting with a cancel', () => {
    const rows = sidebarItems(view({ status: 'starting', willRun: 'nothing', entry: 'working tree' }))
    expect(rows.find(row => row.id === 'starting')?.label).toBe('Starting walkthrough…')
    expect(rows.find(row => row.id === 'will-run')?.label).toContain('review snapshot')
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
    expect(rows.find(row => row.id === 'finish')?.label).toBe('Finish walkthrough')
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
    expect(rows.find(row => row.id === 'continue-rebase')?.label).toBe('Continue rebase')
    expect(rows.find(row => row.id === 'abort-rebase')?.label).toBe('Abort rebase')
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
    expect(ids.indexOf('working-tree')).toBeLessThan(ids.indexOf('autostash-stash@{0}'))
    expect(ids.indexOf('working-tree')).toBeLessThan(ids.indexOf('pop-stash@{0}'))
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

  it('uses rebase finish and abort copy on the last step', () => {
    const rows = sidebarItems(view({
      status: 'active',
      mode: 'rebase',
      entry: 'commit abc',
      complete: true,
      progress: { index: 2, total: 2 },
      canRetreat: true,
      currentStep: step(),
    }))
    expect(rows.find(row => row.id === 'finish')?.label).toBe('Amend and continue')
    expect(rows.find(row => row.id === 'finish')?.slot).toBe('nav')
    expect(rows.find(row => row.id === 'cancel')?.label).toBe('Abort rebase')
    expect(rows.find(row => row.id === 'cancel')?.tone).toBe('consequential')
    expect(rows.find(row => row.id === 'complete')?.label).toBe('All 2 steps revealed')
    expect(rows.find(row => row.id === 'session')?.label).toBe('Rebase · selected commit')
  })

  it('opens a conflicted path from the banner', () => {
    const rows = sidebarItems(view({
      gitState: gitState({ conflicts: ['src/app.ts'] }),
    }))
    expect(rows.find(row => row.command === 'tabthrough.openConflict')?.payload).toBe('src/app.ts')
  })
})
