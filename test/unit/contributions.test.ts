import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/**
 * The `when` clause and the enablement clauses are the whole mitigation for
 * R1 (Tab is the most contested key in the editor), so they are asserted here
 * rather than trusted to a manual read of package.json.
 */

interface Contribution {
  readonly command: string
  readonly title?: string
  readonly enablement?: string
  readonly key?: string
  readonly when?: string
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly Contribution[]
    readonly keybindings: readonly Contribution[]
    readonly configuration: { readonly properties: Readonly<Record<string, unknown>> }
  }
}

async function manifest(): Promise<Manifest> {
  const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  return JSON.parse(raw) as Manifest
}

/** ADR 0002 D2, clause by clause. */
const TAB_CLAUSES: readonly string[] = [
  'guideReviewer.sessionActive',
  'resourceScheme == \'guide-reviewer\'',
  'editorTextFocus',
  '!suggestWidgetVisible',
  '!inlineSuggestionVisible',
  '!inSnippetMode',
  '!renameInputVisible',
  '!parameterHintsVisible',
  '!accessibilityModeEnabled',
  '!editorTabMovesFocus',
  'config.guideReviewer.keybinding.useTab',
]

describe('contributed commands', () => {
  it('declares every command the plan lists for P0-14', async () => {
    const { contributes } = await manifest()
    const declared = contributes.commands.map(entry => entry.command).sort()

    expect(declared).toEqual([
      'guide-reviewer.cancel',
      'guide-reviewer.cleanupBackups',
      'guide-reviewer.finish',
      'guide-reviewer.next',
      'guide-reviewer.previous',
      'guide-reviewer.restoreBackup',
      'guide-reviewer.showStepDetail',
      'guide-reviewer.start',
      'guide-reviewer.startFromCommit',
      'guide-reviewer.startFromRange',
    ])
  })

  it('gates every command on a context key, so the palette never offers a failure', async () => {
    const { contributes } = await manifest()
    for (const entry of contributes.commands) {
      expect(entry.enablement, entry.command).toBeDefined()
      expect(entry.enablement, entry.command).toMatch(/^guideReviewer\./)
    }
  })

  it('only offers the three entry points when the model says a start can succeed', async () => {
    const { contributes } = await manifest()
    const starts = contributes.commands.filter(entry => entry.command.startsWith('guide-reviewer.start'))

    expect(starts).toHaveLength(3)
    for (const entry of starts)
      expect(entry.enablement).toBe('guideReviewer.canStart')
  })
})

describe('keybindings', () => {
  it('scopes Tab to the reveal document, every widget guard, and the opt-out', async () => {
    const { contributes } = await manifest()
    const tab = contributes.keybindings.filter(entry => entry.key === 'tab' || entry.key === 'shift+tab')

    expect(tab.map(entry => entry.command)).toEqual(['guide-reviewer.next', 'guide-reviewer.previous'])
    for (const entry of tab) {
      for (const clause of TAB_CLAUSES)
        expect(entry.when, `${entry.key} is missing ${clause}`).toContain(clause)
    }
  })

  it('drops the two clauses ADR 0002 D2 rejected', async () => {
    const { contributes } = await manifest()
    for (const entry of contributes.keybindings) {
      // A selection carries no Tab meaning in a read-only document, and
      // read-only is precisely what makes Tab safe to take here.
      expect(entry.when ?? '').not.toContain('editorHasSelection')
      expect(entry.when ?? '').not.toContain('editorReadonly')
    }
  })

  it('keeps the chord unconditional, so accessibility mode still has a way forward', async () => {
    const { contributes } = await manifest()
    const chord = contributes.keybindings.filter(entry => entry.key === 'alt+]' || entry.key === 'alt+[')

    expect(chord.map(entry => entry.command)).toEqual(['guide-reviewer.next', 'guide-reviewer.previous'])
    for (const entry of chord)
      expect(entry.when).toBe('guideReviewer.sessionActive')
  })

  it('lets the user turn the Tab binding off entirely', async () => {
    const { contributes } = await manifest()
    expect(contributes.configuration.properties['guideReviewer.keybinding.useTab']).toBeDefined()
  })
})
