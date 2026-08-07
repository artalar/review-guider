import type { GuideStep, LineGroup, Significance } from './types'

export const SIGNIFICANCE_RANK: Readonly<Record<Significance, number>> = {
  skip: 0,
  low: 1,
  normal: 2,
  high: 3,
  critical: 4,
}

export function maxSignificance(a: Significance, b: Significance): Significance {
  return SIGNIFICANCE_RANK[a] >= SIGNIFICANCE_RANK[b] ? a : b
}

export function compareGroupOrder(a: LineGroup, b: LineGroup): number {
  if (a.hunkIndex !== b.hunkIndex)
    return a.hunkIndex - b.hunkIndex
  if (a.oldAnchor !== b.oldAnchor)
    return a.oldAnchor - b.oldAnchor
  return a.newAnchor - b.newAnchor
}

function absorb(host: GuideStep, guest: GuideStep): GuideStep {
  return { ...host, groups: [...host.groups, ...guest.groups].sort(compareGroupOrder) }
}

/**
 * guide-schema.md §6.1: a `skip` step's lines are still revealed, but they never
 * own a step — they fold into the next step in the same file, or the previous
 * one when they are last. A file whose steps are all `skip` keeps its step, so
 * no line is ever dropped (invariant I1).
 */
export function absorbSkipSteps(steps: readonly GuideStep[]): GuideStep[] {
  const out: GuideStep[] = []
  const carried = new Map<string, GuideStep[]>()

  const hasSuccessor = (from: number, path: string): boolean =>
    steps.some((candidate, i) =>
      i > from
      && candidate.path === path
      && candidate.kind === 'reveal'
      && candidate.significance !== 'skip')

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (step.kind === 'reveal' && step.significance === 'skip') {
      if (hasSuccessor(i, step.path)) {
        const list = carried.get(step.path) ?? []
        list.push(step)
        carried.set(step.path, list)
        continue
      }
      let target = -1
      for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].path === step.path && out[j].kind === 'reveal' && out[j].significance !== 'skip') {
          target = j
          break
        }
      }
      if (target >= 0)
        out[target] = absorb(out[target], step)
      else
        out.push(step)
      continue
    }

    let next = step
    const pending = carried.get(step.path)
    if (pending !== undefined && step.kind === 'reveal') {
      for (const skipped of pending) next = absorb(next, skipped)
      carried.delete(step.path)
    }
    out.push(next)
  }

  return out
}
