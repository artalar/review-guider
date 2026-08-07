import type { TextEditor, Uri as VscodeUri } from 'vscode'
import type { LineRange } from '../guide/types'
import type { ReviewDocRef, ReviewViewModel } from '../model/view'
import { peek } from '@reatom/core'
import { useActiveTextEditor, useDisposable, useEditorDecorations, watch } from 'reactive-vscode'
import {
  commands,
  EventEmitter,
  OverviewRulerLane,
  Range,
  Selection,
  TextEditorRevealType,
  ThemeColor,
  Uri,
  window,
  workspace,
} from 'vscode'
import { REVIEW_SCHEME, reviewDocPath, reviewViewModel } from '../model/view'
import { logger } from '../utils'
import { useAtomRef } from './binding'

/**
 * Progressive reveal (ADR 0002 D1): the reviewed file is a native diff between
 * two read-only virtual documents. Unrevealed lines are *absent* from the
 * reveal document rather than dimmed, so they cannot be read, selected, or
 * copied ahead of time — and because both sides are real documents, the diff
 * editor supplies gutter markers, highlighting, and navigation for free.
 */

const LOADING = '// Tabthrough is reading this file…\n'

export function reviewUri(ref: ReviewDocRef, rev?: string): VscodeUri {
  return Uri.from({
    scheme: REVIEW_SCHEME,
    authority: ref.kind,
    path: reviewDocPath(ref),
    ...(rev === undefined ? {} : { query: `rev=${rev}` }),
  })
}

function urisFor(view: ReviewViewModel & { activePath: string }): { base: VscodeUri, reveal: VscodeUri } {
  const { sessionId, activePath } = view
  return {
    base: reviewUri({ kind: 'base', sessionId, path: activePath }, view.baseRev),
    reveal: reviewUri({ kind: 'reveal', sessionId, path: activePath }),
  }
}

function withActivePath(view: ReviewViewModel | null): (ReviewViewModel & { activePath: string }) | null {
  return view !== null && view.activePath !== null
    ? { ...view, activePath: view.activePath }
    : null
}

function isRevealDocument(uri: VscodeUri): boolean {
  return uri.scheme === REVIEW_SCHEME && uri.authority === 'reveal'
}

/** 1-based inclusive model ranges → editor ranges, clamped to the document. */
function toEditorRanges(ranges: readonly LineRange[] | undefined, editor: TextEditor): Range[] {
  const last = Math.max(editor.document.lineCount - 1, 0)
  const out: Range[] = []
  for (const range of ranges ?? []) {
    // A pure deletion is encoded as an empty range; there is no line to paint.
    if (range.end < range.start)
      continue
    const start = Math.min(Math.max(range.start - 1, 0), last)
    const end = Math.min(Math.max(range.end - 1, start), last)
    out.push(new Range(start, 0, end, editor.document.lineAt(end).text.length))
  }
  return out
}

/** Scrolls the reveal editor to the current step, without stealing focus. */
export function focusCurrentStep(): void {
  const view = withActivePath(peek(reviewViewModel))
  if (view === null)
    return

  const target = urisFor(view).reveal.toString()
  const editor = window.visibleTextEditors.find(candidate => candidate.document.uri.toString() === target)
  if (editor === undefined)
    return

  const ranges = toEditorRanges(view.ranges, editor)
  const first = ranges[0]
  if (first === undefined)
    return

  editor.revealRange(first, TextEditorRevealType.InCenterIfOutsideViewport)
  editor.selection = new Selection(first.start, first.start)
}

/** Status-bar click and `Go to Current Step`: reopen the diff if it was closed. */
export async function revealCurrentStep(): Promise<void> {
  const view = withActivePath(peek(reviewViewModel))
  if (view === null)
    return

  const { base, reveal } = urisFor(view)
  const open = window.visibleTextEditors.some(editor => editor.document.uri.toString() === reveal.toString())
  if (!open)
    await openDiff(base, reveal, view.title)

  focusCurrentStep()
}

async function openDiff(base: VscodeUri, reveal: VscodeUri, title: string): Promise<void> {
  try {
    await commands.executeCommand('vscode.diff', base, reveal, title, { preview: false })
  }
  catch (error) {
    logger.error('could not open the review diff', error)
  }
}

export function useReviewDocuments(): void {
  const emitter = useDisposable(new EventEmitter<VscodeUri>())
  // The one imperative cache in the codebase, and only because
  // `provideTextDocumentContent` is a synchronous pull: a write-only
  // projection of `reviewViewModel`, never read back by the model.
  const contents = new Map<string, string>()

  useDisposable(workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, {
    onDidChange: emitter.event,
    provideTextDocumentContent: uri => contents.get(uri.toString()) ?? LOADING,
  }))

  // VS Code re-reads the provider after `fire`; this is the moment the editor
  // is guaranteed to hold the new text, so it is where the scroll belongs.
  useDisposable(workspace.onDidChangeTextDocument((event) => {
    if (isRevealDocument(event.document.uri))
      focusCurrentStep()
  }))

  const view = useAtomRef(reviewViewModel)
  let openedFor: string | null = null

  const publish = (uri: VscodeUri, text: string | null): void => {
    if (text === null)
      return
    const key = uri.toString()
    if (contents.get(key) === text)
      return
    contents.set(key, text)
    emitter.fire(uri)
  }

  const apply = async (next: ReviewViewModel | null): Promise<void> => {
    const active = withActivePath(next)
    if (active === null) {
      contents.clear()
      openedFor = null
      return
    }

    const { base, reveal } = urisFor(active)
    publish(base, active.baseText)
    publish(reveal, active.revealText)

    // Both sides must exist before the diff opens, or the editor caches the
    // loading placeholder as the file's content.
    if (active.baseText === null || active.revealText === null)
      return

    const key = reveal.toString()
    if (openedFor !== key) {
      openedFor = key
      await openDiff(base, reveal, active.title)
    }
    focusCurrentStep()
  }

  watch(view, (next) => {
    void apply(next).catch(error => logger.error('review document update failed', error))
  }, { immediate: true })
}

/**
 * The current step's highlight, plus the dim mode's grey-out. In progressive
 * mode `pendingRanges` is empty by construction — unrevealed lines are not in
 * the document — so the same two calls serve both modes.
 */
export function useReviewDecorations(): void {
  const view = useAtomRef(reviewViewModel)
  const editor = useActiveTextEditor()

  const ranges = (pick: (model: ReviewViewModel) => readonly LineRange[]) => (target: TextEditor): Range[] => {
    const model = view.value
    if (model === null || !isRevealDocument(target.document.uri))
      return []
    return toEditorRanges(pick(model), target)
  }

  useEditorDecorations(
    editor,
    {
      isWholeLine: true,
      backgroundColor: new ThemeColor('editor.wordHighlightBackground'),
      overviewRulerColor: new ThemeColor('editorOverviewRuler.wordHighlightForeground'),
      overviewRulerLane: OverviewRulerLane.Center,
    },
    ranges(model => model.ranges),
  )

  useEditorDecorations(
    editor,
    { isWholeLine: true, opacity: '0.4' },
    ranges(model => model.pendingRanges),
  )
}
