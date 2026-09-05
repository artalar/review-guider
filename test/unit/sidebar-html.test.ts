import type { SidebarViewModel } from '../../src/model/view'
import { describe, expect, it } from 'vitest'
import { htmlAttr, htmlText, renderSidebarBody } from '../../src/ui/sidebar-html'

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
    applyPending: false,
    canAdvance: false,
    canRetreat: false,
    preflight: null,
    recoveryPending: false,
    blockedMessage: null,
    idleReason: null,
    setup: { kind: 'home' },
    skillInstalled: true,
    guideFocused: false,
    sidecarReady: false,
    focusedGuideMismatch: false,
    guideFileName: '.tabthrough-guide.json',
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
  })
})
