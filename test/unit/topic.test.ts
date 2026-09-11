import { describe, expect, it } from 'vitest'
import {
  applyGuideCursor,
  guideFileNameForTopic,
  slugifyTopic,
  topicFromGuideFileName,
  topicFromLabel,
  withGitignorePattern,
} from '../../src/guide/topic'

describe('slugifyTopic', () => {
  it('kebabs a branch or subject into a filename token', () => {
    expect(slugifyTopic('feat/my-feature')).toBe('feat-my-feature')
    expect(slugifyTopic('Add Retry Rule')).toBe('add-retry-rule')
    expect(slugifyTopic('  ')).toBe('review')
  })
})

describe('topicFromLabel', () => {
  it('takes a short slug from a conventional-commit subject', () => {
    expect(topicFromLabel('fix: withCache deliver the cached value instead of')).toBe('withcache-deliver-the-cached')
    expect(topicFromLabel('feat(api): Add Retry Rule for 4xx')).toBe('add-retry-rule-for')
  })
})

describe('guideFileNameForTopic', () => {
  it('builds .tabthrough.{topic}.guide.json', () => {
    expect(guideFileNameForTopic('My Feature')).toBe('.tabthrough.my-feature.guide.json')
    expect(topicFromGuideFileName('.tabthrough.my-feature.guide.json')).toBe('my-feature')
    expect(topicFromGuideFileName('.tabthrough-guide.json')).toBeNull()
  })
})

describe('applyGuideCursor', () => {
  it('sets cursor without rewriting when the value is already stored', () => {
    const text = `${JSON.stringify({ version: 1, steps: [], cursor: 2 }, null, 2)}\n`
    expect(applyGuideCursor(text, 2)).toBeNull()
    const next = applyGuideCursor(text, 3)
    expect(next).toContain('"cursor": 3')
    expect(JSON.parse(next ?? '{}')).toMatchObject({ version: 1, cursor: 3 })
  })

  it('rejects non-JSON', () => {
    expect(applyGuideCursor('not-json', 0)).toBeNull()
  })
})

describe('withGitignorePattern', () => {
  it('appends the pattern once', () => {
    expect(withGitignorePattern(null, '.tabthrough*')).toEqual({
      text: '.tabthrough*\n',
      changed: true,
    })
    expect(withGitignorePattern('dist\n', '.tabthrough*')).toEqual({
      text: 'dist\n.tabthrough*\n',
      changed: true,
    })
    expect(withGitignorePattern('dist\n.tabthrough*\n', '.tabthrough*')).toEqual({
      text: 'dist\n.tabthrough*\n',
      changed: false,
    })
  })
})
