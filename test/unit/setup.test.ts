import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workspaceRoot } from '../../src/model/session'
import {
  generateAgentGuide,
  generateSimpleGuide,
  installWorkspaceSkill,
  loadCommits,
  pickRange,
  pickWorkingTree,
  recentCommits,
  selectCommit,
  selectRangeRev,
  setupBack,
  setupPhase,
  submitRange,
} from '../../src/model/setup'
import { bootstrapModel } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

let dispose: (() => void) | null = null

beforeEach(() => context.reset())

afterEach(() => {
  dispose?.()
  dispose = null
})

afterAll(cleanupTempRepos)

describe('setup machine', () => {
  it('walks back from generate through the picker that produced the target', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    pickWorkingTree()
    expect(peek(setupPhase)).toEqual({ kind: 'generate', target: { kind: 'workingTree' } })
    setupBack()
    expect(peek(setupPhase).kind).toBe('targets')
    setupBack()
    expect(peek(setupPhase).kind).toBe('home')

    await pickRange()
    submitRange('main..HEAD')
    expect(peek(setupPhase)).toMatchObject({ kind: 'generate', target: { kind: 'range', from: 'main', to: 'HEAD' } })
    setupBack()
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', from: 'main', to: 'HEAD' })
  })

  it('rejects an empty or hostile commit ref without leaving the picker', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await loadCommits()
    selectCommit('')
    expect(peek(setupPhase)).toMatchObject({ kind: 'commits', error: 'Enter a commit, tag, or ref.' })
    selectCommit('--output=/tmp/x')
    expect(peek(setupPhase)).toMatchObject({ kind: 'commits', error: 'That does not look like a commit, tag, or ref.' })
    selectCommit('HEAD~1')
    expect(peek(setupPhase)).toEqual({ kind: 'generate', target: { kind: 'commit', rev: 'HEAD~1' } })
  })

  it('keeps the range picker open when the input is unusable', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await pickRange()
    submitRange('')
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', error: 'Enter a commit range, for example main..HEAD.' })
    submitRange('not-a-range')
    expect(peek(setupPhase).kind).toBe('range')
  })

  it('orders two clicked commits into start and end', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('a.ts', 'a\n')
    await repo.git('add', 'a.ts')
    const older = await repo.commit('older')
    await repo.write('b.ts', 'b\n')
    await repo.git('add', 'b.ts')
    const newer = await repo.commit('newer')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await pickRange()
    const phase = peek(setupPhase)
    expect(phase.kind).toBe('range')
    expect(phase.kind === 'range' && phase.loading).toBe(false)
    expect(phase.kind === 'range' && phase.commits.length).toBeGreaterThanOrEqual(2)

    selectRangeRev(newer)
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', from: newer, to: null })
    selectRangeRev(older)
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', from: older, to: newer })
    selectRangeRev(older)
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', from: newer, to: null })
  })

  it('reopens the range picker after Back during an in-flight history load', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    const first = pickRange()
    setupBack()
    await pickRange()
    const reopened = peek(setupPhase)
    expect(reopened.kind).toBe('range')
    expect(reopened.kind === 'range' && reopened.loading).toBe(false)
    await first
    expect(peek(setupPhase).kind).toBe('range')
  })

  it('does not treat an aborted history load as a picker error', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    const pending = pickRange()
    recentCommits.abort()
    await pending
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', error: null })
  })

  it('shows an empty history list when git is unavailable', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    workspaceRoot.set(null)
    await pickRange()
    expect(peek(setupPhase)).toMatchObject({ kind: 'range', commits: [], loading: false, error: null })
  })

  it('ignores submitRange and selectRangeRev when not on the range picker', () => {
    submitRange('main..HEAD')
    selectRangeRev('abc')
    expect(peek(setupPhase).kind).toBe('home')
  })

  it('refuses Simple when there is nothing to review', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    pickWorkingTree()
    await generateSimpleGuide()
    expect(harness.writes).toEqual([])
    expect(harness.notifications.some(note => note.message.includes('Nothing to review'))).toBe(true)
  })

  it('writes a working-tree sidecar without a digest and opens it', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('src/app.ts', 'export const n = 1\n')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    pickWorkingTree()
    await generateSimpleGuide()

    expect(harness.openedFiles).toEqual(['.tabthrough-guide.json'])
    const written = harness.writes.find(entry => entry.path === '.tabthrough-guide.json')
    expect(written).toBeDefined()
    const doc = JSON.parse(written?.text ?? '{}') as {
      scope?: { kind?: string, diffDigest?: string }
      steps?: readonly { path: string }[]
    }
    expect(doc.scope?.kind).toBe('workingTree')
    expect(doc.scope?.diffDigest).toBeUndefined()
    expect(doc.steps?.some(step => step.path === 'src/app.ts')).toBe(true)
  })

  it('opens Agent chat with a prompt for the picked target', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('src/app.ts', 'export const n = 1\n')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    pickWorkingTree()
    await generateAgentGuide()
    expect(harness.agentPrompts[0]).toContain('/tabthrough')
    expect(harness.agentPrompts[0]).toContain('.tabthrough-guide.json')
    expect(harness.agentPrompts[0]).toContain('working tree')
  })

  it('does not overwrite an existing skill file', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('.cursor/skills/tabthrough/SKILL.md', 'custom skill\n')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await installWorkspaceSkill()
    expect(await repo.read('.cursor/skills/tabthrough/SKILL.md')).toBe('custom skill\n')
    expect(harness.writes.some(entry => entry.path === '.cursor/skills/tabthrough/SKILL.md')).toBe(false)
    expect(harness.writes.some(entry => entry.path === '.cursor/commands/tabthrough.md')).toBe(true)
  })
})
