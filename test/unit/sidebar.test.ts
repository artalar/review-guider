import type { GuideStep } from '../../src/guide/types'
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
      setup: { kind: 'range', error: 'Enter a commit range, for example main..HEAD.' },
    }))
    expect(rows.find(row => row.id === 'pick-range')?.description).toContain('main..HEAD')
    expect(rows.find(row => row.id === 'range-input')?.input?.placeholder).toBe('main..HEAD')
    expect(rows.find(row => row.id === 'range-input')?.input?.submit).toBe('Use')
    expect(rows.find(row => row.id === 'back')?.slot).toBe('nav')
  })

  it('shows Start when a guide is focused at home', () => {
    const rows = sidebarItems(view({ guideFocused: true }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.startFromGuide',
      'tabthrough.review',
    ])
  })

  it('offers Simple and Agent after a target is picked', () => {
    const rows = sidebarItems(view({
      setup: { kind: 'generate', target: { kind: 'workingTree' } },
    }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.generateSimple',
      'tabthrough.generateAgent',
      'tabthrough.setupBack',
    ])
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
  })

  it('does not expose advancing controls while apply is writing', () => {
    const rows = sidebarItems(view({
      status: 'applying',
      mode: 'apply',
      applyPending: true,
      progress: { index: 1, total: 2 },
      currentStep: step(),
    }))
    expect(rows.map(row => row.command).filter(Boolean)).toEqual(['tabthrough.cancel'])
    expect(rows.some(row => row.id === 'applying')).toBe(true)
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

  it('does not offer recovery for a live session in another window', () => {
    expect(sidebarItems(view({ recoveryPending: true, liveElsewhere: true })).some(row => row.command)).toBe(false)
  })
})
