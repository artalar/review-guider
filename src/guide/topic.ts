export const DEFAULT_GUIDE_TOPIC = 'review'
export const TOPIC_GUIDE_PREFIX = '.tabthrough.'
export const TOPIC_GUIDE_SUFFIX = '.guide.json'
export const LEGACY_DEFAULT_GUIDE_FILE = '.tabthrough-guide.json'
export const TOPIC_MAX_LENGTH = 48
export const SUGGESTED_TOPIC_MAX_LENGTH = 32

const TOPIC_GUIDE_NAME = /^\.tabthrough\.([a-z0-9]+(?:-[a-z0-9]+)*)\.guide\.json$/
const TOPIC_TOKEN = /[^a-z0-9]+/g
const CONVENTIONAL_PREFIX = /^(feat|fix|chore|docs|refactor|test|style|perf|ci|build|revert)(\([^)]*\))?:\s*/i

export function slugifyTopic(raw: string, maxLength = TOPIC_MAX_LENGTH): string {
  const slug = raw.trim().toLowerCase().replace(TOPIC_TOKEN, '-').replace(/^-+|-+$/g, '').slice(0, maxLength).replace(/-+$/, '')
  return slug === '' ? DEFAULT_GUIDE_TOPIC : slug
}

export function topicFromLabel(raw: string): string {
  const withoutType = raw.replace(CONVENTIONAL_PREFIX, '')
  const words = withoutType.trim().split(/\s+/).filter(word => word !== '').slice(0, 4).join(' ')
  return slugifyTopic(words, SUGGESTED_TOPIC_MAX_LENGTH)
}

export function guideFileNameForTopic(topic: string): string {
  return `${TOPIC_GUIDE_PREFIX}${slugifyTopic(topic)}${TOPIC_GUIDE_SUFFIX}`
}

function fileNameOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash === -1 ? path : path.slice(slash + 1)
}

export function topicFromGuideFileName(fileName: string): string | null {
  const match = TOPIC_GUIDE_NAME.exec(fileNameOf(fileName))
  return match?.[1] ?? null
}

export function isTabthroughGuideFileName(fileName: string): boolean {
  const name = fileNameOf(fileName)
  return name === LEGACY_DEFAULT_GUIDE_FILE || TOPIC_GUIDE_NAME.test(name)
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function applyGuideCursor(text: string, cursor: number): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!isJsonObject(parsed))
    return null
  if (parsed.cursor === cursor)
    return null
  return `${JSON.stringify({ ...parsed, cursor }, null, 2)}\n`
}

export const TABTHROUGH_GITIGNORE = '.tabthrough*'

export function withGitignorePattern(existing: string | null, pattern: string): { text: string, changed: boolean } {
  const body = existing ?? ''
  const lines = body.split(/\r?\n/)
  if (lines.some(line => line.trim() === pattern)) {
    if (body === '' || body.endsWith('\n'))
      return { text: body, changed: false }
    return { text: `${body}\n`, changed: true }
  }
  const prefix = body === '' || body.endsWith('\n') ? body : `${body}\n`
  return { text: `${prefix}${pattern}\n`, changed: true }
}
