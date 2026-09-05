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
  }
  return { ...base, ...overrides }
}

describe('sidebar projection', () => {
  it('offers the three first-run entry points while idle', () => {
    const rows = sidebarItems(view())
    expect(rows.map(row => row.command).filter(Boolean)).toEqual([
      'tabthrough.start',
      'tabthrough.startFromCommit',
      'tabthrough.startFromRange',
    ])
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
    expect(byId.get('next')?.command).toBe('tabthrough.next')
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
    expect(rows.findIndex(row => row.id === 'notes')).toBeLessThan(rows.findIndex(row => row.id === 'finish'))
    expect(rows.some(row => row.id === 'next')).toBe(false)
  })

  it('does not offer recovery for a live session in another window', () => {
    expect(sidebarItems(view({ recoveryPending: true, liveElsewhere: true })).some(row => row.command)).toBe(false)
  })
})
