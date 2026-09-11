import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cancelSession, guideDiagnostics, persistGuideCursor, session, sessionStatus } from '../../src/model/session'
import { generateSimpleGuide, pickWorkingTree } from '../../src/model/setup'
import { bootstrapModel, startReview } from '../helpers/model'
import { cleanupTempRepos, makeTempRepo } from '../helpers/tmp-repo'

let dispose: (() => void) | null = null

beforeEach(() => context.reset())

afterEach(async () => {
  if (peek(sessionStatus) !== 'idle')
    await cancelSession('cancel')
  dispose?.()
  dispose = null
})

afterAll(cleanupTempRepos)

describe('simple working-tree guide', () => {
  it('includes untracked files and starts without a stale-guide warning', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('src/app.ts', 'export const tracked = 1\n')
    await repo.git('add', '-A')
    await repo.commit('baseline')
    await repo.write('src/app.ts', 'export const tracked = 2\n')
    await repo.write('src/extra.ts', 'export const extra = 1\n')

    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await pickWorkingTree()
    await generateSimpleGuide()

    const sidecar = harness.writes.find(entry => entry.path === '.tabthrough.main.guide.json')
    expect(sidecar).toBeDefined()
    const doc = JSON.parse(sidecar?.text ?? '{}') as { scope?: { diffDigest?: string } }
    expect(doc.scope?.diffDigest).toBeUndefined()

    await startReview(harness, {
      entry: { kind: 'workingTree' },
      guideFile: '.tabthrough.main.guide.json',
      sidecar: { path: '.tabthrough.main.guide.json', text: sidecar?.text ?? '' },
    })

    expect(peek(guideDiagnostics).some(item => item.code === 'stale-guide')).toBe(false)
    expect(peek(session)?.guide.steps.some(step => step.path === 'src/extra.ts')).toBe(true)
    expect(peek(session)?.diff.files.some(file => file.path === 'src/extra.ts')).toBe(true)
  })

  it('restores and persists the walk cursor on the topic sidecar', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('src/app.ts', 'export const n = 1\n')
    await repo.git('add', '-A')
    await repo.commit('baseline')
    await repo.write('src/app.ts', 'export const n = 2\n')
    await repo.write('src/other.ts', 'export const o = 1\n')

    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await pickWorkingTree()
    await generateSimpleGuide()
    const sidecar = harness.writes.find(entry => entry.path === '.tabthrough.main.guide.json')
    expect(sidecar).toBeDefined()

    await startReview(harness, {
      entry: { kind: 'workingTree' },
      guideFile: '.tabthrough.main.guide.json',
      sidecar: { path: '.tabthrough.main.guide.json', text: sidecar?.text ?? '' },
      cursor: 1,
    })
    expect(peek(session)?.cursor()).toBe(1)
    expect(peek(session)?.guideFile).toBe('.tabthrough.main.guide.json')

    await persistGuideCursor('.tabthrough.main.guide.json', 1)
    const saved = JSON.parse(await repo.read('.tabthrough.main.guide.json')) as { cursor?: number }
    expect(saved.cursor).toBe(1)
  })

  it('does not bind a heuristic start to the default sidecar path', async () => {
    const repo = await makeTempRepo({ files: { 'README.md': '# fixture\n' } })
    await repo.write('src/app.ts', 'export const n = 1\n')
    const harness = await bootstrapModel(repo.root)
    dispose = harness.dispose

    await startReview(harness, { kind: 'workingTree' })
    expect(peek(session)?.guideFile).toBeNull()
  })
})
