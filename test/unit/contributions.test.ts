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

interface Capability {
  readonly supported: boolean
  readonly description?: string
}

interface Manifest {
  readonly capabilities?: {
    readonly untrustedWorkspaces?: Capability
    readonly virtualWorkspaces?: Capability
  }
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
      'guide-reviewer.discardRecovery',
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

  /**
   * `sessionActive` means "the reveal loop is running", which is false in
   * `blocked`, `error`, and a stalled `preflight`. Gating the way *out* on it
   * would hide Cancel in exactly the states a user needs it.
   */
  it('keeps the exit reachable from every state a session can be stuck in', async () => {
    const { contributes } = await manifest()
    const cancel = contributes.commands.find(entry => entry.command === 'guide-reviewer.cancel')

    expect(cancel?.enablement).toBe('guideReviewer.sessionOpen')
  })

  it('keeps the recovery commands away from a live session', async () => {
    const { contributes } = await manifest()
    const recovery = contributes.commands.filter(entry =>
      entry.command === 'guide-reviewer.restoreBackup' || entry.command === 'guide-reviewer.discardRecovery')

    expect(recovery).toHaveLength(2)
    for (const entry of recovery)
      expect(entry.enablement).toBe('guideReviewer.recoveryPending && !guideReviewer.sessionActive')
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

/**
 * Left undeclared, VS Code assumes an extension is merely "limited" in an
 * untrusted folder and loads it anyway. This one shells out to git, and a
 * repository's own config can make git run arbitrary commands, so the default
 * is the wrong one to inherit silently.
 */
describe('workspace trust', () => {
  it('refuses untrusted and virtual workspaces, with a reason the user can read', async () => {
    const { capabilities } = await manifest()

    expect(capabilities?.untrustedWorkspaces?.supported).toBe(false)
    expect(capabilities?.untrustedWorkspaces?.description).toBeTruthy()
    expect(capabilities?.virtualWorkspaces?.supported).toBe(false)
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
