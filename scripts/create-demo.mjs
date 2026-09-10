import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Always create a new repository. Never modify the caller's checkout.
const root = mkdtempSync(join(tmpdir(), 'tabthrough-demo-'))
const write = (path, text) => writeFileSync(join(root, path), text)
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(result.stderr || 'Git could not create the demo.')
}
mkdirSync(join(root, 'src'))
write('src/pricing.ts', 'export function total(price: number, quantity: number): number {\n  return price * quantity\n}\n')
write('src/checkout.ts', 'import { total } from \'./pricing\'\n\nexport const checkout = () => total(25, 2)\n')
write('.guide.json', `${JSON.stringify({
  version: 1,
  summary: 'Make checkout pricing explicit: introduce an order contract, calculate from that contract, then update the caller. Each step builds on the previous one.',
  steps: [
    { id: 'order', order: 10, path: 'src/order.ts', title: 'An order has named fields', rationale: 'The shared contract comes before the functions that consume it', notes: 'Positional numbers are easy to swap. The Order type gives price and quantity names, so each later call explains itself.' },
    { id: 'pricing', order: 20, path: 'src/pricing.ts', title: 'Pricing consumes the contract', rationale: 'The calculation establishes behavior before checkout calls it', notes: 'The multiplication stays the same. Only the function boundary changes: callers now supply an Order instead of two unrelated numbers.', dependsOn: ['order'] },
    { id: 'checkout', order: 30, path: 'src/checkout.ts', title: 'Checkout names its inputs', rationale: 'The final caller makes sense after the contract and calculation', notes: 'This is the last step. Its notes remain visible while you decide what to do next.\n\nFinish or Cancel closes the walkthrough. The working tree stays as you left it.', dependsOn: ['pricing'] },
  ],
}, null, 2)}\n`)
git('init', '--quiet', '--initial-branch=main')
git('config', 'user.name', 'Tabthrough Demo')
git('config', 'user.email', 'demo@tabthrough.local')
git('config', 'commit.gpgsign', 'false')
git('add', '-A')
git('commit', '--quiet', '-m', 'Before the walkthrough')
write('src/order.ts', 'export interface Order {\n  price: number\n  quantity: number\n}\n')
write('src/pricing.ts', 'import type { Order } from \'./order\'\n\nexport function total(order: Order): number {\n  return order.price * order.quantity\n}\n')
write('src/checkout.ts', 'import { total } from \'./pricing\'\n\nexport const checkout = () => total({ price: 25, quantity: 2 })\n')
console.log(root)
console.log('Open this folder in VS Code or Cursor, then run Tabthrough: Review Working Changes.')
