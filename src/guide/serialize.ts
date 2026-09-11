import type { GuideDoc, GuideRangeDoc, GuideScopeDoc, GuideStepDoc } from './schema'
import type { Guide, GuideStep, LineGroup } from './types'

const SCHEMA_URL = 'https://raw.githubusercontent.com/artalar/tabthrough/main/schema/guide-v1.json'

export interface SerializeGuideArgs {
  readonly guide: Guide
  readonly scope: GuideScopeDoc
  readonly sidecarPath: string
  readonly topic?: string
  readonly createdAt?: string
  readonly generatorName?: string
}

function sidecarStepId(index: number): string {
  return `s${(index + 1) * 10}`
}

function groupRange(group: LineGroup): GuideRangeDoc | null {
  if (group.newRange !== undefined)
    return { side: 'new', start: group.newRange.start, end: group.newRange.end }
  if (group.oldRange !== undefined)
    return { side: 'old', start: group.oldRange.start, end: group.oldRange.end }
  return null
}

function stepRanges(step: GuideStep): readonly GuideRangeDoc[] | undefined {
  const ranges: GuideRangeDoc[] = []
  for (const group of step.groups) {
    const range = groupRange(group)
    if (range !== null)
      ranges.push(range)
  }
  return ranges.length === 0 ? undefined : ranges
}

function clipRationale(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 119)}…`
}

export function serializeGuide(args: SerializeGuideArgs): GuideDoc & { readonly $schema: string } {
  const steps: GuideStepDoc[] = args.guide.steps.map((step, index) => {
    const id = sidecarStepId(index)
    const ranges = stepRanges(step)
    return {
      id,
      path: step.path,
      rationale: clipRationale(step.rationale),
      order: (index + 1) * 10,
      significance: step.significance,
      grouping: 'atomic',
      dependsOn: [],
      tags: [],
      ...(ranges === undefined ? {} : { ranges }),
      ...(step.title === undefined ? {} : { title: step.title }),
      ...(step.notes === undefined ? {} : { notes: step.notes }),
    }
  })

  return {
    $schema: SCHEMA_URL,
    version: 1,
    scope: args.scope,
    steps,
    defaults: { mergeStrategy: 'replace' },
    files: {
      [args.sidecarPath]: { significance: 'skip', rationale: 'The sidecar this walk is written into' },
    },
    generator: { name: args.generatorName ?? 'tabthrough-heuristic' },
    ...(args.topic === undefined ? {} : { topic: args.topic }),
    ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
  }
}

export function formatGuideJson(doc: GuideDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
