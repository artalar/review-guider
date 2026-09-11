import type { GuideDiagnostic, Result, Significance } from './types'
import { sha256Utf8 } from './sha256'
import { err, ok } from './types'

/** `.guide.json` v1 — see architecture/guide-schema.md. */

export type MergeStrategy = 'merge' | 'replace'
export type Grouping = 'atomic' | 'split' | 'mergeWithNext'
export type RangeSide = 'new' | 'old'
export type ScopeKind = 'workingTree' | 'commit' | 'range'

export interface GuideRangeDoc {
  readonly start: number
  readonly end: number
  readonly side: RangeSide
}

export interface GuideStepDoc {
  readonly id: string
  readonly path: string
  readonly rationale: string
  readonly order: number
  /** Absent means "claim every unclaimed group in `path`". */
  readonly ranges?: readonly GuideRangeDoc[]
  readonly significance: Significance
  readonly grouping: Grouping
  readonly title?: string
  readonly notes?: string
  readonly dependsOn: readonly string[]
  readonly tags: readonly string[]
}

export interface GuideScopeDoc {
  readonly kind: ScopeKind
  readonly base?: string
  readonly head?: string
  readonly diffDigest?: string
}

export interface GuideFinishDefaults {
  readonly hooks?: boolean
  readonly sign?: boolean
}

export interface GuideDefaultsDoc {
  readonly mergeStrategy: MergeStrategy
  readonly maxLinesPerStep?: number
  readonly finish?: GuideFinishDefaults
}

export interface GuideFileOverrideDoc {
  readonly significance?: Significance
  readonly rationale?: string
}

export interface GuideGeneratorDoc {
  readonly name?: string
  readonly version?: string
  readonly model?: string
}

export interface GuideDoc {
  readonly version: 1
  readonly steps: readonly GuideStepDoc[]
  readonly scope?: GuideScopeDoc
  readonly summary?: string
  readonly topic?: string
  readonly cursor?: number
  readonly defaults: GuideDefaultsDoc
  readonly files: Readonly<Record<string, GuideFileOverrideDoc>>
  readonly generator?: GuideGeneratorDoc
  readonly createdAt?: string
}

export type GuideDocErrorCode = 'parse-error' | 'unsupported-version' | 'invalid-document'

export interface GuideDocError {
  readonly code: GuideDocErrorCode
  readonly message: string
  readonly at?: string
}

export interface GuideDocValidation {
  readonly doc: GuideDoc
  readonly diagnostics: readonly GuideDiagnostic[]
}

export const MAX_STEPS = 500
export const STEP_ID_PATTERN = /^[\w.:-]{1,64}$/

const SIGNIFICANCES: readonly Significance[] = ['critical', 'high', 'normal', 'low', 'skip']
const GROUPINGS: readonly Grouping[] = ['atomic', 'split', 'mergeWithNext']
const SCOPE_KINDS: readonly ScopeKind[] = ['workingTree', 'commit', 'range']

const TOP_LEVEL_KEYS: readonly string[] = [
  '$schema',
  'version',
  'steps',
  'scope',
  'summary',
  'topic',
  'cursor',
  'defaults',
  'files',
  'generator',
  'createdAt',
]
const STEP_KEYS: readonly string[] = [
  'id',
  'path',
  'rationale',
  'order',
  'ranges',
  'significance',
  'grouping',
  'title',
  'notes',
  'dependsOn',
  'tags',
]
const RANGE_KEYS: readonly string[] = ['start', 'end', 'side']
const SCOPE_KEYS: readonly string[] = ['kind', 'base', 'head', 'diffDigest']
const DEFAULTS_KEYS: readonly string[] = ['mergeStrategy', 'maxLinesPerStep', 'finish']
const FINISH_KEYS: readonly string[] = ['hooks', 'sign']
const FILE_OVERRIDE_KEYS: readonly string[] = ['significance', 'rationale']
const GENERATOR_KEYS: readonly string[] = ['name', 'version', 'model']

/**
 * Everything this reader recognises, in one place, so the published JSON Schema
 * can be diffed against it instead of reviewed against it (guide-schema.md §4).
 * Anything outside these sets is an `unknown-field` diagnostic, not an error.
 */
export const KNOWN_FIELDS = {
  $: TOP_LEVEL_KEYS,
  step: STEP_KEYS,
  range: RANGE_KEYS,
  scope: SCOPE_KEYS,
  defaults: DEFAULTS_KEYS,
  finish: FINISH_KEYS,
  fileOverride: FILE_OVERRIDE_KEYS,
  generator: GENERATOR_KEYS,
} as const

/** The values each closed enum accepts, likewise for schema comparison. */
export const ENUM_VALUES = {
  significance: SIGNIFICANCES,
  grouping: GROUPINGS,
  scopeKind: SCOPE_KINDS,
  side: ['new', 'old'],
  mergeStrategy: ['merge', 'replace'],
} as const satisfies Readonly<Record<string, readonly string[]>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

class Collector {
  readonly errors: GuideDocError[] = []
  readonly diagnostics: GuideDiagnostic[] = []

  fail(code: GuideDocErrorCode, message: string, at?: string): void {
    this.errors.push(at === undefined ? { code, message } : { code, message, at })
  }

  unknownFields(value: Record<string, unknown>, known: readonly string[], at: string): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.diagnostics.push({
          code: 'unknown-field',
          severity: 'info',
          message: `Ignored unknown field \`${key}\``,
          at: `${at}.${key}`,
        })
      }
    }
  }
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  at: string,
  c: Collector,
): string | undefined {
  const value = source[key]
  if (value === undefined)
    return undefined
  if (typeof value !== 'string') {
    c.fail('invalid-document', `\`${key}\` must be a string`, `${at}.${key}`)
    return undefined
  }
  return value
}

const TOPIC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function readOptionalTopic(source: Record<string, unknown>, c: Collector): string | undefined {
  const value = source.topic
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || !TOPIC_PATTERN.test(value) || value.length > 48) {
    c.fail('invalid-document', '`topic` must be a kebab-case label', 'topic')
    return undefined
  }
  return value
}

function readOptionalCursor(source: Record<string, unknown>, c: Collector): number | undefined {
  const value = source.cursor
  if (value === undefined)
    return undefined
  if (!isInteger(value) || value < -1 || value > MAX_STEPS - 1) {
    c.fail('invalid-document', '`cursor` must be an integer from -1 to 499', 'cursor')
    return undefined
  }
  return value
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  at: string,
  c: Collector,
): T | undefined {
  const value = source[key]
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    c.fail(
      'invalid-document',
      `\`${key}\` must be one of ${allowed.map(item => `"${item}"`).join(', ')}`,
      `${at}.${key}`,
    )
    return undefined
  }
  return value as T
}

function readStringArray(
  source: Record<string, unknown>,
  key: string,
  at: string,
  c: Collector,
): string[] {
  const value = source[key]
  if (value === undefined)
    return []
  if (!Array.isArray(value)) {
    c.fail('invalid-document', `\`${key}\` must be an array of strings`, `${at}.${key}`)
    return []
  }
  const out: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i]
    if (typeof item !== 'string') {
      c.fail('invalid-document', `\`${key}[${i}]\` must be a string`, `${at}.${key}[${i}]`)
      continue
    }
    out.push(item)
  }
  return out
}

function validateRange(input: unknown, at: string, c: Collector): GuideRangeDoc | null {
  if (!isRecord(input)) {
    c.fail('invalid-document', 'A range must be an object', at)
    return null
  }
  c.unknownFields(input, RANGE_KEYS, at)
  const start = input.start
  if (!isInteger(start) || start < 1) {
    c.fail('invalid-document', '`start` must be an integer ≥ 1', `${at}.start`)
    return null
  }
  let end = start
  if (input.end !== undefined) {
    if (!isInteger(input.end)) {
      c.fail('invalid-document', '`end` must be an integer', `${at}.end`)
      return null
    }
    end = input.end
  }
  if (end < start) {
    c.fail('invalid-document', '`end` must be ≥ `start`', `${at}.end`)
    return null
  }
  const side = readEnum(input, 'side', ['new', 'old'] as const, at, c) ?? 'new'
  return { start, end, side }
}

function validateStep(
  input: unknown,
  index: number,
  seen: Set<string>,
  c: Collector,
): GuideStepDoc | null {
  const at = `steps[${index}]`
  if (!isRecord(input)) {
    c.fail('invalid-document', 'A step must be an object', at)
    return null
  }
  c.unknownFields(input, STEP_KEYS, at)

  const id = input.id
  if (typeof id !== 'string' || !STEP_ID_PATTERN.test(id)) {
    c.fail('invalid-document', '`id` must match ^[A-Za-z0-9._:-]{1,64}$', `${at}.id`)
    return null
  }
  if (seen.has(id)) {
    c.fail('invalid-document', `Duplicate step id \`${id}\``, `${at}.id`)
    return null
  }
  seen.add(id)

  const path = input.path
  if (typeof path !== 'string' || path.length === 0) {
    c.fail('invalid-document', '`path` must be a non-empty string', `${at}.path`)
    return null
  }

  const rationale = input.rationale
  if (typeof rationale !== 'string' || rationale.length === 0) {
    c.fail('invalid-document', '`rationale` must be a non-empty string', `${at}.rationale`)
    return null
  }

  let order = index * 10
  if (input.order !== undefined) {
    if (!isInteger(input.order)) {
      c.fail('invalid-document', '`order` must be an integer', `${at}.order`)
      return null
    }
    order = input.order
  }

  let ranges: GuideRangeDoc[] | undefined
  if (input.ranges !== undefined) {
    if (!Array.isArray(input.ranges)) {
      c.fail('invalid-document', '`ranges` must be an array', `${at}.ranges`)
      return null
    }
    ranges = []
    for (let i = 0; i < input.ranges.length; i++) {
      const range = validateRange(input.ranges[i], `${at}.ranges[${i}]`, c)
      if (range === null)
        return null
      ranges.push(range)
    }
  }

  const significance = readEnum(input, 'significance', SIGNIFICANCES, at, c) ?? 'normal'
  const grouping = readEnum(input, 'grouping', GROUPINGS, at, c) ?? 'atomic'
  const title = readOptionalString(input, 'title', at, c)
  const notes = readOptionalString(input, 'notes', at, c)
  const dependsOn = readStringArray(input, 'dependsOn', at, c)
  const tags = readStringArray(input, 'tags', at, c)

  return {
    id,
    path,
    rationale,
    order,
    ...(ranges === undefined ? {} : { ranges }),
    significance,
    grouping,
    ...(title === undefined ? {} : { title }),
    ...(notes === undefined ? {} : { notes }),
    dependsOn,
    tags,
  }
}

function validateScope(input: unknown, c: Collector): GuideScopeDoc | undefined {
  if (input === undefined)
    return undefined
  if (!isRecord(input)) {
    c.fail('invalid-document', '`scope` must be an object', 'scope')
    return undefined
  }
  c.unknownFields(input, SCOPE_KEYS, 'scope')
  const kind = readEnum(input, 'kind', SCOPE_KINDS, 'scope', c)
  if (kind === undefined) {
    if (input.kind === undefined)
      c.fail('invalid-document', '`scope.kind` is required', 'scope.kind')
    return undefined
  }
  const base = readOptionalString(input, 'base', 'scope', c)
  const head = readOptionalString(input, 'head', 'scope', c)
  const diffDigest = readOptionalString(input, 'diffDigest', 'scope', c)
  return {
    kind,
    ...(base === undefined ? {} : { base }),
    ...(head === undefined ? {} : { head }),
    ...(diffDigest === undefined ? {} : { diffDigest }),
  }
}

function validateFinish(input: unknown, c: Collector): GuideFinishDefaults | undefined {
  if (input === undefined)
    return undefined
  if (!isRecord(input)) {
    c.fail('invalid-document', '`defaults.finish` must be an object', 'defaults.finish')
    return undefined
  }
  c.unknownFields(input, FINISH_KEYS, 'defaults.finish')
  const hooks = readOptionalBoolean(input, 'hooks', 'defaults.finish', c)
  const sign = readOptionalBoolean(input, 'sign', 'defaults.finish', c)
  if (hooks === undefined && sign === undefined)
    return {}
  return {
    ...(hooks === undefined ? {} : { hooks }),
    ...(sign === undefined ? {} : { sign }),
  }
}

function readOptionalBoolean(
  source: Record<string, unknown>,
  key: string,
  at: string,
  c: Collector,
): boolean | undefined {
  const value = source[key]
  if (value === undefined)
    return undefined
  if (typeof value !== 'boolean') {
    c.fail('invalid-document', `\`${key}\` must be a boolean`, `${at}.${key}`)
    return undefined
  }
  return value
}

function validateDefaults(input: unknown, c: Collector): GuideDefaultsDoc {
  if (input === undefined)
    return { mergeStrategy: 'merge' }
  if (!isRecord(input)) {
    c.fail('invalid-document', '`defaults` must be an object', 'defaults')
    return { mergeStrategy: 'merge' }
  }
  c.unknownFields(input, DEFAULTS_KEYS, 'defaults')
  const mergeStrategy = readEnum(input, 'mergeStrategy', ['merge', 'replace'] as const, 'defaults', c) ?? 'merge'
  let maxLinesPerStep: number | undefined
  if (input.maxLinesPerStep !== undefined) {
    if (!isInteger(input.maxLinesPerStep) || input.maxLinesPerStep < 1 || input.maxLinesPerStep > 500)
      c.fail('invalid-document', '`maxLinesPerStep` must be an integer 1–500', 'defaults.maxLinesPerStep')
    else
      maxLinesPerStep = input.maxLinesPerStep
  }
  const finish = validateFinish(input.finish, c)
  return {
    mergeStrategy,
    ...(maxLinesPerStep === undefined ? {} : { maxLinesPerStep }),
    ...(finish === undefined ? {} : { finish }),
  }
}

function validateFiles(input: unknown, c: Collector): Record<string, GuideFileOverrideDoc> {
  const out: Record<string, GuideFileOverrideDoc> = {}
  if (input === undefined)
    return out
  if (!isRecord(input)) {
    c.fail('invalid-document', '`files` must be an object', 'files')
    return out
  }
  for (const [key, value] of Object.entries(input)) {
    const at = `files[${JSON.stringify(key)}]`
    if (!isRecord(value)) {
      c.fail('invalid-document', 'A file override must be an object', at)
      continue
    }
    c.unknownFields(value, FILE_OVERRIDE_KEYS, at)
    const significance = readEnum(value, 'significance', SIGNIFICANCES, at, c)
    const rationale = readOptionalString(value, 'rationale', at, c)
    out[key] = {
      ...(significance === undefined ? {} : { significance }),
      ...(rationale === undefined ? {} : { rationale }),
    }
  }
  return out
}

function validateGenerator(input: unknown, c: Collector): GuideGeneratorDoc | undefined {
  if (input === undefined)
    return undefined
  if (!isRecord(input)) {
    c.fail('invalid-document', '`generator` must be an object', 'generator')
    return undefined
  }
  c.unknownFields(input, GENERATOR_KEYS, 'generator')
  const name = readOptionalString(input, 'name', 'generator', c)
  const version = readOptionalString(input, 'version', 'generator', c)
  const model = readOptionalString(input, 'model', 'generator', c)
  return {
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    ...(model === undefined ? {} : { model }),
  }
}

/**
 * Total, hand-rolled validator for `.guide.json` v1. Never throws; a rejected
 * document always degrades to the heuristic guide (guide-schema.md §5.4).
 */
export function validateGuideDoc(input: unknown): Result<GuideDocValidation, GuideDocError[]> {
  const c = new Collector()

  if (!isRecord(input))
    return err([{ code: 'parse-error', message: 'The guide document root must be a JSON object' }])

  c.unknownFields(input, TOP_LEVEL_KEYS, '$')

  if (input.version !== 1) {
    return err([{
      code: 'unsupported-version',
      message: `Unsupported guide version ${JSON.stringify(input.version ?? null)}; expected 1`,
      at: 'version',
    }])
  }

  if (!Array.isArray(input.steps))
    return err([{ code: 'invalid-document', message: '`steps` must be an array', at: 'steps' }])

  const rawSteps: readonly unknown[] = input.steps
  const kept = rawSteps.slice(0, MAX_STEPS)
  if (rawSteps.length > MAX_STEPS) {
    c.diagnostics.push({
      code: 'too-many-steps',
      severity: 'warning',
      message: `Guide has ${rawSteps.length} steps; only the first ${MAX_STEPS} are used`,
      at: 'steps',
    })
  }

  const seen = new Set<string>()
  const steps: GuideStepDoc[] = []
  for (let i = 0; i < kept.length; i++) {
    const step = validateStep(kept[i], i, seen, c)
    if (step !== null)
      steps.push(step)
  }

  const scope = validateScope(input.scope, c)
  const defaults = validateDefaults(input.defaults, c)
  const files = validateFiles(input.files, c)
  const generator = validateGenerator(input.generator, c)
  const summary = readOptionalString(input, 'summary', '$', c)
  const topic = readOptionalTopic(input, c)
  const cursor = readOptionalCursor(input, c)
  const createdAt = readOptionalString(input, 'createdAt', '$', c)

  if (c.errors.length > 0)
    return err(c.errors)

  return ok({
    doc: {
      version: 1,
      steps,
      ...(scope === undefined ? {} : { scope }),
      ...(summary === undefined ? {} : { summary }),
      ...(topic === undefined ? {} : { topic }),
      ...(cursor === undefined ? {} : { cursor }),
      defaults,
      files,
      ...(generator === undefined ? {} : { generator }),
      ...(createdAt === undefined ? {} : { createdAt }),
    },
    diagnostics: c.diagnostics,
  })
}

const INDEX_LINE = /^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}(?: \d+)?$/

/**
 * guide-schema.md §7 normalization: drop `index` lines, CRLF → LF, exactly one
 * trailing newline. Idempotent, so passing an already-normalized patch is safe.
 */
export function normalizePatchForDigest(patch: string): string {
  const lf = patch.replace(/\r\n/g, '\n')
  const kept = lf.split('\n').filter(line => !INDEX_LINE.test(line))
  const body = kept.join('\n').replace(/\n+$/, '')
  return body === '' ? '' : `${body}\n`
}

/** `sha256:<hex>` over the normalized patch. */
export function computeDiffDigest(patch: string): string {
  return `sha256:${sha256Utf8(normalizePatchForDigest(patch))}`
}
