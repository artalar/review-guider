import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rewriteSequenceTodo, runSequenceEditor, shaMatches } from '../../src/sequence-editor'

const HELPER = fileURLToPath(new URL('../helpers/sequence-editor.cjs', import.meta.url))
const DIST_EDITOR = fileURLToPath(new URL('../../dist/sequence-editor.cjs', import.meta.url))

describe('rewriteSequenceTodo', () => {
  it('rewrites a full pick verb for the reviewed SHA', () => {
    const after = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const input = [
      `pick ${after} first`,
      'pick bbbbbbb second',
      '',
    ].join('\n')
    expect(rewriteSequenceTodo(input, after)).toBe([
      `edit ${after} first`,
      'pick bbbbbbb second',
      '',
    ].join('\n'))
  })

  it('rewrites an abbreviated pick verb', () => {
    const after = 'abcdef1234567890abcdef1234567890abcdef12'
    expect(rewriteSequenceTodo('p abcdef1 subject\n', after)).toBe('edit abcdef1 subject\n')
  })

  it('matches a todo abbreviation against a full after SHA', () => {
    expect(shaMatches('abc1234', 'abc1234ffffffffffffffffffffffff')).toBe(true)
    expect(shaMatches('abc1234ffffffffffffffffffffffff', 'abc1234')).toBe(true)
    expect(shaMatches('deadbee', 'abc1234ffffffffffffffffffffffff')).toBe(false)
  })

  it('keeps rebase.instructionFormat noise after the subject', () => {
    const after = '0123456789abcdef0123456789abcdef01234567'
    const line = `pick ${after.slice(0, 7)} subject [Ada] <ada@test>`
    expect(rewriteSequenceTodo(`${line}\n`, after)).toBe(`edit ${after.slice(0, 7)} subject [Ada] <ada@test>\n`)
  })

  it('leaves comments, blanks, and other verbs alone', () => {
    const after = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const input = [
      '# pick aaaaaaa commented',
      '',
      'reword bbbbbbb other',
      `pick ${after} target`,
      'squash ccccccc later',
    ].join('\n')
    expect(rewriteSequenceTodo(input, after)).toBe([
      '# pick aaaaaaa commented',
      '',
      'reword bbbbbbb other',
      `edit ${after} target`,
      'squash ccccccc later',
    ].join('\n'))
  })

  it('exits 0 on --check without a todo file', () => {
    expect(runSequenceEditor(['node', 'sequence-editor', '--check'])).toBe(0)
  })
})

describe('sequence-editor helper bin', () => {
  it('rewrites a todo file the same way as the TypeScript rewrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tabthrough-seq-'))
    const todo = join(dir, 'todo')
    const after = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const input = `pick ${after} one\np bbbbbbb two\n`
    await writeFile(todo, input)
    const spawned = spawnSync(process.execPath, [HELPER, after, todo], { encoding: 'utf8' })
    expect(spawned.status).toBe(0)
    expect(await readFile(todo, 'utf8')).toBe(rewriteSequenceTodo(input, after))
  })

  it('probes --check', () => {
    const spawned = spawnSync(process.execPath, [HELPER, '--check'], { encoding: 'utf8' })
    expect(spawned.status).toBe(0)
  })

  it('rewrites a todo file when spawned as dist/sequence-editor.cjs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tabthrough-seq-dist-'))
    const todo = join(dir, 'todo')
    const after = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const input = `pick ${after} one\np bbbbbbb two\n`
    await writeFile(todo, input)
    const spawned = spawnSync(process.execPath, [DIST_EDITOR, after, todo], { encoding: 'utf8' })
    expect(spawned.status).toBe(0)
    expect(await readFile(todo, 'utf8')).toBe(rewriteSequenceTodo(input, after))
  })
})
