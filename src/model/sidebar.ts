import type { SidebarViewModel } from './view'
import { commands as Commands } from '../generated/meta'
import { describeTarget } from '../git/types'
import { describeSetupTarget } from './setup'

/** Keep hostile or accidentally huge guide text from taking over the view. */
export function safeSidebarText(value: string, max = 500): string {
  const clean = [...value].filter((character) => {
    const code = character.charCodeAt(0)
    return (code >= 32 && code !== 127) || character === '\n' || character === '\r' || character === '\t'
  }).join('')
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/** Data-only sidebar rows; the extension host turns these into TreeItems. */
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

  if (view.status === 'idle') {
    if (view.liveElsewhere) {
      add({ id: 'live', label: 'Review active in another window', description: 'Finish that walkthrough before starting here.' })
      return items
    }
    if (view.recoveryPending) {
      add({ id: 'recovery', label: 'A previous review needs recovery', description: 'Restore before starting', icon: 'warning', contextValue: 'recovery' })
      add({ id: 'restore', label: 'Restore backup', command: Commands.restoreBackup, icon: 'history', contextValue: 'action' })
      add({ id: 'dismiss', label: 'Dismiss reminder', command: Commands.discardRecovery, icon: 'close', contextValue: 'action' })
      return items
    }
    if (view.staleLock) {
      const owner = view.lockOwner
      add({
        id: 'stale-lock',
        label: owner === null ? 'Leftover review lock' : `Leftover review lock (${owner})`,
        description: 'Tabthrough cannot see a live session for this lock in this editor. If another editor or profile is reviewing this repository, keep the lock. Clearing removes only the lock. Your files stay as they are.',
        icon: 'warning',
        contextValue: 'recovery',
      })
      add({
        id: 'clear-lock',
        label: 'Clear leftover lock',
        description: 'Removes only the lock. Leftover refs stay until you run Clean Up Backups.',
        command: Commands.clearStaleLock,
        icon: 'unlock',
        contextValue: 'action',
      })
      add({
        id: 'cleanup-refs',
        label: 'Clean up leftover refs…',
        description: 'Permanently removes leftover Tabthrough refs. Stash entries stay.',
        command: Commands.cleanupBackups,
        icon: 'trash',
        contextValue: 'action',
      })
      return items
    }

    addIdleItems(view, add)
    return items
  }

  if (view.status === 'preflight') {
    if (view.preflight === null) {
      add({ id: 'preparing', label: 'Preparing your review…', description: 'Checking the repository and saved changes.' })
      add({ id: 'cancel-preparing', label: 'Cancel', command: Commands.cancel, contextValue: 'action' })
      return items
    }
    const plan = view.preflight
    const changed = plan.changedFileCount === 1 ? '1 changed file' : `${plan.changedFileCount} changed files`
    add({ id: 'preflight', label: `Ready to review ${changed}`, description: `${plan.changedLineCount} changed lines · ${plan.sessionMode === 'apply' ? 'apply with user' : 'read-only'}`, icon: 'question' })
    add({ id: 'target', label: safeSidebarText(describeTarget(plan.entry, { short: true })), description: plan.willStash ? 'Your work will be stashed safely first' : 'Working tree is clean', icon: 'info' })
    add({ id: 'cancel-preflight', label: 'Cancel', command: Commands.cancel, icon: 'close', contextValue: 'action' })
    return items
  }

  if (view.status === 'stashing') {
    add({ id: 'stashing', label: 'Preparing walkthrough…', description: 'Capturing your workspace safely', icon: 'sync~spin' })
    add({ id: 'cancel-stashing', label: 'Cancel', command: Commands.cancel, icon: 'close', contextValue: 'action' })
    return items
  }

  if (view.status === 'restoring') {
    add({ id: 'restoring', label: 'Restoring your workspace…', description: 'Waiting for git to verify the restore', icon: 'sync~spin' })
    return items
  }

  if (view.status === 'blocked' || view.status === 'error') {
    add({ id: 'blocked', label: view.status === 'blocked' ? 'Walkthrough needs attention' : 'Walkthrough could not start', description: view.blockedMessage ?? 'Your backup is retained. Restore your workspace to continue.', icon: 'error' })
    if (view.status === 'blocked')
      add({ id: 'cancel-blocked', label: 'Restore workspace', command: Commands.restoreBackup, icon: 'history', contextValue: 'action' })
    add({ id: 'dismiss', label: 'Dismiss recovery reminder…', command: Commands.discardRecovery, contextValue: 'action' })
    return items
  }

  const progress = view.progress
  const current = view.currentStep
  const mode = view.mode === 'apply' ? 'Apply with user' : 'Read-only walkthrough'
  add({
    id: 'session',
    label: mode,
    description: progress === null ? view.status : `${progress.index} of ${progress.total}`,
    tooltip: view.entry === null ? undefined : `Reviewing ${view.entry}`,
    icon: view.mode === 'apply' ? 'edit' : 'book',
  })
  if (view.summary !== null)
    add({ id: 'summary', label: 'Guide summary', description: view.summary, tooltip: view.summary, icon: 'note' })

  if (view.applyPending || view.status === 'applying') {
    add({ id: 'applying', label: 'Applying current step…', description: 'Saving and updating your workspace', icon: 'sync~spin' })
  }
  else {
    if (current === null)
      add({ id: 'ready', label: 'Ready for the first step', description: 'Use Next step to begin', icon: 'circle-outline' })
    if (current !== null) {
      const title = current.title ?? current.path
      add({ id: 'current', label: title, description: current.path, tooltip: current.rationale, icon: 'arrow-right' })
      if (current.rationale !== '')
        add({ id: 'rationale', label: 'Why here', description: current.rationale, tooltip: current.rationale, icon: 'lightbulb' })
      if (current.notes !== undefined && current.notes.trim() !== '')
        add({ id: 'notes', label: 'Notes', description: current.notes, tooltip: current.notes, icon: 'note' })
      if (view.nextStep !== null)
        add({ id: 'next-step', label: 'Next', description: `${view.nextStep.title ?? view.nextStep.path} · ${view.nextStep.rationale}`, icon: 'chevron-right' })
    }
    if (view.complete)
      add({ id: 'complete', label: view.mode === 'apply' ? 'All steps applied' : 'Walkthrough complete', description: view.mode === 'apply' ? 'Finish keeps changes for your commit' : 'Finish restores your workspace', icon: 'check' })
  }

  if (!view.applyPending && view.status === 'active') {
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
        label: view.mode === 'apply' ? 'Finish and keep changes' : 'Finish and restore workspace',
        command: Commands.finish,
        icon: 'check',
        contextValue: 'action',
        enabled: true,
      })
    }
    add({ id: 'current-file', label: 'Go to current change', command: Commands.showStepDetail, contextValue: 'action', enabled: current !== null })
  }
  add({ id: 'cancel', label: 'Cancel and restore workspace', command: Commands.cancel, icon: 'close', contextValue: 'action', enabled: true })
  return items
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
      for (const commit of phase.commits) {
        const merge = commit.parentCount > 1 ? ' · merge' : ''
        add({
          id: `commit-${commit.sha}`,
          label: commit.subject === '' ? commit.shortSha : commit.subject,
          description: `${commit.shortSha} · ${commit.author} · ${commit.relativeDate}${merge}`,
          command: Commands.selectCommit,
          payload: commit.sha,
          icon: 'git-commit',
          contextValue: 'action',
          enabled: view.canStart,
        })
      }
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
    add({ id: 'pick-range', label: 'Commit range', description: phase.error ?? 'A..B reviews B against merge-base(A, B)' })
    add({
      id: 'range-input',
      label: 'Range',
      command: Commands.submitRange,
      input: { placeholder: 'main..HEAD', submit: 'Use' },
      contextValue: 'input',
      enabled: view.canStart,
    })
    add(navBack())
    return
  }

  if (phase.kind === 'generate') {
    add({
      id: 'generate',
      label: describeSetupTarget(phase.target),
      description: `Write ${view.guideFileName}, then Start the walkthrough.`,
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
