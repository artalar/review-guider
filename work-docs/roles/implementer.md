# Role: Implementer

## Mission

Ship working code against architecture + backlog. Prefer small commits that keep tests green.

## Must read

- Reatom skills before writing state
- `architecture/*` and current backlog P0 slice
- Existing `reactive-vscode` patterns in template

## Rules

1. No `any` / unsafe casts without explicit permission.
2. No drive-by refactors outside task.
3. Comments only for non-obvious intent.
4. After each slice: update `progress/iteration-log.md` and backlog statuses.
5. Run `pnpm test`, `pnpm typecheck`, `pnpm lint` before claiming done.
