import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The load-bearing rule, asserted over the source graph rather than trusted to
 * review. Lint enforces the same thing (ADR 0002 D8); this test keeps it true
 * even if the lint config is edited.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g
const BARE_IMPORT_PATTERN = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g

async function collect(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      out.push(...await collect(full))
    else if (entry.name.endsWith('.ts'))
      out.push(full)
  }
  return out
}

async function importsOf(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8')
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_PATTERN))
    specifiers.push(match[1])
  for (const match of source.matchAll(BARE_IMPORT_PATTERN))
    specifiers.push(match[1])
  return specifiers
}

interface Layer {
  readonly dir: string
  readonly forbidden: readonly string[]
}

const LAYERS: readonly Layer[] = [
  { dir: 'guide', forbidden: ['vscode', 'reactive-vscode', '@reatom/core', 'node:'] },
  { dir: 'git', forbidden: ['vscode', 'reactive-vscode', '@reatom/core'] },
  { dir: 'model', forbidden: ['vscode', 'reactive-vscode', 'node:'] },
]

describe('import boundaries', () => {
  for (const layer of LAYERS) {
    it(`src/${layer.dir} imports nothing forbidden`, async () => {
      const files = await collect(join(SRC, layer.dir))
      expect(files.length).toBeGreaterThan(0)

      const violations: string[] = []
      for (const file of files) {
        for (const specifier of await importsOf(file)) {
          const banned = layer.forbidden.find(prefix =>
            specifier === prefix || specifier.startsWith(prefix),
          )
          if (banned !== undefined)
            violations.push(`${relative(SRC, file).split(sep).join('/')} -> ${specifier}`)
        }
      }

      expect(violations).toEqual([])
    })
  }

  it('src/git never reaches up into src/model or src/ui', async () => {
    const files = await collect(join(SRC, 'git'))
    const violations: string[] = []
    for (const file of files) {
      for (const specifier of await importsOf(file)) {
        if (specifier.includes('../model') || specifier.includes('../ui') || specifier.includes('../commands'))
          violations.push(`${relative(SRC, file).split(sep).join('/')} -> ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })
})
