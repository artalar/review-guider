import type { CommitSummary } from '../../src/git/log'
import type { GitState } from '../../src/git/state'
import type { RangeSetupPhase } from '../../src/model/setup'
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
    expect(html).toContain('placeholder="main..HEAD"')
    expect(html).toContain('<form')
    expect(html).toContain('>Use range</button>')
    expect(html).toContain('<header class="chrome">')
    expect(html).toContain('data-command="tabthrough.setupBack"')
    expect(html).toContain('← Back')
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
    expect(html).not.toContain('bound-word')
    expect(html).toContain('<svg')
    expect(html).not.toContain('gitDecoration-addedResourceForeground')
    expect(html).not.toContain('gitDecoration-modifiedResourceForeground')
    expect(html).toContain('data-payload="cccccccccccccccccccccccccccccccccccccccc..aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
  })

  it('places leftover autostash copy after the Review button', () => {
    const html = renderSidebarBody(view({
      gitState: gitState({
        autostashes: [{ selector: 'stash@{0}', subject: 'On main: autostash' }],
      }),
    }))
    expect(html.indexOf('data-command="tabthrough.review"')).toBeGreaterThan(-1)
    expect(html.indexOf('data-command="tabthrough.review"')).toBeLessThan(html.indexOf('A rebase left your changes'))
  })

  it('puts commit metadata on the choice button and Back in chrome', () => {
    const html = renderSidebarBody(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        commits: [commitSummary({ sha: 'abc123def456', shortSha: 'abc123d', subject: 'Add types' })],
      },
    }))
    expect(html.indexOf('<header class="chrome">')).toBe(0)
    expect(html).toContain('abc123d · Ada · 2 hours ago')
    expect(html).toContain('>Use commit</button>')
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

  it('uses host theme tokens instead of a private color palette', () => {
    const html = renderSidebarHtml(view())
    expect(html).toContain('--vscode-sideBar-foreground')
    expect(html).toContain('--vscode-sideBar-background')
    expect(html).toContain('--vscode-sideBar-border')
    expect(html).toContain('button.primary{')
    expect(html).toContain('--vscode-button-background')
    expect(html).toContain('--vscode-list-inactiveSelectionBackground')
    expect(html).toContain('--vscode-list-activeSelectionBackground')
    expect(html).toContain('--vscode-inputValidation-errorForeground')
    expect(html).toContain('--vscode-notificationsInfoIcon-foreground')
    expect(html).not.toContain('--vscode-badge-background')
    expect(html).not.toContain('--vscode-editor-inactiveSelectionBackground')
    expect(html).not.toContain('box-shadow:inset 3px 0 0 var(--vscode-focusBorder)')
    expect(html).not.toContain('--surface-canvas')
    expect(html).not.toContain('--text-primary')
    expect(html).not.toContain('--action-primary-bg')
    expect(html).toContain('button.choice .hint{color:inherit')
  })

  it('renders target picks as list rows', () => {
    const html = renderSidebarBody(view({ setup: { kind: 'targets' } }))
    expect(html).toContain('class="list-pick choice"')
    expect(html).toContain('data-id="working-tree"')
    expect(html).not.toContain('class="secondary choice"')
  })
})
