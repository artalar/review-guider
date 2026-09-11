/**
 * Rewrites a `git rebase -i` todo so the reviewed commit becomes `edit`.
 *
 * Git's todo is one command per line. `rebase.instructionFormat` may append
 * extra columns after the subject; those stay untouched. Comment lines and
 * every command that is not `pick` / `p` for the reviewed SHA stay as-is.
 */

const PICK_LINE = /^(\s*)(pick|p)(\s+)([0-9a-fA-F]{4,40})\b(.*)$/

export function shaMatches(todoSha: string, afterSha: string): boolean {
  const todo = todoSha.toLowerCase()
  const after = afterSha.toLowerCase()
  if (todo === after)
    return true
  return after.startsWith(todo) || todo.startsWith(after)
}

export function rewriteSequenceTodo(text: string, afterSha: string): string {
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
