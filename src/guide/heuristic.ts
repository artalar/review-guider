import type { DiffFile, Guide, GuideStep, LineGroup, ReviewDiff, Significance } from './types'
import { groupSize } from './groups'
import { absorbSkipSteps, compareGroupOrder, maxSignificance } from './steps'

export interface HeuristicOptions {
  /** Upper bound on the changed lines a coalesced step may carry. */
  readonly maxLinesPerStep: number
  /** Context-line tolerance used when the diff was grouped. Informational here. */
  readonly intraHunkGap: number
  /** When true, formatting-only groups score `skip` and fold into a neighbour. */
  readonly hideFormattingSteps: boolean
}

export const DEFAULT_HEURISTIC_OPTIONS: HeuristicOptions = {
  maxLinesPerStep: 24,
  intraHunkGap: 1,
  hideFormattingSteps: false,
}

export const TIER_RATIONALE: readonly string[] = [
  'Types before callers',
  'Core logic before the code that calls it',
  'Wiring after the pieces it wires',
  'Presentation last',
  'Tests confirm the behaviour above',
  'Supporting changes',
  'Generated output — skim only',
]

const TIER_TEST = 4
const TIER_GENERATED = 6

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'rb',
  'php',
  'cs',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'scala',
  'dart',
  'ex',
  'exs',
])

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\//
const TEST_FILE = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|(?:^|\/)conftest\.py$/
const TYPE_PATH = /(?:^|\/)(?:types?|schemas?|migrations?|interfaces?|contracts?|proto)\//
const TYPE_FILE = /\.d\.ts$|\.proto$|(?:^|\/)types?\.[^/]+$|(?:^|\/)schema[^/]*$|\.graphql$|\.sql$/
const CONFIG_FILE = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|[^/]*\.config\.[^/]+|\.[^/]*rc(?:\.[^/]+)?|dockerfile|makefile|[^/]+\.ya?ml|[^/]+\.toml|[^/]+\.md|[^/]+\.txt|license[^/]*)$/i
const CONFIG_PATH = /(?:^|\/)(?:\.github|\.vscode|docs?|\.changeset)\//
const UI_PATH = /(?:^|\/)(?:ui|components?|views?|pages?|routes?|screens?|layouts?|styles?)\//
const UI_FILE = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less|html)$/
const SERVICE_PATH = /(?:^|\/)(?:services?|api|clients?|store|stores|state|model|models|repositories|controllers|handlers|commands|hooks)\//
const LIB_PATH = /(?:^|\/)(?:lib|libs|core|domain|utils?|helpers?|shared|common|guide|packages)\//

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Stage 1 of the ordering: which pedagogical tier does this file sit in?
 * Checked most-specific-first, so `service.test.ts` is a test rather than a
 * service and `types.test.ts` is a test rather than a type.
 */
export function fileTier(file: DiffFile): number {
  const path = file.path.toLowerCase()
  if (file.isBinary || file.isGenerated)
    return TIER_GENERATED
  if (TEST_FILE.test(path) || TEST_PATH.test(path))
    return TIER_TEST
  if (TYPE_FILE.test(path) || TYPE_PATH.test(path))
    return 0
  if (CONFIG_PATH.test(path) || CONFIG_FILE.test(path))
    return 5
  if (UI_FILE.test(path) || UI_PATH.test(path))
    return 3
  if (SERVICE_PATH.test(path))
    return 2
  if (LIB_PATH.test(path))
    return 1
  return SOURCE_EXTENSIONS.has(extensionOf(path)) ? 1 : 5
}

function tierRationale(tier: number, hasGroups: boolean): string {
  if (tier === TIER_GENERATED && !hasGroups)
    return 'Skipped: generated'
  return TIER_RATIONALE[tier] ?? TIER_RATIONALE[5]
}

// --- Stage 2: import-graph refinement inside a tier ---------------------------

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*|\bimport\(\s*)['"]([^'"]+)['"]/g
const RESOLVE_EXTENSIONS: readonly string[] = [
  '',
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '/index.ts',
  '/index.tsx',
  '/index.js',
]

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function normalizeJoin(base: string, relative: string): string {
  const segments = base === '' ? [] : base.split('/')
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..')
      segments.pop()
    else
      segments.push(segment)
  }
  return segments.join('/')
}

function specifiersOf(file: DiffFile): string[] {
  const out: string[] = []
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      SPECIFIER.lastIndex = 0
      let match = SPECIFIER.exec(line.text)
      while (match !== null) {
        out.push(match[1])
        match = SPECIFIER.exec(line.text)
      }
    }
  }
  return out
}

/**
 * Stage 2: order files inside a tier so a changed file comes after the changed
 * files it imports. Specifiers are read from the diff text only — no filesystem
 * walk, no AST. A cycle degrades to path order.
 */
export function orderWithinTier(files: readonly DiffFile[]): DiffFile[] {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const known = new Set(sorted.map(file => file.path))
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const file of sorted) {
    indegree.set(file.path, 0)
    dependents.set(file.path, [])
  }

  for (const file of sorted) {
    const base = dirname(file.path)
    const seen = new Set<string>()
    for (const specifier of specifiersOf(file)) {
      if (!specifier.startsWith('.'))
        continue
      const resolvedBase = normalizeJoin(base, specifier)
      let target: string | null = null
      for (const extension of RESOLVE_EXTENSIONS) {
        const candidate = `${resolvedBase}${extension}`
        if (known.has(candidate) && candidate !== file.path) {
          target = candidate
          break
        }
      }
      if (target === null || seen.has(target))
        continue
      seen.add(target)
      dependents.get(target)?.push(file.path)
      indegree.set(file.path, (indegree.get(file.path) ?? 0) + 1)
    }
  }

  const byPath = new Map(sorted.map(file => [file.path, file]))
  const ready = sorted.filter(file => indegree.get(file.path) === 0).map(file => file.path)
  const out: DiffFile[] = []
  const emitted = new Set<string>()

  while (ready.length > 0) {
    ready.sort()
    const path = ready.shift() as string
    const file = byPath.get(path)
    if (file === undefined || emitted.has(path))
      continue
    emitted.add(path)
    out.push(file)
    for (const dependent of dependents.get(path) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0)
        ready.push(dependent)
    }
  }

  for (const file of sorted) {
    if (!emitted.has(file.path))
      out.push(file)
  }
  return out
}

// --- Stage 3: hunk significance ----------------------------------------------

interface Signal {
  readonly weight: number
  readonly rationale: string
  readonly test: RegExp
  /** Only fires on added lines — a removed import is not a new dependency. */
  readonly addedOnly?: boolean
}

const TRIVIAL_LINE = /^\s*(?:\/\/|\/\*|\*|#|<!--|--|;;)|^\s*$/

const SIGNALS: readonly Signal[] = [
  {
    weight: 5,
    rationale: 'New public surface',
    test: /^\s*(?:export\b|module\.exports\b|exports\.[A-Za-z_$]|pub\s|public\s)/,
  },
  {
    weight: 4,
    rationale: 'Signature changed — callers must adapt',
    test: /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|fn|func)\b|^\s*(?:(?:public|private|protected|static|readonly|async)\s*)?[A-Za-z_$][\w$]*\s*(?:<[^>]*>\s*)?\([^)]*\)\s*(?::[^{;]+)?[{;]\s*$|=>\s*(?:\{\s*)?$/,
  },
  {
    weight: 3,
    rationale: 'New branch of behaviour',
    test: /\b(?:if|else|for|while|switch|case|match)\b|^\s*return\b/,
  },
  {
    weight: 2,
    rationale: 'New dependency introduced',
    test: /^\s*(?:import\b|#include\b|use\s+[A-Za-z_])|\brequire\(/,
    addedOnly: true,
  },
  {
    weight: 2,
    rationale: 'Failure path',
    test: /\b(?:throw|catch|except|rescue|panic|reject)\b|\bError\b/,
  },
]

const BODY_RATIONALE = 'Implementation detail'
const FORMATTING_RATIONALE = 'Formatting only'

export interface GroupScore {
  readonly score: number
  readonly significance: Significance
  readonly rationale: string
}

function groupTexts(file: DiffFile, group: LineGroup): { added: string[], deleted: string[] } {
  const hunk = file.hunks[group.hunkIndex]
  const added: string[] = []
  const deleted: string[] = []
  if (hunk === undefined)
    return { added, deleted }
  for (const line of hunk.lines) {
    if (line.kind === 'add' && group.newRange !== undefined && line.newLine !== undefined
      && line.newLine >= group.newRange.start && line.newLine <= group.newRange.end) {
      added.push(line.text)
    }
    if (line.kind === 'del' && group.oldRange !== undefined && line.oldLine !== undefined
      && line.oldLine >= group.oldRange.start && line.oldLine <= group.oldRange.end) {
      deleted.push(line.text)
    }
  }
  return { added, deleted }
}

function bucket(score: number, hideFormattingSteps: boolean): Significance {
  if (score >= 8)
    return 'critical'
  if (score >= 5)
    return 'high'
  if (score >= 2)
    return 'normal'
  if (score >= 1)
    return 'low'
  return hideFormattingSteps ? 'skip' : 'low'
}

/**
 * Stage 3. Each signal contributes its weight at most once per group: the score
 * measures *what kinds of change* the group contains, not how many lines it has,
 * so the bucket boundaries mean the same thing for a 3-line and a 30-line group.
 */
export function scoreGroup(file: DiffFile, group: LineGroup, hideFormattingSteps = false): GroupScore {
  const { added, deleted } = groupTexts(file, group)
  const all = [...added, ...deleted]
  let score = 0
  let topWeight = 0
  let rationale = FORMATTING_RATIONALE

  for (const signal of SIGNALS) {
    const candidates = signal.addedOnly === true ? added : all
    if (!candidates.some(line => signal.test.test(line)))
      continue
    score += signal.weight
    if (signal.weight > topWeight) {
      topWeight = signal.weight
      rationale = signal.rationale
    }
  }

  if (all.some(line => !TRIVIAL_LINE.test(line))) {
    score += 1
    if (topWeight === 0)
      rationale = BODY_RATIONALE
  }

  return { score, significance: bucket(score, hideFormattingSteps), rationale }
}

// --- Stage 4: step sizing -----------------------------------------------------

interface Bucketed {
  groups: LineGroup[]
  significance: Significance
  rationale: string
  lines: number
}

function stepId(group: LineGroup): string {
  return `h:${group.id}`
}

function fileSteps(file: DiffFile, tier: number, options: HeuristicOptions): GuideStep[] {
  const ordered = [...file.groups].sort(compareGroupOrder)
  const steps: GuideStep[] = []
  let pending: Bucketed | null = null

  const flush = (): void => {
    if (pending === null)
      return
    const first = pending.groups[0]
    steps.push({
      id: stepId(first),
      path: file.path,
      groups: pending.groups,
      kind: 'reveal',
      significance: pending.significance,
      rationale: steps.length === 0 ? tierRationale(tier, true) : pending.rationale,
      source: 'heuristic',
    })
    pending = null
  }

  for (const group of ordered) {
    const scored = scoreGroup(file, group, options.hideFormattingSteps)
    const size = groupSize(group)

    if (scored.significance === 'critical' || scored.significance === 'high') {
      flush()
      steps.push({
        id: stepId(group),
        path: file.path,
        groups: [group],
        kind: 'reveal',
        significance: scored.significance,
        rationale: steps.length === 0 ? tierRationale(tier, true) : scored.rationale,
        source: 'heuristic',
      })
      continue
    }

    if (pending !== null && pending.lines + size > options.maxLinesPerStep)
      flush()

    if (pending === null) {
      pending = {
        groups: [group],
        significance: scored.significance,
        rationale: scored.rationale,
        lines: size,
      }
      continue
    }
    pending.groups.push(group)
    pending.significance = maxSignificance(pending.significance, scored.significance)
    pending.lines += size
  }
  flush()

  return steps
}

function stubRationale(file: DiffFile): string {
  if (file.isBinary)
    return 'Skipped: binary file'
  if (file.status === 'mode-only')
    return 'Mode change only'
  if (file.status === 'renamed')
    return 'Renamed with no content change'
  if (file.isGenerated)
    return 'Skipped: generated'
  return 'No revealable content'
}

/**
 * Deterministic offline ordering: file tier, then import graph inside the tier,
 * then hunk significance, then sizing. Ties break by path, hunk index and start
 * line, so a fixture can never flake (invariant I4).
 */
export function buildHeuristicGuide(diff: ReviewDiff, opts?: Partial<HeuristicOptions>): Guide {
  const options: HeuristicOptions = { ...DEFAULT_HEURISTIC_OPTIONS, ...opts }

  const tiers = new Map<number, DiffFile[]>()
  for (const file of diff.files) {
    const tier = fileTier(file)
    const list = tiers.get(tier) ?? []
    list.push(file)
    tiers.set(tier, list)
  }

  const steps: GuideStep[] = []
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    for (const file of orderWithinTier(tiers.get(tier) ?? [])) {
      if (file.groups.length === 0) {
        steps.push({
          id: `h:stub:${file.path}`,
          path: file.path,
          groups: [],
          kind: 'stub',
          significance: 'low',
          rationale: stubRationale(file),
          source: 'heuristic',
        })
        continue
      }
      steps.push(...fileSteps(file, tier, options))
    }
  }

  return { steps: absorbSkipSteps(steps), stale: false, diagnostics: [] }
}
