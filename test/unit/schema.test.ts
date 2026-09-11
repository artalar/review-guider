import { describe, expect, it } from 'vitest'
import { computeDiffDigest, normalizePatchForDigest, validateGuideDoc } from '../../src/guide/schema'
import { sha256Utf8 } from '../../src/guide/sha256'
import { isSafeRepoPath, loadSidecar, normalizeRepoPath, resolveGuideFile } from '../../src/guide/sidecar'
import { readDiffFixture, readGuideFixture, readGuideFixtureText } from '../helpers/fixtures'

function expectOk(input: unknown) {
  const result = validateGuideDoc(input)
  if (!result.ok)
    throw new Error(`expected a valid document, got ${JSON.stringify(result.error)}`)
  return result.value
}

function expectErrorCode(input: unknown, code: string): void {
  const result = validateGuideDoc(input)
  expect(result.ok).toBe(false)
  if (!result.ok)
    expect(result.error.map(problem => problem.code)).toContain(code)
}

describe('validateGuideDoc — accepting', () => {
  it('accepts the minimal document from the schema doc', () => {
    const { doc } = expectOk({
      version: 1,
      steps: [
        { id: 'a', path: 'src/types.ts', rationale: 'Types before callers' },
        { id: 'b', path: 'src/service.ts', rationale: 'The first consumer of those types' },
      ],
    })
    expect(doc.steps).toHaveLength(2)
  })

  it('fills every documented default', () => {
    const { doc } = expectOk({
      version: 1,
      steps: [{ id: 'a', path: 'src/types.ts', rationale: 'Types before callers' }],
    })
    expect(doc.defaults).toEqual({ mergeStrategy: 'merge' })
    expect(doc.defaults.finish).toBeUndefined()
    expect(doc.files).toEqual({})
    expect(doc.steps[0]).toMatchObject({
      order: 0,
      significance: 'normal',
      grouping: 'atomic',
      dependsOn: [],
      tags: [],
    })
    expect(doc.steps[0].ranges).toBeUndefined()
  })

  it('defaults `order` to the document index times ten', () => {
    const { doc } = expectOk({
      version: 1,
      steps: [
        { id: 'a', path: 'a.ts', rationale: 'first' },
        { id: 'b', path: 'b.ts', rationale: 'second' },
        { id: 'c', path: 'c.ts', rationale: 'third', order: 5 },
      ],
    })
    expect(doc.steps.map(step => step.order)).toEqual([0, 10, 5])
  })

  it('defaults a range `end` to its `start` and its `side` to new', () => {
    const { doc } = expectOk({
      version: 1,
      steps: [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: [{ start: 7 }] }],
    })
    expect(doc.steps[0].ranges).toEqual([{ start: 7, end: 7, side: 'new' }])
  })

  it('parses optional defaults.finish', () => {
    const { doc } = expectOk({
      version: 1,
      defaults: { finish: { hooks: true, sign: false } },
      steps: [{ id: 'a', path: 'a.ts', rationale: 'r' }],
    })
    expect(doc.defaults.finish).toEqual({ hooks: true, sign: false })
  })

  it('rejects a non-boolean defaults.finish field', () => {
    expectErrorCode({
      version: 1,
      defaults: { finish: { hooks: 'yes' } },
      steps: [{ id: 'a', path: 'a.ts', rationale: 'r' }],
    }, 'invalid-document')
  })

  it('accepts the full example fixture', () => {
    const { doc } = expectOk(readGuideFixture('valid.guide.json'))
    expect(doc.steps.map(step => step.id)).toEqual(['service-resume', 'component', 'types-session'])
    expect(doc.files['pnpm-lock.yaml']).toEqual({
      significance: 'skip',
      rationale: 'Lockfile churn from the same install',
    })
  })

  it('ignores unknown fields and says so once each', () => {
    const { doc, diagnostics } = expectOk(readGuideFixture('forward-compatible.guide.json'))
    expect(doc.steps).toHaveLength(1)
    expect(diagnostics.every(diagnostic => diagnostic.code === 'unknown-field')).toBe(true)
    expect(diagnostics.map(diagnostic => diagnostic.at).sort()).toEqual([
      '$.audience',
      '$.checks',
      'steps[0].symbol',
    ])
  })

  it('warns and truncates past 500 steps', () => {
    const steps = Array.from({ length: 502 }, (_, i) => ({
      id: `s${i}`,
      path: 'a.ts',
      rationale: 'r',
    }))
    const { doc, diagnostics } = expectOk({ version: 1, steps })
    expect(doc.steps).toHaveLength(500)
    expect(diagnostics.map(diagnostic => diagnostic.code)).toContain('too-many-steps')
  })
})

describe('validateGuideDoc — rejecting', () => {
  it.each([
    ['a non-object root', 'not an object', 'parse-error'],
    ['null', null, 'parse-error'],
    ['an array root', [], 'parse-error'],
    ['a missing version', { steps: [] }, 'unsupported-version'],
    ['a future version', { version: 2, steps: [] }, 'unsupported-version'],
    ['a string version', { version: '1', steps: [] }, 'unsupported-version'],
    ['steps that are not an array', { version: 1, steps: {} }, 'invalid-document'],
  ])('rejects %s', (_name, input, code) => {
    expectErrorCode(input, code)
  })

  it.each([
    ['a step that is not an object', ['nope']],
    ['a missing id', [{ path: 'a.ts', rationale: 'r' }]],
    ['an id that breaks the pattern', [{ id: 'has space', path: 'a.ts', rationale: 'r' }]],
    ['a duplicate id', [
      { id: 'a', path: 'a.ts', rationale: 'r' },
      { id: 'a', path: 'b.ts', rationale: 'r' },
    ]],
    ['a missing path', [{ id: 'a', rationale: 'r' }]],
    ['a missing rationale', [{ id: 'a', path: 'a.ts' }]],
    ['an empty rationale', [{ id: 'a', path: 'a.ts', rationale: '' }]],
    ['a non-integer order', [{ id: 'a', path: 'a.ts', rationale: 'r', order: 1.5 }]],
    ['ranges that are not an array', [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: {} }]],
    ['a range starting at zero', [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: [{ start: 0 }] }]],
    ['a range ending before it starts', [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: [{ start: 5, end: 2 }] }]],
    ['a non-integer range', [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: [{ start: 1.5 }] }]],
    ['an unknown significance', [{ id: 'a', path: 'a.ts', rationale: 'r', significance: 'urgent' }]],
    ['an unknown grouping', [{ id: 'a', path: 'a.ts', rationale: 'r', grouping: 'sometimes' }]],
  ])('rejects %s as invalid-document', (_name, steps) => {
    expectErrorCode({ version: 1, steps }, 'invalid-document')
  })

  it('rejects the invalid fixture and names the offending location', () => {
    const result = validateGuideDoc(readGuideFixture('invalid.guide.json'))
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error[0].at).toBe('steps[1].id')
  })

  it('rejects the unsupported-version fixture wholesale', () => {
    expectErrorCode(readGuideFixture('unsupported-version.guide.json'), 'unsupported-version')
  })
})

describe('validateGuideDoc — totality', () => {
  const adversarial: readonly unknown[] = [
    undefined,
    Number.NaN,
    { version: 1, steps: [null] },
    { version: 1, steps: [{ id: 'a', path: 'a.ts', rationale: 'r', dependsOn: [1] }] },
    { version: 1, steps: [], defaults: 'merge' },
    { version: 1, steps: [], files: { 'a.ts': 'skip' } },
    { version: 1, steps: [], scope: { kind: 'nope' } },
    { version: 1, steps: [], generator: [] },
    { version: 1, steps: [{ id: 'a', path: 'a.ts', rationale: 'r', ranges: [{ start: 1, side: 'sideways' }] }] },
  ]

  it.each(adversarial.map((input, i) => [i, input]))('never throws on adversarial input %i', (_i, input) => {
    expect(() => validateGuideDoc(input)).not.toThrow()
  })
})

describe('computeDiffDigest', () => {
  const patch = readDiffFixture('foundation-order.diff')

  it('hashes with a real SHA-256, including multi-byte and astral input', () => {
    expect(sha256Utf8('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Utf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Utf8('café')).toBe('850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e')
    expect(sha256Utf8('日本語 🎉')).toBe('565f98c5ac0940bbc49b03a3415c5d91936e53e2d01b4d0209eae08658d6f8c9')
    expect(sha256Utf8('x'.repeat(1000))).toHaveLength(64)
  })

  it('produces the documented shape', () => {
    expect(computeDiffDigest(patch)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('ignores abbreviated object ids, which vary by repository', () => {
    const rewritten = patch.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, 'index deadbee..f00dcaf')
    expect(computeDiffDigest(rewritten)).toBe(computeDiffDigest(patch))
  })

  it('ignores CRLF and trailing-newline differences', () => {
    expect(computeDiffDigest(patch.replace(/\n/g, '\r\n'))).toBe(computeDiffDigest(patch))
    expect(computeDiffDigest(`${patch}\n\n`)).toBe(computeDiffDigest(patch))
  })

  it('changes when the content changes', () => {
    expect(computeDiffDigest(patch.replace('interface User', 'interface Person')))
      .not
      .toBe(computeDiffDigest(patch))
  })

  it('normalizes idempotently', () => {
    const once = normalizePatchForDigest(patch)
    expect(normalizePatchForDigest(once)).toBe(once)
    expect(normalizePatchForDigest('')).toBe('')
  })
})

describe('sidecar loading', () => {
  it('reports nothing when there is no sidecar', () => {
    expect(loadSidecar(null)).toEqual({ doc: null, diagnostics: [] })
  })

  it('falls back with exactly one warning when the JSON is broken', () => {
    const load = loadSidecar({ path: '.guide.json', text: '{ "version": 1, ' })
    expect(load.doc).toBeNull()
    expect(load.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toHaveLength(1)
    expect(load.diagnostics[0].code).toBe('parse-error')
  })

  it('falls back with exactly one warning when the document is invalid', () => {
    const load = loadSidecar({ path: '.guide.json', text: readGuideFixtureText('invalid.guide.json') })
    expect(load.doc).toBeNull()
    expect(load.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toHaveLength(1)
    expect(load.diagnostics[0].code).toBe('invalid-document')
    expect(load.diagnostics[0].message).toContain('steps[1].id')
  })

  it('falls back with exactly one warning on an unsupported version', () => {
    const load = loadSidecar({
      path: '.guide.json',
      text: readGuideFixtureText('unsupported-version.guide.json'),
    })
    expect(load.doc).toBeNull()
    expect(load.diagnostics).toHaveLength(1)
    expect(load.diagnostics[0].code).toBe('unsupported-version')
  })

  it('loads a valid sidecar with no warnings', () => {
    const load = loadSidecar({ path: '.guide.json', text: readGuideFixtureText('valid.guide.json') })
    expect(load.doc?.steps).toHaveLength(3)
    expect(load.diagnostics.filter(diagnostic => diagnostic.severity === 'warning')).toHaveLength(0)
  })

  it('surfaces defaults.finish from a valid sidecar', () => {
    const load = loadSidecar({
      path: '.tabthrough-guide.json',
      text: JSON.stringify({
        version: 1,
        defaults: { finish: { hooks: true } },
        steps: [{ id: 'a', path: 'a.ts', rationale: 'r' }],
      }),
    })
    expect(load.finish).toEqual({ hooks: true })
    expect(load.doc?.defaults.finish).toEqual({ hooks: true })
  })

  it('resolves the guide file from the setting, falling back to .tabthrough-guide.json', () => {
    expect(resolveGuideFile(undefined)).toBe('.tabthrough-guide.json')
    expect(resolveGuideFile('  ')).toBe('.tabthrough-guide.json')
    expect(resolveGuideFile('./docs/review.json')).toBe('docs/review.json')
  })

  it('treats a path that escapes the repo as unsafe', () => {
    expect(isSafeRepoPath('src/a.ts')).toBe(true)
    expect(isSafeRepoPath('')).toBe(false)
    expect(isSafeRepoPath('/etc/passwd')).toBe(false)
    expect(isSafeRepoPath('C:/Windows/system32')).toBe(false)
    expect(isSafeRepoPath('../outside.ts')).toBe(false)
    expect(isSafeRepoPath('src/../../outside.ts')).toBe(false)
    expect(isSafeRepoPath('..\\outside.ts')).toBe(false)
  })

  it('normalizes windows separators and redundant slashes', () => {
    expect(normalizeRepoPath('src\\guide\\types.ts')).toBe('src/guide/types.ts')
    expect(normalizeRepoPath('./src//guide.ts')).toBe('src/guide.ts')
  })
})
