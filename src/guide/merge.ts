import type { HeuristicOptions } from './heuristic'
import type { Grouping, GuideDoc, GuideRangeDoc, GuideStepDoc } from './schema'
import type { Guide, GuideDiagnostic, GuideStep, LineGroup, ReviewDiff } from './types'
import { groupSize } from './groups'
import { DEFAULT_HEURISTIC_OPTIONS } from './heuristic'
import { isSafeRepoPath, normalizeRepoPath } from './sidecar'
import { absorbSkipSteps, compareGroupOrder } from './steps'

export interface MergeArgs {
  readonly diff: ReviewDiff
  readonly heuristic: Guide
  readonly sidecar?: GuideDoc
  readonly options?: Partial<HeuristicOptions>
}

export interface MergeResult {
  readonly guide: Guide
  readonly diagnostics: readonly GuideDiagnostic[]
}

interface WorkStep {
  readonly step: GuideStep
  readonly grouping: Grouping
}

interface Candidate {
  readonly doc: GuideStepDoc
  readonly index: number
  readonly path: string
}

function rangeOverlap(group: LineGroup, range: GuideRangeDoc): number {
  const side = range.side === 'old' ? group.oldRange : group.newRange
  if (side === undefined)
    return 0
  const start = Math.max(side.start, range.start)
  const end = Math.min(side.end, range.end)
  return end < start ? 0 : end - start + 1
}

function totalOverlap(group: LineGroup, ranges: readonly GuideRangeDoc[]): number {
  let total = 0
  for (const range of ranges) total += rangeOverlap(group, range)
  return total
}

function toStep(candidate: Candidate, groups: readonly LineGroup[]): GuideStep {
  const { doc } = candidate
  return {
    id: doc.id,
    path: candidate.path,
    groups: [...groups].sort(compareGroupOrder),
    kind: 'reveal',
    significance: doc.significance,
    rationale: doc.rationale,
    ...(doc.title === undefined ? {} : { title: doc.title }),
    ...(doc.notes === undefined ? {} : { notes: doc.notes }),
    source: 'sidecar',
  }
}

/** §5.3 step 2: `dependsOn` refines the `order` sort; a cycle drops every edge. */
function refineByDependsOn(
  candidates: readonly Candidate[],
  diagnostics: GuideDiagnostic[],
): Candidate[] {
  const known = new Set(candidates.map(candidate => candidate.doc.id))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const candidate of candidates) {
    indegree.set(candidate.doc.id, 0)
    dependents.set(candidate.doc.id, [])
  }

  let edges = 0
  for (const candidate of candidates) {
    for (const dependency of candidate.doc.dependsOn) {
      if (!known.has(dependency)) {
        diagnostics.push({
          code: 'depends-unknown',
          severity: 'warning',
          message: `Step \`${candidate.doc.id}\` depends on unknown step \`${dependency}\``,
          stepId: candidate.doc.id,
        })
        continue
      }
      dependents.get(dependency)?.push(candidate.doc.id)
      indegree.set(candidate.doc.id, (indegree.get(candidate.doc.id) ?? 0) + 1)
      edges++
    }
  }
  if (edges === 0)
    return [...candidates]

  const position = new Map(candidates.map((candidate, i) => [candidate.doc.id, i]))
  const byId = new Map(candidates.map(candidate => [candidate.doc.id, candidate]))
  const ready = candidates.filter(candidate => indegree.get(candidate.doc.id) === 0).map(c => c.doc.id)
  const out: Candidate[] = []

  while (ready.length > 0) {
    ready.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0))
    const id = ready.shift() as string
    const candidate = byId.get(id)
    if (candidate === undefined)
      continue
    out.push(candidate)
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0)
        ready.push(dependent)
    }
  }

  if (out.length !== candidates.length) {
    diagnostics.push({
      code: 'depends-cycle',
      severity: 'warning',
      message: '`dependsOn` edges form a cycle; all dependency edges were ignored',
    })
    return [...candidates]
  }
  return out
}

/** §6.2 `split`: hand sizing back to the engine, sharing one rationale. */
function expandSplit(work: WorkStep, maxLinesPerStep: number): WorkStep[] {
  if (work.grouping !== 'split' || work.step.groups.length <= 1)
    return [{ ...work, grouping: work.grouping === 'split' ? 'atomic' : work.grouping }]

  const onePerStep = work.step.significance === 'high' || work.step.significance === 'critical'
  const chunks: LineGroup[][] = []
  let current: LineGroup[] = []
  let lines = 0
  for (const group of work.step.groups) {
    const size = groupSize(group)
    if (current.length > 0 && (onePerStep || lines + size > maxLinesPerStep)) {
      chunks.push(current)
      current = []
      lines = 0
    }
    current.push(group)
    lines += size
  }
  if (current.length > 0)
    chunks.push(current)

  if (chunks.length <= 1)
    return [{ ...work, grouping: 'atomic' }]

  return chunks.map((groups, i) => ({
    grouping: 'atomic' as const,
    step: {
      ...work.step,
      id: `${work.step.id}#${i + 1}`,
      groups,
      ...(work.step.title === undefined ? {} : { title: `${work.step.title} (${i + 1}/${chunks.length})` }),
    },
  }))
}

/** §6.2 `mergeWithNext`: fold this step's groups into its successor. */
function applyMergeWithNext(work: readonly WorkStep[], diagnostics: GuideDiagnostic[]): GuideStep[] {
  const out: GuideStep[] = []
  let carried: LineGroup[] = []

  for (let i = 0; i < work.length; i++) {
    const entry = work[i]
    const successor = work[i + 1]
    const mergeable = entry.grouping === 'mergeWithNext'
      && successor !== undefined
      && successor.step.path === entry.step.path
      && successor.step.kind === 'reveal'

    if (mergeable) {
      carried = [...carried, ...entry.step.groups]
      continue
    }
    if (entry.grouping === 'mergeWithNext') {
      diagnostics.push({
        code: 'merge-no-successor',
        severity: 'info',
        message: `Step \`${entry.step.id}\` asks to merge with the next step but has none in the same file`,
        stepId: entry.step.id,
      })
    }
    out.push(
      carried.length === 0
        ? entry.step
        : { ...entry.step, groups: [...carried, ...entry.step.groups].sort(compareGroupOrder) },
    )
    carried = []
  }
  return out
}

/**
 * Merge a validated sidecar with the heuristic guide (guide-schema.md §5).
 *
 * Never violates I1: every line group in the diff ends up in exactly one reveal
 * step, whichever branch produced it.
 */
export function mergeGuide(args: MergeArgs): MergeResult {
  const { diff, heuristic, sidecar } = args
  const diagnostics: GuideDiagnostic[] = [...heuristic.diagnostics]

  if (sidecar === undefined)
    return { guide: heuristic, diagnostics }

  const maxLinesPerStep = sidecar.defaults.maxLinesPerStep
    ?? args.options?.maxLinesPerStep
    ?? DEFAULT_HEURISTIC_OPTIONS.maxLinesPerStep

  const groupsByPath = new Map<string, LineGroup[]>()
  for (const file of diff.files)
    groupsByPath.set(file.path, [...file.groups])

  let stale = heuristic.stale
  const digest = sidecar.scope?.diffDigest
  if (digest !== undefined && digest !== diff.digest) {
    stale = true
    diagnostics.push({
      code: 'stale-guide',
      severity: 'warning',
      message: 'The guide was written for a different diff; using it anyway',
      at: 'scope.diffDigest',
    })
  }

  const candidates: Candidate[] = []
  sidecar.steps.forEach((doc, index) => {
    if (!isSafeRepoPath(doc.path)) {
      diagnostics.push({
        code: 'path-unsafe',
        severity: 'warning',
        message: `Step \`${doc.id}\` was dropped: \`${doc.path}\` escapes the repository`,
        stepId: doc.id,
      })
      return
    }
    const path = normalizeRepoPath(doc.path)
    if (!groupsByPath.has(path)) {
      diagnostics.push({
        code: 'path-unknown',
        severity: 'warning',
        message: `Step \`${doc.id}\` was dropped: \`${path}\` is not in the diff`,
        stepId: doc.id,
      })
      return
    }
    candidates.push({ doc, index, path })
  })

  candidates.sort((a, b) => a.doc.order - b.doc.order || a.index - b.index)

  // §5.1 anchor resolution: ranges first, whole-file claims last.
  const claimedBy = new Map<string, Candidate>()
  const bids = new Map<string, { candidate: Candidate, overlap: number }[]>()
  for (const candidate of candidates) {
    if (candidate.doc.ranges === undefined)
      continue
    for (const group of groupsByPath.get(candidate.path) ?? []) {
      const overlap = totalOverlap(group, candidate.doc.ranges)
      if (overlap === 0)
        continue
      const list = bids.get(group.id) ?? []
      list.push({ candidate, overlap })
      bids.set(group.id, list)
    }
  }

  const overlapReported = new Set<string>()
  for (const [groupId, list] of bids) {
    const winner = list.reduce((best, bid) => (bid.overlap > best.overlap ? bid : best), list[0])
    claimedBy.set(groupId, winner.candidate)
    for (const bid of list) {
      if (bid.candidate === winner.candidate || overlapReported.has(bid.candidate.doc.id))
        continue
      overlapReported.add(bid.candidate.doc.id)
      diagnostics.push({
        code: 'range-overlap',
        severity: 'warning',
        message: `Step \`${bid.candidate.doc.id}\` lost overlapping lines to \`${winner.candidate.doc.id}\``,
        stepId: bid.candidate.doc.id,
      })
    }
  }

  for (const candidate of candidates) {
    if (candidate.doc.ranges !== undefined)
      continue
    for (const group of groupsByPath.get(candidate.path) ?? []) {
      if (!claimedBy.has(group.id))
        claimedBy.set(group.id, candidate)
    }
  }

  const groupsFor = new Map<string, LineGroup[]>()
  for (const file of diff.files) {
    for (const group of file.groups) {
      const owner = claimedBy.get(group.id)
      if (owner === undefined)
        continue
      const list = groupsFor.get(owner.doc.id) ?? []
      list.push(group)
      groupsFor.set(owner.doc.id, list)
    }
  }

  const surviving = candidates.filter((candidate) => {
    const groups = groupsFor.get(candidate.doc.id) ?? []
    if (groups.length > 0)
      return true
    diagnostics.push({
      code: 'anchor-unmatched',
      severity: 'warning',
      message: `Step \`${candidate.doc.id}\` matched no changed lines and was dropped`,
      stepId: candidate.doc.id,
    })
    return false
  })

  if (surviving.length === 0) {
    return {
      guide: { steps: heuristic.steps, stale, diagnostics },
      diagnostics,
    }
  }

  const ordered = refineByDependsOn(surviving, diagnostics)
  const sidecarWork: WorkStep[] = ordered.flatMap(candidate =>
    expandSplit(
      { step: toStep(candidate, groupsFor.get(candidate.doc.id) ?? []), grouping: candidate.doc.grouping },
      maxLinesPerStep,
    ),
  )

  const claimedIds = new Set(claimedBy.keys())
  const fallback = sidecar.defaults.mergeStrategy === 'replace'
    ? replaceFallback(diff, heuristic, claimedIds)
    : mergeFallback(heuristic, claimedIds)

  const applied = applyFileOverrides(fallback, sidecar)
  const combined = applyMergeWithNext([...sidecarWork, ...applied.map(step => ({ step, grouping: 'atomic' as const }))], diagnostics)
  const steps = ensureCoverage(diff, absorbSkipSteps(combined))

  return { guide: { steps, stale, diagnostics }, diagnostics }
}

/** §5.2 `merge`: heuristic order fills the gaps, appended after the sidecar. */
function mergeFallback(heuristic: Guide, claimed: ReadonlySet<string>): GuideStep[] {
  const out: GuideStep[] = []
  for (const step of heuristic.steps) {
    if (step.kind === 'stub') {
      out.push(step)
      continue
    }
    const groups = step.groups.filter(group => !claimed.has(group.id))
    if (groups.length === 0)
      continue
    out.push(groups.length === step.groups.length ? step : { ...step, groups })
  }
  return out
}

/** §5.2 `replace`: no heuristic ordering, one trailing step per file. */
function replaceFallback(diff: ReviewDiff, heuristic: Guide, claimed: ReadonlySet<string>): GuideStep[] {
  const out: GuideStep[] = []
  for (const step of heuristic.steps) {
    if (step.kind === 'stub')
      out.push(step)
  }
  for (const file of diff.files) {
    const groups = file.groups.filter(group => !claimed.has(group.id))
    if (groups.length === 0)
      continue
    out.push({
      id: `h:remainder:${file.path}`,
      path: file.path,
      groups: [...groups].sort(compareGroupOrder),
      kind: 'reveal',
      significance: 'normal',
      rationale: `Remaining changes in ${file.path}`,
      source: 'heuristic',
    })
  }
  return out
}

/** §3.6 `files`: per-file defaults for the heuristic's own steps. */
function applyFileOverrides(steps: readonly GuideStep[], sidecar: GuideDoc): GuideStep[] {
  return steps.map((step) => {
    const override = sidecar.files[step.path]
    if (override === undefined)
      return step
    return {
      ...step,
      ...(override.significance === undefined ? {} : { significance: override.significance }),
      ...(override.rationale === undefined ? {} : { rationale: override.rationale }),
    }
  })
}

/**
 * Invariant I1, enforced rather than asserted: anything the branches above left
 * unclaimed is appended as a trailing per-file step. A guide can lose ordering
 * opinions; it can never lose a line.
 */
function ensureCoverage(diff: ReviewDiff, steps: readonly GuideStep[]): GuideStep[] {
  const seen = new Set<string>()
  const deduped: GuideStep[] = steps.map((step) => {
    const groups = step.groups.filter((group) => {
      if (seen.has(group.id))
        return false
      seen.add(group.id)
      return true
    })
    return groups.length === step.groups.length ? step : { ...step, groups }
  }).filter(step => step.kind === 'stub' || step.groups.length > 0)

  for (const file of diff.files) {
    const missing = file.groups.filter(group => !seen.has(group.id))
    if (missing.length === 0)
      continue
    for (const group of missing) seen.add(group.id)
    deduped.push({
      id: `h:remainder:${file.path}`,
      path: file.path,
      groups: [...missing].sort(compareGroupOrder),
      kind: 'reveal',
      significance: 'normal',
      rationale: `Remaining changes in ${file.path}`,
      source: 'heuristic',
    })
  }
  return deduped
}
