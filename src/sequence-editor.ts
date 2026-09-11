import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { rewriteSequenceTodo } from './git/sequence-todo'

export { rewriteSequenceTodo, shaMatches } from './git/sequence-todo'

export function runSequenceEditor(argv: readonly string[]): number {
  const args = argv.slice(2)
  if (args.includes('--check'))
    return 0

  const afterSha = args[0]
  const todoPath = args[1]
  if (afterSha === undefined || afterSha === '' || todoPath === undefined || todoPath === '') {
    process.stderr.write('usage: sequence-editor <afterSha> <todo-file>\n')
    return 2
  }

  const original = readFileSync(todoPath, 'utf8')
  writeFileSync(todoPath, rewriteSequenceTodo(original, afterSha))
  return 0
}

const invokedAsEditor = (process.argv[1] ?? '').includes('sequence-editor')
if (invokedAsEditor)
  process.exit(runSequenceEditor(process.argv))
