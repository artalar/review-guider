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
    readonly menus?: Readonly<Record<string, readonly Contribution[]>>
    readonly configuration: { readonly properties: Readonly<Record<string, unknown>> }
  }
}

async function manifest(): Promise<Manifest> {
  const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  return JSON.parse(raw) as Manifest
}

const TAB_CLAUSES: readonly string[] = [
  'tabthrough.sessionActive',
  'resourceScheme == \'tabthrough\'',
  'editorTextFocus',
  '!suggestWidgetVisible',
  '!inlineSuggestionVisible',
  '!inSnippetMode',
  '!renameInputVisible',
  '!parameterHintsVisible',
  '!accessibilityModeEnabled',
  '!editorTabMovesFocus',
  'config.tabthrough.keybinding.useTab',
]

describe('contributed commands', () => {
  it('declares every command Phase 12 ships', async () => {
    const { contributes } = await manifest()
    const declared = contributes.commands.map(entry => entry.command).sort()

    expect(declared).toEqual([
      'tabthrough.abortRebase',
      'tabthrough.cancel',
      'tabthrough.chooseMode',
      'tabthrough.commitHandoff',
      'tabthrough.continueRebase',
      'tabthrough.editHere',
      'tabthrough.finish',
      'tabthrough.generateAgent',
      'tabthrough.generateSimple',
      'tabthrough.installSkill',
      'tabthrough.next',
      'tabthrough.openConflict',
      'tabthrough.openWorktree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
      'tabthrough.pickWorkingTree',
      'tabthrough.popAutostash',
      'tabthrough.previous',
      'tabthrough.pruneWorktrees',
      'tabthrough.removeWorktree',
      'tabthrough.review',
      'tabthrough.selectCommit',
      'tabthrough.setGuideTopic',
      'tabthrough.setupBack',
      'tabthrough.showAutostash',
      'tabthrough.showStepDetail',
      'tabthrough.showWalkthrough',
      'tabthrough.start',
      'tabthrough.startFromCommit',
      'tabthrough.startFromGuide',
      'tabthrough.startFromRange',
      'tabthrough.submitRange',
    ])
  })

  it('keeps the exit reachable from every state a session can be stuck in', async () => {
    const { contributes } = await manifest()
    const cancel = contributes.commands.find(entry => entry.command === 'tabthrough.cancel')

    expect(cancel?.enablement).toBe('tabthrough.sessionOpen && !tabthrough.sessionFinishing')
    expect(cancel?.title).toBe('End Walkthrough')
    const title = contributes.menus?.['view/title']?.find(entry => entry.command === 'tabthrough.cancel')
    expect(title?.when).toBe('view == tabthrough.sidebar && tabthrough.sessionOpen && !tabthrough.sessionFinishing')
  })

  it('does not ship isolation recovery commands', async () => {
    const { contributes } = await manifest()
    const retired = contributes.commands.filter(entry =>
      entry.command === 'tabthrough.restoreBackup'
      || entry.command === 'tabthrough.discardRecovery'
      || entry.command === 'tabthrough.clearStaleLock'
      || entry.command === 'tabthrough.cleanupBackups')

    expect(retired).toEqual([])
  })

  it('gates git-state commands on the matching context keys', async () => {
    const { contributes } = await manifest()
    const byCommand = new Map(contributes.commands.map(entry => [entry.command, entry.enablement]))
    expect(byCommand.get('tabthrough.continueRebase')).toBe('tabthrough.rebaseInProgress')
    expect(byCommand.get('tabthrough.abortRebase')).toBe('tabthrough.rebaseInProgress')
    expect(byCommand.get('tabthrough.popAutostash')).toBe('tabthrough.hasAutostash')
    expect(byCommand.get('tabthrough.showAutostash')).toBe('tabthrough.hasAutostash')
    expect(byCommand.get('tabthrough.openWorktree')).toBe('tabthrough.hasTabthroughWorktree')
    expect(byCommand.get('tabthrough.removeWorktree')).toBe('tabthrough.hasTabthroughWorktree')
    expect(byCommand.get('tabthrough.pruneWorktrees')).toBe('tabthrough.gitUsable')
    expect(byCommand.get('tabthrough.openConflict')).toBe('tabthrough.hasConflicts')
    expect(byCommand.get('tabthrough.editHere')).toBe('tabthrough.sessionActive')
  })

  it('gates every command on a context key, so the palette never offers a failure', async () => {
    const { contributes } = await manifest()
    for (const entry of contributes.commands) {
      expect(entry.enablement, entry.command).toBeDefined()
      expect(entry.enablement, entry.command).toMatch(/^tabthrough\./)
    }
  })

  it('only offers the entry points when the model says a start can succeed', async () => {
    const { contributes } = await manifest()
    const starts = contributes.commands.filter(entry =>
      entry.command === 'tabthrough.review'
      || entry.command === 'tabthrough.start'
      || entry.command === 'tabthrough.startFromCommit'
      || entry.command === 'tabthrough.startFromRange')

    expect(starts).toHaveLength(4)
    for (const entry of starts)
      expect(entry.enablement).toBe('tabthrough.canStart')
  })

  it('offers Start Review from This Guide only for a valid open guide', async () => {
    const { contributes } = await manifest()
    const fromGuide = contributes.commands.find(entry => entry.command === 'tabthrough.startFromGuide')

    expect(fromGuide?.enablement).toBe('tabthrough.canStart && tabthrough.activeGuideValid')
    expect(fromGuide?.title).toBe('Start Walkthrough from This Guide')
    expect(contributes.menus?.['editor/title']?.some(entry => entry.command === 'tabthrough.startFromGuide')).toBe(true)
    expect(contributes.menus?.['editor/context']?.some(entry => entry.command === 'tabthrough.startFromGuide')).toBe(true)
  })

  it('does not duplicate Review in the Walkthrough view title', async () => {
    const { contributes } = await manifest()
    expect(contributes.menus?.['view/title']?.some(entry => entry.command === 'tabthrough.review')).toBe(false)
  })
})

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
    const tab = contributes.keybindings.filter(entry =>
      (entry.key === 'tab' || entry.key === 'shift+tab')
      && (entry.when ?? '').includes('resourceScheme == \'tabthrough\''))

    expect(tab.map(entry => entry.command)).toEqual(['tabthrough.next', 'tabthrough.previous'])
    for (const entry of tab) {
      for (const clause of TAB_CLAUSES)
        expect(entry.when, `${entry.key} is missing ${clause}`).toContain(clause)
      expect(entry.when ?? '').not.toContain('sessionMode')
    }
  })

  it('drops the two clauses ADR 0002 D2 rejected', async () => {
    const { contributes } = await manifest()
    for (const entry of contributes.keybindings) {
      expect(entry.when ?? '').not.toContain('editorHasSelection')
      expect(entry.when ?? '').not.toContain('editorReadonly')
    }
  })

  it('keeps the chord available for the whole active session', async () => {
    const { contributes } = await manifest()
    const chord = contributes.keybindings.filter(entry => entry.key === 'alt+]' || entry.key === 'alt+[')

    expect(chord.map(entry => entry.command)).toEqual(['tabthrough.next', 'tabthrough.previous'])
    for (const entry of chord) {
      expect(entry.when).toBe('tabthrough.sessionActive')
      expect(entry.when).not.toContain('applyPending')
    }
  })

  it('binds Edit here to Alt+Enter on a review document', async () => {
    const { contributes } = await manifest()
    const edit = contributes.keybindings.find(entry => entry.command === 'tabthrough.editHere')
    expect(edit?.key).toBe('alt+enter')
    expect(edit?.when).toContain('tabthrough.sessionActive')
    expect(edit?.when).toContain('resourceScheme == \'tabthrough\'')
  })

  it('does not steal Tab in ordinary file editors', async () => {
    const { contributes } = await manifest()
    const tabKeys = contributes.keybindings.filter(entry =>
      entry.key === 'tab' || entry.key === 'shift+tab')

    for (const entry of tabKeys) {
      expect(entry.when ?? '', entry.key).not.toContain('resourceScheme == \'file\'')
      expect(entry.when ?? '', entry.key).toContain('resourceScheme == \'tabthrough\'')
    }
  })

  it('lets the user turn the Tab binding off entirely', async () => {
    const { contributes } = await manifest()
    expect(contributes.configuration.properties['tabthrough.keybinding.useTab']).toBeDefined()
  })

  it('defaults the sidecar path to .tabthrough-guide.json', async () => {
    const { contributes } = await manifest()
    const setting = contributes.configuration.properties['tabthrough.guideFile'] as { default?: string }
    expect(setting.default).toBe('.tabthrough-guide.json')
  })

  it('declares the session mode setting with git-first enums', async () => {
    const { contributes } = await manifest()
    const setting = contributes.configuration.properties['tabthrough.session.mode'] as {
      default?: string
      enum?: string[]
      enumDescriptions?: string[]
    }
    expect(setting.default).toBe('ask')
    expect(setting.enum).toEqual(['ask', 'readonly', 'rebase', 'worktree'])
    expect(setting.enumDescriptions?.[2]).not.toMatch(/later phase/i)
    expect(contributes.configuration.properties['tabthrough.finish.hooks']).toMatchObject({ default: false })
    expect(contributes.configuration.properties['tabthrough.finish.sign']).toMatchObject({ default: false })
  })

  it('declares the worktree root setting', async () => {
    const { contributes } = await manifest()
    expect(contributes.configuration.properties['tabthrough.worktree.dir']).toBeDefined()
    expect(contributes.configuration.properties['tabthrough.stash.includeUntracked']).toBeUndefined()
  })

  it('offers Finish for every active session', async () => {
    const { contributes } = await manifest()
    const finish = contributes.commands.find(entry => entry.command === 'tabthrough.finish')
    expect(finish?.enablement).toBe('tabthrough.sessionActive')
    expect(finish?.title).toBe('Finish Walkthrough')
  })

  it('hides internal setup commands from the command palette', async () => {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as {
      contributes: { menus?: { commandPalette?: readonly { command: string, when?: string }[] } }
    }
    const hidden = new Set(
      (parsed.contributes.menus?.commandPalette ?? [])
        .filter(entry => entry.when === 'false')
        .map(entry => entry.command),
    )
    for (const command of [
      'tabthrough.pickWorkingTree',
      'tabthrough.pickCommit',
      'tabthrough.pickRange',
      'tabthrough.selectCommit',
      'tabthrough.submitRange',
      'tabthrough.setGuideTopic',
      'tabthrough.generateSimple',
      'tabthrough.generateAgent',
      'tabthrough.setupBack',
      'tabthrough.chooseMode',
    ])
      expect(hidden.has(command), command).toBe(true)
  })

  it('offers commit handoff without requiring a live session', async () => {
    const { contributes } = await manifest()
    const handoff = contributes.commands.find(entry => entry.command === 'tabthrough.commitHandoff')
    expect(handoff?.enablement).toBe('tabthrough.gitUsable')
  })
})
