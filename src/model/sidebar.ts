import type { ReviewTarget } from '../git/types'
import type { SidebarViewModel } from './view'
import { commands as Commands } from '../generated/meta'

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
  readonly icon?: string
  readonly contextValue?: string
  readonly enabled?: boolean
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

    add({
      id: 'welcome',
      label: 'Understand every change, one Tab at a time',
      description: view.idleReason ?? 'Walk a change in an order that builds context',
      tooltip: 'Start with local changes, a commit, or a commit range. Notes stay visible here as you walk.',
      icon: 'book',
    })
    add({ id: 'working-tree', label: 'Review Working Changes', command: Commands.start, icon: 'diff', contextValue: 'action', enabled: view.canStart })
    add({ id: 'commit', label: 'Review a Commit…', command: Commands.startFromCommit, icon: 'git-commit', contextValue: 'action', enabled: view.canStart })
    add({ id: 'range', label: 'Review a Commit Range…', command: Commands.startFromRange, icon: 'git-compare', contextValue: 'action', enabled: view.canStart })
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
    add({ id: 'target', label: safeSidebarText(describeEntry(plan.entry)), description: plan.willStash ? 'Your work will be stashed safely first' : 'Working tree is clean', icon: 'info' })
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
    if (view.canRetreat)
      add({ id: 'previous', label: 'Previous step', command: Commands.previous, icon: 'arrow-left', contextValue: 'action', enabled: true })
    if (view.canAdvance)
      add({ id: 'next', label: 'Next step', command: Commands.next, icon: 'arrow-right', contextValue: 'action', enabled: true })
    add({ id: 'finish', label: view.mode === 'apply' ? 'Finish and keep changes' : 'Finish and restore workspace', command: Commands.finish, icon: 'check', contextValue: 'action', enabled: true })
    add({ id: 'current-file', label: 'Go to current change', command: Commands.showStepDetail, contextValue: 'action', enabled: current !== null })
  }
  add({ id: 'cancel', label: 'Cancel and restore workspace', command: Commands.cancel, icon: 'close', contextValue: 'action', enabled: true })
  return items
}

function describeEntry(entry: ReviewTarget): string {
  if (entry.kind === 'workingTree')
    return 'Working changes'
  if (entry.kind === 'commit')
    return `Commit ${entry.rev}`
  return `${entry.from}..${entry.to}`
}
