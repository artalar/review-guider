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
  return `<button class="${classes}" type="button" data-id="${htmlAttr(row.id, 80)}" data-command="${htmlAttr(command, 100)}"${payload}${enabled ? '' : ' disabled'}${busy ? ' aria-busy="true"' : ''}>${buttonInner(row)}</button>`
}

function boundMark(accent: SidebarItemData['accent']): { readonly label: string, readonly svg: string } | null {
  if (accent === 'start')
    return { label: 'Start', svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5.2 3.4v9.2L13 8z"/></svg>' }
  if (accent === 'end')
    return { label: 'End', svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" fill="currentColor"/></svg>' }
  if (accent === 'selected')
    return { label: 'Select', svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' }
  return null
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

function boundMarkup(row: SidebarItemData): string {
  const mark = boundMark(row.accent)
  if (mark !== null)
    return `<span class="bound" title="${mark.label}" aria-label="${mark.label}">${mark.svg}</span>`
  if (row.surface === 'list' && row.id.startsWith('commit-'))
    return '<span class="bound"></span>'
  return ''
}

function buttonInner(row: SidebarItemData): string {
  const label = htmlText(row.label, 200)
  if (row.slot === 'nav')
    return label
  const badge = boundMarkup(row)
  if (row.description === undefined)
    return `${badge}${label}`
  return `<span class="head">${badge}<span class="label">${label}</span></span><span class="hint">${htmlText(row.description, 400)}</span>`
}

function button(row: SidebarItemData): string {
  const extra = [row.description === undefined ? '' : 'choice', accentClass(row.accent)]
    .filter(part => part !== '')
    .join(' ')
  return commandButton(row, extra)
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
  return `<form class="input-row" data-command="${htmlAttr(command, 100)}" data-id="${htmlAttr(row.id, 80)}"><label class="field-label" for="${fieldId}">${htmlText(row.label, 200)}</label><div class="fields"><input id="${fieldId}" type="text" name="payload" placeholder="${htmlAttr(placeholder, 120)}"${enabled ? '' : ' disabled'} autocomplete="off" spellcheck="false"${described}><button class="${submitClass}" type="submit"${enabled ? '' : ' disabled'}>${htmlText(submit, 80)}</button></div>${error === undefined ? '' : `<p class="field-error" id="${errorId}">${htmlText(error, 400)}</p>`}</form>`
}

function chrome(view: SidebarViewModel, nav: readonly SidebarItemData[]): string {
  if (nav.length === 0)
    return ''
  const back = nav.find(row => row.id === 'back')
  if (back !== undefined)
    return `<header class="chrome">${commandButton(back, 'quiet back')}</header>`
  const previous = nav.find(row => row.id === 'previous')
  const next = nav.find(row => row.id === 'next')
  const finish = nav.find(row => row.id === 'finish')
  const right = next ?? finish
  const progress = walkProgress(view)
  return `<header class="chrome walk">${previous === undefined ? '' : commandButton(previous, 'retreat')}<span class="progress">${htmlText(progress, 40)}</span>${right === undefined ? '' : commandButton(right, 'advance')}</header>`
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

function textRow(row: SidebarItemData): string {
  const body = row.id === 'notes' && row.description !== undefined
    ? notesBody(row.description)
    : (row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`)
  return `<section class="row ${htmlAttr(row.id, 100)}" data-id="${htmlAttr(row.id, 80)}"><strong>${htmlText(row.label)}</strong>${body}</section>`
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

function repositoryDetails(rows: readonly SidebarItemData[]): string {
  if (rows.length === 0)
    return ''
  return `<details class="disclosure repository" data-id="repository-details"><summary>Repository details</summary><div class="disclosure-body">${rows.map(bodyRow).join('')}</div></details>`
}

const CANVAS_FG = 'var(--vscode-sideBar-foreground,var(--vscode-foreground))'
const SUBTLE_BORDER = 'var(--vscode-sideBar-border,var(--vscode-panel-border))'
const DISABLED_FG = 'var(--vscode-disabledForeground,var(--vscode-descriptionForeground))'

const SIDEBAR_STYLE = [
  ':root{',
  '--type-meta:max(12px,calc(var(--vscode-font-size) * 0.92));',
  '--type-title:calc(var(--vscode-font-size) * 1.23);',
  '--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;',
  '--radius-control:4px;--border-width:1px;--focus-width:2px;--control-height:32px',
  '}',
  `body{margin:0;background:transparent;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:${CANVAS_FG};padding:var(--space-3) var(--space-4) var(--space-5);line-height:1.5}`,
  '.live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.row{padding:var(--space-3) 0}',
  `.row + .row{border-top:var(--border-width) solid ${SUBTLE_BORDER}}`,
  '.row strong{display:block;font-weight:600}',
  '.row span{display:block;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:var(--space-1);line-height:1.5}',
  '.session{padding-top:var(--space-2);padding-bottom:var(--space-2)}',
  '.session strong{font-size:var(--type-meta);font-weight:600;line-height:1.4}',
  '.session span{font-size:var(--type-meta);color:var(--vscode-descriptionForeground)}',
  '.current strong{font-size:var(--type-title);font-weight:600;line-height:1.4}',
  '.current span{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--type-meta);color:var(--vscode-descriptionForeground)}',
  `.rationale span,.notes span,.complete span{color:${CANVAS_FG}}`,
  '.notes span{line-height:1.5}',
  '.complete strong{font-weight:600}',
  '.next-step{font-size:var(--type-meta)}',
  '.next-step strong{font-weight:600}',
  'button{display:block;width:100%;text-align:left;margin:var(--space-2) 0;padding:var(--space-2);min-height:var(--control-height);border-radius:var(--radius-control);border:var(--border-width) solid transparent;color:inherit;background:transparent;cursor:pointer;transition:background-color 120ms ease}',
  'button:hover{background:var(--vscode-list-hoverBackground)}',
  `button:disabled{color:${DISABLED_FG};background:transparent;border-color:transparent;cursor:default}`,
  'button:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  'button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border-color:var(--vscode-button-border,transparent)}',
  'button.primary:hover{background:var(--vscode-button-hoverBackground)}',
  `button.primary:disabled{color:${DISABLED_FG};background:var(--vscode-button-secondaryBackground);border-color:${SUBTLE_BORDER}}`,
  'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border-color:var(--vscode-button-border,transparent)}',
  'button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}',
  `button.secondary:disabled{color:${DISABLED_FG};background:var(--vscode-button-secondaryBackground);border-color:${SUBTLE_BORDER}}`,
  'button.quiet{background:transparent;color:var(--vscode-textLink-foreground);border-color:transparent}',
  'button.quiet:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground));color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground))}',
  `button.quiet:disabled{color:${DISABLED_FG};background:transparent}`,
  `button.consequential{background:transparent;color:${CANVAS_FG};border-color:var(--vscode-button-border,${SUBTLE_BORDER})}`,
  'button.consequential:hover{background:var(--vscode-list-hoverBackground)}',
  `button.consequential:disabled{color:${DISABLED_FG};background:transparent;border-color:${SUBTLE_BORDER}}`,
  'button.choice{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:var(--space-2)}',
  'button.choice .head{display:flex;align-items:center;gap:6px;min-width:0}',
  'button.choice .label{font-weight:600}',
  'button.choice .hint{color:inherit;font-size:var(--type-meta);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.4}',
  `header.chrome{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:var(--space-2);margin:calc(var(--space-3) * -1) calc(var(--space-4) * -1) var(--space-2);padding:10px var(--space-4) var(--space-2);background:var(--vscode-sideBarStickyScroll-background,var(--vscode-sideBar-background));border-bottom:var(--border-width) solid var(--vscode-sideBarStickyScroll-border,${SUBTLE_BORDER})}`,
  'header.chrome button{width:auto;margin:0;text-align:center}',
  'header.chrome button.quiet{text-align:left;padding:var(--space-1) 0;min-height:var(--control-height)}',
  'header.chrome.walk button.retreat,header.chrome.walk button.advance{flex:1 1 0}',
  'header.chrome .progress{flex:0 0 auto;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums;font-size:var(--type-meta)}',
  `.notice{margin:var(--space-3) 0;padding:var(--space-3);border:var(--border-width) solid ${SUBTLE_BORDER};border-radius:var(--radius-control);border-left-width:3px}`,
  '.notice-info{border-left-color:var(--vscode-notificationsInfoIcon-foreground,var(--vscode-inputValidation-infoBorder,var(--vscode-editorInfo-foreground)))}',
  '.notice-warning{border-left-color:var(--vscode-notificationsWarningIcon-foreground,var(--vscode-inputValidation-warningBorder,var(--vscode-editorWarning-foreground)))}',
  '.notice-error{border-left-color:var(--vscode-notificationsErrorIcon-foreground,var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground)))}',
  '.notice strong{display:block;font-weight:600}',
  `.notice span{display:block;color:${CANVAS_FG};margin-top:var(--space-1);white-space:pre-wrap;overflow-wrap:anywhere}`,
  '.notice button{margin-top:var(--space-2)}',
  `details.disclosure{margin:var(--space-3) 0;border-top:var(--border-width) solid ${SUBTLE_BORDER};padding-top:var(--space-2)}`,
  'details.disclosure summary{cursor:pointer;font-weight:600;min-height:var(--control-height);display:flex;align-items:center}',
  'details.disclosure summary:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  `.disclosure-body{margin-top:var(--space-2);color:${CANVAS_FG};white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-font-family)}`,
  '.will-run-command .disclosure-body,.will-run .disclosure-body{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--type-meta);overflow-x:auto}',
  'form.input-row{margin:var(--space-3) 0}',
  'form.input-row .field-label{display:block;font-weight:600;margin-bottom:var(--space-2)}',
  'form.input-row .fields{display:flex;gap:var(--space-2);align-items:stretch}',
  `form.input-row .fields input{flex:1 1 auto;width:auto;min-height:var(--control-height);box-sizing:border-box;padding:var(--space-2);border:var(--border-width) solid var(--vscode-input-border,${SUBTLE_BORDER});border-radius:var(--radius-control);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}`,
  'form.input-row .fields input::placeholder{color:var(--vscode-input-placeholderForeground)}',
  'form.input-row .fields input:focus-visible{outline:var(--focus-width) solid var(--vscode-focusBorder);outline-offset:2px}',
  'form.input-row .fields button{width:auto;margin:0;text-align:center}',
  '.field-error{margin:var(--space-1) 0 0;color:var(--vscode-inputValidation-errorForeground,var(--vscode-errorForeground));font-size:var(--type-meta)}',
  '.notes-more{margin-top:var(--space-2)}',
  '.notes-more summary{color:var(--vscode-textLink-foreground);cursor:pointer;font-weight:600}',
  '@media (max-width:280px){body{padding-left:var(--space-3);padding-right:var(--space-3)}header.chrome{margin-left:calc(var(--space-3) * -1);margin-right:calc(var(--space-3) * -1);padding-left:var(--space-3);padding-right:var(--space-3);flex-wrap:wrap}header.chrome.walk .progress{order:-1;flex:1 0 100%;text-align:center}form.input-row .fields{flex-direction:column}}',
  '@media (prefers-reduced-motion:reduce){button{transition:none}}',
  '@media (forced-colors:active){button,form.input-row .fields input,header.chrome,.notice{border-color:var(--vscode-contrastBorder)}}',
].join('')

const LIST_PICK_STYLE = [
  `button.list-pick{margin:2px 0;padding:7px 10px;background:transparent;color:${CANVAS_FG};border-color:transparent;border-radius:var(--radius-control)}`,
  'button.list-pick:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,var(--vscode-sideBar-foreground,var(--vscode-foreground)))}',
  `button.list-pick:disabled{color:${DISABLED_FG};background:transparent}`,
  'button.list-pick .hint{color:var(--vscode-descriptionForeground)}',
  'button.list-pick.range-selected .hint,button.list-pick.range-start .hint,button.list-pick.range-end .hint{color:inherit}',
  'button.list-pick .bound{flex:0 0 18px;width:18px;height:18px;justify-content:center;display:inline-flex;align-items:center;padding:0;background:transparent;color:currentColor}',
  'button.list-pick .bound svg{width:12px;height:12px;display:block}',
  'button.list-pick .bound:empty{visibility:hidden}',
  `button.list-pick.range-selected,button.list-pick.range-start,button.list-pick.range-end{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground,${CANVAS_FG})}`,
  `button.list-pick.range-between{background:transparent;color:${CANVAS_FG};box-shadow:inset 3px 0 0 var(--vscode-list-inactiveSelectionBackground)}`,
  'button.list-pick.range-selected:hover,button.list-pick.range-start:hover,button.list-pick.range-end:hover{background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground));color:var(--vscode-list-activeSelectionForeground,var(--vscode-list-hoverForeground,var(--vscode-sideBar-foreground,var(--vscode-foreground))))}',
  'button.list-pick.range-between:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-list-hoverForeground,var(--vscode-sideBar-foreground,var(--vscode-foreground)))}',
  'button.list-pick.range-between .hint{color:var(--vscode-descriptionForeground)}',
  'body.vscode-high-contrast button.list-pick.range-selected,body.vscode-high-contrast button.list-pick.range-start,body.vscode-high-contrast button.list-pick.range-end,body.vscode-high-contrast-light button.list-pick.range-selected,body.vscode-high-contrast-light button.list-pick.range-start,body.vscode-high-contrast-light button.list-pick.range-end{outline:1px solid var(--vscode-contrastBorder);outline-offset:-1px}',
].join('')

const SIDEBAR_SCRIPT = `const api=acquireVsCodeApi();const post=(command,payload)=>{if(!command)return;api.postMessage(payload===undefined||payload===null||payload===''?{command}:{command,payload})};const wire=()=>{for(const button of document.querySelectorAll('button[data-command]'))button.addEventListener('click',()=>post(button.getAttribute('data-command'),button.getAttribute('data-payload')));for(const form of document.querySelectorAll('form[data-command]'))form.addEventListener('submit',event=>{event.preventDefault();const input=form.querySelector('input');post(form.getAttribute('data-command'),input?input.value:'')});for(const details of document.querySelectorAll('details[data-id]'))details.addEventListener('toggle',()=>{const state=api.getState()??{};const open=state.open??{};open[details.getAttribute('data-id')??'']=details.open;api.setState({...state,open})})};const capture=()=>{const active=document.activeElement;const inputs={};for(const input of document.querySelectorAll('input[name="payload"]')){const form=input.closest('form');const key=form?.getAttribute('data-id')??form?.getAttribute('data-command')??'';inputs[key]={value:input.value,start:input.selectionStart,end:input.selectionEnd,focus:input===active}}const open={};for(const details of document.querySelectorAll('details[data-id]'))open[details.getAttribute('data-id')??'']=details.open;return{command:active?.getAttribute?.('data-command')??null,payload:active?.getAttribute?.('data-payload')??'',id:active?.getAttribute?.('data-id')??null,tag:active?.tagName??'',inputs,open,top:document.documentElement.scrollTop}};const restore=(snap)=>{const remembered=api.getState()?.open??{};for(const details of document.querySelectorAll('details[data-id]')){const key=details.getAttribute('data-id')??'';if(Object.hasOwn(snap.open,key))details.open=snap.open[key];else if(Object.hasOwn(remembered,key))details.open=remembered[key]}for(const form of document.querySelectorAll('form[data-command]')){const key=form.getAttribute('data-id')??form.getAttribute('data-command')??'';const saved=snap.inputs[key];if(!saved)continue;const input=form.querySelector('input');if(!input)continue;input.value=saved.value;try{input.setSelectionRange(saved.start??saved.value.length,saved.end??saved.value.length)}catch{}}let focused=false;if(snap.tag==='INPUT'){for(const form of document.querySelectorAll('form[data-command]')){const key=form.getAttribute('data-id')??form.getAttribute('data-command')??'';if(snap.inputs[key]?.focus){form.querySelector('input')?.focus({preventScroll:true});focused=true;break}}}if(!focused&&snap.command){for(const next of document.querySelectorAll('[data-command]')){if(next.getAttribute('data-command')!==snap.command)continue;if((next.getAttribute('data-payload')??'')!==snap.payload)continue;next.focus({preventScroll:true});focused=true;break}}if(!focused&&snap.command==='tabthrough.next'){const finish=document.querySelector('[data-command="tabthrough.finish"]');if(finish)finish.focus({preventScroll:true})}document.documentElement.scrollTop=snap.top};wire();window.addEventListener('message',event=>{if(event.data?.type!=='update')return;const snap=capture();document.body.innerHTML=event.data.body;wire();restore(snap)});`

/** Secure plain HTML: escaped guide text, no remote resources, fixed commands. */
export function renderSidebarHtml(view: SidebarViewModel): string {
  const nonce = randomUUID().replace(/[^a-z0-9]/gi, '')
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${SIDEBAR_STYLE}${LIST_PICK_STYLE}</style></head><body>${renderSidebarBody(view)}<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script></body></html>`
}

export function renderSidebarBody(view: SidebarViewModel): string {
  const items = sidebarItems(view)
  const nav = items.filter(row => row.slot === 'nav')
  const body = items.filter(row => row.slot !== 'nav')
  const main: SidebarItemData[] = []
  const repo: SidebarItemData[] = []
  for (const row of body) {
    if (row.group === 'repository')
      repo.push(row)
    else
      main.push(row)
  }
  return `${chrome(view, nav)}${liveRegion(view)}${main.map(bodyRow).join('')}${repositoryDetails(repo)}`
}
