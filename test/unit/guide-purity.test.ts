import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const GUIDE_DIR = new URL('../../src/guide/', import.meta.url)
// Anchored at column 0 so a `from ` inside an indented string literal cannot
// masquerade as an import statement.
const IMPORT = /^(?:import|export|\})[^\n]*\bfrom\s*['"]([^'"]+)['"]/gm
const BARE_IMPORT = /^import\s+['"]([^'"]+)['"]/gm
const REQUIRE = /^[^\n]*\brequire\(\s*['"]([^'"]+)['"]\s*\)/gm

function specifiersOf(source: string): string[] {
  const found: string[] = []
  for (const pattern of [IMPORT, BARE_IMPORT, REQUIRE]) {
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      found.push(match[1])
      match = pattern.exec(source)
    }
  }
  return found
}

describe('the pure layer stays pure', () => {
  const files = readdirSync(GUIDE_DIR).filter(name => name.endsWith('.ts'))

  it('has the modules the architecture calls for', () => {
    expect(files.sort()).toEqual([
      'from-file.ts',
      'groups.ts',
      'heuristic.ts',
      'index.ts',
      'merge.ts',
      'parse-diff.ts',
      'render.ts',
      'schema.ts',
      'sha256.ts',
      'sidecar.ts',
      'steps.ts',
      'text.ts',
      'types.ts',
    ])
  })

  it.each(readdirSync(GUIDE_DIR).filter(name => name.endsWith('.ts')))(
    '%s imports nothing but src/guide itself',
    (name) => {
      const source = readFileSync(new URL(name, GUIDE_DIR), 'utf8')
      for (const specifier of specifiersOf(source)) {
        expect(specifier.startsWith('./')).toBe(true)
        expect(specifier).not.toContain('..')
      }
    },
  )

  it.each(readdirSync(GUIDE_DIR).filter(name => name.endsWith('.ts')))(
    '%s uses no `any`',
    (name) => {
      const source = readFileSync(new URL(name, GUIDE_DIR), 'utf8')
      expect(source).not.toMatch(/\bas any\b|:\s*any\b|<any>/)
    },
  )
})
