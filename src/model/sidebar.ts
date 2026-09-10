import type { CommitSummary } from '../git/log'
import type { GitState } from '../git/state'
import type { RangeSetupPhase } from './setup'
import type { SidebarViewModel } from './view'
import { commands as Commands } from '../generated/meta'
import { describeSetupTarget } from './setup'

export function safeSidebarText(value: string, max = 500): string {
  const clean = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return (code >= 32 && code !== 127) || character === '\n' || character === '\r' || character === '\t'
  }).join('')
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

export interface SidebarItemData {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly tooltip?: string
  readonly command?: string
  readonly payload?: string
  readonly input?: { readonly placeholder: string, readonly submit?: string }
  readonly icon?: string
  readonly contextValue?: string
  readonly enabled?: boolean
  readonly slot?: 'nav'
  readonly surface?: 'list'
  readonly accent?: 'start' | 'end' | 'between' | 'selected'
}

export function sidebarItems(view: SidebarViewModel): readonly SidebarItemData[] {
  const items: SidebarItemData[] = []
  const add = (item: SidebarItemData): void => {
    items.push({
      ...item,
      label: safeSidebarText(item.label),
      ...(item.description === undefined ? {} : { description: safeSidebarText(item.description, 4000) }),
      ...(item.tooltip === undefined ? {} : { tooltip: safeSidebarText(item.tooltip, 2000) }),
    })
  }

  addGitBanner(view.gitState, add)

  if (view.status === 'idle') {
    addIdleItems(view, add)
    addAutostashNotice(view.gitState, add)
    return items
  }

  if (view.status === 'starting') {
    add({ id: 'starting', label: 'Starting review…', description: `Will run: ${view.willRun}`, icon: 'sync~spin' })
    add({ id: 'cancel-starting', label: 'Cancel', command: Commands.cancel, icon: 'close', contextValue: 'action' })
    addAutostashNotice(view.gitState, add)
    return items
  }

  if (view.status === 'finishing') {
    add({ id: 'finishing', label: 'Closing review…', icon: 'sync~spin' })
    addAutostashNotice(view.gitState, add)
    return items
  }

  const progress = view.progress
  const current = view.currentStep
  add({
    id: 'session',
    label: 'Read-only walkthrough',
    description: progress === null ? view.status : `${progress.index} of ${progress.total}`,
    tooltip: view.entry === null ? undefined : `Reviewing ${view.entry}`,
    icon: 'book',
  })
  if (view.summary !== null)
    add({ id: 'summary', label: 'Guide summary', description: view.summary, tooltip: view.summary, icon: 'note' })

  if (current === null)
    add({ id: 'ready', label: 'Ready for the first step', description: 'Use Next step to begin', icon: 'circle-outline' })
  if (current !== null) {
    const title = current.title ?? current.path
    const edited = view.editedPaths.includes(current.path)
    add({
      id: 'current',
      label: edited ? `${title} · edited on disk` : title,
      description: current.path,
      tooltip: current.rationale,
      icon: 'arrow-right',
    })
    if (current.rationale !== '')
      add({ id: 'rationale', label: 'Why here', description: current.rationale, tooltip: current.rationale, icon: 'lightbulb' })
    if (current.notes !== undefined && current.notes.trim() !== '')
      add({ id: 'notes', label: 'Notes', description: current.notes, tooltip: current.notes, icon: 'note' })
    if (view.nextStep !== null)
      add({ id: 'next-step', label: 'Next', description: `${view.nextStep.title ?? view.nextStep.path} · ${view.nextStep.rationale}`, icon: 'chevron-right' })
  }
  if (view.complete)
    add({ id: 'complete', label: 'Walkthrough complete', description: 'Finish closes the review', icon: 'check' })

  if (view.status === 'active') {
    add({
      id: 'previous',
      label: 'Previous',
      command: Commands.previous,
      icon: 'arrow-left',
      contextValue: 'action',
      enabled: view.canRetreat,
      slot: 'nav',
    })
    if (view.complete) {
      add({
        id: 'finish',
        label: 'Finish',
        command: Commands.finish,
        icon: 'check',
        contextValue: 'action',
        enabled: true,
        slot: 'nav',
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
      })
      add({
        id: 'finish',
        label: 'Finish review',
        command: Commands.finish,
        icon: 'check',
        contextValue: 'action',
        enabled: true,
      })
    }
    add({ id: 'current-file', label: 'Go to current change', command: Commands.showStepDetail, contextValue: 'action', enabled: current !== null })
    add({
      id: 'edit-here',
      label: 'Edit here',
      description: view.editHereEnabled ? 'Open the real file at this step' : 'Start in Rebase or Worktree mode to edit the real file',
      command: Commands.editHere,
      icon: 'go-to-file',
      contextValue: 'action',
      enabled: view.editHereEnabled,
    })
  }
  add({ id: 'cancel', label: 'Cancel review', command: Commands.cancel, icon: 'close', contextValue: 'action', enabled: true })
  addAutostashNotice(view.gitState, add)
  return items
}

function addGitBanner(state: GitState | null, add: (item: SidebarItemData) => void): void {
  if (state === null)
    return

  if (state.rebase !== null) {
    const sha = state.rebase.stoppedSha === null ? '?' : state.rebase.stoppedSha.slice(0, 8)
    const branch = state.rebase.branch ?? 'HEAD'
    add({
      id: 'rebase',
      label: `Rebasing ${branch} · stopped at ${sha} · ${state.rebase.done} of ${state.rebase.total}`,
      icon: 'git-merge',
    })
    add({ id: 'continue-rebase', label: 'Continue', command: Commands.continueRebase, contextValue: 'action' })
    add({ id: 'abort-rebase', label: 'Abort', command: Commands.abortRebase, contextValue: 'action' })
    add({ id: 'scm-rebase', label: 'Open Source Control', command: Commands.commitHandoff, contextValue: 'action' })
  }
  else if (state.operation !== null) {
    add({
      id: 'operation',
      label: operationLabel(state.operation),
      command: Commands.commitHandoff,
      contextValue: 'action',
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
    })
  }
  if (state.conflicts.length > 0 && state.rebase !== null)
    add({ id: 'continue-conflicts', label: 'Continue', command: Commands.continueRebase, contextValue: 'action' })

  for (const worktree of state.worktrees) {
    add({
      id: `worktree-${worktree.path}`,
      label: worktree.path,
      description: `${worktree.head.slice(0, 8)}${worktree.dirty ? ' · dirty' : ''}`,
    })
    add({ id: `open-${worktree.path}`, label: 'Open', command: Commands.openWorktree, payload: worktree.path, contextValue: 'action' })
    add({ id: `remove-${worktree.path}`, label: 'Remove', command: Commands.removeWorktree, payload: worktree.path, contextValue: 'action' })
  }
  if (state.worktrees.length > 0)
    add({ id: 'prune', label: 'Prune', command: Commands.pruneWorktrees, contextValue: 'action' })

  if (state.staged > 0 || state.unstaged > 0 || state.untracked > 0) {
    add({
      id: 'dirty',
      label: `${state.staged} staged · ${state.unstaged} unstaged · ${state.untracked} untracked`,
    })
  }

  if (state.detached)
    add({ id: 'detached', label: 'Detached HEAD', description: state.headSha === null ? undefined : state.headSha.slice(0, 12) })

  if (state.snapshotRefCount > 0) {
    add({
      id: 'snapshots',
      label: state.snapshotRefCount === 1 ? '1 snapshot ref' : `${state.snapshotRefCount} snapshot refs`,
      description: 'Swept after 24 hours',
    })
  }
}

function addAutostashNotice(state: GitState | null, add: (item: SidebarItemData) => void): void {
  if (state === null)
    return
  for (const stash of state.autostashes) {
    add({
      id: `autostash-${stash.selector}`,
      label: `A rebase left your changes in ${stash.selector}`,
      description: stash.subject,
      icon: 'archive',
    })
    add({ id: `pop-${stash.selector}`, label: 'Pop', command: Commands.popAutostash, payload: stash.selector, contextValue: 'action' })
    add({ id: `show-${stash.selector}`, label: 'Show', command: Commands.showAutostash, payload: stash.selector, contextValue: 'action' })
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

  if (phase.kind === 'targets') {
    add({ id: 'pick-target', label: 'What should we walk through?', description: 'Pick a target, then Simple or Agent writes the guide.' })
    add({
      id: 'working-tree',
      label: 'Working changes',
      description: 'Uncommitted files in this workspace',
      command: Commands.pickWorkingTree,
      icon: 'diff',
      contextValue: 'action',
      enabled: view.canStart,
    })
    add({
      id: 'commit',
      label: 'A commit',
      description: 'One commit against its first parent',
      command: Commands.pickCommit,
      icon: 'git-commit',
      contextValue: 'action',
      enabled: view.canStart,
    })
    add({
      id: 'range',
      label: 'A commit range',
      description: 'Compare two revisions',
      command: Commands.pickRange,
      icon: 'git-compare',
      contextValue: 'action',
      enabled: view.canStart,
    })
    add(navBack())
    return
  }

  if (phase.kind === 'commits') {
    add({
      id: 'pick-commit',
      label: 'Pick a commit',
      description: phase.loading
        ? 'Loading recent history…'
        : (phase.error ?? 'Reviewed against its first parent'),
    })
    if (!phase.loading) {
      addCommitChoices(phase.commits, add, view.canStart)
      add({
        id: 'commit-ref',
        label: 'Enter a commit, tag, or ref',
        command: Commands.selectCommit,
        input: { placeholder: 'HEAD~1', submit: 'Go' },
        contextValue: 'input',
        enabled: view.canStart,
      })
    }
    add(navBack())
    return
  }

  if (phase.kind === 'range') {
    addRangePicker(phase, view, add)
    return
  }

  if (phase.kind === 'generate') {
    add({
      id: 'generate',
      label: describeSetupTarget(phase.target),
      description: `Write ${view.guideFileName}, then Start the walkthrough.`,
    })
    add({
      id: 'will-run',
      label: `Will run: ${view.willRun}`,
      description: 'Read-only — the working tree is not checked out.',
      icon: 'terminal',
    })
    add({
      id: 'simple',
      label: 'Simple',
      description: 'Offline heuristic order',
      command: Commands.generateSimple,
      icon: 'sparkle',
      contextValue: 'action',
      enabled: view.canStart,
    })
    add({
      id: 'agent',
      label: 'Agent',
      description: 'Ask the editor agent for valuable comments and order',
      command: Commands.generateAgent,
      icon: 'comment-discussion',
      contextValue: 'action',
      enabled: view.canStart && view.skillInstalled !== null,
    })
    if (view.sidecarReady || (view.guideFocused && !view.focusedGuideMismatch)) {
      add({
        id: 'start-guide',
        label: 'Start',
        command: Commands.startFromGuide,
        icon: 'play',
        contextValue: 'action',
        enabled: view.canStart,
      })
    }
    else if (view.focusedGuideMismatch) {
      add({
        id: 'guide-mismatch',
        label: 'Focused guide is for a different target',
        description: `Start uses ${view.guideFileName} for this pick.`,
      })
    }
    add(navBack())
    return
  }

  add({
    id: 'welcome',
    label: 'Understand every change, one Tab at a time',
    description: view.idleReason ?? 'Walk a change in an order that builds context',
    tooltip: 'Review a target, generate a guide, then Start.',
    icon: 'book',
  })
  if (view.guideFocused) {
    add({
      id: 'start-guide',
      label: 'Start',
      command: Commands.startFromGuide,
      icon: 'play',
      contextValue: 'action',
      enabled: view.canStart,
    })
  }
  add({ id: 'review', label: 'Review…', command: Commands.review, icon: 'diff', contextValue: 'action', enabled: view.canStart })
  if (view.skillInstalled === false) {
    add({
      id: 'install-skill',
      label: 'Install /tabthrough',
      description: 'Adds the Tabthrough skill to this workspace so Agent can write the guide',
      command: Commands.installSkill,
      icon: 'desktop-download',
      contextValue: 'action',
    })
  }
}

function navBack(): SidebarItemData {
  return {
    id: 'back',
    label: '← Back',
    command: Commands.setupBack,
    icon: 'arrow-left',
    contextValue: 'action',
    slot: 'nav',
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
      : (phase.error ?? 'Click a start and an end, or type A..B.'),
  })
  const rangeReady = phase.from !== null && phase.to !== null
  add({
    id: 'use-range',
    label: rangeReady
      ? `Use ${displayRev(phase.from, phase.commits)}..${displayRev(phase.to, phase.commits)}`
      : 'Use range',
    description: 'Review the end against merge-base with the start',
    command: Commands.submitRange,
    payload: rangeReady ? `${phase.from}..${phase.to}` : '',
    contextValue: 'action',
    enabled: view.canStart && rangeReady,
  })
  if (!phase.loading) {
    addCommitChoices(phase.commits, add, view.canStart, (_commit, index) => rangeAccent(phase, index))
    add({
      id: 'range-input',
      label: 'Range',
      command: Commands.submitRange,
      input: { placeholder: 'main..HEAD', submit: 'Use' },
      contextValue: 'input',
      enabled: view.canStart,
    })
  }
  add(navBack())
}

function addCommitChoices(
  commits: readonly CommitSummary[],
  add: (item: SidebarItemData) => void,
  enabled: boolean,
  accentOf?: (commit: CommitSummary, index: number) => SidebarItemData['accent'],
): void {
  for (const [index, commit] of commits.entries()) {
    const merge = commit.parentCount > 1 ? ' · merge' : ''
    const accent = accentOf?.(commit, index)
    add({
      id: `commit-${commit.sha}`,
      label: commit.subject === '' ? commit.shortSha : commit.subject,
      description: `${commit.shortSha} · ${commit.author} · ${commit.relativeDate}${merge}`,
      command: Commands.selectCommit,
      payload: commit.sha,
      icon: 'git-commit',
      contextValue: 'action',
      enabled,
      surface: 'list',
      ...(accent === undefined ? {} : { accent }),
    })
  }
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
