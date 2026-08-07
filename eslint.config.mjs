// @ts-check
import antfu from '@antfu/eslint-config'

/**
 * The dependency rule (ADR 0002 D8) is lint, not culture. It is what lets the
 * safety and ordering suites run under plain vitest with no extension host.
 *
 * @param {string[]} groups
 * @param {string} message
 */
function forbid(groups, message) {
  return {
    'no-restricted-imports': ['error', { patterns: [{ group: groups, message }] }],
  }
}

export default antfu(
  {
    ignores: [
      'work-docs/**',
      '.agents/**',
      '.cursor/**',
    ],
  },
  {
    files: ['src/guide/**/*.ts'],
    rules: forbid(
      ['vscode', 'reactive-vscode', '@reatom/core', 'node:*'],
      'src/guide is the pure layer: no vscode, no Reatom, no node builtins (architecture/overview.md §2).',
    ),
  },
  {
    files: ['src/git/**/*.ts'],
    rules: forbid(
      ['vscode', 'reactive-vscode', '@reatom/core'],
      'src/git is the capability layer: node builtins only, never vscode or Reatom (architecture/overview.md §2).',
    ),
  },
  {
    files: ['src/model/**/*.ts'],
    rules: forbid(
      ['vscode', 'reactive-vscode', 'node:*'],
      'src/model orchestrates through src/git and the installed ports; it never touches vscode or node directly.',
    ),
  },
  {
    rules: {
      // overrides
    },
  },
)
