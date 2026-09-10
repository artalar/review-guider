import { describe, expect, it } from 'vitest'
import { validateGuideDoc } from '../../src/guide/schema'
import { formatGuideJson, serializeGuide } from '../../src/guide/serialize'
import { agentPromptFor } from '../../src/model/setup'

describe('serializeGuide', () => {
  it('emits a valid sidecar with stable step ids', () => {
    const doc = serializeGuide({
      guide: {
        stale: false,
        diagnostics: [],
        steps: [
          {
            id: 'h:src/foo.ts#0:1-4',
            path: 'src/foo.ts',
            groups: [{
              id: 'g1',
              path: 'src/foo.ts',
              hunkIndex: 0,
              kind: 'add',
              newRange: { start: 10, end: 18 },
              oldAnchor: 9,
              newAnchor: 10,
              addedLines: 9,
              deletedLines: 0,
            }],
            kind: 'reveal',
            significance: 'high',
            rationale: 'Types before callers',
            source: 'heuristic',
          },
        ],
      },
      scope: { kind: 'workingTree', base: 'HEAD' },
      sidecarPath: '.tabthrough-guide.json',
    })

    expect(doc.steps[0]?.id).toBe('s10')
    expect(doc.steps[0]?.ranges).toEqual([{ side: 'new', start: 10, end: 18 }])
    expect(doc.files['.tabthrough-guide.json']?.significance).toBe('skip')
    const validated = validateGuideDoc(JSON.parse(formatGuideJson(doc)))
    expect(validated.ok).toBe(true)
  })

  it('omits ranges for a stub step and uses old-side ranges for deletions', () => {
    const doc = serializeGuide({
      guide: {
        stale: false,
        diagnostics: [],
        steps: [
          {
            id: 'stub',
            path: 'src/empty.ts',
            groups: [],
            kind: 'stub',
            significance: 'low',
            rationale: 'Placeholder for a binary or empty change',
            source: 'heuristic',
          },
          {
            id: 'del',
            path: 'src/gone.ts',
            groups: [{
              id: 'g-del',
              path: 'src/gone.ts',
              hunkIndex: 0,
              kind: 'del',
              oldRange: { start: 4, end: 8 },
              oldAnchor: 4,
              newAnchor: 3,
              addedLines: 0,
              deletedLines: 5,
            }],
            kind: 'reveal',
            significance: 'normal',
            rationale: 'What goes away before callers adapt',
            source: 'heuristic',
          },
          {
            id: 'replace',
            path: 'src/swap.ts',
            groups: [{
              id: 'g-rep',
              path: 'src/swap.ts',
              hunkIndex: 0,
              kind: 'replace',
              oldRange: { start: 2, end: 3 },
              newRange: { start: 2, end: 6 },
              oldAnchor: 2,
              newAnchor: 2,
              addedLines: 5,
              deletedLines: 2,
            }],
            kind: 'reveal',
            significance: 'high',
            rationale: 'The replacement that later steps consume',
            source: 'heuristic',
          },
        ],
      },
      scope: { kind: 'commit', base: 'aaa', head: 'bbb' },
      sidecarPath: '.tabthrough-guide.json',
    })

    expect(doc.steps[0]?.ranges).toBeUndefined()
    expect(doc.steps[1]?.ranges).toEqual([{ side: 'old', start: 4, end: 8 }])
    expect(doc.steps[2]?.ranges).toEqual([{ side: 'new', start: 2, end: 6 }])
    expect(validateGuideDoc(JSON.parse(formatGuideJson(doc))).ok).toBe(true)
  })

  it('clips a rationale to 120 characters', () => {
    const long = 'x'.repeat(121)
    const doc = serializeGuide({
      guide: {
        stale: false,
        diagnostics: [],
        steps: [{
          id: 'long',
          path: 'src/a.ts',
          groups: [],
          kind: 'stub',
          significance: 'normal',
          rationale: long,
          source: 'heuristic',
        }],
      },
      scope: { kind: 'workingTree', base: 'HEAD' },
      sidecarPath: '.tabthrough-guide.json',
    })
    expect(doc.steps[0]?.rationale.length).toBe(120)
    expect(doc.steps[0]?.rationale.endsWith('…')).toBe(true)
  })
})

describe('agentPromptFor', () => {
  it('asks a working-tree walk to include untracked files and skip the digest', () => {
    const prompt = agentPromptFor(
      { kind: 'workingTree' },
      '.tabthrough-guide.json',
      'HEAD',
      null,
    )
    expect(prompt).toContain('git status --porcelain=v1 --untracked-files=all')
    expect(prompt).toContain('Omit scope.diffDigest')
    expect(prompt).toContain('Include untracked files')
  })

  it('asks for /tabthrough and the sidecar path', () => {
    const prompt = agentPromptFor(
      { kind: 'commit', rev: 'abc123' },
      '.tabthrough-guide.json',
      'base',
      'abc123',
    )
    expect(prompt).toContain('/tabthrough')
    expect(prompt).toContain('.tabthrough-guide.json')
    expect(prompt).toContain('abc123')
  })

  it('spells out the words contract and the -U0 anchor recipe', () => {
    const prompt = agentPromptFor(
      { kind: 'range', from: 'main', to: 'HEAD' },
      '.tabthrough-guide.json',
      'base',
      'HEAD',
    )
    expect(prompt).toContain('-U0 base HEAD')
    expect(prompt).toContain('`title` names the thought')
    expect(prompt).toContain('`notes` only for the why that is not in the code')
    expect(prompt).toContain('`summary`')
    expect(prompt).toContain('main .. HEAD')
  })
})
