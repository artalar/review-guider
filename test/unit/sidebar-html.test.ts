import type { CommitSummary } from '../../src/git/log'
import type { GitState } from '../../src/git/state'
import type { HomeSetupPhase, RangeSetupPhase } from '../../src/model/setup'
import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { htmlAttr, htmlText, renderSidebarBody, renderSidebarHtml } from '../../src/ui/sidebar-html'

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

function idleHome(overrides: Partial<HomeSetupPhase> = {}): HomeSetupPhase {
  return {
    kind: 'home',
    commits: [],
    loading: false,
    error: null,
    remotes: [],
    selectedRemote: null,
    branches: [],
    selectedBranch: 'main',
    defaultBase: 'main',
    selection: { kind: 'none' },
    fetching: false,
    fetchError: null,
    ...overrides,
  }
}

function view(overrides: Partial<SidebarViewModel> = {}): SidebarViewModel {
  return {
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
    setup: idleHome(),
    skillInstalled: true,
    guideFocused: false,
    sidecarReady: false,
    focusedGuideMismatch: false,
    guideFileName: '.tabthrough-guide.json',
    guideTopic: 'review',
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
    ...overrides,
  }
}

describe('sidebar text boundary', () => {
  it('escapes HTML and keeps a full-length note readable', () => {
    const text = `<script>alert("x")</script>\n${'note '.repeat(350)}`
    const html = htmlText(text)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<br>')
    expect(html).toContain('note '.repeat(350))
  })

  it('escapes attribute payloads without turning newlines into tags', () => {
    expect(htmlAttr('abc"def\nHEAD', 200)).toBe('abc&quot;def HEAD')
  })

  it('renders the range form with a data-command host can post', () => {
    const html = renderSidebarBody(view({ setup: rangeSetup() }))
    expect(html).toContain('data-command="tabthrough.submitRange"')
    expect(html).toContain('data-bound="from"')
    expect(html).toContain('data-bound="to"')
    expect(html).toContain('<form')
    expect(html).toContain('Use range')
    expect(html).toMatch(/data-id="use-range"[^>]* disabled/)
    expect(html).toContain('<header class="chrome setup">')
    expect(html).toContain('data-command="tabthrough.setupBack"')
    expect(html).toContain('aria-label="Review"')
    expect(html.indexOf('Use range')).toBeGreaterThan(html.indexOf('<header class="chrome setup">'))
    expect(html.indexOf('Use range')).toBeLessThan(html.indexOf('<main class="body">'))
    expect(html.indexOf('range-fields')).toBeGreaterThan(html.indexOf('<header class="chrome setup">'))
    expect(html.indexOf('range-fields')).toBeLessThan(html.indexOf('<main class="body">'))
  })

  it('highlights the selected range ends and the commits between them', () => {
    const newer = commitSummary({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortSha: 'aaaaaaa', subject: 'Tip' })
    const middle = commitSummary({ sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', shortSha: 'bbbbbbb', subject: 'Middle' })
    const older = commitSummary({ sha: 'cccccccccccccccccccccccccccccccccccccccc', shortSha: 'ccccccc', subject: 'Base' })
    const html = renderSidebarBody(view({
      setup: rangeSetup({
        commits: [newer, middle, older],
        from: older.sha,
        to: newer.sha,
      }),
    }))
    expect(html).toContain('list-pick')
    expect(html).toContain('range-start')
    expect(html).toContain('range-end')
    expect(html).toContain('range-between')
    expect(html).toContain('aria-label="Start"')
    expect(html).toContain('aria-label="End"')
    expect(html).toContain('bound-word')
    expect(html).toContain('<svg')
    expect(html).not.toContain('gitDecoration-addedResourceForeground')
    expect(html).not.toContain('gitDecoration-modifiedResourceForeground')
    expect(html).toContain('data-payload="cccccccccccccccccccccccccccccccccccccccc..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  })

  it('places leftover autostash copy after the target choices', () => {
    const html = renderSidebarBody(view({
      gitState: gitState({
        unstaged: 1,
        autostashes: [{ selector: 'stash@{0}', subject: 'On main: autostash' }],
      }),
    }))
    expect(html.indexOf('data-id="working-tree"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-id="working-tree"')).toBeLessThan(html.indexOf('A rebase left your changes'))
  })

  it('puts commit metadata on the choice button and Back in chrome', () => {
    const html = renderSidebarBody(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        selected: null,
        commits: [commitSummary({ sha: 'abc123def456', shortSha: 'abc123d', subject: 'Add types' })],
      },
    }))
    expect(html).toContain('<header class="chrome setup">')
    expect(html).toContain('abc123d Ada · 2 hours ago')
    expect(html).toContain('Use commit')
    expect(html).toMatch(/data-id="use-commit"[^>]* disabled/)
    expect(html.indexOf('Use commit')).toBeLessThan(html.indexOf('<main class="body">'))
    expect(html).toContain('for="field-commit-ref"')
    expect(html).toContain('id="field-commit-ref"')
  })

  it('puts walk Previous, progress, and Next in the chrome header', () => {
    const html = renderSidebarBody(view({
      status: 'active',
      mode: 'readonly',
      progress: { index: 3, total: 12 },
      canAdvance: true,
      canRetreat: true,
      currentStep: {
        id: 'step',
        path: 'src/app.ts',
        groups: [],
        kind: 'reveal',
        significance: 'normal',
        rationale: 'The contract comes before its consumer',
        source: 'sidecar',
        title: 'State contract',
      },
    }))
    expect(html).toContain('<header class="chrome walk">')
    expect(html).toContain('3 of 12')
    expect(html).toContain('data-command="tabthrough.previous"')
    expect(html).toContain('data-command="tabthrough.next"')
    expect(html.indexOf('data-command="tabthrough.next"')).toBeLessThan(html.indexOf('State contract'))
    expect(html).toContain('End walkthrough')
    expect(html.indexOf('End walkthrough')).toBeLessThan(html.indexOf('State contract'))
    expect(html).toContain('class="subhead"')
  })

  it('makes Continue rebase the primary sidebar action', () => {
    const html = renderSidebarBody(view({
      gitState: gitState({
        rebase: {
          branch: 'topic',
          onto: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          stoppedSha: 'cccccccccccccccccccccccccccccccccccccccc',
          origHead: 'dddddddddddddddddddddddddddddddddddddddd',
          done: 2,
          total: 4,
          autostashSha: null,
        },
      }),
    }))
    expect(html).toContain('Rebasing topic')
    expect(html).toContain('data-command="tabthrough.continueRebase"')
    expect(html).toContain('class="primary"')
    expect(html).toContain('data-command="tabthrough.abortRebase"')
  })

  it('shows the rebase Start line and unsigned note', () => {
    const html = renderSidebarBody(view({
      setup: { kind: 'generate', target: { kind: 'commit', rev: 'abc' } },
      willRun: 'git rebase -i --autostash --no-autosquash --no-verify --no-gpg-sign abc1234',
      willRunNotes: 'autostash will park 3 files; 2 commits above will be rewritten; replayed commits will be unsigned',
      showModePicker: true,
      showRebase: true,
      rebaseApplicable: true,
      askMode: true,
      previewMode: 'rebase',
    }))
    expect(html).toContain('git rebase -i --autostash --no-autosquash --no-verify --no-gpg-sign abc1234')
    expect(html).toContain('replayed commits will be unsigned')
    expect(html).not.toContain('Will run: nothing')
    expect(html).toContain('data-command="tabthrough.chooseMode"')
    expect(html).toContain('data-payload="rebase"')
    expect(html).toContain('class="list-pick choice range-selected"')
  })

  it('shows a continuation for notes past the display limit', () => {
    const notes = 'A detailed explanation. '.repeat(40)
    const html = renderSidebarBody(view({
      status: 'active',
      mode: 'readonly',
      currentStep: {
        id: 'step',
        path: 'src/app.ts',
        groups: [],
        kind: 'reveal',
        significance: 'normal',
        rationale: 'The contract comes before its consumer',
        source: 'sidecar',
        notes,
      },
    }))
    expect(html).toContain('Show full notes')
    expect(html).toContain(notes.trim())
  })

  it('promotes Finish into chrome when the walk is complete', () => {
    const html = renderSidebarBody(view({
      status: 'active',
      mode: 'readonly',
      complete: true,
      progress: { index: 2, total: 2 },
      canRetreat: true,
      currentStep: {
        id: 'step',
        path: 'src/app.ts',
        groups: [],
        kind: 'reveal',
        significance: 'normal',
        rationale: 'The contract comes before its consumer',
        source: 'sidecar',
        notes: 'A long last-step note.',
      },
    }))
    expect(html).toContain('<header class="chrome walk">')
    expect(html).toContain('data-command="tabthrough.finish"')
    expect(html).not.toContain('data-command="tabthrough.next"')
    expect(html.indexOf('data-command="tabthrough.finish"')).toBeLessThan(html.indexOf('A long last-step note'))
  })

  it('wires Tab to Finish when the walk is complete', () => {
    const html = renderSidebarHtml(view({
      status: 'active',
      mode: 'readonly',
      complete: true,
      progress: { index: 2, total: 2 },
    }))
    expect(html).toContain('data-command="tabthrough.finish"')
    expect(html).toContain("event.key!=='Tab'")
    expect(html).toContain("post('tabthrough.finish')")
  })

  it('uses host theme tokens instead of a private color palette', () => {
    const html = renderSidebarHtml(view())
    expect(html).toContain('--vscode-sideBar-foreground')
    expect(html).toContain('--vscode-sideBar-background')
    expect(html).toContain('--vscode-sideBar-border')
    expect(html).toContain('button.primary{')
    expect(html).toContain('--vscode-button-background')
    expect(html).toContain('--vscode-list-inactiveSelectionBackground')
    expect(html).toContain('--vscode-inputValidation-errorForeground')
    expect(html).toContain('--vscode-notificationsInfoIcon-foreground')
    expect(html).not.toContain('--vscode-badge-background')
    expect(html).not.toContain('--vscode-editor-inactiveSelectionBackground')
    expect(html).not.toContain('box-shadow:inset 3px 0 0 var(--vscode-focusBorder)')
    expect(html).not.toContain('--surface-canvas')
    expect(html).not.toContain('--text-primary')
    expect(html).not.toContain('--action-primary-bg')
    expect(html).toContain('--vscode-dropdown-background')
  })

  it('renders home commits, selectors, and Review without a slogan', () => {
    const html = renderSidebarHtml(view({
      setup: idleHome({
        commits: [commitSummary({ sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', shortSha: 'aaaaaaa', subject: 'Tip' })],
        remotes: [{ name: 'origin', fetchUrl: 'https://example.invalid/tabthrough.git' }],
        selectedRemote: 'origin',
        selection: { kind: 'workingTree' },
      }),
      gitState: gitState({ unstaged: 1 }),
    }))
    expect(html).toContain('list-pick')
    expect(html).toContain('data-id="working-tree"')
    expect(html).toContain('data-command="tabthrough.reviewSelection"')
    expect(html).toContain('data-command="tabthrough.selectHomeRev"')
    expect(html).toContain('data-command="tabthrough.setRemote"')
    expect(html).toContain('data-command="tabthrough.setBranch"')
    expect(html).toContain('<select ')
    expect(html).toContain('select.addEventListener')
    expect(html).not.toContain('Review a change')
    expect(html).not.toContain('Choose where to begin')
    expect(html).not.toContain('data-command="tabthrough.pickCommit"')
  })
})
