import { readFileSync } from 'node:fs'

const FIXTURES = new URL('../fixtures/', import.meta.url)

export function readDiffFixture(name: string): string {
  return readFileSync(new URL(`diffs/${name}`, FIXTURES), 'utf8')
}

export function readGuideFixtureText(name: string): string {
  return readFileSync(new URL(`guides/${name}`, FIXTURES), 'utf8')
}

export function readGuideFixture(name: string): unknown {
  return JSON.parse(readGuideFixtureText(name))
}
