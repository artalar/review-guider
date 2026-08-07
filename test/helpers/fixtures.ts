import { readFileSync } from 'node:fs'

const FIXTURES = new URL('../fixtures/', import.meta.url)

/** Diffs and guides are authored as LF; Windows checkouts must not change their bytes. */
function readUtf8Lf(url: URL): string {
  return readFileSync(url, 'utf8').replace(/\r\n/g, '\n')
}

export function readDiffFixture(name: string): string {
  return readUtf8Lf(new URL(`diffs/${name}`, FIXTURES))
}

export function readGuideFixtureText(name: string): string {
  return readUtf8Lf(new URL(`guides/${name}`, FIXTURES))
}

export function readGuideFixture(name: string): unknown {
  return JSON.parse(readGuideFixtureText(name))
}
