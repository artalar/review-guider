import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Track B: build, mutate, and fingerprint a throwaway git repository.
 *
 * The safety suite compares fingerprints taken before and after a round trip,
 * so this helper is the thing that decides what "byte-identical" means.
 */

export const isWindows = process.platform === 'win32'

const CREATED: string[] = []

export interface FileFingerprint {
  readonly hash: string
  readonly executable: boolean
}

export interface RepoFingerprint {
  /** Canonical `git status --porcelain=v2 -z`, minus the branch headers. */
  readonly status: readonly string[]
  readonly files: Readonly<Record<string, FileFingerprint>>
}

export interface TmpRepo {
  readonly root: string
  git: (...args: string[]) => Promise<string>
  tryGit: (...args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>
  write: (path: string, content: string) => Promise<void>
  /** Bytes rather than text, for the binary rows of the edge matrix. */
  writeBytes: (path: string, content: Uint8Array) => Promise<void>
  read: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
  setExecutable: (path: string) => Promise<void>
  commit: (message: string) => Promise<string>
  head: () => Promise<string>
  fingerprint: () => Promise<RepoFingerprint>
}

function run(cwd: string, args: readonly string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => resolve({
      code: code ?? -1,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }))
  })
}

function splitNul(raw: string): string[] {
  const parts = raw.split('\0')
  if (parts[parts.length - 1] === '')
    parts.pop()
  return parts
}

export interface TmpRepoOptions {
  /** Written and committed as the initial commit. */
  readonly files?: Readonly<Record<string, string>>
  readonly initialCommit?: boolean
}

export async function makeTempRepo(options: TmpRepoOptions = {}): Promise<TmpRepo> {
  const root = await mkdtemp(join(tmpdir(), 'tabthrough-test-'))
  CREATED.push(root)

  const repo = createHandle(root)

  await repo.git('init', '--quiet', '--initial-branch=main', '.')
  await repo.git('config', 'user.email', 'test@tabthrough.local')
  await repo.git('config', 'user.name', 'Tabthrough Test')
  await repo.git('config', 'commit.gpgsign', 'false')
  await repo.git('config', 'core.autocrlf', 'false')

  const files = options.files ?? { 'README.md': '# fixture\n' }
  for (const [path, content] of Object.entries(files))
    await repo.write(path, content)

  if (options.initialCommit !== false) {
    await repo.git('add', '-A')
    await repo.commit('initial commit')
  }

  return repo
}

/**
 * A depth-limited clone of `source`, for the P0 edge row "shallow clone missing
 * objects". The boundary commit keeps its recorded parents but the objects they
 * name were never fetched, which is the whole point of the fixture.
 */
export async function makeShallowClone(source: TmpRepo, depth = 1): Promise<TmpRepo> {
  const root = await mkdtemp(join(tmpdir(), 'tabthrough-shallow-'))
  CREATED.push(root)

  const clone = await run(root, ['clone', '--quiet', '--depth', String(depth), pathToFileURL(source.root).href, '.'])
  if (clone.code !== 0)
    throw new Error(`shallow clone failed (${clone.code}): ${clone.stderr || clone.stdout}`)

  const repo = createHandle(root)
  await repo.git('config', 'user.email', 'test@tabthrough.local')
  await repo.git('config', 'user.name', 'Tabthrough Test')
  await repo.git('config', 'commit.gpgsign', 'false')
  await repo.git('config', 'core.autocrlf', 'false')
  return repo
}

/** A directory that is deliberately not a repository. */
export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tabthrough-plain-'))
  CREATED.push(dir)
  return dir
}

export async function cleanupTempRepos(): Promise<void> {
  while (CREATED.length > 0) {
    const dir = CREATED.pop()
    if (dir !== undefined)
      await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

function createHandle(root: string): TmpRepo {
  const handle: TmpRepo = {
    root,

    async git(...args) {
      const result = await run(root, args)
      if (result.code !== 0)
        throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr || result.stdout}`)
      return result.stdout
    },

    async tryGit(...args) {
      return await run(root, args)
    },

    async write(path, content) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, content, 'utf8')
    },

    async writeBytes(path, content) {
      const absolute = join(root, path)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, content)
    },

    async read(path) {
      return await readFile(join(root, path), 'utf8')
    },

    async exists(path) {
      try {
        await stat(join(root, path))
        return true
      }
      catch {
        return false
      }
    },

    async remove(path) {
      await rm(join(root, path), { force: true, recursive: true })
    },

    async setExecutable(path) {
      await chmod(join(root, path), 0o755)
    },

    async commit(message) {
      await handle.git('commit', '--quiet', '--no-gpg-sign', '-m', message)
      return await handle.head()
    },

    async head() {
      return (await handle.git('rev-parse', 'HEAD')).trim()
    },

    async fingerprint() {
      return await fingerprintRepo(handle)
    },
  }
  return handle
}

/**
 * `git status --porcelain=v2 -z` plus a SHA-256 of every tracked and untracked
 * file, exactly as the plan's Phase 2 test gate specifies.
 */
export async function fingerprintRepo(repo: TmpRepo): Promise<RepoFingerprint> {
  const statusRaw = await repo.git('status', '--porcelain=v2', '-z')
  const status = splitNul(statusRaw).filter(record => !record.startsWith('# ')).sort()

  const tracked = splitNul(await repo.git('ls-files', '-z'))
  const untracked = splitNul(await repo.git('ls-files', '--others', '--exclude-standard', '-z'))

  const files: Record<string, FileFingerprint> = {}
  for (const path of [...new Set([...tracked, ...untracked])].sort()) {
    const absolute = join(repo.root, path)
    try {
      const info = await stat(absolute)
      if (!info.isFile())
        continue
      const content = await readFile(absolute)
      files[path] = {
        hash: createHash('sha256').update(content).digest('hex'),
        // Modes are meaningless on Windows; the mode row of the matrix skips there.
        executable: isWindows ? false : (info.mode & 0o111) !== 0,
      }
    }
    catch {
      // A tracked-but-deleted path has no content to fingerprint; the status
      // record above already carries the deletion.
    }
  }

  return { status, files }
}
