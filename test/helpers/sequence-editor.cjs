'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const process = require('node:process')

const PICK_LINE = /^(\s*)(pick|p)(\s+)([0-9a-fA-F]{4,40})\b(.*)$/

function shaMatches(todoSha, afterSha) {
  const todo = String(todoSha).toLowerCase()
  const after = String(afterSha).toLowerCase()
  return todo === after || after.startsWith(todo) || todo.startsWith(after)
}

function rewriteSequenceTodo(text, afterSha) {
  const endsWithNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsWithNewline && lines[lines.length - 1] === '')
    lines.pop()

  const rewritten = lines.map((line) => {
    const match = PICK_LINE.exec(line)
    if (match === null)
      return line
    const indent = match[1] ?? ''
    const spaces = match[3] ?? ' '
    const sha = match[4] ?? ''
    const rest = match[5] ?? ''
    if (!shaMatches(sha, afterSha))
      return line
    return `${indent}edit${spaces}${sha}${rest}`
  })

  return endsWithNewline ? `${rewritten.join('\n')}\n` : rewritten.join('\n')
}

const args = process.argv.slice(2)
if (args.includes('--check'))
  process.exit(0)

const afterSha = args[0]
const todoPath = args[1]
if (!afterSha || !todoPath) {
  process.stderr.write('usage: sequence-editor <afterSha> <todo-file>\n')
  process.exit(2)
}

writeFileSync(todoPath, rewriteSequenceTodo(readFileSync(todoPath, 'utf8'), afterSha))
