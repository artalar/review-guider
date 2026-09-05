import type { SidebarItemData } from '../model/sidebar'
import type { SidebarViewModel } from '../model/view'
import { randomUUID } from 'node:crypto'
import { safeSidebarText, sidebarItems } from '../model/sidebar'

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

function isPrimary(row: SidebarItemData): boolean {
  const command = row.command ?? ''
  if (command.endsWith('.finish'))
    return row.slot === 'nav'
  return command.endsWith('.next')
    || command.endsWith('.startFromGuide')
    || command.endsWith('.review')
}

function commandButton(row: SidebarItemData, extraClass = ''): string {
  const command = row.command ?? ''
  const enabled = row.enabled !== false
  const payload = row.payload === undefined ? '' : ` data-payload="${htmlAttr(row.payload, 200)}"`
  const kind = isPrimary(row) ? 'primary' : 'secondary'
  const classes = [kind, extraClass].filter(part => part !== '').join(' ')
  return `<button class="${classes}" type="button" data-command="${htmlAttr(command, 100)}"${payload}${enabled ? '' : ' disabled'}>${buttonInner(row)}</button>`
}

function buttonInner(row: SidebarItemData): string {
  const label = htmlText(row.label, 200)
  if (row.slot === 'nav' || row.description === undefined)
    return label
  return `<span class="label">${label}</span><span class="hint">${htmlText(row.description, 400)}</span>`
}

function button(row: SidebarItemData): string {
  const extra = row.description === undefined ? '' : 'choice'
  return commandButton(row, extra)
}

function inputRow(row: SidebarItemData): string {
  const command = row.command ?? ''
  const placeholder = row.input?.placeholder ?? ''
  const submit = row.input?.submit ?? 'Go'
  const enabled = row.enabled !== false
  return `<form class="input-row" data-command="${htmlAttr(command, 100)}"><label>${htmlText(row.label, 200)}</label><div class="fields"><input type="text" name="payload" placeholder="${htmlAttr(placeholder, 120)}"${enabled ? '' : ' disabled'} autocomplete="off" spellcheck="false"><button class="primary" type="submit"${enabled ? '' : ' disabled'}>${htmlText(submit, 80)}</button></div></form>`
}

function chrome(view: SidebarViewModel, nav: readonly SidebarItemData[]): string {
  if (nav.length === 0)
    return ''
  const back = nav.find(row => row.id === 'back')
  if (back !== undefined)
    return `<header class="chrome">${commandButton(back, 'ghost back')}</header>`
  const previous = nav.find(row => row.id === 'previous')
  const next = nav.find(row => row.id === 'next')
  const finish = nav.find(row => row.id === 'finish')
  const right = next ?? finish
  const progress = view.progress === null ? '' : `${view.progress.index} of ${view.progress.total}`
  return `<header class="chrome walk">${previous === undefined ? '' : commandButton(previous, 'retreat')}<span class="progress">${htmlText(progress, 40)}</span>${right === undefined ? '' : commandButton(right, 'advance')}</header>`
}

function bodyRow(row: SidebarItemData): string {
  if (row.command !== undefined && row.contextValue === 'input')
    return inputRow(row)
  if (row.command !== undefined && row.contextValue === 'action')
    return button(row)
  return `<section class="row ${htmlAttr(row.id, 100)}"><strong>${htmlText(row.label)}</strong>${row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`}</section>`
}

const SIDEBAR_STYLE = 'body{margin:0;background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:12px 16px 20px}.row{padding:12px 0;border-bottom:1px solid var(--vscode-panel-border)}.row strong{display:block;font-weight:600}.row span{display:block;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:3px;line-height:1.35}button{display:block;width:100%;text-align:left;margin:7px 0;padding:5px 8px;min-height:32px;border-radius:3px;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}button.choice{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px}button.choice .hint{color:var(--vscode-descriptionForeground);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}header.chrome{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;margin:-12px -16px 8px;padding:10px 16px 8px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)}header.chrome button{width:auto;margin:0;text-align:center}header.chrome button.ghost{background:transparent;color:var(--vscode-textLink-foreground);border-color:transparent;text-align:left;padding:4px 0;min-height:0}header.chrome button.ghost:hover{background:var(--vscode-toolbar-hoverBackground,transparent);color:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground))}header.chrome.walk button.retreat,header.chrome.walk button.advance{flex:1 1 0}header.chrome .progress{flex:0 0 auto;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}.session strong{font-size:11px;text-transform:uppercase;letter-spacing:.08em}.session span{font-size:22px;color:var(--vscode-foreground)}.current strong{font-size:16px;line-height:1.4}.notes span{color:var(--vscode-foreground);line-height:1.6}.complete{margin:12px 0;color:var(--vscode-testing-iconPassed)}.rationale span{color:var(--vscode-foreground)}.next-step{font-size:12px}.summary{margin-bottom:8px}form.input-row{margin:10px 0}form.input-row label{display:block;font-weight:600;margin-bottom:6px}form.input-row .fields{display:flex;gap:6px;align-items:stretch}form.input-row .fields input{flex:1 1 auto;width:auto;box-sizing:border-box;padding:6px 8px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}form.input-row .fields button{width:auto;margin:0;text-align:center}'

const SIDEBAR_SCRIPT = `const api=acquireVsCodeApi();const post=(command,payload)=>{if(!command)return;api.postMessage(payload===undefined||payload===null||payload===''?{command}:{command,payload})};const wire=()=>{for(const button of document.querySelectorAll('button[data-command]'))button.addEventListener('click',()=>post(button.getAttribute('data-command'),button.getAttribute('data-payload')));for(const form of document.querySelectorAll('form[data-command]'))form.addEventListener('submit',event=>{event.preventDefault();const input=form.querySelector('input');post(form.getAttribute('data-command'),input?input.value:'')})};wire();window.addEventListener('message',event=>{if(event.data?.type!=='update')return;const active=document.activeElement;const command=active?.getAttribute('data-command');const top=document.documentElement.scrollTop;document.body.innerHTML=event.data.body;wire();if(command){for(const next of document.querySelectorAll('[data-command]'))if(next.getAttribute('data-command')===command){next.focus();break}}document.documentElement.scrollTop=top});`

/** Secure plain HTML: escaped guide text, no remote resources, fixed commands. */
export function renderSidebarHtml(view: SidebarViewModel): string {
  const nonce = randomUUID().replace(/[^a-z0-9]/gi, '')
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${SIDEBAR_STYLE}</style></head><body>${renderSidebarBody(view)}<script nonce="${nonce}">${SIDEBAR_SCRIPT}</script></body></html>`
}

export function renderSidebarBody(view: SidebarViewModel): string {
  const items = sidebarItems(view)
  const nav = items.filter(row => row.slot === 'nav')
  const body = items.filter(row => row.slot !== 'nav')
  return `${chrome(view, nav)}${body.map(bodyRow).join('')}`
}
