import { context, peek } from '@reatom/core'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cancelSession, guideDiagnostics, session, sessionStatus } from '../../src/model/session'
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

    pickWorkingTree()
    await generateSimpleGuide()

    const sidecar = harness.writes.find(entry => entry.path === '.tabthrough-guide.json')
    expect(sidecar).toBeDefined()
    const doc = JSON.parse(sidecar?.text ?? '{}') as { scope?: { diffDigest?: string } }
    expect(doc.scope?.diffDigest).toBeUndefined()

    await startReview(harness, {
      entry: { kind: 'workingTree' },
      sidecar: { path: '.tabthrough-guide.json', text: sidecar?.text ?? '' },
    })

    expect(peek(guideDiagnostics).some(item => item.code === 'stale-guide')).toBe(false)
    expect(peek(session)?.guide.steps.some(step => step.path === 'src/extra.ts')).toBe(true)
    expect(peek(session)?.diff.files.some(file => file.path === 'src/extra.ts')).toBe(true)
  })
})
