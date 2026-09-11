import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'

/**
 * The only place in the codebase that starts a subprocess.
 *
 * Every invocation is non-interactive, locale-stable, and built from an argv
 * array — never a shell string. See architecture/overview.md §3.4.
 */

export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * `GIT_TERMINAL_PROMPT=0` so a credential prompt can never block the extension
 * host; `GIT_OPTIONAL_LOCKS=0` so read probes never fight the user's own git;
 * `LC_ALL=C` so parsed output does not depend on the user's locale.
 */
let cachedBaseEnv: Record<string, string> | null = null

export function baseEnv(): Record<string, string> {
  if (cachedBaseEnv !== null)
    return cachedBaseEnv
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined)
      env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PAGER = 'cat'
  env.LC_ALL = 'C'
  cachedBaseEnv = env
  return env
}

export interface GitExecRequest {
  readonly cwd: string
  readonly args: readonly string[]
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  /** Merged on top of {@link baseEnv}. Used for `GIT_INDEX_FILE` and identities. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to stdin, which is then closed. */
  readonly stdin?: string
}

export interface GitExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Injectable so unit tests can feed recorded outputs (plan P0-1). */
export type GitExec = (request: GitExecRequest) => Promise<GitExecResult>

export interface GitOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly exec?: GitExec
}

export class GitMissingError extends Error {
  override readonly name = 'GitMissingError'
  constructor(readonly cause: unknown) {
    super('git executable not found on PATH')
  }
}

export class GitCommandError extends Error {
  override readonly name = 'GitCommandError'
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} exited with ${code}: ${stderr.trim() || stdout.trim()}`)
  }
}

export class GitTimeoutError extends Error {
  override readonly name = 'GitTimeoutError'
  constructor(readonly args: readonly string[], readonly timeoutMs: number) {
    super(`git ${args.join(' ')} timed out after ${timeoutMs}ms`)
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

/** The production {@link GitExec}. Resolves for any exit code; only spawn failures reject. */
export const execGit: GitExec = request => new Promise<GitExecResult>((resolve, reject) => {
  if (request.signal?.aborted) {
    reject(request.signal.reason ?? new Error('aborted'))
    return
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const child = spawn('git', [...request.args], {
    cwd: request.cwd,
    env: { ...baseEnv(), ...request.env },
    shell: false,
    windowsHide: true,
  })

  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let settled = false
  let failure: unknown

  const timer = setTimeout(() => {
    if (settled)
      return
    failure = new GitTimeoutError(request.args, timeoutMs)
    child.kill('SIGKILL')
  }, timeoutMs)

  const onAbort = () => {
    if (settled)
      return
    failure ??= request.signal?.reason ?? new Error('aborted')
    clearTimeout(timer)
    child.kill('SIGKILL')
  }

  if (request.signal) {
    request.signal.addEventListener('abort', onAbort, { once: true })
  }

  const cleanup = () => {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }

  // Killing a child while it is consuming stdin can report EPIPE on the
  // writable stream after the promise has already been rejected by abort.
  // Handle it explicitly so an interrupted git probe cannot become an
  // uncaught exception in the extension host.
  child.stdin?.on('error', (error) => {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : ''
    if (code === 'EPIPE' || settled)
      return
    failure ??= error
    child.kill('SIGKILL')
  })

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

  child.on('error', (error) => {
    if (settled)
      return
    settled = true
    cleanup()
    reject(isEnoent(error) ? new GitMissingError(error) : error)
  })

  child.on('close', (code) => {
    if (settled)
      return
    settled = true
    cleanup()
    if (failure !== undefined) {
      reject(failure)
      return
    }
    resolve({
      code: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    })
  })

  if (request.stdin !== undefined)
    child.stdin?.end(request.stdin)
  else
    child.stdin?.end()
})

/** Runs git and throws {@link GitCommandError} on a non-zero exit. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions & { env?: Readonly<Record<string, string>>, stdin?: string } = {},
): Promise<string> {
  const result = await tryGit(cwd, args, options)
  if (result.code !== 0)
    throw new GitCommandError(args, result.code, result.stdout, result.stderr)
  return result.stdout
}

/** Runs git and surfaces the exit code instead of throwing. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
  options: GitOptions & { env?: Readonly<Record<string, string>>, stdin?: string } = {},
): Promise<GitExecResult> {
  const exec = options.exec ?? execGit
  return await exec({
    cwd,
    args,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    env: options.env,
    stdin: options.stdin,
  })
}

/** Splits `-z` output into records, dropping the trailing empty field. */
export function splitNul(raw: string): string[] {
  const parts = raw.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '')
    parts.pop()
  return parts
}

/** Splits newline-delimited output, dropping a trailing blank line. */
export function splitLines(raw: string): string[] {
  return raw.split('\n').filter(line => line !== '')
}
