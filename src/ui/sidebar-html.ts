import type { SidebarViewModel } from '../model/view'
import { randomUUID } from 'node:crypto'
import { safeSidebarText, sidebarItems } from '../model/sidebar'

export function htmlText(value: string | undefined, max = 4000): string {
  return safeSidebarText(value ?? '', max)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>')
}

function button(label: string, command: string, enabled = true): string {
  return `<button class="${command.endsWith('.next') || command.endsWith('.start') ? 'primary' : 'secondary'}" type="button" data-command="${htmlText(command, 100)}"${enabled ? '' : ' disabled'}>${htmlText(label, 200)}</button>`
}

/** Secure plain HTML: escaped guide text, no remote resources, fixed commands. */
export function renderSidebarHtml(view: SidebarViewModel): string {
  const nonce = randomUUID().replace(/[^a-z0-9]/gi, '')
  return `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{margin:0;background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px 10px}.row{padding:7px 0;border-bottom:1px solid var(--vscode-panel-border)}.row strong{display:block;font-weight:600}.row span{display:block;color:var(--vscode-descriptionForeground);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:3px;line-height:1.35}button{display:block;width:100%;text-align:left;margin:4px 0;padding:5px 8px;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}.session strong{font-size:11px;text-transform:uppercase;letter-spacing:.08em}.session span{font-size:22px;color:var(--vscode-foreground)}.current strong{font-size:16px;line-height:1.4}.notes span{color:var(--vscode-foreground);line-height:1.6}.complete{margin:12px 0;color:var(--vscode-testing-iconPassed)}.row{padding:12px 0}.rationale span{color:var(--vscode-foreground)}.next-step{font-size:12px}.summary{margin-bottom:8px}button{min-height:32px;border-radius:3px;margin:7px 0}body{padding:12px 16px 20px}</style></head><body>${renderSidebarBody(view)}<script nonce="${nonce}">const api=acquireVsCodeApi();const wire=()=>{for(const button of document.querySelectorAll('[data-command]'))button.addEventListener('click',()=>api.postMessage({command:button.getAttribute('data-command')}))};wire();window.addEventListener('message',event=>{if(event.data?.type!=='update')return;const active=document.activeElement;const command=active?.getAttribute('data-command');const top=document.documentElement.scrollTop;document.body.innerHTML=event.data.body;wire();if(command){for(const next of document.querySelectorAll('[data-command]'))if(next.getAttribute('data-command')===command){next.focus();break}}document.documentElement.scrollTop=top});</script></body></html>`
}

export function renderSidebarBody(view: SidebarViewModel): string {
  const content = sidebarItems(view).map((row) => {
    if (row.command !== undefined && row.contextValue === 'action')
      return button(row.label, row.command, row.enabled !== false)
    return `<section class="row ${htmlText(row.id, 100)}"><strong>${htmlText(row.label)}</strong>${row.description === undefined ? '' : `<span>${htmlText(row.description, 4000)}</span>`}</section>`
  }).join('')
  return content
}
