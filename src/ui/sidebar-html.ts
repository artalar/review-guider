import type { SidebarItemData } from '../model/sidebar'
import type { SidebarViewModel } from '../model/view'
import { randomUUID } from 'node:crypto'
import { safeSidebarText, sidebarItems } from '../model/sidebar'

export const NOTES_PREVIEW_LIMIT = 480

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function htmlText(value: string | undefined, max = 4000): string {
  return escapeHtml(safeSidebarText(value ?? '', max)).replace(/\r?\n/g, '<br>')
}

export function htmlAttr(value: string | undefined, max = 200): string {
  return escapeHtml(safeSidebarText(value ?? '', max).replace(/\r?\n/g, ' '))
}

function buttonClass(row: SidebarItemData): string {
  if (row.surface === 'list')
    return 'list-pick'
  if (row.tone === 'primary')
    return 'primary'
  if (row.tone === 'quiet')
    return 'quiet'
  if (row.tone === 'consequential')
    return 'consequential'
  return 'secondary'
}

function commandButton(row: SidebarItemData, extraClass = ''): string {
  const command = row.command ?? ''
  const enabled = row.enabled !== false
  const payload = row.payload === undefined ? '' : ` data-payload="${htmlAttr(row.payload, 200)}"`
  const classes = [buttonClass(row), extraClass].filter(part => part !== '').join(' ')
  const busy = row.id === 'starting' || row.id === 'finishing'
  const title = row.tooltip === undefined ? '' : ` title="${htmlAttr(row.tooltip, 400)}"`
  return `<button class="${classes}" type="button" data-id="${htmlAttr(row.id, 80)}" data-command="${htmlAttr(command, 100)}"${payload}${title}${enabled ? '' : ' disabled'}${busy ? ' aria-busy="true"' : ''}>${buttonInner(row)}</button>`
}

function accentClass(accent: SidebarItemData['accent']): string {
  if (accent === 'start')
    return 'range-start'
  if (accent === 'end')
    return 'range-end'
  if (accent === 'between')
    return 'range-between'
  if (accent === 'selected')
    return 'range-selected'
  return ''
}

function iconSvg(name: string | undefined): string {
  if (name === 'diff')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h6.2L13 5.8v7.7H3.5zm6 0v3.3H13"/></svg>'
  if (name === 'git-commit')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5M1.75 8h3.1a3.75 3.75 0 0 0 6.3 0h3.1v-1h-3.1a3.75 3.75 0 0 0-6.3 0h-3.1z"/></svg>'
  if (name === 'git-compare')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 2.5a1.5 1.5 0 1 0-1 0V6a3 3 0 0 0 3 3h3v1.5a1.5 1.5 0 1 0 1 0V9a3 3 0 0 0-3-3H6V2.5z"/></svg>'
  if (name === 'go-to-file')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h6.2L13 5.8v7.7H3.5zm6 0v3.3H13M5 9h6v1H5zm0 2.5h4v1H5z"/></svg>'
  if (name === 'link-external')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9 3h4v4h-1V4.7L7.7 9 7 8.3 11.3 4H9zM4 4.5h3.2v1H5v6h6V9.8h1V12.5H4z"/></svg>'
  if (name === 'arrow-left')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M7.4 3.6 3 8l4.4 4.4.7-.7L5.2 8.5H13v-1H5.2l2.9-2.8z"/></svg>'
  if (name === 'arrow-right')
    return '<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m8.6 3.6-.7.7L10.8 7.5H3v1h7.8L7.9 11.3l.7.7L13 8z"/></svg>'
  return ''
}

function chevronSvg(): string {
  return '<svg class="glyph chevron" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m6.2 3.6-.7.7L9.2 8l-3.7 3.7.7.7L10.6 8z"/></svg>'
}

function boundWord(accent: SidebarItemData['accent']): string {
  if (accent === 'start')
    return 'Start'
  if (accent === 'end')
    return 'End'
  return ''
}

function isHeaderAction(row: SidebarItemData): boolean {
  return row.tone === 'primary' && (row.id === 'use-range' || row.id === 'use-commit' || row.id === 'start-guide' || row.id === 'next' || row.id === 'finish')
}

function buttonInner(row: SidebarItemData): string {
  if (row.id === 'back')
    return iconSvg('arrow-left')
  if (row.slot === 'nav' && row.id === 'previous')
    return `${iconSvg('arrow-left')}`
  if (isHeaderAction(row))
    return `${htmlText(row.label, 80)}${iconSvg('arrow-right')}`
  if (row.slot === 'nav')
    return `${iconSvg(row.icon)}${htmlText(row.label, 200)}`
  if (row.id.startsWith('commit-')) {
    const word = boundWord(row.accent)
    const mark = word === '' ? '' : `<span class="bound-word">${word}</span>`
    return `<span class="gutter" aria-hidden="true"><span class="dot"></span></span><span class="commit-text"><span class="subject">${htmlText(row.label, 200)}</span><span class="meta">${htmlText(row.description, 400)}</span></span>${mark}`
  }
  const icon = iconSvg(row.icon)
  const chevron = row.trailing === 'chevron' ? chevronSvg() : ''
  if (row.description === undefined)
    return `${icon}<span class="label">${htmlText(row.label, 200)}</span>${chevron}`
  return `${icon}<span class="choice-text"><span class="label">${htmlText(row.label, 200)}</span><span class="hint">${htmlText(row.description, 400)}</span></span>${chevron}`
}

function button(row: SidebarItemData): string {
  const extra = [
    row.description === undefined && !row.id.startsWith('commit-') ? '' : 'choice',
    row.id.startsWith('commit-') ? 'commit-row' : '',
    row.trailing === 'chevron' ? 'has-chevron' : '',
    accentClass(row.accent),
    row.id === 'previous' || row.id === 'back' ? 'icon-only' : '',
    row.id === 'back' ? 'back' : '',
    isHeaderAction(row) ? 'compact' : '',
  ].filter(part => part !== '').join(' ')
  const bound = boundWord(row.accent)
  const named = row.id === 'previous'
    ? ' aria-label="Previous"'
    : row.id === 'back'
      ? ` aria-label="${htmlAttr(row.label, 80)}"`
      : bound === ''
        ? ''
        : ` aria-label="${bound}"`
  return commandButton(row, extra).replace('<button ', `<button${named} `)
}

function inputRow(row: SidebarItemData): string {
  const command = row.command ?? ''
  const placeholder = row.input?.placeholder ?? ''
  const submit = row.input?.submit ?? 'Go'
  const enabled = row.enabled !== false
  const fieldId = `field-${row.id}`
  const error = row.input?.error
  const errorId = `${fieldId}-error`
  const described = error === undefined ? '' : ` aria-invalid="true" aria-describedby="${errorId}"`
  const submitClass = row.tone === 'secondary' ? 'secondary' : 'primary'
  const value = row.input?.value ?? ''
  const bound = row.input?.bound === undefined ? '' : ` data-bound="${row.input.bound}"`
  const hiddenSubmit = row.input?.hideSubmit === true
  const submitButton = hiddenSubmit
    ? ''
    : `<button class="${submitClass} compact" type="submit"${enabled ? '' : ' disabled'}>${htmlText(submit, 80)}</button>`
  return `<form class="input-row${hiddenSubmit ? ' bound-field' : ''}" data-command="${htmlAttr(command, 100)}" data-id="${htmlAttr(row.id, 80)}"${bound}><label class="field-label" for="${fieldId}">${htmlText(row.label, 200)}</label><div class="fields"><input id="${fieldId}" type="text" name="payload" value="${htmlAttr(value, 120)}" data-rendered="${htmlAttr(value, 120)}" placeholder="${htmlAttr(placeholder, 120)}"${enabled ? '' : ' disabled'} autocomplete="off" spellcheck="false"${described}>${submitButton}</div>${error === undefined ? '' : `<p class="field-error" id="${errorId}">${htmlText(error, 400)}</p>`}</form>`
}

function walkProgress(view: SidebarViewModel): string {
  if (view.progress === null)
    return ''
  if (view.currentStep === null && view.progress.index === 0)
    return view.progress.total === 0 ? 'Ready to begin' : `0 of ${view.progress.total}`
  return `${view.progress.index} of ${view.progress.total}`
}

function liveRegion(view: SidebarViewModel): string {
  if (view.status !== 'active')
    return ''
  const progress = walkProgress(view)
  const title = view.currentStep === null
    ? 'Ready to begin'
    : (view.currentStep.title ?? view.currentStep.path)
  const text = progress === '' ? title : `${progress}. ${title}`
  return `<div class="live" aria-live="polite" aria-atomic="true">${htmlText(text, 200)}</div>`
}

function notesBody(text: string): string {
  if ([...text].length <= NOTES_PREVIEW_LIMIT)
    return `<span>${htmlText(text, 4000)}</span>`
  const preview = [...text].slice(0, NOTES_PREVIEW_LIMIT).join('')
  return `<span>${htmlText(preview, NOTES_PREVIEW_LIMIT)}</span><details class="notes-more" data-id="notes-more"><summary>Show full notes</summary><span>${htmlText(text, 4000)}</span></details>`
}

function disclosure(row: SidebarItemData): string {
  const open = row.expanded === true ? ' open' : ''
  const body = row.description === undefined ? '' : `<div class="disclosure-body">${htmlText(row.description, 4000)}</div>`
  return `<details class="disclosure ${htmlAttr(row.id, 80)}" data-id="${htmlAttr(row.id, 80)}"${open}><summary>${htmlText(row.label)}</summary>${body}</details>`
}

function notice(row: SidebarItemData): string {
  const severity = row.severity ?? 'info'
  const body = row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`
  if (row.command !== undefined)
    return `<section class="notice notice-${severity}" data-id="${htmlAttr(row.id, 80)}">${commandButton(row, 'notice-action')}</section>`
  return `<section class="notice notice-${severity} row ${htmlAttr(row.id, 80)}" data-id="${htmlAttr(row.id, 80)}"><strong>${htmlText(row.label)}</strong>${body}</section>`
}

function titleBlock(row: SidebarItemData): string {
  const lede = row.description === undefined ? '' : `<p class="lede">${htmlText(row.description, 400)}</p>`
  return `<div class="title-block ${htmlAttr(row.id, 80)}" data-id="${htmlAttr(row.id, 80)}"><h2 class="screen-title">${htmlText(row.label)}</h2>${lede}</div>`
}

function textRow(row: SidebarItemData): string {
  if (row.id === 'welcome' || row.id === 'pick-range' || row.id === 'pick-commit' || row.id === 'generate')
    return titleBlock(row)
  if (row.id.endsWith('-lede'))
    return `<p class="lede ${htmlAttr(row.id, 80)}" data-id="${htmlAttr(row.id, 80)}">${htmlText(row.label)}</p>`
  if (row.id === 'session' || row.id === 'history-heading' || row.id === 'agent-prompt' || row.id === 'guide-provenance')
    return `<p class="meta-line ${htmlAttr(row.id, 80)}" data-id="${htmlAttr(row.id, 80)}">${htmlText(row.label)}</p>`
  if (row.id === 'current') {
    const path = row.description === undefined ? '' : `<p class="path">${htmlText(row.description, 400)}</p>`
    return `<section class="thought ${htmlAttr(row.id, 100)}" data-id="${htmlAttr(row.id, 80)}"><h2 class="screen-title">${htmlText(row.label)}</h2>${path}</section>`
  }
  if (row.id === 'rationale') {
    const body = row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`
    return `<section class="why" data-id="rationale"><p class="meta-line">${htmlText(row.label)}</p>${body}</section>`
  }
  if (row.id === 'notes') {
    const body = row.description === undefined ? '' : notesBody(row.description)
    return `<section class="prose notes" data-id="notes">${body}</section>`
  }
  if (row.id === 'next-step') {
    const body = row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`
    return `<section class="up-next" data-id="next-step"><p class="meta-line">${htmlText(row.label)}</p>${body}</section>`
  }
  const body = row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`
  return `<section class="row ${htmlAttr(row.id, 100)}" data-id="${htmlAttr(row.id, 80)}"><p class="meta-line">${htmlText(row.label)}</p>${body}</section>`
}

function bodyRow(row: SidebarItemData): string {
  if (row.command !== undefined && row.contextValue === 'input')
    return inputRow(row)
  if (row.surface === 'notice')
    return notice(row)
  if (row.surface === 'disclosure')
    return disclosure(row)
  if (row.command !== undefined && row.contextValue === 'action')
    return button(row)
  return textRow(row)
}

function screenName(view: SidebarViewModel): string {
  if (view.status !== 'idle')
    return 'read'
  if (view.setup.kind === 'range')
    return 'range'
  if (view.setup.kind === 'commits')
    return 'commits'
  if (view.setup.kind === 'generate')
    return 'generate'
  return 'home'
}

function isTitleRow(row: SidebarItemData): boolean {
  return row.id === 'welcome' || row.id === 'pick-range' || row.id === 'pick-commit' || row.id === 'generate'
}

function rangeFields(rows: readonly SidebarItemData[]): string {
  if (rows.length === 0)
    return ''
  return `<div class="range-fields">${rows.map(inputRow).join('<span class="range-arrow" aria-hidden="true">→</span>')}</div>`
}

function walkModeLabel(view: SidebarViewModel): string {
  if (view.mode === 'rebase')
    return 'Rebase'
  if (view.mode === 'readonly')
    return 'Read-only'
  return ''
}

function chrome(
  view: SidebarViewModel,
  nav: readonly SidebarItemData[],
  titles: readonly SidebarItemData[],
  headerFields: readonly SidebarItemData[],
): string {
  const back = nav.find(row => row.id === 'back')
  const previous = nav.find(row => row.id === 'previous')
  const next = nav.find(row => row.id === 'next')
  const finish = nav.find(row => row.id === 'finish')
  const right = next ?? finish
  const end = nav.find(row => row.id === 'cancel')
  const action = nav.find(row => isHeaderAction(row) && row.id !== 'next' && row.id !== 'finish')
  const fields = rangeFields(headerFields)
  if (previous !== undefined || right !== undefined) {
    const progress = walkProgress(view)
    const mode = walkModeLabel(view)
    const subhead = `<div class="subhead">${mode === '' ? '' : `<span class="meta-line">${htmlText(mode, 40)}</span>`}${end === undefined ? '' : button(end)}</div>`
    return `<header class="chrome walk"><div class="action-row">${previous === undefined ? '' : button(previous)}<span class="progress">${htmlText(progress, 40)}</span>${right === undefined ? '' : button(right)}</div>${subhead}</header>`
  }
  const title = titles[0]
  const heading = title === undefined ? '' : `<h2 class="screen-title">${htmlText(title.label)}</h2>`
  if (back === undefined && heading === '' && fields === '' && action === undefined)
    return ''
  return `<header class="chrome setup"><div class="action-row">${back === undefined ? '' : button(back)}${heading}${action === undefined ? '' : button(action)}</div>${fields}</header>`
}

function isChoiceRow(row: SidebarItemData): boolean {
  return row.surface === 'list' && row.command !== undefined && !row.id.startsWith('commit-')
}

function bodyRows(rows: readonly SidebarItemData[]): string {
  const html: string[] = []
  let choices: SidebarItemData[] = []
  const flushChoices = (): void => {
    if (choices.length === 0)
      return
    html.push(`<div class="choices">${choices.map(button).join('')}</div>`)
    choices = []
  }
  for (const row of rows) {
    if (isChoiceRow(row)) {
      choices.push(row)
      continue
    }
    flushChoices()
    html.push(bodyRow(row))
  }
  flushChoices()
  return html.join('')
}

function repositoryDisclosure(rows: readonly SidebarItemData[], summary: string): string {
  if (rows.length === 0 && summary === '')
    return ''
  const inner = rows.filter(row => row.id !== 'repository-summary')
  return `<details class="disclosure repository" data-id="repository-details"><summary>${htmlText(summary === '' ? 'Repository' : summary)}</summary><div class="disclosure-body">${inner.map(bodyRow).join('')}</div></details>`
}

const CANVAS_FG = 'var(--vscode-sideBar-foreground,var(--vscode-foreground))'
const SUBTLE_BORDER = 'var(--vscode-sideBar-border,var(--vscode-panel-border))'
const DISABLED_FG = 'var(--vscode-disabledForeground,var(--vscode-descriptionForeground))'

const SIDEBAR_STYLE = [
  ':root{',
  '--type-meta:max(12px,calc(var(--vscode-font-size) * 0.92));',
  '--type-title:calc(var(--vscode-font-size) * 1.31);',
  '--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;',
  '--radius-control:4px;--border-width:1px;--focus-width:2px;--control-height:32px',
  '}',
  `html,body{height:100%;margin:0}`,
  `body{display:flex;flex-direction:column;background:transparent;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);font-weight:400;color:${CANVAS_FG};line-height:1.5}`,
  '.frame{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
  '.live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  `header.chrome,footer.bar{flex:0 0 auto;padding:10px var(--space-4);background:var(--vscode-sideBarStickyScroll-background,var(--vscode-sideBar-background))}`,
  `header.chrome{border-bottom:var(--border-width) solid ${SUBTLE_BORDER}}`,
  `footer.bar{border-top:var(--border-width) solid ${SUBTLE_BORDER};display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)}`,
  '.body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:var(--space-3) var(--space-4) var(--space-5);scroll-padding:var(--space-3)}',
  '.screen-title{margin:0;font-size:var(--type-title);font-weight:500;line-height:1.35}',
  `.lede,.meta-line,.path,.hint,.meta{margin:0;color:var(--vscode-descriptionForeground);font-size:var(--type-meta);font-weight:400}`,
  '.lede{margin-top:var(--space-1)}',
  '.title-block{margin:0 0 var(--space-4)}',
  'header.chrome .title-block{margin:0 0 var(--space-4)}',
  '.thought{margin:var(--space-3) 0 var(--space-4)}',
  '.path{margin-top:var(--space-1);font-family:var(--vscode-editor-font-family,monospace)}',
  '.prose,.why,.up-next,.row{margin:var(--space-4) 0}',
  '.prose span,.why span,.up-next span,.row span{display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:var(--space-2)}',
  '.prose.notes>span:first-child{margin-top:0}',
  `.why{padding-left:var(--space-3);border-left:2px solid ${SUBTLE_BORDER}}`,
  'button{display:inline-flex;align-items:center;gap:var(--space-2);width:auto;max-width:100%;text-align:left;margin:var(--space-2) 0;padding:6px 10px;min-height:var(--control-height);border-radius:var(--radius-control);border:var(--border-width) solid transparent;color:inherit;background:transparent;cursor:pointer;font:inherit;font-weight:400}',
  'button:hover{background:var(--vscode-list-hoverBackground)}',
  `button:disabled{color:${DISABLED_FG};background:transparent;cursor:default}`,
  'button:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  'button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:var(--vscode-button-border,transparent);font-weight:500}',
  'button.primary:hover{background:var(--vscode-button-hoverBackground)}',
  `button.primary:disabled{color:${DISABLED_FG};background:transparent;border-color:${SUBTLE_BORDER}}`,
  `button.primary:disabled:hover{background:transparent;color:${DISABLED_FG}}`,
  'button.secondary{background:transparent;color:inherit;border-color:var(--vscode-button-border,transparent)}',
  'button.quiet,button.consequential{background:transparent;color:var(--vscode-textLink-foreground);border-color:transparent;padding-left:0;padding-right:0}',
  'button.quiet:hover,button.consequential:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}',
  `button.consequential{color:${CANVAS_FG};border:var(--border-width) solid ${SUBTLE_BORDER};padding-left:10px;padding-right:10px}`,
  'button.compact{min-width:0;margin:0}',
  'button.icon-only{width:32px;justify-content:center;padding:0}',
  'button .glyph{width:16px;height:16px;flex:0 0 16px}',
  'header.chrome.walk,header.chrome.setup{display:flex;flex-direction:column;align-items:stretch;gap:var(--space-2)}',
  'header.chrome .action-row{display:flex;align-items:center;gap:var(--space-2)}',
  'header.chrome .action-row .screen-title{flex:1 1 auto;min-width:0}',
  'header.chrome .action-row .primary{margin-left:auto;flex:0 0 auto;min-width:max-content;white-space:nowrap}',
  'header.chrome .subhead{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}',
  'header.chrome.walk .progress{flex:1 1 auto;text-align:center;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;font-size:var(--type-meta)}',
  'header.chrome.setup .back{margin:0}',
  '.range-fields{display:flex;align-items:flex-end;gap:var(--space-2);margin:0}',
  `.choices{margin:var(--space-4) 0;border-top:var(--border-width) solid ${SUBTLE_BORDER};border-bottom:var(--border-width) solid ${SUBTLE_BORDER}}`,
  `.choices .list-pick{border-bottom:var(--border-width) solid ${SUBTLE_BORDER}}`,
  '.choices .list-pick:last-child{border-bottom:none}',
  '.range-fields .bound-field{flex:1 1 0;margin:0}',
  '.range-arrow{flex:0 0 auto;color:var(--vscode-descriptionForeground);padding-bottom:8px}',
  'form.input-row{margin:var(--space-3) 0}',
  'form.input-row .field-label{display:block;font-weight:500;margin-bottom:var(--space-1)}',
  'form.input-row .fields{display:flex;gap:var(--space-2);align-items:stretch}',
  `form.input-row .fields input{flex:1 1 auto;width:100%;min-height:var(--control-height);box-sizing:border-box;padding:var(--space-2);border:var(--border-width) solid var(--vscode-input-border,${SUBTLE_BORDER});border-radius:var(--radius-control);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}`,
  'form.input-row .fields input::placeholder{color:var(--vscode-input-placeholderForeground)}',
  'form.input-row .fields input:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  'form.input-row .fields button{width:auto;margin:0}',
  '.field-error{margin:var(--space-1) 0 0;color:var(--vscode-inputValidation-errorForeground,var(--vscode-errorForeground));font-size:var(--type-meta)}',
  `button.list-pick{display:flex;width:100%;align-items:center;gap:var(--space-3);margin:0;padding:10px 8px;min-height:58px;background:transparent;color:${CANVAS_FG};border:none;border-radius:0;font-weight:400}`,
  'button.list-pick.commit-row{border-bottom:none}',
  'button.list-pick:hover{background:var(--vscode-list-hoverBackground)}',
  `button.list-pick:disabled{color:${DISABLED_FG}}`,
  'button.list-pick .label{font-weight:500}',
  'button.list-pick .hint{color:var(--vscode-descriptionForeground);font-weight:400}',
  'button.list-pick .choice-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:2px}',
  'button.list-pick .chevron{margin-left:auto;opacity:0.7}',
  'button.commit-row{min-height:54px;align-items:flex-start;padding:8px 8px 8px 4px;border-bottom:none;border-radius:var(--radius-control)}',
  'button.commit-row .gutter{flex:0 0 16px;position:relative;align-self:stretch}',
  `button.commit-row .gutter::before{content:"";position:absolute;left:7px;top:0;bottom:0;width:1px;background:${SUBTLE_BORDER}}`,
  `button.commit-row .dot{position:relative;z-index:1;display:block;width:9px;height:9px;margin:6px auto 0;border-radius:50%;border:var(--border-width) solid var(--vscode-descriptionForeground);background:transparent}`,
  `button.commit-row.range-start .dot,button.commit-row.range-end .dot,button.commit-row.range-selected .dot{background:${CANVAS_FG};border-color:${CANVAS_FG}}`,
  'button.commit-row .commit-text{flex:1 1 auto;min-width:0}',
  'button.commit-row .subject{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-weight:400}',
  'button.commit-row .meta{margin-top:2px}',
  'button.commit-row .bound-word{flex:0 0 auto;font-size:var(--type-meta);color:var(--vscode-descriptionForeground);padding-top:4px}',
  `button.commit-row.range-start,button.commit-row.range-end,button.commit-row.range-selected{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground,${CANVAS_FG})}`,
  'button.commit-row.range-between{background:transparent}',
  `.notice{margin:var(--space-3) 0;padding:var(--space-3);border:var(--border-width) solid ${SUBTLE_BORDER};border-radius:var(--radius-control);border-left-width:3px}`,
  '.notice-info{border-left-color:var(--vscode-notificationsInfoIcon-foreground,var(--vscode-inputValidation-infoBorder,var(--vscode-editorInfo-foreground)))}',
  '.notice-warning{border-left-color:var(--vscode-notificationsWarningIcon-foreground,var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground)))}',
  '.notice-error{border-left-color:var(--vscode-notificationsErrorIcon-foreground,var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground)))}',
  'details.disclosure{margin:var(--space-4) 0}',
  'details.disclosure summary{cursor:pointer;font-weight:400;min-height:var(--control-height);display:flex;align-items:center;color:var(--vscode-descriptionForeground)}',
  'details.disclosure summary:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  `.disclosure-body{margin-top:var(--space-2);color:${CANVAS_FG};white-space:pre-wrap;overflow-wrap:anywhere}`,
  'footer.bar details.disclosure{margin:0;flex:1 1 auto}',
  'footer.bar .meta-line{margin:0}',
  'footer.bar button{margin:0}',
  '.notes-more{margin-top:var(--space-2)}',
  '.notes-more summary{color:var(--vscode-textLink-foreground);cursor:pointer}',
  '@media (max-width:280px){.body,header.chrome,footer.bar{padding-left:var(--space-3);padding-right:var(--space-3)}.range-fields{flex-direction:column;align-items:stretch}.range-arrow{display:none}footer.bar{flex-wrap:wrap}header.chrome.setup .action-row{flex-wrap:wrap}header.chrome.setup .action-row .primary{flex:1 0 100%;justify-content:center;margin-left:0}header.chrome.walk .progress{order:-1;flex:1 0 100%}}',
  '@media (max-height:520px){header.chrome .lede{display:none}}',
  '@media (prefers-reduced-motion:reduce){button{transition:none}}',
  '@media (forced-colors:active){button,form.input-row .fields input,header.chrome,footer.bar,.notice{border-color:var(--vscode-contrastBorder)}}',
].join('')

const SIDEBAR_SCRIPT = `const api=acquireVsCodeApi();const bodyEl=()=>document.querySelector('.body');const post=(command,payload)=>{if(!command)return;api.postMessage(payload===undefined||payload===null||payload===''?{command}:{command,payload})};const formPayload=(form,value)=>{const bound=form.getAttribute('data-bound');return bound?bound+':'+value:value};const wire=()=>{for(const button of document.querySelectorAll('button[data-command]'))button.addEventListener('click',()=>post(button.getAttribute('data-command'),button.getAttribute('data-payload')));for(const form of document.querySelectorAll('form[data-command]')){form.addEventListener('submit',event=>{event.preventDefault();const input=form.querySelector('input');post(form.getAttribute('data-command'),formPayload(form,input?input.value:''))});const input=form.querySelector('input');const bound=form.getAttribute('data-bound');if(input&&bound)input.addEventListener('focus',()=>post('tabthrough.selectCommit','focus:'+bound))}for(const details of document.querySelectorAll('details[data-id]'))details.addEventListener('toggle',()=>{const state=api.getState()??{};const open=state.open??{};open[details.getAttribute('data-id')??'']=details.open;api.setState({...state,open})})};const capture=()=>{const active=document.activeElement;const inputs={};for(const input of document.querySelectorAll('input[name="payload"]')){const form=input.closest('form');const key=form?.getAttribute('data-id')??form?.getAttribute('data-command')??'';inputs[key]={value:input.value,start:input.selectionStart,end:input.selectionEnd,focus:input===active,dirty:input.value!==(input.getAttribute('data-rendered')??'')}}const open={};for(const details of document.querySelectorAll('details[data-id]'))open[details.getAttribute('data-id')??'']=details.open;return{command:active?.getAttribute?.('data-command')??null,payload:active?.getAttribute?.('data-payload')??'',id:active?.getAttribute?.('data-id')??null,tag:active?.tagName??'',inputs,open,top:bodyEl()?.scrollTop??0}};const restore=(snap)=>{const remembered=api.getState()?.open??{};for(const details of document.querySelectorAll('details[data-id]')){const key=details.getAttribute('data-id')??'';if(Object.hasOwn(snap.open,key))details.open=snap.open[key];else if(Object.hasOwn(remembered,key))details.open=remembered[key]}for(const form of document.querySelectorAll('form[data-command]')){const key=form.getAttribute('data-id')??form.getAttribute('data-command')??'';const saved=snap.inputs[key];if(!saved||!(saved.focus||saved.dirty))continue;const input=form.querySelector('input');if(!input)continue;input.value=saved.value;try{input.setSelectionRange(saved.start??saved.value.length,saved.end??saved.value.length)}catch{}}let focused=false;if(snap.tag==='INPUT'){for(const form of document.querySelectorAll('form[data-command]')){const key=form.getAttribute('data-id')??form.getAttribute('data-command')??'';if(snap.inputs[key]?.focus){form.querySelector('input')?.focus({preventScroll:true});focused=true;break}}}if(!focused&&snap.command){for(const next of document.querySelectorAll('[data-command]')){if(next.getAttribute('data-command')!==snap.command)continue;if((next.getAttribute('data-payload')??'')!==snap.payload)continue;next.focus({preventScroll:true});focused=true;break}}if(!focused&&snap.command==='tabthrough.next'){const finish=document.querySelector('[data-command="tabthrough.finish"]');if(finish)finish.focus({preventScroll:true})}const scroller=bodyEl();if(scroller)scroller.scrollTop=(snap.command==='tabthrough.next'||snap.command==='tabthrough.previous')?0:snap.top};wire();window.addEventListener('message',event=>{if(event.data?.type!=='update')return;const snap=capture();const frame=document.querySelector('.frame');if(frame)frame.outerHTML=event.data.body;wire();restore(snap)});document.addEventListener('keydown',event=>{if(event.key!=='Tab'||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey)return;const finish=document.querySelector('[data-command="tabthrough.finish"]');if(!finish||finish.hasAttribute('disabled'))return;event.preventDefault();post('tabthrough.finish')});`

/** Secure plain HTML: escaped guide text, no remote resources, fixed commands. */
export function renderSidebarHtml(view: SidebarViewModel): string {
  const nonce = randomUUID().replace(/[^a-z0-9]/gi, '')
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${SIDEBAR_STYLE}</style></head><body>${renderSidebarBody(view)}<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script></body></html>`
}

export function renderSidebarBody(view: SidebarViewModel): string {
  const items = sidebarItems(view)
  const nav = items.filter(row => row.slot === 'nav')
  const headerFields = items.filter(row => row.slot === 'header')
  const footer = items.filter(row => row.slot === 'footer')
  const titles: SidebarItemData[] = []
  const main: SidebarItemData[] = []
  const repo: SidebarItemData[] = []
  for (const row of items) {
    if (row.slot === 'nav' || row.slot === 'header' || row.slot === 'footer')
      continue
    if (row.group === 'repository') {
      repo.push(row)
      continue
    }
    if (isTitleRow(row) && screenName(view) !== 'home') {
      titles.push(row)
      if (row.description !== undefined) {
        main.push({
          id: `${row.id}-lede`,
          label: row.description,
        })
      }
      continue
    }
    main.push(row)
  }
  const screen = screenName(view)
  const repoInFooter = screen === 'home' || screen === 'generate'
  const repoSummary = repo.find(row => row.id === 'repository-summary')?.label
    ?? footer.find(row => row.id === 'repository-summary')?.label
    ?? ''
  const footerItems = footer.filter(row => row.id !== 'repository-summary' && row.command === undefined)
  const repoBlock = repositoryDisclosure(repo, repoSummary)
  const footerInner = repoInFooter
    ? repoBlock
    : footerItems.map(bodyRow).join('')
  const bodyRepo = repoInFooter ? '' : repoBlock
  return `<div class="frame screen-${screen}">${chrome(view, nav, titles, headerFields)}${liveRegion(view)}<main class="body">${bodyRows(main)}${bodyRepo}</main>${footerInner === '' ? '' : `<footer class="bar">${footerInner}</footer>`}</div>`
}
