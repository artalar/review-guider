import type { CommitSummary } from '../git/log'
import type { GitState } from '../git/state'
import type { ReviewTarget, SessionMode } from '../git/types'
import type { RangeSetupPhase } from './setup'
import type { SidebarViewModel } from './view'
import { commands as Commands } from '../generated/meta'

export function safeSidebarText(value: string, max = 500): string {
  const clean = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return (code >= 32 && code !== 127) || character === '\n' || character === '\r' || character === '\t'
  }).join('')
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export type SidebarTone = 'primary' | 'secondary' | 'quiet' | 'consequential'
export type SidebarSeverity = 'info' | 'warning' | 'error'
export type SidebarSurface = 'list' | 'notice' | 'disclosure'
export type SidebarGroup = 'repository'

export interface SidebarItemData {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly tooltip?: string
  readonly command?: string
  readonly payload?: string
  readonly input?: {
    readonly placeholder: string
    readonly submit?: string
    readonly error?: string
    readonly value?: string
    readonly bound?: 'from' | 'to'
    readonly hideSubmit?: boolean
  }
  readonly icon?: string
  readonly contextValue?: string
  readonly enabled?: boolean
  readonly slot?: 'nav' | 'header' | 'footer'
  readonly surface?: SidebarSurface
  readonly accent?: 'start' | 'end' | 'between' | 'selected'
  readonly tone?: SidebarTone
  readonly severity?: SidebarSeverity
  readonly expanded?: boolean
  readonly group?: SidebarGroup
  readonly trailing?: 'chevron'
}

export function finishLabel(mode: SessionMode | null): string {
  return mode === 'rebase' ? 'Amend and continue' : 'Finish walkthrough'
}

export function exitLabel(mode: SessionMode | null): string {
  return mode === 'rebase' ? 'Abort rebase' : 'End walkthrough'
}

export function finishConsequence(mode: SessionMode | null): string {
  if (mode === 'rebase') {
    return 'Stages tracked changes and amends this commit when needed, then replays later commits. New files are included only if selected.'
  }
  return 'Closes the review and removes its temporary snapshot ref, if any.'
}

export function exitConsequence(mode: SessionMode | null): string {
  if (mode === 'rebase')
    return 'Abort may discard edits made during this rebase.'
  return 'Edits made to real files remain.'
}

export function sessionContextLabel(mode: SessionMode | null, entry: string | null): string {
  const modeLabel = mode === 'rebase' ? 'Rebase' : 'Read-only'
  const target = formatEntry(entry)
  return target === null ? modeLabel : `${modeLabel} · ${target}`
}

export function guideProvenanceLabel(
  kind: SidebarViewModel['guideProvenance'],
): string | null {
  if (kind === 'repository')
    return 'Repository guide'
  if (kind === 'simple')
    return 'Simple · offline'
  if (kind === 'agent')
    return 'Editor agent'
  return null
}

export function sidebarItems(view: SidebarViewModel): readonly SidebarItemData[] {
  const items: SidebarItemData[] = []
  const add = (item: SidebarItemData): void => {
    items.push({
      ...item,
      label: safeSidebarText(item.label),
      ...(item.description === undefined ? {} : { description: safeSidebarText(item.description, 4000) }),
      ...(item.tooltip === undefined ? {} : { tooltip: safeSidebarText(item.tooltip, 2000) }),
      ...(item.input?.error === undefined
        ? {}
        : {
            input: {
              ...item.input,
              error: safeSidebarText(item.input.error, 400),
            },
          }),
    })
  }

  if (view.status === 'idle') {
    addBlockingNotices(view, add)
    addIdleItems(view, add)
    addRepositoryDetails(view, add)
    return items
  }

  if (view.status === 'starting') {
    addStartingItems(view, add)
    addRepositoryDetails(view, add)
    return items
  }

  if (view.status === 'finishing') {
    add({
      id: 'finishing',
      label: view.mode === 'rebase'
        ? 'Amending and continuing rebase…'
        : 'Closing walkthrough…',
    })
    addRepositoryDetails(view, add)
    return items
  }

  addWalkItems(view, add)
  return items
}

function formatEntry(entry: string | null): string | null {
  if (entry === null)
    return null
  if (entry === 'working tree')
    return 'Working changes'
  if (entry.startsWith('commit '))
    return 'selected commit'
  return entry
}

function addStartingItems(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  add({
    id: 'starting',
    label: 'Starting walkthrough…',
    description: sessionContextLabel(view.previewMode, view.entry),
    icon: 'sync~spin',
  })
  const consequence = startConsequence(view)
  add({
    id: 'will-run',
    label: consequence.summary,
    description: consequence.command === null ? undefined : consequence.command,
    surface: consequence.command === null ? undefined : 'disclosure',
    expanded: false,
  })
  add({
    id: 'cancel-starting',
    label: 'Cancel',
    command: Commands.cancel,
    icon: 'close',
    contextValue: 'action',
    tone: 'secondary',
  })
}

function addWalkItems(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  addBlockingNotices(view, add)

  const progress = view.progress
  const current = view.currentStep
  add({
    id: 'session',
    label: sessionContextLabel(view.mode, view.entry),
    tooltip: view.entry === null ? undefined : `Reviewing ${view.entry}`,
    icon: 'book',
  })

  if (view.guideFallback) {
    add({
      id: 'guide-fallback',
      label: 'Using Simple ordering',
      description: 'The repository guide could not be applied. Full diagnostics are in the Tabthrough output.',
      surface: 'notice',
      severity: 'warning',
    })
  }

  if (current === null) {
    add({
      id: 'ready',
      label: 'Ready to begin',
      description: progress === null ? 'Use Next to begin' : `0 of ${progress.total}`,
    })
  }
  if (current !== null) {
    const title = current.title ?? current.path
    const edited = view.editedPaths.includes(current.path)
    const pathDuplicatesTitle = title === current.path
    add({
      id: 'current',
      label: title,
      description: pathDuplicatesTitle ? undefined : current.path,
      tooltip: current.rationale,
      icon: 'arrow-right',
    })
    if (edited) {
      add({
        id: 'edited',
        label: 'Edited on disk',
        description: 'The review still shows the captured change. Later edits are not included in this walkthrough.',
        surface: 'notice',
        severity: 'info',
      })
    }
    if (current.notes !== undefined && current.notes.trim() !== '')
      add({ id: 'notes', label: 'Implementation notes', description: current.notes, tooltip: current.notes, icon: 'note' })
    if (current.rationale !== '')
      add({ id: 'rationale', label: 'Why this comes here', description: current.rationale, tooltip: current.rationale, icon: 'lightbulb' })
    if (view.status === 'active') {
      add({
        id: 'edit-here',
        label: 'Open real file',
        description: view.editHereEnabled
          ? undefined
          : 'Opens the real file during a working-changes or rebase walkthrough.',
        command: Commands.editHere,
        icon: 'go-to-file',
        contextValue: 'action',
        enabled: view.editHereEnabled,
        tone: 'quiet',
      })
    }
    if (view.nextStep !== null) {
      add({
        id: 'next-step',
        label: 'Up next',
        description: view.nextStep.rationale === ''
          ? (view.nextStep.title ?? view.nextStep.path)
          : `${view.nextStep.title ?? view.nextStep.path}\n${view.nextStep.rationale}`,
        icon: 'chevron-right',
      })
    }
  }
  if (view.complete && progress !== null) {
    add({
      id: 'complete',
      label: `All ${progress.total} steps revealed`,
      description: finishConsequence(view.mode),
    })
  }

  if (view.summary !== null) {
    add({
      id: 'summary',
      label: 'Guide overview',
      description: view.summary,
      tooltip: view.summary,
      icon: 'note',
      surface: 'disclosure',
      expanded: false,
    })
  }

  if (view.status === 'active') {
    add({
      id: 'previous',
      label: 'Previous',
      command: Commands.previous,
      icon: 'arrow-left',
      contextValue: 'action',
      enabled: view.canRetreat,
      slot: 'nav',
      tone: 'secondary',
    })
    if (view.complete) {
      add({
        id: 'finish',
        label: finishLabel(view.mode),
        command: Commands.finish,
        icon: 'check',
        contextValue: 'action',
        enabled: true,
        slot: 'nav',
        tone: 'primary',
      })
    }
    else {
      add({
        id: 'next',
        label: 'Next',
        command: Commands.next,
        icon: 'arrow-right',
        contextValue: 'action',
        enabled: view.canAdvance,
        slot: 'nav',
        tone: 'primary',
      })
    }
  }
  add({
    id: 'cancel',
    label: exitLabel(view.mode),
    command: Commands.cancel,
    icon: 'close',
    contextValue: 'action',
    enabled: true,
    slot: 'nav',
    tone: view.mode === 'rebase' ? 'consequential' : 'quiet',
    tooltip: exitConsequence(view.mode),
  })
  const provenance = guideProvenanceLabel(view.guideProvenance)
  if (provenance !== null) {
    add({
      id: 'guide-provenance',
      label: provenance,
      slot: 'footer',
    })
  }
  addRepositoryDetails(view, add)
}

function addBlockingNotices(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  const state = view.gitState
  if (state === null)
    return

  const sessionOwnsRebase = view.status !== 'idle' && view.mode === 'rebase'
  const rebaseBlocks = state.rebase !== null && (!sessionOwnsRebase || state.conflicts.length > 0)

  if (rebaseBlocks && state.rebase !== null) {
    const sha = state.rebase.stoppedSha === null ? '?' : state.rebase.stoppedSha.slice(0, 8)
    const branch = state.rebase.branch ?? 'HEAD'
    add({
      id: 'rebase',
      label: `Rebasing ${branch} · stopped at ${sha} · ${state.rebase.done} of ${state.rebase.total}`,
      description: state.conflicts.length > 0
        ? 'Resolve the conflicted files, then continue the rebase.'
        : 'A rebase is stopped in this repository.',
      icon: 'git-merge',
      surface: 'notice',
      severity: state.conflicts.length > 0 ? 'error' : 'warning',
    })
    add({
      id: 'continue-rebase',
      label: 'Continue rebase',
      command: Commands.continueRebase,
      contextValue: 'action',
      tone: 'primary',
    })
    add({
      id: 'abort-rebase',
      label: 'Abort rebase',
      description: 'Abort may discard edits made during this rebase.',
      command: Commands.abortRebase,
      contextValue: 'action',
      tone: 'consequential',
    })
    add({
      id: 'scm-rebase',
      label: 'Open Source Control',
      command: Commands.commitHandoff,
      contextValue: 'action',
      tone: 'secondary',
    })
  }
  else if (state.operation !== null) {
    add({
      id: 'operation',
      label: operationLabel(state.operation),
      command: Commands.commitHandoff,
      contextValue: 'action',
      surface: 'notice',
      severity: 'warning',
      tone: 'secondary',
    })
  }

  for (const path of state.conflicts) {
    add({
      id: `conflict-${path}`,
      label: path,
      description: 'Conflict',
      command: Commands.openConflict,
      payload: path,
      icon: 'warning',
      contextValue: 'action',
      surface: 'notice',
      severity: 'error',
      tone: 'secondary',
    })
  }
}

function repoFooterLabel(state: GitState): string {
  if (state.detached)
    return 'Repository · detached'
  if (state.branch !== null && state.branch !== '')
    return `Repository · ${state.branch}`
  return 'Repository'
}

function addRepositoryDetails(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  const state = view.gitState
  if (state === null)
    return
  if (view.status === 'idle' && (view.setup.kind === 'home' || view.setup.kind === 'targets' || view.setup.kind === 'generate')) {
    add(repo({
      id: 'repository-summary',
      label: repoFooterLabel(state),
      slot: 'footer',
      surface: 'disclosure',
    }))
  }

  const sessionOwnsRebase = view.status !== 'idle' && view.mode === 'rebase'
  if (state.rebase !== null && sessionOwnsRebase && state.conflicts.length === 0) {
    const sha = state.rebase.stoppedSha === null ? '?' : state.rebase.stoppedSha.slice(0, 8)
    const branch = state.rebase.branch ?? 'HEAD'
    add(repo({
      id: 'rebase',
      label: `Rebasing ${branch} · stopped at ${sha} · ${state.rebase.done} of ${state.rebase.total}`,
      icon: 'git-merge',
    }))
  }

  if (state.staged > 0 || state.unstaged > 0 || state.untracked > 0) {
    add(repo({
      id: 'dirty',
      label: `${state.staged} staged · ${state.unstaged} unstaged · ${state.untracked} untracked`,
    }))
  }

  if (state.detached) {
    add(repo({
      id: 'detached',
      label: 'Detached HEAD',
      description: state.headSha === null ? undefined : state.headSha.slice(0, 12),
    }))
  }

  if (state.snapshotRefCount > 0) {
    add(repo({
      id: 'snapshots',
      label: state.snapshotRefCount === 1 ? '1 snapshot ref' : `${state.snapshotRefCount} snapshot refs`,
      description: 'Swept after 24 hours',
    }))
  }

  for (const worktree of state.worktrees) {
    add(repo({
      id: `worktree-${worktree.path}`,
      label: worktree.path,
      description: `${worktree.head.slice(0, 8)}${worktree.dirty ? ' · dirty' : ''}`,
    }))
    add(repo({
      id: `open-${worktree.path}`,
      label: 'Open worktree',
      command: Commands.openWorktree,
      payload: worktree.path,
      contextValue: 'action',
      tone: 'secondary',
    }))
    add(repo({
      id: `remove-${worktree.path}`,
      label: 'Remove worktree',
      description: worktree.dirty ? 'This worktree has uncommitted changes.' : undefined,
      command: Commands.removeWorktree,
      payload: worktree.path,
      contextValue: 'action',
      tone: 'consequential',
    }))
  }
  if (state.worktrees.length > 0) {
    add(repo({
      id: 'prune',
      label: 'Prune worktrees',
      command: Commands.pruneWorktrees,
      contextValue: 'action',
      tone: 'secondary',
    }))
  }

  addAutostashNotice(state, add)
}

function repo(item: SidebarItemData): SidebarItemData {
  return { ...item, group: 'repository' }
}

function addAutostashNotice(state: GitState, add: (item: SidebarItemData) => void): void {
  for (const stash of state.autostashes) {
    add(repo({
      id: `autostash-${stash.selector}`,
      label: `A rebase left your changes in ${stash.selector}`,
      description: stash.subject,
      icon: 'archive',
      surface: 'notice',
      severity: 'warning',
    }))
    add(repo({
      id: `pop-${stash.selector}`,
      label: 'Pop stash',
      command: Commands.popAutostash,
      payload: stash.selector,
      contextValue: 'action',
      tone: 'secondary',
    }))
    add(repo({
      id: `show-${stash.selector}`,
      label: 'Show stash',
      command: Commands.showAutostash,
      payload: stash.selector,
      contextValue: 'action',
      tone: 'secondary',
    }))
  }
}

function operationLabel(operation: NonNullable<GitState['operation']>): string {
  switch (operation) {
    case 'merge':
      return 'Merge in progress'
    case 'cherry-pick':
      return 'Cherry-pick in progress'
    case 'revert':
      return 'Revert in progress'
    case 'bisect':
      return 'Bisect in progress'
  }
}

function addIdleItems(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  const phase = view.setup

  if (phase.kind === 'home' || phase.kind === 'targets') {
    addHomeItems(view, add)
    return
  }

  if (phase.kind === 'commits') {
    add({
      id: 'pick-commit',
      label: 'Commit',
      description: phase.loading
        ? 'Loading recent history…'
        : 'Review a commit against its parent.',
    })
    if (!phase.loading) {
      add({
        id: 'history-heading',
        label: 'Recent commits',
      })
      addCommitChoices(phase.commits, add, view.canStart, (commit) => {
        return commitMatchesRev(commit, phase.selected) ? 'selected' : undefined
      }, 'pick:')
      add({
        id: 'commit-ref',
        label: 'Commit',
        command: Commands.selectCommit,
        input: {
          placeholder: 'HEAD~1',
          hideSubmit: true,
          value: phase.selected === null ? '' : displayRev(phase.selected, phase.commits),
          ...(phase.error === null ? {} : { error: phase.error }),
        },
        contextValue: 'input',
        enabled: view.canStart,
      })
    }
    else if (phase.error !== null) {
      add({
        id: 'commit-error',
        label: 'Could not load history',
        description: phase.error,
        surface: 'notice',
        severity: 'error',
      })
    }
    add({
      id: 'use-commit',
      label: 'Use commit',
      command: Commands.selectCommit,
      payload: phase.selected ?? '',
      contextValue: 'action',
      enabled: view.canStart && phase.selected !== null && phase.selected !== '',
      slot: 'nav',
      tone: 'primary',
    })
    add(navBack())
    return
  }

  if (phase.kind === 'range') {
    addRangePicker(phase, view, add)
    return
  }

  if (phase.kind === 'generate') {
    addGenerateItems(phase.target, view, add)
    return
  }
}

function addHomeItems(view: SidebarViewModel, add: (item: SidebarItemData) => void): void {
  if (!view.canStart && view.idleReason !== null) {
    add({
      id: 'welcome',
      label: 'A repository is required',
      description: view.idleReason,
      surface: 'notice',
      severity: 'warning',
      tooltip: view.idleReason,
      icon: 'book',
    })
    return
  }

  add({
    id: 'welcome',
    label: 'Review a change',
    description: 'Choose where to begin.',
  })
  if (view.guideFocused) {
    add({
      id: 'start-guide',
      label: 'Continue with this guide',
      command: Commands.startFromGuide,
      icon: 'play',
      contextValue: 'action',
      enabled: view.canStart,
      tone: 'primary',
    })
  }
  add({
    id: 'working-tree',
    label: 'Working changes',
    description: 'Staged, unstaged and new files',
    command: Commands.pickWorkingTree,
    icon: 'diff',
    contextValue: 'action',
    enabled: view.canStart,
    surface: 'list',
    trailing: 'chevron',
    tone: 'secondary',
  })
  add({
    id: 'commit',
    label: 'A commit',
    description: 'One commit against its parent',
    command: Commands.pickCommit,
    icon: 'git-commit',
    contextValue: 'action',
    enabled: view.canStart,
    surface: 'list',
    trailing: 'chevron',
    tone: 'secondary',
  })
  add({
    id: 'range',
    label: 'A commit range',
    description: 'Changes between two revisions',
    command: Commands.pickRange,
    icon: 'git-compare',
    contextValue: 'action',
    enabled: view.canStart,
    surface: 'list',
    trailing: 'chevron',
    tone: 'secondary',
  })
  if (view.skillInstalled === false) {
    add({
      id: 'agent-prompt',
      label: 'Want an agent-authored guide?',
    })
    add({
      id: 'install-skill',
      label: 'Set up editor agent',
      command: Commands.installSkill,
      icon: 'link-external',
      contextValue: 'action',
      tone: 'quiet',
    })
  }
}

function addGenerateItems(
  target: ReviewTarget,
  view: SidebarViewModel,
  add: (item: SidebarItemData) => void,
): void {
  add({
    id: 'generate',
    label: 'Walkthrough',
    description: view.sidecarReady
      ? `A guide is already in ${view.guideFileName}.`
      : `Write ${view.guideFileName}, then start the walkthrough.`,
  })
  if (view.sidecarReady) {
    add({
      id: 'guide-source',
      label: 'Repository guide',
      description: 'Provenance, not a verdict on the code.',
    })
  }

  add({
    id: 'simple',
    label: 'Generate Simple guide',
    description: 'Offline ordering from the diff',
    command: Commands.generateSimple,
    icon: 'list-tree',
    contextValue: 'action',
    enabled: view.canStart,
    surface: 'list',
    tone: 'secondary',
  })
  add({
    id: 'agent',
    label: 'Ask editor agent',
    description: 'Handoff to the editor agent, with a copy-and-paste fallback if needed. This is not offline generation.',
    command: Commands.generateAgent,
    icon: 'comment-discussion',
    contextValue: 'action',
    enabled: view.canStart && view.skillInstalled !== null,
    surface: 'list',
    tone: 'secondary',
  })

  if (view.showModePicker) {
    add({
      id: 'mode-readonly',
      label: 'Read-only',
      description: 'Virtual documents. The working tree is not checked out.',
      command: Commands.chooseMode,
      payload: 'readonly',
      contextValue: 'action',
      enabled: view.canStart,
      accent: view.previewMode === 'readonly' ? 'selected' : undefined,
      surface: 'list',
      tone: 'secondary',
    })
    if (view.showRebase) {
      add({
        id: 'mode-rebase',
        label: 'Rebase',
        description: view.rebaseApplicable
          ? 'Stop an interactive rebase at this commit so you can edit the real files.'
          : (view.rebaseHint ?? 'Not available for this target.'),
        command: Commands.chooseMode,
        payload: 'rebase',
        contextValue: 'action',
        enabled: view.canStart && view.rebaseApplicable,
        accent: view.previewMode === 'rebase' ? 'selected' : undefined,
        surface: 'list',
        tone: 'secondary',
      })
    }
  }

  const consequence = startConsequence(view, target)
  add({
    id: 'will-run',
    label: consequence.summary,
    description: consequence.detail,
    surface: consequence.command === null ? undefined : 'disclosure',
    expanded: false,
    icon: 'info',
  })
  if (consequence.command !== null) {
    add({
      id: 'will-run-command',
      label: 'Command details',
      description: consequence.command,
      surface: 'disclosure',
      expanded: false,
    })
  }

  const startReady = view.sidecarReady || (view.guideFocused && !view.focusedGuideMismatch)
  add({
    id: 'start-guide',
    label: 'Start walkthrough',
    command: Commands.startFromGuide,
    icon: 'play',
    contextValue: 'action',
    enabled: view.canStart && view.startEnabled && startReady,
    slot: 'nav',
    tone: 'primary',
  })
  if (view.focusedGuideMismatch) {
    add({
      id: 'guide-mismatch',
      label: 'Focused guide is for a different target',
      description: `Start uses ${view.guideFileName} for this pick.`,
      surface: 'notice',
      severity: 'info',
    })
  }
  add(navBack())
}

function startConsequence(
  view: SidebarViewModel,
  target?: ReviewTarget,
): { readonly summary: string, readonly detail?: string, readonly command: string | null } {
  const hint = view.startHint ?? undefined
  if (view.previewMode === 'rebase' && view.willRun !== 'nothing') {
    return {
      summary: hint ?? 'Rewrites later commits after the reviewed tip.',
      detail: view.willRunNotes,
      command: view.willRun,
    }
  }
  const workingTree = target?.kind === 'workingTree' || view.entry === 'working tree'
  if (workingTree) {
    return {
      summary: 'Saves open changes and captures a review snapshot. No checkout or stash. Later edits do not update this walkthrough.',
      detail: hint,
      command: null,
    }
  }
  return {
    summary: 'Reads committed objects without checking out the target.',
    detail: hint,
    command: null,
  }
}

function navBack(): SidebarItemData {
  return {
    id: 'back',
    label: 'Review',
    command: Commands.setupBack,
    icon: 'arrow-left',
    contextValue: 'action',
    slot: 'nav',
    tone: 'quiet',
  }
}

function addRangePicker(
  phase: RangeSetupPhase,
  view: SidebarViewModel,
  add: (item: SidebarItemData) => void,
): void {
  add({
    id: 'pick-range',
    label: 'Commit range',
    description: phase.loading
      ? 'Loading recent history…'
      : 'Set the start and end of your review.',
  })
  const rangeReady = phase.from !== null && phase.to !== null
  const fieldError = phase.error ?? undefined
  add({
    id: 'range-start',
    label: 'Start',
    command: Commands.selectCommit,
    input: {
      placeholder: 'base',
      value: phase.from === null ? '' : displayRev(phase.from, phase.commits),
      bound: 'from',
      hideSubmit: true,
      ...(fieldError === undefined ? {} : { error: fieldError }),
    },
    contextValue: 'input',
    enabled: view.canStart && !phase.loading,
    slot: 'header',
  })
  add({
    id: 'range-end',
    label: 'End',
    command: Commands.selectCommit,
    input: {
      placeholder: 'tip',
      value: phase.to === null ? '' : displayRev(phase.to, phase.commits),
      bound: 'to',
      hideSubmit: true,
    },
    contextValue: 'input',
    enabled: view.canStart && !phase.loading,
    slot: 'header',
  })
  if (!phase.loading) {
    add({
      id: 'history-heading',
      label: rangeHistoryHeading(phase),
    })
    addCommitChoices(phase.commits, add, view.canStart, (_commit, index) => rangeAccent(phase, index))
    add({
      id: 'range-compare',
      label: 'How this range is compared',
      description: 'Review the end against its merge base with the start.',
      surface: 'disclosure',
      expanded: false,
    })
  }
  add({
    id: 'use-range',
    label: 'Use range',
    command: Commands.submitRange,
    payload: rangeReady ? `${phase.from}..${phase.to}` : '',
    contextValue: 'action',
    enabled: view.canStart && rangeReady,
    slot: 'nav',
    tone: 'primary',
  })
  add(navBack())
}

function rangeHistoryHeading(phase: RangeSetupPhase): string {
  return phase.pick === 'to'
    ? 'Recent commits · choose end'
    : 'Recent commits · choose start'
}

function addCommitChoices(
  commits: readonly CommitSummary[],
  add: (item: SidebarItemData) => void,
  enabled: boolean,
  accentOf?: (commit: CommitSummary, index: number) => SidebarItemData['accent'],
  payloadPrefix = '',
): void {
  for (const [index, commit] of commits.entries()) {
    const merge = commit.parentCount > 1 ? ' · merge' : ''
    const accent = accentOf?.(commit, index)
    add({
      id: `commit-${commit.sha}`,
      label: commit.subject === '' ? commit.shortSha : commit.subject,
      description: `${commit.shortSha} ${commit.author} · ${commit.relativeDate}${merge}`,
      tooltip: commit.subject === '' ? commit.shortSha : commit.subject,
      command: Commands.selectCommit,
      payload: `${payloadPrefix}${commit.sha}`,
      icon: 'git-commit',
      contextValue: 'action',
      enabled,
      surface: 'list',
      tone: 'secondary',
      ...(accent === undefined ? {} : { accent }),
    })
  }
}

function commitMatchesRev(commit: CommitSummary, rev: string | null): boolean {
  if (rev === null)
    return false
  return commit.sha === rev || commit.shortSha === rev
}

function rangeAccent(
  phase: RangeSetupPhase,
  index: number,
): SidebarItemData['accent'] {
  const fromIndex = indexOfRev(phase.commits, phase.from)
  const toIndex = indexOfRev(phase.commits, phase.to)
  if (fromIndex >= 0 && toIndex >= 0) {
    if (index === fromIndex)
      return 'start'
    if (index === toIndex)
      return 'end'
    const low = Math.min(fromIndex, toIndex)
    const high = Math.max(fromIndex, toIndex)
    if (index > low && index < high)
      return 'between'
    return undefined
  }
  if (fromIndex >= 0 && index === fromIndex)
    return 'selected'
  if (toIndex >= 0 && index === toIndex)
    return 'selected'
  return undefined
}

function indexOfRev(commits: readonly CommitSummary[], rev: string | null): number {
  if (rev === null)
    return -1
  return commits.findIndex(commit => commit.sha === rev || commit.shortSha === rev)
}

function displayRev(rev: string, commits: readonly CommitSummary[]): string {
  const found = commits.find(commit => commit.sha === rev || commit.shortSha === rev)
  if (found !== undefined)
    return found.shortSha
  return rev.length > 12 ? rev.slice(0, 12) : rev
}
