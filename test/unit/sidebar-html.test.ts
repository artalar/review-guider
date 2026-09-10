import type { GitState } from '../../src/git/state'
import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { htmlAttr, htmlText, renderSidebarBody } from '../../src/ui/sidebar-html'

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
    editHereEnabled: false,
    editedPaths: [],
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
    const html = renderSidebarBody(view({ setup: { kind: 'range', error: null } }))
    expect(html).toContain('data-command="tabthrough.submitRange"')
    expect(html).toContain('placeholder="main..HEAD"')
    expect(html).toContain('<form')
    expect(html).toContain('>Use</button>')
    expect(html).toContain('<header class="chrome">')
    expect(html).toContain('data-command="tabthrough.setupBack"')
  })

  it('puts commit metadata on the choice button and Back in chrome', () => {
    const html = renderSidebarBody(view({
      setup: {
        kind: 'commits',
        loading: false,
        error: null,
        commits: [{
          sha: 'abc123def456',
          shortSha: 'abc123d',
          subject: 'Add types',
          author: 'Ada',
          relativeDate: '2 hours ago',
          parentCount: 1,
        }],
      },
    }))
    expect(html.indexOf('<header class="chrome">')).toBe(0)
    expect(html).toContain('abc123d · Ada · 2 hours ago')
    expect(html).toContain('>Go</button>')
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
})
