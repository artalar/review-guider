import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENUM_VALUES,
  KNOWN_FIELDS,
  MAX_STEPS,
  STEP_ID_PATTERN,
  validateGuideDoc,
} from '../../src/guide/schema'
import { readGuideFixture } from '../helpers/fixtures'

/**
 * `schema/guide-v1.json` is what an author's editor validates against; the
 * hand-rolled reader in `src/guide/schema.ts` is what decides whether their
 * session works. This suite is the only thing keeping the two honest — a schema
 * that accepted a document the reader rejects would be worse than no schema,
 * because it would promise a guide works and then silently fall back.
 *
 * The one place they differ is deliberate and asserted below: the schema closes
 * `additionalProperties`, the reader ignores unknown fields (guide-schema.md §8).
 */

interface SchemaNode {
  readonly $id?: string
  readonly $schema?: string
  readonly $ref?: string
  readonly $defs?: Readonly<Record<string, SchemaNode>>
  readonly type?: string
  readonly required?: readonly string[]
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly additionalProperties?: boolean | SchemaNode
  readonly enum?: readonly string[]
  readonly const?: unknown
  readonly items?: SchemaNode
  readonly maxItems?: number
  readonly pattern?: string
  readonly minimum?: number
  readonly maximum?: number
}

const REPO = new URL('../../', import.meta.url)
const SCHEMA_PATH = new URL('schema/guide-v1.json', REPO)

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as SchemaNode

function def(name: string): SchemaNode {
  const node = schema.$defs?.[name]
  if (node === undefined)
    throw new Error(`schema/guide-v1.json has no $defs.${name}`)
  return node
}

function prop(node: SchemaNode, name: string): SchemaNode {
  const child = node.properties?.[name]
  if (child === undefined)
    throw new Error(`schema node has no property \`${name}\``)
  return child
}

function keysOf(node: SchemaNode): string[] {
  return Object.keys(node.properties ?? {}).sort()
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

const step = def('step')
const range = def('range')
const fileOverride = typeof prop(schema, 'files').additionalProperties === 'object'
  ? prop(schema, 'files').additionalProperties as SchemaNode
  : (() => { throw new Error('files.additionalProperties must be a schema') })()

/** Minimal document the sync tests mutate one field at a time. */
function minimal(): Record<string, unknown> {
  return {
    version: 1,
    steps: [{ id: 'a', path: 'src/types.ts', rationale: 'Types before callers' }],
  }
}

function accepts(input: unknown): boolean {
  return validateGuideDoc(input).ok
}

describe('the published schema is where it says it is', () => {
  it('carries the frozen $id and declares draft 2020-12', () => {
    expect(schema.$id).toBe('https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json')
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  })

  it('is the URL the fixtures and the agent skill point authors at', () => {
    const fixture = readGuideFixture('valid.guide.json') as { $schema?: string }
    expect(fixture.$schema).toBe(schema.$id)

    const skill = readFileSync(new URL('.agents/skills/tabthrough/SKILL.md', REPO), 'utf8')
    expect(skill).toContain(schema.$id)
    expect(skill).toContain('schema/guide-v1.json')
  })

  it('pins the version rather than merely typing it', () => {
    expect(prop(schema, 'version').const).toBe(1)
    expect(accepts({ ...minimal(), version: 2 })).toBe(false)
  })
})

describe('required fields match the reader', () => {
  it('agrees on the top level', () => {
    expect(sorted(schema.required ?? [])).toEqual(['steps', 'version'])
    for (const field of schema.required ?? []) {
      const doc = minimal()
      delete doc[field]
      expect(accepts(doc), `reader must reject a document with no \`${field}\``).toBe(false)
    }
    expect(accepts(minimal())).toBe(true)
  })

  it('agrees on a step', () => {
    expect(sorted(step.required ?? [])).toEqual(['id', 'path', 'rationale'])
    for (const field of step.required ?? []) {
      const only: Record<string, unknown> = { id: 'a', path: 'src/types.ts', rationale: 'why here' }
      delete only[field]
      expect(accepts({ version: 1, steps: [only] }), `reader must reject a step with no \`${field}\``).toBe(false)
    }
  })

  it('agrees on a range and a scope', () => {
    expect(range.required).toEqual(['start'])
    expect(accepts({
      version: 1,
      steps: [{ id: 'a', path: 'p.ts', rationale: 'why', ranges: [{ end: 4 }] }],
    })).toBe(false)

    expect(prop(schema, 'scope').required).toEqual(['kind'])
    expect(accepts({ ...minimal(), scope: { base: 'HEAD~1' } })).toBe(false)
  })

  it('makes everything else optional, exactly as the reader does', () => {
    expect(accepts({ version: 1, steps: [] })).toBe(true)
  })
})

describe('the known-field sets match the reader', () => {
  it.each([
    ['$', () => keysOf(schema), KNOWN_FIELDS.$],
    ['step', () => keysOf(step), KNOWN_FIELDS.step],
    ['range', () => keysOf(range), KNOWN_FIELDS.range],
    ['scope', () => keysOf(prop(schema, 'scope')), KNOWN_FIELDS.scope],
    ['defaults', () => keysOf(prop(schema, 'defaults')), KNOWN_FIELDS.defaults],
    ['files[*]', () => keysOf(fileOverride), KNOWN_FIELDS.fileOverride],
    ['generator', () => keysOf(prop(schema, 'generator')), KNOWN_FIELDS.generator],
  ])('%s', (_level, declared, known) => {
    expect(declared()).toEqual(sorted(known))
  })

  it('closes additionalProperties everywhere an object is described', () => {
    expect(schema.additionalProperties).toBe(false)
    expect(step.additionalProperties).toBe(false)
    expect(range.additionalProperties).toBe(false)
    expect(prop(schema, 'scope').additionalProperties).toBe(false)
    expect(prop(schema, 'defaults').additionalProperties).toBe(false)
    expect(fileOverride.additionalProperties).toBe(false)
    expect(prop(schema, 'generator').additionalProperties).toBe(false)
  })

  // The documented, intentional divergence: a 1.1 document must still work in a
  // 1.0 reader, so the reader downgrades an unknown field to a diagnostic while
  // the schema flags it for the author who can still fix it.
  it('is stricter than the reader about unknown fields, on purpose', () => {
    const forward = readGuideFixture('forward-compatible.guide.json') as Record<string, unknown>
    const result = validateGuideDoc(forward)

    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.value.diagnostics.map(entry => entry.code)).toContain('unknown-field')
    expect(result.value.diagnostics.every(entry => entry.severity === 'info')).toBe(true)

    // Every one of those fields is absent from the schema, which is what makes
    // the author-facing check useful.
    expect(keysOf(schema)).not.toContain('audience')
    expect(keysOf(step)).not.toContain('symbol')
  })
})

describe('the enums match the reader', () => {
  it.each([
    ['step.significance', () => prop(step, 'significance').enum, ENUM_VALUES.significance],
    ['step.grouping', () => prop(step, 'grouping').enum, ENUM_VALUES.grouping],
    ['range.side', () => prop(range, 'side').enum, ENUM_VALUES.side],
    ['scope.kind', () => prop(prop(schema, 'scope'), 'kind').enum, ENUM_VALUES.scopeKind],
    ['defaults.mergeStrategy', () => prop(prop(schema, 'defaults'), 'mergeStrategy').enum, ENUM_VALUES.mergeStrategy],
    ['files[*].significance', () => prop(fileOverride, 'significance').enum, ENUM_VALUES.significance],
  ])('%s', (_field, declared, known) => {
    expect(sorted(declared() ?? [])).toEqual(sorted(known))
  })

  it('accepts every declared value and refuses one that is not declared', () => {
    for (const significance of ENUM_VALUES.significance)
      expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'why', significance }] })).toBe(true)
    for (const grouping of ENUM_VALUES.grouping)
      expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'why', grouping }] })).toBe(true)
    for (const kind of ENUM_VALUES.scopeKind)
      expect(accepts({ ...minimal(), scope: { kind } })).toBe(true)
    for (const mergeStrategy of ENUM_VALUES.mergeStrategy)
      expect(accepts({ ...minimal(), defaults: { mergeStrategy } })).toBe(true)

    expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'why', significance: 'urgent' }] })).toBe(false)
    expect(accepts({ ...minimal(), scope: { kind: 'pullRequest' } })).toBe(false)
  })
})

describe('the bounds match the reader', () => {
  it('caps the step list at the same number', () => {
    expect(prop(schema, 'steps').maxItems).toBe(MAX_STEPS)

    const overflowing = {
      version: 1,
      steps: Array.from({ length: MAX_STEPS + 1 }, (_, index) => ({
        id: `s${index}`,
        path: 'p.ts',
        rationale: 'why',
      })),
    }
    const result = validateGuideDoc(overflowing)
    expect(result.ok).toBe(true)
    if (!result.ok)
      return
    expect(result.value.doc.steps).toHaveLength(MAX_STEPS)
    expect(result.value.diagnostics.map(entry => entry.code)).toContain('too-many-steps')
  })

  // The two patterns are written differently — `\w` against an explicit class —
  // so equality is asserted where it matters, on what they accept.
  it('accepts and rejects the same step ids as the reader', () => {
    const pattern = new RegExp(prop(step, 'id').pattern ?? '')
    const samples = ['a', 'A-1', 'types.before.callers', 'ns:step_2', '_leading', '9', 'x'.repeat(64)]
    const rejects = ['', 'has space', 'slash/step', 'é', 'x'.repeat(65), 'plus+sign']

    for (const id of samples) {
      expect(pattern.test(id), `schema pattern must accept ${id}`).toBe(true)
      expect(STEP_ID_PATTERN.test(id), `reader must accept ${id}`).toBe(true)
    }
    for (const id of rejects) {
      expect(pattern.test(id), `schema pattern must reject ${JSON.stringify(id)}`).toBe(false)
      expect(STEP_ID_PATTERN.test(id), `reader must reject ${JSON.stringify(id)}`).toBe(false)
    }
  })

  it('bounds maxLinesPerStep identically', () => {
    const node = prop(prop(schema, 'defaults'), 'maxLinesPerStep')
    expect(node.minimum).toBe(1)
    expect(node.maximum).toBe(500)

    for (const maxLinesPerStep of [node.minimum, node.maximum])
      expect(accepts({ ...minimal(), defaults: { maxLinesPerStep } })).toBe(true)
    for (const maxLinesPerStep of [0, 501, 24.5])
      expect(accepts({ ...minimal(), defaults: { maxLinesPerStep } })).toBe(false)
  })

  it('bounds a range start the same way', () => {
    expect(prop(range, 'start').minimum).toBe(1)
    expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'w', ranges: [{ start: 0 }] }] })).toBe(false)
    expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'w', ranges: [{ start: 3, end: 2 }] }] })).toBe(false)
    expect(accepts({ version: 1, steps: [{ id: 'a', path: 'p.ts', rationale: 'w', ranges: [{ start: 1 }] }] })).toBe(true)
  })
})

describe('every document we publish validates against both', () => {
  /** Walks a document and reports fields the schema does not declare. */
  function undeclared(value: unknown, node: SchemaNode, at: string): string[] {
    const resolved = node.$ref === '#/$defs/step'
      ? step
      : node.$ref === '#/$defs/range' ? range : node

    if (Array.isArray(value)) {
      return resolved.items === undefined
        ? []
        : value.flatMap((item, index) => undeclared(item, resolved.items as SchemaNode, `${at}[${index}]`))
    }
    if (typeof value !== 'object' || value === null)
      return []

    const problems: string[] = []
    for (const [key, child] of Object.entries(value)) {
      const declared = resolved.properties?.[key]
        ?? (typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined)
      if (declared === undefined) {
        problems.push(`${at}.${key}`)
        continue
      }
      problems.push(...undeclared(child, declared, `${at}.${key}`))
    }
    return problems
  }

  it.each([
    'valid.guide.json',
    'replace.guide.json',
    'helper-consumer.guide.json',
    'helper-consumer-merged.guide.json',
  ])('%s', (name) => {
    const doc = readGuideFixture(name)
    expect(accepts(doc)).toBe(true)
    expect(undeclared(doc, schema, '$')).toEqual([])
  })

  it.each([
    ['architecture/guide-schema.md', 'work-docs/architecture/guide-schema.md'],
    ['agent skill', '.agents/skills/tabthrough/SKILL.md'],
    ['agent authoring guide', 'work-docs/guides/agent-guide-authoring.md'],
  ])('the guide documents embedded in %s', (_label, path) => {
    const markdown = readFileSync(new URL(path, REPO), 'utf8').replace(/\r\n/g, '\n')
    const blocks = [...markdown.matchAll(/```json\r?\n([\s\S]*?)```/g)]
      .map(match => match[1] ?? '')
      .map((text): unknown => {
        try {
          return JSON.parse(text)
        }
        catch {
          return null
        }
      })
      .filter((doc): doc is Record<string, unknown> =>
        typeof doc === 'object' && doc !== null && !Array.isArray(doc) && 'version' in doc)

    // A doc that stopped carrying an example is a doc that stopped being checked.
    expect(blocks.length).toBeGreaterThan(0)
    for (const doc of blocks) {
      expect(validateGuideDoc(doc).ok, `${path}: ${JSON.stringify(doc).slice(0, 80)}…`).toBe(true)
      expect(undeclared(doc, schema, '$')).toEqual([])
    }
  })
})
